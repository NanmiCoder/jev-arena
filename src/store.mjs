/**
 * 运行目录管理：runs/<runId>/{manifest.json, events.jsonl, labels.<lane>.jsonl, report.json}
 *
 * 设计要点（都是演示场景逼出来的）：
 *  - **每条写完必须 fsync**：视频录制中途可能被 Ctrl-C 掐掉，只有落盘的行才算数，
 *    否则 resume 时「已完成」集合会和实际不符，重复付费。
 *  - 追加写而不是全量重写：1 万条 × 2 道，重写会 O(n²)。
 *  - 每个文件一条 Promise 串行链，避免并发写入把两行 JSON 交错在一起。
 *  - 读侧容忍坏行（进程被 kill 时最后一行可能只写了一半），跳过而不是抛异常。
 */

import { mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** runId 形如 0919-121530（月日-时分秒，本地时区）。 */
export function makeRunId(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

const RUN_ID_RE = /^\d{4}-\d{6}$/;

/** 列出 runs/ 下的运行目录，新的在前。 */
export async function listRuns(root = "runs") {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

async function findLatestRun(root) {
  const runs = await listRuns(root);
  return runs[0];
}

/** 逐行解析 JSONL，坏行直接跳过（中断时最后一行可能不完整）。 */
function parseJsonl(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* 半截行，忽略 */ }
  }
  return out;
}

export class RunStore {
  #root;
  #dir;
  #runId;
  #handles = new Map(); // file → Promise<FileHandle>，缓存 Promise 防止并发重复 open
  #queues = new Map();  // file → Promise，串行化「写 + fsync」
  #manifest = null;
  #closed = false;

  constructor({ root, dir, runId }) {
    this.#root = root;
    this.#dir = dir;
    this.#runId = runId;
  }

  /**
   * @param {{root?:string, runId?:string, resume?:boolean, manifest?:object}} opts
   *   runId 显式指定 → 用该目录；resume=true 且没给 runId → 复用最近一次运行目录。
   */
  static async open({ root = "runs", runId, resume = false, manifest = {} } = {}) {
    await mkdir(root, { recursive: true });
    let id = runId;
    if (!id && resume) id = await findLatestRun(root);
    let resumed = Boolean(id);
    if (!id) { id = makeRunId(); resumed = false; }
    if (!RUN_ID_RE.test(id)) throw new Error("非法 runId");
    if (!resumed) {
      const existing = new Set(await listRuns(root));
      let offset = 0;
      while (existing.has(id)) id = makeRunId(new Date(Date.now() + ++offset * 1000));
    }
    const dir = path.join(root, id);
    await mkdir(dir, { recursive: true });

    const store = new RunStore({ root, dir, runId: id });
    await store.#initManifest({ ...manifest, runId: id, resumeRequested: resumed });
    return store;
  }

  get runId() { return this.#runId; }
  get dir() { return this.#dir; }

  pathFor(name) { return path.join(this.#dir, name); }

  async #initManifest(seed) {
    let existing = null;
    try { existing = JSON.parse(await readFile(this.pathFor("manifest.json"), "utf8")); } catch { /* 新建 */ }
    this.#manifest = {
      ...(existing ?? {}),
      ...seed,
      runId: this.#runId,
      // 以磁盘上是否已有 manifest 为准：命令行 --resume 但目录是新建的，不算续跑
      resumed: Boolean(existing),
      updatedAt: new Date().toISOString(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    await this.#writeManifest();
  }

  // --- 写入 ---------------------------------------------------------------

  async #handle(file) {
    if (!this.#handles.has(file)) {
      const promise = open(this.pathFor(file), "a");
      this.#handles.set(file, promise);
      // open 失败就别把坏 Promise 留在缓存里
      promise.catch(() => this.#handles.delete(file));
    }
    return this.#handles.get(file);
  }

  async #writeNow(file, line) {
    try {
      const fh = await this.#handle(file);
      await fh.write(line, null, "utf8");
      await fh.sync(); // 关键：没有 fsync，掉电/被 kill 时这行可能还在页缓存里
      return;
    } catch (err) {
      // 句柄可能已经坏了，丢掉缓存让下次重新 open
      const cached = this.#handles.get(file);
      this.#handles.delete(file);
      if (cached) cached.then((fh) => fh.close().catch(() => {})).catch(() => {});
      throw err;
    }
  }

  /** 追加一行 JSON 并落盘。同一文件上的调用串行执行，保证不交错。 */
  #append(file, obj) {
    const line = `${JSON.stringify(obj)}\n`;
    const prev = this.#queues.get(file) ?? Promise.resolve();
    const task = prev.then(() => this.#writeNow(file, line));
    this.#queues.set(file, task.catch(() => {})); // 链上吞错，错误仍抛给调用方
    return task;
  }

  appendEvent(event) {
    // 加 t 便于回放时按墙钟排序；契约字段原样保留，前端忽略多余字段即可
    return this.#append("events.jsonl", { ...event, t: Date.now() });
  }

  appendLabel(lane, label) {
    return this.#append(`labels.${lane}.jsonl`, label);
  }

  // --- 读取 ---------------------------------------------------------------

  async readLabels(lane) {
    try {
      return parseJsonl(await readFile(this.pathFor(`labels.${lane}.jsonl`), "utf8"));
    } catch (err) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
  }

  async readEvents() {
    try {
      return parseJsonl(await readFile(this.pathFor("events.jsonl"), "utf8"));
    } catch (err) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
  }

  /**
   * 断点续跑用：返回该道「已经不需要再跑」的 comment_id 集合。
   * 成功记录在 labels.<lane>.jsonl，失败记在 events.jsonl 的 decision.ok=false 里 ——
   * 失败也要跳过，因为同一批输入确定性失败过就不再重复付费。
   */
  async readProgress(lane) {
    const [labels, events] = await Promise.all([this.readLabels(lane), this.readEvents()]);
    const decided = new Set();
    let costUsd = 0;
    let tokensIn = 0;
    let tokensOut = 0;

    for (const label of labels) {
      const id = String(label?.comment_id ?? "");
      if (id) decided.add(id);
      costUsd += Number(label?.meta?.costUsd) || 0;
      tokensIn += Number(label?.meta?.tokensIn) || 0;
      tokensOut += Number(label?.meta?.tokensOut) || 0;
    }

    let failed = 0;
    for (const evt of events) {
      if (evt?.type !== "decision" || evt?.lane !== lane || evt?.ok !== false) continue;
      const id = String(evt.commentId ?? "");
      if (id && !decided.has(id)) { decided.add(id); failed++; }
    }

    return { decided, ok: labels.length, failed, costUsd, tokensIn, tokensOut };
  }

  // --- manifest / report --------------------------------------------------

  get manifest() { return this.#manifest; }

  async updateManifest(patch) {
    this.#manifest = { ...this.#manifest, ...patch, updatedAt: new Date().toISOString() };
    await this.#writeManifest();
    return this.#manifest;
  }

  async #writeManifest() {
    await this.#writeAtomic("manifest.json", JSON.stringify(this.#manifest, null, 2));
  }

  async saveReport(report) {
    await this.#writeAtomic("report.json", JSON.stringify(report, null, 2));
    await this.updateManifest({ reportAt: new Date().toISOString() });
  }

  /** 原子写：先写 .tmp 再 rename，避免报告/log 被读到半截。 */
  async #writeAtomic(name, text) {
    const file = this.pathFor(name);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, text, "utf8");
    await rename(tmp, file);
  }

  // --- 收尾 ---------------------------------------------------------------

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#queues.values()]);
    const handles = [...this.#handles.values()];
    this.#handles.clear();
    this.#queues.clear();
    await Promise.allSettled(handles.map(async (p) => {
      const fh = await p;
      await fh.close();
    }));
  }
}
