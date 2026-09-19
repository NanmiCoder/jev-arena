/**
 * HTTP 服务：node:http 标准库，不引框架（演示项目要的是启动快、依赖少）。
 *
 * 路由：
 *   GET  /             → web/ 静态页（前端没就绪时给一个提示页）
 *   GET  /api/state    → 运行状态 + 数据集信息（含 replaying / speed）
 *   POST /api/start    → {limit?, concurrency?, resume?, runId?}，已在跑返回 409
 *   POST /api/stop     → 停止当前运行
 *   GET  /api/stream   → SSE 事件流（含心跳、断线清理）
 *   GET  /api/report   → 最近一次运行的报告 JSON
 *   GET  /api/runs     → 可回放的录像列表（目录里有 events.jsonl 的 run）
 *   POST /api/replay       → {runId, speed} 回放已落盘的事件（只读文件，绝不调模型）
 *   POST /api/replay/stop  → 停止回放
 *   POST /api/replay/speed → {speed} 回放中途变速
 *
 * 启动：node src/server.mjs [--port=5173] [--resume] [--run=0919-121530]
 */

import "dotenv/config";
import http from "node:http";
import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initialConfig, publicConfig, validateConfig, configuredLanes } from "./config.mjs";
import { datasetFromFile } from "./dataset.mjs";
import { enrichReport } from "./report-view.mjs";
import { RunStore, listRuns } from "./store.mjs";
import { createRunner } from "./runner.mjs";
import { createReplay, clampSpeed } from "./replay.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let modelConfig = initialConfig();
let mutationBusy = false;
const DATA_PATH = process.env.DATA_PATH || path.join(ROOT, "examples", "comments.csv");
const WEB_DIR = path.join(ROOT, "web");
const RUNS_DIR = process.env.RUNS_DIR || path.join(ROOT, "runs");

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf("=");
  return eq >= 0 ? hit.slice(eq + 1) : true;
}

const PORT = Number(flag("port", process.env.PORT || 5173));
const HOST = process.env.HOST || "127.0.0.1";
const CLI_RESUME = Boolean(flag("resume", false));
const CLI_RUN = typeof flag("run", null) === "string" ? flag("run", null) : null;
const DEFAULT_CONCURRENCY = Number(flag("concurrency", process.env.CONCURRENCY || 3)) || 3;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

let dataset = null;
/** 当前/最近一次运行：{runner, store, runId, running, startedAt, total, limit} */
let current = null;
let lastReport = null;
const sseClients = new Set();

/**
 * 回放实例（createReplay）。与 current 完全隔离：
 * 回放只读 runs/<runId>/events.jsonl，不碰 runner / backend，不会发起任何模型调用。
 */
let replay = null;
let replayRunId = null;
const laneInfo = () => publicConfig(modelConfig).map(({ id, label, model }) => ({ id, label, model }));

const isReplaying = () => Boolean(replay?.getState().replaying);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req, limitBytes = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (err) { reject(new Error(`JSON 解析失败：${err.message}`)); }
    });
    req.on("error", reject);
  });
}

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function handleStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // 反代别缓冲，否则「实时」就没了
  });
  res.write("retry: 1500\n\n");
  sseClients.add(res);

  // 心跳：视频里长时间没事件时，别让浏览器/代理把连接掐了
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* 下面 close 事件会清理 */ }
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("close", cleanup);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function handleState(req, res) {
  const state = current?.runner.getState();
  const live = Boolean(current?.running);
  const rs = replay?.getState() ?? null;
  const replayLanes = rs ? Object.values(rs.lanes) : null;
  // 真跑优先；否则若是回放（进行中或已放完），用回放重算出来的车道状态，
  // 让「刷新页面后仍能看到终局数字」这件事对回放同样成立。
  const lanes = live
    ? (state?.lanes ?? [])
    : (replayLanes ?? state?.lanes ?? laneInfo().map((l) => ({ ...l, done: 0, failed: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, cps: 0 })));
  const replayTotal = replayLanes?.length ? Math.max(...replayLanes.map((l) => Number(l.total) || 0)) : 0;

  sendJson(res, 200, {
    running: live || Boolean(rs?.replaying),
    replaying: Boolean(rs?.replaying),
    speed: rs?.speed ?? null,
    replay: rs ? {
      runId: rs.runId,
      replaying: rs.replaying,
      finished: rs.finished,
      speed: rs.speed,
      virtualMs: rs.virtualMs,
      totalMs: rs.totalMs,
      emitted: rs.emitted,
      total: rs.total,
    } : null,
    runId: live ? current.runId : (rs?.runId ?? current?.runId ?? null),
    startedAt: current?.startedAt ? new Date(current.startedAt).toISOString() : null,
    elapsedMs: live ? (state?.elapsedMs ?? 0) : (rs?.virtualMs ?? 0),
    total: live ? (current?.total ?? 0) : replayTotal,
    limit: current?.limit ?? null,
    lanes,
    dataset: {
      name: path.basename(dataset.stats.path),
      rows: dataset.stats.total,
      platforms: dataset.stats.platforms,
      platformList: dataset.stats.platformList,
      contentChars: dataset.stats.contentChars,
      withNewline: dataset.stats.withNewline,
      fingerprint: dataset.stats.fingerprint,
    },
    resumeAvailable: (await listRuns(RUNS_DIR)).length > 0,
  });
}

async function handleStart(req, res) {
  if (current?.running) {
    return sendJson(res, 409, { error: "已有运行在进行中，先 POST /api/stop", runId: current.runId });
  }

  let body;
  try { body = await readJsonBody(req); } catch (err) { return sendJson(res, 400, { error: err.message }); }

  const maxRows = dataset.stats.total;
  const requested = Number(body.limit);
  const limit = body.limit === undefined ? Math.min(20, maxRows) : Math.min(requested, maxRows);
  if (!Number.isInteger(limit) || limit < 1) return sendJson(res, 400, { error: "条数必须是正整数" });
  if (limit > 30 && body.confirmLargeRun !== true) return sendJson(res, 400, { error: "超过 30 条需要明确确认本次付费运行" });
  if (modelConfig.some(c => !c.apiKey)) return sendJson(res, 400, { error: "请先配置两侧 API Key" });
  const concurrency = Number(body.concurrency ?? DEFAULT_CONCURRENCY);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) return sendJson(res, 400, { error: "并发数必须为 1–10" });
  const resume = body.resume ?? CLI_RESUME;
  const runId = body.runId ?? CLI_RUN ?? undefined;
  if (resume || runId) return sendJson(res, 400, { error: "更换模型或数据后不可续写旧运行；请新建运行，旧结果可回放" });
  const rows = dataset.rows.slice(0, limit);

  let store;
  try {
    store = await RunStore.open({
      root: RUNS_DIR,
      runId,
      resume,
      manifest: {
        dataset: {
          path: dataset.stats.path,
          rows: dataset.stats.total,
          fingerprint: dataset.stats.fingerprint,
          platforms: dataset.stats.platforms,
        },
      },
    });
  } catch (err) {
    return sendJson(res, 500, { error: `创建运行目录失败：${err.message}` });
  }

  const runner = createRunner({
    rows,
    lanes: configuredLanes(modelConfig),
    concurrency,
    store,
    config: { limit, concurrency, resume: Boolean(resume) },
    // runner 自己负责把事件写进 events.jsonl（含失败记账），server 只负责广播给 SSE 客户端
    onEvent: (event) => broadcast(event),
  });

  replay = null;
  replayRunId = null;
  lastReport = null;
  current = { runner, store, runId: store.runId, running: true, startedAt: Date.now(), total: rows.length, limit };

  // 不 await：HTTP 立刻返回 runId，进度靠 SSE 推
  current.promise = runner
    .start()
    .then((report) => { if (report) lastReport = report; })
    .catch((err) => broadcast({ type: "error", message: `运行异常终止：${err.message}` }))
    .finally(async () => {
      await store.close().catch(() => {});
      current.running = false;
    });

  sendJson(res, 200, {
    runId: store.runId,
    total: rows.length,
    limit,
    concurrency,
    resume: Boolean(resume),
    lanes: laneInfo(),
  });
}

function handleStop(req, res) {
  const stopped = current?.runner.stop() ?? false;
  sendJson(res, 200, { stopped, runId: current?.runId ?? null });
}

async function reportDirectory(runId) {
  for (const root of [RUNS_DIR, path.join(ROOT, 'examples', 'demo')]) {
    const dir = path.join(root, runId);
    try { await stat(path.join(dir, 'report.json')); return dir; }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return path.join(RUNS_DIR, runId);
}

async function loadLatestReport() {
  if (lastReport) return lastReport;
  for (const runId of await listRuns(RUNS_DIR)) {
    try {
      return JSON.parse(await readFile(path.join(RUNS_DIR, runId, "report.json"), "utf8"));
    } catch { /* 该次运行没有报告，继续找 */ }
  }
  try { return JSON.parse(await readFile(path.join(ROOT, 'examples', 'demo', '0919-124001', 'report.json'), 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') throw err; return null; }
}

async function handleReport(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const requested = url.searchParams.get('runId');
  if (requested !== null && !/^\d{4}-\d{6}$/.test(requested)) return sendJson(res, 400, { error: '非法 runId' });
  const selected = requested ?? replayRunId ?? current?.runId;
  let report;
  if (selected) {
    try { report = JSON.parse(await readFile(path.join(await reportDirectory(selected), 'report.json'), 'utf8')); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  } else report = await loadLatestReport();
  if (!report) return sendJson(res, 404, { error: '这次运行还没有报告；请等待运行完成，或选择已完成的录像。' });
  const id = selected ?? report.runId;
  if (!/^\d{4}-\d{6}$/.test(id ?? '')) return sendJson(res, 422, { error: '报告缺少有效的运行编号' });
  sendJson(res, 200, await enrichReport({ ...report, runId: id }, await reportDirectory(id), dataset));
}

async function handleReportArtifact(req,res) {
  const url = new URL(req.url, 'http://localhost');
  const runId = url.searchParams.get('runId'); const lane=url.searchParams.get('lane');
  if (!/^\d{4}-\d{6}$/.test(runId ?? '') || !['jev','deepseek'].includes(lane)) return sendJson(res,400,{error:'非法运行编号或模型侧'});
  try {
    const body=await readFile(path.join(await reportDirectory(runId),`report.${lane}.html`));
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"});
    res.end(body);
  } catch(err) { if(err.code!=='ENOENT') throw err; sendJson(res,404,{error:'这次运行没有保存该侧的完整模板报告，请查看双侧对比页。'}); }
}

// ---------------------------------------------------------------------------
// 回放（只读 runs/ 下已落盘的事件；这条路径不碰 runner/backend，不会花钱）
// ---------------------------------------------------------------------------

/** 读文件尾部若干字节（run_end 总在最后一行附近，没必要整份 17MB 读进来）。 */
async function readTailText(file, maxBytes = 256 * 1024) {
  let fh;
  try {
    fh = await open(file, "r");
    const info = await fh.stat();
    const len = Math.min(info.size, maxBytes);
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, info.size - len);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** 从 events.jsonl 尾部找最后一条指定类型的事件（容忍被 kill 时的半截行）。 */
async function readLastEventOfType(file, type) {
  const lines = (await readTailText(file)).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s || !s.includes(`"${type}"`)) continue;
    try {
      const e = JSON.parse(s);
      if (e?.type === type) return e;
    } catch { /* 半截行，继续往前找 */ }
  }
  return null;
}

/** 数 events.jsonl 行数（流式，避免把 17MB 转成字符串数组）。 */
function countLines(file) {
  return new Promise((resolve) => {
    let n = 0;
    let lastByte = 10;
    const rs = createReadStream(file);
    rs.on("data", (chunk) => {
      let i = chunk.indexOf(10);
      while (i !== -1) { n++; i = chunk.indexOf(10, i + 1); }
      lastByte = chunk[chunk.length - 1];
    });
    rs.on("end", () => resolve(n + (lastByte === 10 ? 0 : 1)));
    rs.on("error", () => resolve(null));
  });
}

async function handleRuns(req, res) {
  const ids = await listRuns(RUNS_DIR);
  const runs = [];
  for (const id of ids) {
    const dir = path.join(RUNS_DIR, id);
    const eventsPath = path.join(dir, "events.jsonl");
    try {
      const info = await stat(eventsPath);
      if (!info.isFile()) continue;
    } catch {
      continue; // 没有 events.jsonl 的目录不可回放，直接不列
    }

    let manifest = null;
    try { manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")); } catch { /* 可选 */ }
    const end = await readLastEventOfType(eventsPath, "run_end");
    const lanes = (end?.lanes ?? manifest?.lanes ?? []).map((l) => ({
      id: l.id,
      label: l.label ?? l.id,
      model: l.model ?? "",
      total: Number(l.total) || 0,
      done: Number(l.done) || 0,
      failed: Number(l.failed) || 0,
      elapsedMs: Number(l.elapsedMs) || 0,
      costUsd: Number(l.costUsd) || 0,
      cps: Number(l.cps) || 0,
      tokensIn: Number(l.tokensIn) || 0,
      tokensOut: Number(l.tokensOut) || 0,
    }));
    const durationMs = Number(end?.elapsedMs) || lanes.reduce((m, l) => Math.max(m, l.elapsedMs), 0);

    runs.push({
      runId: id,
      status: manifest?.status ?? (end ? "finished" : "unknown"),
      createdAt: manifest?.createdAt ?? null,
      finishedAt: manifest?.finishedAt ?? null,
      events: await countLines(eventsPath),
      decisionCount: lanes.reduce((s, l) => s + l.done, 0),
      durationMs,
      total: Number(manifest?.config?.limit ?? manifest?.dataset?.rows) || lanes.reduce((m, l) => Math.max(m, l.total), 0),
      lanes,
      replayable: true,
    });
  }
  sendJson(res, 200, { runs });
}

async function handleReplayStart(req, res) {
  if (current?.running) {
    return sendJson(res, 409, { error: "真实对决正在进行，不能同时回放", runId: current.runId });
  }
  if (isReplaying()) {
    return sendJson(res, 409, { error: "回放已在运行，先 POST /api/replay/stop", runId: replayRunId });
  }

  let body;
  try { body = await readJsonBody(req); } catch (err) { return sendJson(res, 400, { error: err.message }); }

  const runId = String(body.runId ?? "").trim();
  // 只接受 runs/<runId> 这种形状，避免路径穿越读到别处
  if (!/^\d{4}-\d{6}$/.test(runId)) return sendJson(res, 400, { error: "runId 非法（形如 0919-124001）" });

  const runDir = path.join(RUNS_DIR, runId);
  try {
    const info = await stat(path.join(runDir, "events.jsonl"));
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    return sendJson(res, 404, { error: `run ${runId} 没有 events.jsonl，不能回放` });
  }

  const speed = clampSpeed(body.speed);
  const instance = createReplay({
    runDir,
    speed,
    // 事件形状与真跑完全一致（含 elapsedMs/cps 等原值），只多一个 replay 标记；
    // 前端因此不需要为回放改任何渲染逻辑，也能一眼区分「这是录像」。
    onEvent: (event) => broadcast({ ...event, replay: true }),
  });

  try {
    await instance.start();
  } catch (err) {
    return sendJson(res, 500, { error: `回放启动失败：${err.message}` });
  }

  replay = instance;
  replayRunId = runId;
  const st = instance.getState();
  console.log(`[replay] 开始回放 ${runId} ×${speed}：${st.total} 条事件 / ${(st.totalMs / 1000).toFixed(1)}s（只读 events.jsonl，无任何模型调用）`);
  sendJson(res, 200, { runId, speed: st.speed, total: st.total, totalMs: st.totalMs });
}

function handleReplayStop(req, res) {
  const stopped = replay?.stop() ?? false;
  const st = replay?.getState() ?? null;
  if (stopped) console.log(`[replay] 已停止 ${replayRunId}（推送到第 ${st.emitted}/${st.total} 条）`);
  sendJson(res, 200, { stopped, runId: replayRunId, speed: st?.speed ?? null, emitted: st?.emitted ?? 0 });
}

async function handleReplaySpeed(req, res) {
  if (!replay?.getState().replaying) return sendJson(res, 409, { error: "当前没有正在进行的回放" });
  let body;
  try { body = await readJsonBody(req); } catch (err) { return sendJson(res, 400, { error: err.message }); }
  const speed = replay.setSpeed(body.speed);
  const st = replay.getState();
  console.log(`[replay] 变速 ×${speed}（虚拟时间 ${(st.virtualMs / 1000).toFixed(1)}s / ${(st.totalMs / 1000).toFixed(1)}s，已推 ${st.emitted}/${st.total}）`);
  sendJson(res, 200, { runId: replayRunId, speed, replaying: st.replaying, virtualMs: st.virtualMs, emitted: st.emitted, total: st.total });
}

// ---------------------------------------------------------------------------
// 静态文件
// ---------------------------------------------------------------------------

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index.html";

  const filePath = path.join(WEB_DIR, rel);
  // 目录穿越防护：解析后的路径必须还在 web/ 里面
  if (filePath !== WEB_DIR && !filePath.startsWith(WEB_DIR + path.sep)) {
    return sendJson(res, 403, { error: "非法路径" });
  }

  let target = filePath;
  try {
    const info = await stat(target);
    if (info.isDirectory()) target = path.join(target, "index.html");
  } catch { /* 走下面的 404 分支 */ }

  try {
    const body = await readFile(target);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Length": body.length,
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    if (rel === "/index.html") {
      // 前端还没就绪时，至少让人能点到 API，不至于以为服务挂了
      const html = `<!doctype html><meta charset="utf-8"><title>jev-arena</title>
<body style="font-family:ui-monospace,monospace;background:#0b0d12;color:#d7dce5;padding:40px">
<h1>jev-arena 服务已就绪</h1>
<p>web/index.html 还不存在（前端未就绪）。可以先看接口：</p>
<ul><li><a style="color:#7dd3fc" href="/api/state">/api/state</a></li>
<li><a style="color:#7dd3fc" href="/api/stream">/api/stream</a>（SSE）</li>
<li><a style="color:#7dd3fc" href="/api/report">/api/report</a></li></ul></body>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    }
    sendJson(res, 404, { error: "文件不存在" });
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  try {
    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return sendJson(res, 403, { error: "仅允许同源请求" });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendJson(res, 415, { error: "需要 application/json" });
    }
    if (pathname === '/api/config' && req.method === 'GET') return sendJson(res, 200, { lanes: publicConfig(modelConfig) });
    if (req.method === 'POST' && ['/api/start', '/api/config', '/api/dataset', '/api/replay'].includes(pathname)) {
      if (mutationBusy) return sendJson(res, 409, { error: '另一项操作正在准备中' });
      mutationBusy = true;
      try {
        if (pathname === '/api/start') {
          if (isReplaying()) return sendJson(res, 409, { error: '回放中不能启动付费任务' });
          return await handleStart(req, res);
        }
        if (pathname === '/api/replay') return await handleReplayStart(req, res);
        if (current?.running || isReplaying()) return sendJson(res, 409, { error: '请先停止运行或回放' });
        const body = await readJsonBody(req, 16 * 1024 * 1024);
        if (pathname === '/api/config') {
          modelConfig = validateConfig(body.lanes, modelConfig);
          return sendJson(res, 200, { lanes: publicConfig(modelConfig) });
        }
        if (typeof body.name !== 'string' || typeof body.data !== 'string') throw new Error('缺少文件名或文件数据');
        const next = await datasetFromFile(Buffer.from(body.data, 'base64'), path.basename(body.name));
        dataset = next;
        current = null; replay = null; lastReport = null;
        return sendJson(res, 200, { stats: dataset.stats, preview: dataset.rows.slice(0, 3) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      } finally { mutationBusy = false; }
    }
    if (pathname === "/api/state" && req.method === "GET") return await handleState(req, res);
    // 回放进行中禁止启动真跑：一是避免实跑事件与回放事件在 SSE 上交错，
    // 二是防止录屏时误触「开始对决」真花钱。真实启动逻辑本身不感知回放。
    if (pathname === "/api/start" && req.method === "POST" && isReplaying()) {
      return sendJson(res, 409, { error: "回放进行中，已阻止启动真实对决", runId: replayRunId });
    }
    if (pathname === "/api/start" && req.method === "POST") return await handleStart(req, res);
    if (pathname === "/api/stop" && req.method === "POST") return handleStop(req, res);
    if (pathname === "/api/stream" && req.method === "GET") return handleStream(req, res);
    if (pathname === "/api/report/artifact" && req.method === "GET") return await handleReportArtifact(req,res);
    if (pathname === "/report" && req.method === "GET") return await serveStatic(req,res,"/report.html");
    if (pathname === "/api/report" && req.method === "GET") return await handleReport(req, res);
    if (pathname === "/api/runs" && req.method === "GET") return await handleRuns(req, res);
    if (pathname === "/api/replay" && req.method === "POST") return await handleReplayStart(req, res);
    if (pathname === "/api/replay/stop" && req.method === "POST") return handleReplayStop(req, res);
    if (pathname === "/api/replay/speed" && req.method === "POST") return await handleReplaySpeed(req, res);
    if (pathname.startsWith("/api/")) return sendJson(res, 404, { error: `未知接口 ${pathname}` });
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "只支持 GET/HEAD" });
    return await serveStatic(req, res, pathname);
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message ?? err) });
  }
});

dataset = await datasetFromFile(await readFile(DATA_PATH), DATA_PATH);
console.log(`数据集：${dataset.stats.total} 条，指纹 ${dataset.stats.fingerprint}，平台 ${dataset.stats.platformList.map((p) => `${p.platform}=${p.count}`).join(" ")}`);
if (CLI_RESUME) console.log("已开启 --resume：/api/start 会复用最近一次运行目录，跳过已完成与已失败的评论");

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  jev-arena 对决场已启动");
  console.log(`  页面    http://localhost:${PORT}/`);
  console.log(`  状态    http://localhost:${PORT}/api/state`);
  console.log(`  事件流  http://localhost:${PORT}/api/stream`);
  console.log("");
  console.log(`  启动一轮：curl -X POST http://localhost:${PORT}/api/start -H 'content-type: application/json' -d '{"limit":20,"concurrency":3}'`);
  console.log(`  录像列表：http://localhost:${PORT}/api/runs`);
  console.log(`  录屏回放：http://localhost:${PORT}/?replay=0919-124001&speed=20&autoplay=1`);
  console.log("");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n收到 ${signal}，停止运行并落盘…`);
    try { current?.runner.stop(); } catch { /* ignore */ }
    try { replay?.stop(); } catch { /* ignore */ }
    server.close();
    // 给在途的 appendEvent/fsync 一点时间；超时就直接退
    setTimeout(() => process.exit(0), 1200).unref();
  });
}
