/**
 * 回放器（replay）：把已经落盘的 runs/<runId>/events.jsonl 按原始节奏重新推一遍，
 * 供录屏时「从第一条评论开始、左右两道同时启动地」重播。
 *
 * 硬约束（录屏场景的底线，改这个文件时请保持）：
 *   本文件只做**文件读取 + 定时器调度**，不 import 任何模型后端 / 任务调度 /
 *   网络模块，回放全程绝不会发起模型 API 调用。数据源只有 events.jsonl。
 *
 * 为什么按 t 排序：
 *   events.jsonl 是两道并发追加写的，落盘顺序 ≠ 事件发生顺序（同一毫秒内两道
 *   交替写入）。t 是 epoch 毫秒（见 store.appendEvent 的 Date.now()），只有按 t
 *   做稳定排序，回放才能重现「左道 203 秒跑完、右道还在慢慢爬」的真实时间关系。
 *
 * 为什么变速要记「虚拟时间」：
 *   回放时钟不是墙钟，而是「原run 时间轴上的位置」。setSpeed 时先用旧速度把当前
 *   虚拟位置结算出来（anchorVirtual + 墙钟差 × 旧速度），再以新速度从这个位置继续；
 *   事件游标 cursor 只增不减，所以中途变速既不丢事件也不重复推。
 *
 * 内存：2 万条事件约 17MB，一次性 JSON.parse 成对象数组（~几十 MB），换来播放
 * 循环里零 JSON.parse。对本地录屏场景完全够用。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const MAX_BATCH = 2000;   // 单个定时器回合最多推多少条：100× 时也不长时间占住事件循环
const MAX_TICK_MS = 250;  // 定时器最长睡 250ms：保证 getState()/变速时虚拟时间足够新鲜
const MIN_SPEED = 0.1;
const MAX_SPEED = 1000;

/** 倍速合法化：非法值一律退回 1×，并夹在 [0.1, 1000]。 */
export function clampSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, n));
}

/** 逐行解析 JSONL；坏行（进程被 kill 时的半截行）跳过而不是抛错。 */
function parseJsonl(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 半截行忽略 */ }
  }
  return out;
}

/**
 * 读 events.jsonl → 预解析 + 按 t 稳定排序。
 * @returns {{events:object[], minT:number, totalMs:number}}
 */
async function loadEvents(runDir) {
  const text = await readFile(path.join(runDir, "events.jsonl"), "utf8");
  const events = parseJsonl(text);

  // t 缺失（理论上不该发生）的事件按写入顺序继承上一条的 t，避免它们扎堆到 0
  let last = null;
  for (const e of events) {
    const t = Number(e.t);
    if (Number.isFinite(t)) { e.t = t; last = t; }
    else e.t = last; // last 为 null 时下面统一补
  }

  let minT = Infinity;
  let maxT = -Infinity;
  for (const e of events) {
    if (!Number.isFinite(e.t)) continue;
    if (e.t < minT) minT = e.t;
    if (e.t > maxT) maxT = e.t;
  }
  if (!Number.isFinite(minT)) { minT = 0; maxT = 0; }
  for (const e of events) if (!Number.isFinite(e.t)) e.t = minT;

  // Array#sort 自 Node 11 起是稳定排序：同一 t 的事件保持落盘先后，不会左右横跳
  events.sort((a, b) => a.t - b.t);
  return { events, minT, totalMs: Math.max(0, maxT - minT) };
}

/**
 * @param {{runDir:string, speed?:number, onEvent?:(e:object)=>void}} opts
 * @returns {{start:()=>Promise<object>, stop:()=>boolean, setSpeed:(n:number)=>number, getState:()=>object}}
 */
export function createReplay({ runDir, speed = 1, onEvent = () => {} }) {
  let events = [];
  let runId = path.basename(runDir);
  let minT = 0;
  let totalMs = 0;

  let cursor = 0;              // 已推送到 events 的下标（只增不减 → 不丢不重）
  let virtualMs = 0;           // 已播放到的虚拟时间（相对 minT）
  let curSpeed = clampSpeed(speed);
  let anchorWall = 0;          // 虚拟时间锚点对应的墙钟
  let anchorVirtual = 0;       // 锚点处的虚拟时间
  let timer = null;
  let replaying = false;

  /** laneId -> 该道累计状态（从事件里重算，用于 /api/state 与回放进度） */
  let lanes = new Map();

  const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

  /** 当前虚拟时间：锚点 + 真实流逝墙钟 × 倍速。 */
  function currentVirtual() {
    if (!replaying) return virtualMs;
    const v = anchorVirtual + (Date.now() - anchorWall) * curSpeed;
    return Math.min(totalMs, Math.max(0, v));
  }

  function ensureLane(id, def = {}) {
    let lane = lanes.get(id);
    if (!lane) {
      lane = {
        id, label: def.label ?? id, model: def.model ?? "",
        total: num(def.total), done: 0, failed: 0, elapsedMs: 0,
        costUsd: 0, tokensIn: 0, tokensOut: 0, cps: 0, remaining: num(def.total),
      };
      lanes.set(id, lane);
    }
    return lane;
  }

  /** 把事件合并进 lane 汇总（只影响 getState，不改变推出去的事件本身）。 */
  function applyEvent(e) {
    if (!e || typeof e !== "object") return;
    if (e.type === "run_start") {
      lanes = new Map();
      for (const def of e.lanes ?? []) {
        if (!def?.id) continue;
        ensureLane(def.id, { label: def.label, model: def.model, total: num(e.total) });
      }
      return;
    }
    if (e.type === "decision") {
      const lane = ensureLane(e.lane);
      if (e.ok === false) lane.failed += 1;
      else lane.done += 1;
      lane.costUsd += num(e.costUsd);
      lane.tokensIn += num(e.tokensIn);
      lane.tokensOut += num(e.tokensOut);
      lane.remaining = Math.max(0, num(lane.total) - lane.done - lane.failed);
      return;
    }
    if (e.type === "lane_stats") {
      const lane = ensureLane(e.lane);
      for (const k of ["done", "failed", "elapsedMs", "costUsd", "tokensIn", "tokensOut", "cps", "remaining"]) {
        if (e[k] !== undefined) lane[k] = num(e[k], lane[k]);
      }
      return;
    }
    if (e.type === "run_end") {
      for (const s of e.lanes ?? []) {
        if (!s?.id) continue;
        const lane = ensureLane(s.id, s);
        for (const k of ["label", "model", "total", "done", "failed", "elapsedMs", "costUsd", "tokensIn", "tokensOut", "cps"]) {
          if (s[k] !== undefined) lane[k] = s[k];
        }
        lane.remaining = Math.max(0, num(lane.total) - num(lane.done) - num(lane.failed));
      }
    }
  }

  function schedule() {
    if (!replaying) return;
    if (timer) { clearTimeout(timer); timer = null; }
    if (cursor >= events.length) { finish(); return; }
    const due = events[cursor].t - minT;
    const wait = Math.max(0, (due - currentVirtual()) / curSpeed);
    timer = setTimeout(onTimer, Math.min(wait, MAX_TICK_MS));
  }

  function finish() {
    virtualMs = totalMs;
    anchorVirtual = totalMs;
    anchorWall = Date.now();
    replaying = false;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function onTimer() {
    timer = null;
    if (!replaying) return;

    // 把「虚拟时间已到期」的事件按序全部推出去；超大突发时分批让出事件循环
    let n = 0;
    const nowV = currentVirtual();
    while (cursor < events.length && events[cursor].t - minT <= nowV) {
      const e = events[cursor];
      applyEvent(e);
      try { onEvent(e); } catch { /* 单个监听器异常不能中断整场回放 */ }
      cursor += 1;
      if (++n >= MAX_BATCH) break;
    }

    if (cursor >= events.length) { finish(); return; }
    if (n >= MAX_BATCH) {
      // 还有大量到期事件没推完：立刻续一回合，不按虚拟时间等待
      timer = setTimeout(onTimer, 0);
      return;
    }
    schedule();
  }

  /** 开始回放：每次 start 都重新读盘，保证用的是最新的 events.jsonl。 */
  async function start() {
    if (replaying) throw new Error("回放已在进行中");
    const loaded = await loadEvents(runDir);
    if (!loaded.events.length) throw new Error("events.jsonl 里没有可回放的事件");

    events = loaded.events;
    minT = loaded.minT;
    totalMs = loaded.totalMs;
    const startEv = events.find((e) => e?.type === "run_start");
    runId = startEv?.runId || path.basename(runDir);

    lanes = new Map();
    for (const def of startEv?.lanes ?? []) {
      if (def?.id) ensureLane(def.id, { label: def.label, model: def.model, total: num(startEv.total) });
    }

    cursor = 0;
    virtualMs = 0;
    anchorVirtual = 0;
    anchorWall = Date.now();
    replaying = true;
    schedule();
    return getState();
  }

  /** 立即停止（冻结在当前虚拟位置；不回退、不补发 run_end）。 */
  function stop() {
    if (!replaying) {
      if (timer) { clearTimeout(timer); timer = null; }
      return false;
    }
    virtualMs = currentVirtual();     // 先按旧速度结算，再冻结
    anchorVirtual = virtualMs;
    anchorWall = Date.now();
    replaying = false;
    if (timer) { clearTimeout(timer); timer = null; }
    return true;
  }

  /** 中途变速：结算旧速度 → 换挡 → 重新调度，事件游标不动。 */
  function setSpeed(n) {
    virtualMs = currentVirtual();
    anchorVirtual = virtualMs;
    anchorWall = Date.now();
    curSpeed = clampSpeed(n);
    if (replaying) schedule();
    return curSpeed;
  }

  function getState() {
    return {
      replaying,
      finished: events.length > 0 && cursor >= events.length,
      runId,
      speed: curSpeed,
      virtualMs: Math.round(replaying ? currentVirtual() : virtualMs),
      totalMs: Math.round(totalMs),
      emitted: cursor,
      total: events.length,
      lanes: Object.fromEntries([...lanes].map(([id, lane]) => [id, { ...lane }])),
    };
  }

  return { start, stop, setSpeed, getState };
}
