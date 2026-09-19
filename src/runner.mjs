/**
 * 对决调度器：两条道并行跑，各自独立并发、独立进度、独立账单。
 *
 * 失败处理策略（演示时最怕整轮挂掉）：
 *  - 单批失败：如果错误标了可重试/可分割（STATE_TOO_LARGE、坏 JSON、429 打满、网络抖动），
 *    把批次对半切开塞回队列，直到单条；
 *  - 单条还失败：记账跳过（decision.ok=false），继续跑后面的；
 *  - 同一批输入确定性失败过一次就不再重复付费（failedKeys 记忆）；
 *  - 连续 3 次「确定性失败」（如 401/400）判定该道整体不可用，停该道并广播 error，
 *    避免把 1 万条全部烧成失败记录。
 *
 * 事件节流：decision 每条都推（前端实时滚动靠它），lane_stats ≥200ms 一次。
 */

import * as jevBackend from "./backends/jev.mjs";
import * as deepseekBackend from "./backends/deepseek.mjs";

const DEFAULT_LANES = [
  { id: "jev", label: "Jev", backend: jevBackend },
  { id: "deepseek", label: "DeepSeek Flash", backend: deepseekBackend },
];

/** 对外暴露的道信息（不含 backend 实例，方便前端/报告直接序列化）。 */
export const LANES = DEFAULT_LANES.map(({ id, label, backend }) => ({ id, label, model: backend.modelId }));

/** 报告里最多保留多少条左右对照样本，避免 report.json 变成几十 MB。 */
const SAMPLE_LIMIT = 100;

export function createRunner({
  rows,
  concurrency = 3,
  store,
  onEvent = () => {},
  context = {},
  config = {},
  lanes = DEFAULT_LANES,
  statsIntervalMs = 200,
} = {}) {
  if (!Array.isArray(rows)) throw new TypeError("rows 必须是数组");
  if (!store) throw new TypeError("store 必填：结果要落盘才能断点续跑");

  const laneDefs = lanes.map((def) => ({
    id: def.id,
    label: def.label ?? def.id,
    model: def.model ?? def.backend?.modelId ?? "unknown",
    maxBatchSize: Math.max(1, Number(def.backend?.maxBatchSize) || 10),
    backend: def.backend,
  }));
  for (const def of laneDefs) {
    if (!def.backend?.labelBatch) throw new TypeError(`道 ${def.id} 的 backend 缺少 labelBatch()`);
  }

  const rowById = new Map(rows.map((r) => [String(r.comment_id), r]));
  const indexById = new Map(rows.map((r, i) => [String(r.comment_id), i]));

  const concurrencyFor = (laneId) => {
    const raw = typeof concurrency === "number" ? concurrency : concurrency?.[laneId] ?? concurrency?.default ?? 3;
    return Math.max(1, Math.floor(Number(raw) || 1));
  };

  const laneStates = new Map(laneDefs.map((def) => [def.id, {
    def,
    total: rows.length,
    done: 0,
    failed: 0,
    resumed: 0,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    reasoningTokens: 0,
    latencies: [],
    startedAt: 0,
    finishedAt: 0,
    lastStatsAt: 0,
    consecutiveFatal: 0,
    aborted: false,
  }]));

  let running = false;
  let stopped = false;
  let startedAtMs = 0;
  let finishedAtMs = 0;
  let lastReport = null;

  /** 确定性失败记忆，key = lane:comment_ids。命中了就直接记账，不再打 API。 */
  const failedKeys = new Set();
  const aborters = new Map();

  /** 只广播，不落盘。落盘失败时的告警走这里，避免递归。 */
  const publish = (event) => {
    try { onEvent(event); } catch { /* 监听方抛错不能拖垮调度 */ }
  };
  /**
   * 广播 + 落盘。events.jsonl 必须由 runner 自己写：decision.ok=false 是「已记账失败」的
   * 唯一凭证，resume 靠它跳过确定性失败的评论；如果指望调用方（server）代为落盘，
   * 单独用 runner 的场景（probe/离线跑）就会重复付费。
   */
  const emit = (event) => {
    store.appendEvent(event).catch((err) => publish({ type: "error", message: `事件落盘失败：${err.message}` }));
    publish(event);
  };
  const round8 = (v) => Number((Number(v) || 0).toFixed(8));
  const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
  const percentile = (list, p) => {
    if (!list.length) return 0;
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  };
  const previewOf = (content, max = 80) => {
    const text = String(content ?? "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  const errorText = (err) => {
    const code = err?.code ? `[${err.code}] ` : "";
    return `${code}${String(err?.message ?? err)}`.slice(0, 300);
  };

  function emitLaneStats(state, force = false) {
    const now = Date.now();
    if (!force && now - state.lastStatsAt < statsIntervalMs) return;
    state.lastStatsAt = now;
    const elapsedMs = (state.finishedAt || now) - (state.startedAt || now);
    emit({
      type: "lane_stats",
      lane: state.def.id,
      done: state.done,
      failed: state.failed,
      elapsedMs,
      costUsd: round8(state.costUsd),
      tokensIn: Math.round(state.tokensIn),
      tokensOut: Math.round(state.tokensOut),
      cps: elapsedMs > 0 ? Number((state.done / (elapsedMs / 1000)).toFixed(2)) : 0,
      remaining: Math.max(0, state.total - state.done - state.failed),
    });
  }

  function recordFailure(state, batch, err) {
    const message = errorText(err);
    for (const row of batch) {
      const id = String(row.comment_id);
      state.failed++;
      emit({
        type: "decision",
        lane: state.def.id,
        index: indexById.get(id) ?? -1,
        commentId: id,
        ms: 0,
        ok: false,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        label: null,
        preview: previewOf(row.content),
        error: message,
      });
    }
    emitLaneStats(state);
  }

  function summaryOf(state) {
    const elapsedMs = (state.finishedAt || Date.now()) - (state.startedAt || startedAtMs);
    return {
      id: state.def.id,
      label: state.def.label,
      model: state.def.model,
      total: state.total,
      done: state.done,
      failed: state.failed,
      resumed: state.resumed,
      elapsedMs,
      costUsd: round8(state.costUsd),
      tokensIn: Math.round(state.tokensIn),
      tokensOut: Math.round(state.tokensOut),
      reasoningTokens: Math.round(state.reasoningTokens),
      cps: elapsedMs > 0 ? Number((state.done / (elapsedMs / 1000)).toFixed(2)) : 0,
      avgMs: Math.round(mean(state.latencies)),
      p95Ms: Math.round(percentile(state.latencies, 0.95)),
    };
  }

  /** 一批评不完就二分。切开的半批塞回队列尾部，别的 worker 也能接手。 */
  async function processBatch(state, batch, queue, signal) {
    if (stopped || state.aborted || batch.length === 0) return;

    const key = `${state.def.id}:${batch.map((r) => String(r.comment_id)).join("|")}`;
    if (failedKeys.has(key)) {
      recordFailure(state, batch, new Error("该批次此前已确定性失败，跳过（不重复付费）"));
      return;
    }

    const t0 = Date.now();
    let result;
    try {
      result = await state.def.backend.labelBatch(batch, { ...context, signal, runId: store.runId });
    } catch (err) {
      if (stopped || err?.code === "ABORTED") return;
      const splittable = err?.splittable ?? err?.retryable ?? true;
      if (splittable && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        queue.push(batch.slice(0, mid), batch.slice(mid));
        return;
      }
      failedKeys.add(key);
      if (err?.retryable === false && err?.splittable !== true) state.consecutiveFatal++;
      else state.consecutiveFatal = 0;
      recordFailure(state, batch, err);
      if (state.consecutiveFatal >= 3) {
        state.aborted = true;
        emit({
          type: "error",
          lane: state.def.id,
          message: `连续 ${state.consecutiveFatal} 批确定性失败，已停止该道：${errorText(err)}`,
        });
      }
      return;
    }

    const labels = Array.isArray(result?.labels) ? result.labels : [];
    const usage = result?.usage ?? {};
    const ms = Number(result?.ms) || Date.now() - t0;
    const n = Math.max(1, labels.length);
    const byId = new Map(labels.map((label) => [String(label?.comment_id ?? ""), label]));

    state.consecutiveFatal = 0;
    state.costUsd += Number(usage.costUsd) || 0;
    state.tokensIn += Number(usage.inputTokens) || 0;
    state.tokensOut += Number(usage.outputTokens) || 0;
    state.reasoningTokens += Number(usage.reasoningTokens) || 0;

    const share = {
      costUsd: (Number(usage.costUsd) || 0) / n,
      tokensIn: (Number(usage.inputTokens) || 0) / n,
      tokensOut: (Number(usage.outputTokens) || 0) / n,
    };

    for (const row of batch) {
      const id = String(row.comment_id);
      const label = byId.get(id);
      if (!label) {
        recordFailure(state, [row], new Error("本次响应里缺少这条评论的标签"));
        continue;
      }
      state.done++;
      state.latencies.push(ms);

      // 先落盘再广播：前端看到 done 时，数据一定已经在磁盘上（断点续跑靠这个）
      try {
        await store.appendLabel(state.def.id, label);
      } catch (err) {
        emit({ type: "error", lane: state.def.id, message: `标签落盘失败（${id}）：${err.message}` });
      }

      emit({
        type: "decision",
        lane: state.def.id,
        index: indexById.get(id) ?? -1,
        commentId: id,
        ms,
        ok: true,
        costUsd: round8(share.costUsd),
        tokensIn: Math.round(share.tokensIn),
        tokensOut: Math.round(share.tokensOut),
        label,
        preview: previewOf(row.content),
      });
      emitLaneStats(state);
    }
  }

  async function runLane(state) {
    const def = state.def;
    const controller = new AbortController();
    aborters.set(def.id, controller);
    state.startedAt = Date.now();

    // 断点续跑：成功（labels 文件）+ 已记账失败（events 里的 decision.ok=false）都不再重跑
    let progress = { decided: new Set(), ok: 0, failed: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 };
    try {
      progress = await store.readProgress(def.id);
    } catch (err) {
      emit({ type: "error", lane: def.id, message: `读取断点失败，将全量重跑：${err.message}` });
    }
    state.done = progress.ok;
    state.failed = progress.failed;
    state.resumed = progress.ok + progress.failed;
    state.costUsd = progress.costUsd;
    state.tokensIn = progress.tokensIn;
    state.tokensOut = progress.tokensOut;
    emitLaneStats(state, true);

    const pending = rows.filter((row) => !progress.decided.has(String(row.comment_id)));
    const queue = [];
    for (let i = 0; i < pending.length; i += def.maxBatchSize) {
      queue.push(pending.slice(i, i + def.maxBatchSize));
    }

    let cursor = 0;
    const worker = async () => {
      while (!stopped && !state.aborted) {
        if (cursor >= queue.length) break;
        const batch = queue[cursor++]; // 同步摘取，两个 worker 不会拿到同一批
        await processBatch(state, batch, queue, controller.signal);
      }
    };

    try {
      // 二分会把半批 push 回队列。极端情况下 worker 看到队列空先退出，所以外层再兜一圈：
      // 只要还有未消费的批次（cursor < queue.length）就再开一轮 worker。
      let rounds = 0;
      while (!stopped && !state.aborted && cursor < queue.length && rounds < 32) {
        rounds++;
        await Promise.all(Array.from({ length: concurrencyFor(def.id) }, worker));
      }
    } catch (err) {
      emit({ type: "error", lane: def.id, message: `该道异常终止：${errorText(err)}` });
    } finally {
      state.finishedAt = Date.now();
      emitLaneStats(state, true);
    }
  }

  // --- 报告 ---------------------------------------------------------------

  const jaccard = (a = [], b = []) => {
    const A = new Set(a);
    const B = new Set(b);
    if (A.size === 0 && B.size === 0) return 1;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    const union = A.size + B.size - inter;
    return union === 0 ? 1 : inter / union;
  };
  const rate = (pairs, fn) => (pairs.length ? Number((pairs.filter(fn).length / pairs.length).toFixed(4)) : 0);

  /** 报告里不要把 meta.raw（概率明细）带进去，否则体积翻好几倍。 */
  function compactLabel(label) {
    const meta = label?.meta ?? {};
    return {
      ...label,
      meta: {
        backend: meta.backend,
        evidenceSource: meta.evidenceSource,
        quoteVerified: meta.quoteVerified,
        costUsd: meta.costUsd,
        tokensIn: meta.tokensIn,
        tokensOut: meta.tokensOut,
        latencyMs: meta.latencyMs,
        warnings: meta.warnings,
        normalized: meta.normalized,
      },
    };
  }

  async function buildReport(summaries) {
    const [jevLabels, deepseekLabels] = await Promise.all([
      store.readLabels("jev"),
      store.readLabels("deepseek"),
    ]);
    const dsById = new Map(deepseekLabels.map((l) => [String(l.comment_id), l]));
    const pairs = [];
    for (const jl of jevLabels) {
      const dl = dsById.get(String(jl.comment_id));
      if (dl) pairs.push([jl, dl]);
    }

    const withQuote = (labels) => labels.filter((l) => l.evidence_quote).length;

    const comparison = {
      paired: pairs.length,
      relevanceAgreement: rate(pairs, ([a, b]) => a.is_relevant === b.is_relevant),
      sentimentAgreement: rate(pairs, ([a, b]) => a.sentiment === b.sentiment),
      intentAgreement: rate(pairs, ([a, b]) => a.intent === b.intent),
      meanAbsScoreDiff: pairs.length
        ? Number(mean(pairs.map(([a, b]) => Math.abs(Number(a.sentiment_score) - Number(b.sentiment_score)))).toFixed(4))
        : 0,
      meanAspectJaccard: pairs.length
        ? Number(mean(pairs.map(([a, b]) => jaccard(a.aspects, b.aspects))).toFixed(4))
        : 0,
      meanEmotionJaccard: pairs.length
        ? Number(mean(pairs.map(([a, b]) => jaccard(a.emotion, b.emotion))).toFixed(4))
        : 0,
      evidenceQuotePresent: { jev: withQuote(jevLabels), deepseek: withQuote(deepseekLabels) },
    };

    const samples = pairs.slice(0, SAMPLE_LIMIT).map(([jl, dl]) => {
      const row = rowById.get(String(jl.comment_id)) ?? {};
      return {
        comment_id: String(jl.comment_id),
        platform: row.platform ?? null,
        like_count: row.like_count ?? null,
        topic_title: row.topic_title ?? null,
        content: previewOf(row.content, 220),
        jev: compactLabel(jl),
        deepseek: compactLabel(dl),
      };
    });

    return {
      runId: store.runId,
      generatedAt: new Date().toISOString(),
      startedAt: startedAtMs ? new Date(startedAtMs).toISOString() : null,
      finishedAt: finishedAtMs ? new Date(finishedAtMs).toISOString() : null,
      elapsedMs: finishedAtMs - startedAtMs,
      stopped,
      dataset: {
        total: rows.length,
        fingerprint: store.manifest?.dataset?.fingerprint ?? null,
        platforms: store.manifest?.dataset?.platforms ?? null,
      },
      lanes: summaries,
      comparison,
      samples,
      notes: [
        "引文来源见每条 meta.evidenceSource：host 为宿主机械摘取，model 为模型摘取。",
        "费用来源见 meta.costSource；unknown 表示未设置单价，汇总中的 0 不代表免费。",
        "所有金额单位为美元。",
      ],
    };
  }

  // --- 对外接口 -----------------------------------------------------------

  async function start() {
    if (running) throw new Error("runner 已经在运行");
    running = true;
    stopped = false;
    startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();

    try {
      await store.updateManifest({
        status: "running",
        startedAt,
        lanes: laneDefs.map((d) => ({ id: d.id, label: d.label, model: d.model })),
        config: {
          ...config,
          rows: rows.length,
          concurrency: Object.fromEntries(laneDefs.map((d) => [d.id, concurrencyFor(d.id)])),
        },
      }).catch((err) => emit({ type: "error", message: `manifest 写入失败：${err.message}` }));

      emit({ type: "run_start", runId: store.runId, total: rows.length, lanes: laneDefs.map(({ id, label, model }) => ({ id, label, model })), startedAt });

      await Promise.all(laneDefs.map((def) => runLane(laneStates.get(def.id))));

      finishedAtMs = Date.now();
      const summaries = laneDefs.map((def) => summaryOf(laneStates.get(def.id)));
      lastReport = await buildReport(summaries).catch((err) => ({
        runId: store.runId,
        error: `报告生成失败：${err.message}`,
        lanes: summaries,
      }));
      if (lastReport && !lastReport.error) {
        await store.saveReport(lastReport).catch((err) => emit({ type: "error", message: `报告落盘失败：${err.message}` }));
      }
      await store.updateManifest({
        status: stopped ? "stopped" : "finished",
        finishedAt: new Date(finishedAtMs).toISOString(),
        lanes: summaries,
      }).catch(() => {});

      emit({ type: "run_end", runId: store.runId, lanes: summaries, stopped, elapsedMs: finishedAtMs - startedAtMs });
      return lastReport;
    } finally {
      running = false;
    }
  }

  /** 立刻停：中断在途请求、丢掉未跑的队列；已经 appendLabel + fsync 的结果保留。 */
  function stop() {
    if (!running) return false;
    stopped = true;
    for (const controller of aborters.values()) controller.abort();
    return true;
  }

  function getState() {
    return {
      running,
      stopped,
      runId: store.runId,
      total: rows.length,
      startedAt: startedAtMs ? new Date(startedAtMs).toISOString() : null,
      elapsedMs: startedAtMs ? (finishedAtMs || Date.now()) - startedAtMs : 0,
      lanes: laneDefs.map((def) => summaryOf(laneStates.get(def.id))),
    };
  }

  return { start, stop, getState };
}
