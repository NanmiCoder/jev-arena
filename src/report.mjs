/**
 * 对比报告：把 runs/<runId>/ 下的原始 JSONL 变成「时间 / 金钱 / 速度 / 效果」四个维度的结构化对比。
 *
 * 设计原则（视频里要拿它当证据，所以每一条都不能含糊）：
 *  1. **所有数字都从磁盘原始记录复算**：labels.<lane>.jsonl（逐条标签与 meta）、
 *     events.jsonl（逐条 decision 的 ok / 时间戳 / 费用）、manifest.json（数据集指纹、起止时间）。
 *     本模块不做任何抽样、不算任何「估计值」（唯一例外：延迟是批次延迟，会明确标注口径）。
 *  2. **任何比例必须带分母**：两道成功条数可能不同（失败/中途停止），绝不允许拿两个不同分母的比例直接比。
 *     所有对比都在「两道都成功的配对集（paired）」上做，并把覆盖率对账表摆在最前面。
 *  3. **费用口径分两套，必须写明**：Jev 是 OpenRouter 返回的真实账单（meta.costSource="openrouter-usage"），
 *     DeepSeek 是按官方单价本地算的（meta.costSource="local-pricing"），并且要写出命中的是 peak 还是 off-peak。
 *  4. **引文来源必须区分**：Jev 的 evidence_quote 是宿主机械摘的（meta.evidenceSource="host"），
 *     DeepSeek 是模型自己写的（"model"）。不写清楚就等于把程序摘录冒充成模型输出。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadDataset } from "./dataset.mjs";
import { fmtUsd, fmtCny, USD_TO_CNY, isPeak, deepseekRateLabel } from "./pricing.mjs";

const LANE_IDS = ["jev", "deepseek"];
const LANE_NAMES = { jev: "Jev", deepseek: "DeepSeek Flash" };

/** sentiment_score 容差：落在 ±0.25 内算「一致」。Jev 的分数是档位下标换算（0.5 的倍数），
 *  DeepSeek 是连续值，不给容差会因为量化误差把「同向」误判成「不一致」。 */
const SCORE_TOLERANCE = 0.25;
/** 宽松容差，同时报告，方便看结论对容差是否敏感。 */
const SCORE_TOLERANCE_LOOSE = 0.5;

// ---------------------------------------------------------------------------
// 读盘
// ---------------------------------------------------------------------------

/** 逐行解析 JSONL。坏行（进程被 kill 时的半截行）跳过而不是抛错 —— 报告要能在中断的 run 上出。 */
function parseJsonl(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* 半截行，忽略 */ }
  }
  return out;
}

async function readText(file) {
  try { return await readFile(file, "utf8"); } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function readJson(file) {
  const text = await readText(file);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * 数据集路径：manifest 里记的是绝对路径（server 写入），找不到就退回环境变量 / 项目默认路径。
 * 报告里的 platform 与分歧样本原文都来自这里 —— labels.jsonl 里只有 comment_id，没有正文。
 */
async function loadRows(runDir, manifest) {
  const candidates = [
    manifest?.dataset?.path,
    process.env.DATA_PATH,
    path.resolve(runDir, "..", "..", "data", "comments.csv"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const { rows } = loadDataset(candidate);
      return { rows, path: candidate };
    } catch { /* 换下一个候选 */ }
  }
  return { rows: null, path: null };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const sum = (list) => list.reduce((a, b) => a + b, 0);
const mean = (list) => (list.length ? sum(list) / list.length : 0);
const round = (v, d = 4) => Number((Number(v) || 0).toFixed(d));
const pct = (num, den) => (den > 0 ? round((num / den) * 100, 2) : null);

function percentile(list, p) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function jaccard(a = [], b = []) {
  const A = new Set(Array.isArray(a) ? a : []);
  const B = new Set(Array.isArray(b) ? b : []);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
}

const truncate = (text, max) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** Markdown 表格里 | 和换行会把表格拆坏。 */
const mdCell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();

// ---------------------------------------------------------------------------
// 四个维度
// ---------------------------------------------------------------------------

/** 覆盖率对账：成功 / 失败（events 里 decision.ok=false 的唯一 comment_id）/ 未跑。 */
function computeCoverage({ manifest, events, labels }) {
  const total = Number(manifest?.config?.rows ?? manifest?.dataset?.rows) || null;
  const lanes = {};
  for (const lane of LANE_IDS) {
    const success = labels[lane].length;
    const failedIds = new Set();
    let failureEvents = 0;
    for (const evt of events) {
      if (evt?.type !== "decision" || evt?.lane !== lane || evt?.ok !== false) continue;
      failureEvents++;
      const id = String(evt.commentId ?? "");
      if (id) failedIds.add(id);
    }
    const failed = failedIds.size;
    // 同一个 id 出现多次失败事件 = 二分重试后仍失败；runner 对「重试」本身不发事件，只能给这个下界
    const repeatedFailureIds = failureEvents - failed;
    const accounted = success + failed;
    const notRun = total == null ? null : Math.max(0, total - accounted);
    lanes[lane] = {
      success,
      failed,
      failureEvents,
      repeatedFailureIds,
      notRun,
      accounted,
      successRate: total ? pct(success, total) : null,
      failedRate: total ? pct(failed, total) : null,
    };
  }
  const jevIds = new Set(labels.jev.map((l) => String(l.comment_id)));
  const dsIds = new Set(labels.deepseek.map((l) => String(l.comment_id)));
  const paired = [...jevIds].filter((id) => dsIds.has(id)).length;
  return {
    total,
    lanes,
    paired,
    pairedOfTotalRate: total ? pct(paired, total) : null,
    pairedOfSuccessRate: { jev: pct(paired, jevIds.size), deepseek: pct(paired, dsIds.size) },
    // 分母不同的警告：只要两道成功数不同，任何「非配对」比例都不可直接比较
    denominatorWarning: jevIds.size !== dsIds.size
      ? `两道成功条数不同（Jev ${jevIds.size} / DeepSeek ${dsIds.size}），所有效果对比只在配对的 ${paired} 条上做。`
      : null,
    note: "failureEvents 含二分重试后逐条记账的失败；repeatedFailureIds = 失败事件数 − 失败条数，是「重试后仍失败」的下界。",
  };
}

/** 墙钟时间：以 events.jsonl 的 t（写入时刻，毫秒）为准，manifest 的 lane 汇总做兜底。 */
function computeTime({ manifest, events, coverage }) {
  const t = (evt) => Number(evt?.t) || null;
  const runStartEvt = events.find((e) => e?.type === "run_start");
  const runEndEvt = [...events].reverse().find((e) => e?.type === "run_end");

  const overallStartMs = t(runStartEvt) ?? (manifest?.startedAt ? Date.parse(manifest.startedAt) : null);
  const overallEndMs = t(runEndEvt) ?? (manifest?.finishedAt ? Date.parse(manifest.finishedAt) : null);

  const manifestLane = new Map((manifest?.lanes ?? []).map((l) => [l.id, l]));
  const lanes = {};
  for (const lane of LANE_IDS) {
    const laneEvents = events.filter((e) => e?.lane === lane && t(e) != null);
    const firstT = laneEvents.length ? Math.min(...laneEvents.map(t)) : null;
    const lastT = laneEvents.length ? Math.max(...laneEvents.map(t)) : null;
    const fallbackMs = Number(manifestLane.get(lane)?.elapsedMs) || null;
    const durationMs = firstT != null && lastT != null ? lastT - firstT : fallbackMs;
    lanes[lane] = {
      startedAt: firstT != null ? new Date(firstT).toISOString() : null,
      finishedAt: lastT != null ? new Date(lastT).toISOString() : null,
      durationMs,
      durationSec: durationMs == null ? null : round(durationMs / 1000, 3),
      eventCount: laneEvents.length,
    };
  }
  const finished = LANE_IDS.filter((l) => lanes[l].finishedAt != null);
  const firstFinished = finished.sort((a, b) => Date.parse(lanes[a].finishedAt) - Date.parse(lanes[b].finishedAt))[0] ?? null;
  const lastFinished = finished[finished.length - 1] ?? null;
  const dA = lanes.jev.durationMs;
  const dB = lanes.deepseek.durationMs;
  let fasterLane = null;
  let fasterRatio = null;
  if (dA != null && dB != null && dA > 0 && dB > 0 && dA !== dB) {
    fasterLane = dA < dB ? "jev" : "deepseek";
    fasterRatio = round(Math.max(dA, dB) / Math.min(dA, dB), 3);
  }
  return {
    startedAt: overallStartMs ? new Date(overallStartMs).toISOString() : null,
    finishedAt: overallEndMs ? new Date(overallEndMs).toISOString() : null,
    wallMs: overallStartMs != null && overallEndMs != null ? overallEndMs - overallStartMs : null,
    wallSec: overallStartMs != null && overallEndMs != null ? round((overallEndMs - overallStartMs) / 1000, 3) : null,
    lanes,
    firstFinished,
    fasterLane,
    fasterRatio,
    note: "每道的起止取 events.jsonl 中该道首/末事件的 t；两道并行跑，各自墙钟独立计时。",
  };
}

/** 费用：两套口径分开算，绝不混在一起。 */
function computeMoney({ labels, time, events }) {
  const rateCounts = (lane, field) => {
    const counts = {};
    for (const label of labels[lane]) {
      const key = label?.meta?.[field] ?? "(未记录)";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  };

  const laneMoney = (lane) => {
    const costs = labels[lane].map((l) => Number(l?.meta?.costUsd) || 0);
    const costUsd = sum(costs);
    const n = costs.length;
    const sourceCounts = rateCounts(lane, "costSource");
    return {
      costUsd: round(costUsd, 8),
      costCny: round(costUsd * USD_TO_CNY, 8),
      success: n,
      avgUsd: n ? round(costUsd / n, 8) : null,
      avgCny: n ? round((costUsd / n) * USD_TO_CNY, 8) : null,
      costSourceCounts: sourceCounts,
      missingCostSource: Number(sourceCounts["(未记录)"] ?? 0) + Number(sourceCounts.missing ?? 0),
      rateCounts: lane === "deepseek" ? rateCounts("deepseek", "rate") : undefined,
    };
  };

  const jev = laneMoney("jev");
  const deepseek = laneMoney("deepseek");

  const cheaperLane = jev.avgUsd != null && deepseek.avgUsd != null
    ? (jev.avgUsd < deepseek.avgUsd ? "jev" : deepseek.avgUsd < jev.avgUsd ? "deepseek" : null)
    : null;
  const expensiveAvg = cheaperLane === "jev" ? deepseek.avgUsd : jev.avgUsd;
  const cheapAvg = cheaperLane === "jev" ? jev.avgUsd : deepseek.avgUsd;

  // 事件流 vs 标签文件对账：两边的费用都来自同一批 usage，累计值必须吻合。
  // 对不上说明有标签没落盘、或费用被重复计 —— 这比费用本身更值得报警。
  const reconcile = {};
  for (const lane of LANE_IDS) {
    const eventCostUsd = round(sum(events
      .filter((e) => e?.type === "decision" && e?.lane === lane && e?.ok === true)
      .map((e) => Number(e.costUsd) || 0)), 8);
    const labelCostUsd = round(sum(labels[lane].map((l) => Number(l?.meta?.costUsd) || 0)), 8);
    reconcile[lane] = {
      eventCostUsd,
      labelCostUsd,
      diffUsd: round(eventCostUsd - labelCostUsd, 8),
      // 事件里的 costUsd 是每条均摊后四舍五入到 8 位的，允许 1e-6 量级的舍入差
      consistent: Math.abs(eventCostUsd - labelCostUsd) < 1e-5,
    };
  }

  const runStartMs = time.startedAt ? Date.parse(time.startedAt) : null;
  const peakAtStart = runStartMs != null ? isPeak(new Date(runStartMs)) : null;

  return {
    fx: { usdToCny: USD_TO_CNY, note: "人民币金额仅用于展示，汇率写死为 7.1。" },
    lanes: { jev, deepseek },
    reconcile,
    cheaperLane,
    // 用「单条均价」比而不是总额：两道成功条数可能不同，总额比会被分母污染
    cheaperRatioByAvg: cheaperLane ? round(expensiveAvg / cheapAvg, 3) : null,
    basis: {
      jev: "OpenRouter 响应里的 usage.cost（真实账单），逐条累加 label.meta.costUsd；不用单价表。",
      deepseek: "接口不返回费用，按 pricing.mjs 的官方单价本地计算（cache hit/miss 分开计价），逐条累加 label.meta.costUsd。",
    },
    peak: {
      atRunStart: peakAtStart,
      labelAtRunStart: runStartMs != null ? deepseekRateLabel(new Date(runStartMs)) : null,
      observedRateCounts: deepseek.rateCounts ?? {},
    },
    note: "对比用单条均价，分母分别为两道各自成功条数；比率 = 贵的一方均价 ÷ 便宜的一方均价。",
  };
}

/** 速度：吞吐按该道墙钟算；延迟是「批次延迟」，批内每条共享同一个值（口径必须写明）。 */
function computeSpeed({ labels, coverage, time }) {
  const lanes = {};
  for (const lane of LANE_IDS) {
    const success = labels[lane].length;
    const durationMs = time.lanes[lane].durationMs;
    const latencies = labels[lane]
      .map((l) => Number(l?.meta?.latencyMs))
      .filter((v) => Number.isFinite(v) && v > 0);
    lanes[lane] = {
      success,
      durationMs,
      durationSec: durationMs == null ? null : round(durationMs / 1000, 3),
      cps: durationMs ? round(success / (durationMs / 1000), 3) : null,
      avgLatencyMs: latencies.length ? Math.round(mean(latencies)) : null,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      latencySamples: latencies.length,
      failed: coverage.lanes[lane].failed,
      failureEvents: coverage.lanes[lane].failureEvents,
      retriedThenFailed: coverage.lanes[lane].repeatedFailureIds,
    };
  }
  const throughputRatio = lanes.jev.cps && lanes.deepseek.cps
    ? round(Math.max(lanes.jev.cps, lanes.deepseek.cps) / Math.min(lanes.jev.cps, lanes.deepseek.cps), 3)
    : null;
  return {
    lanes,
    fasterThroughputLane: lanes.jev.cps && lanes.deepseek.cps
      ? (lanes.jev.cps > lanes.deepseek.cps ? "jev" : "deepseek")
      : null,
    throughputRatio,
    note: "延迟口径：label.meta.latencyMs 是「该条所在批次的往返耗时」，同一批内的条目共享同一个值；"
      + "P50/P95 的分母是该道成功条数。重试次数未单独记账（二分会重发请求但不发事件），只能给出重试后仍失败条数。",
  };
}

/** 效果：只在配对集上算，逐字段给分母；分数类给容差 + 平均绝对差。 */
function computeEffect({ labels }) {
  // aspects / emotion 不是「同源测量」：Jev 在 13 个固定维度上逐个判定「是否提到」，
  // prob≥0.5 才命中（产出双峰：要么空、要么好几个）；DeepSeek 是自由列举 1~2 个。
  // 两者的 Jaccard 主要反映「仪器 + 输出长度」的差异，不是准确度差异 —— 因此下面把它标成
  // comparable:false，渲染时移出「效果」主表，只作为仪器差异单独展示并强制带警告。
  const MECHANISM_NOTE = "两边列举机制不同（固定维度集合逐个判定 vs 自由列举），此数字是仪器差异而非准确度。";
  const dsById = new Map(labels.deepseek.map((l) => [String(l.comment_id), l]));
  const pairs = [];
  for (const jl of labels.jev) {
    const dl = dsById.get(String(jl.comment_id));
    if (dl) pairs.push([jl, dl]);
  }

  const rate = (fn) => ({ agree: pairs.filter(fn).length, total: pairs.length, rate: pct(pairs.filter(fn).length, pairs.length) });
  const bothRelevant = pairs.filter(([a, b]) => a.is_relevant === true && b.is_relevant === true);
  const rateBR = (fn) => ({ agree: bothRelevant.filter(fn).length, total: bothRelevant.length, rate: pct(bothRelevant.filter(fn).length, bothRelevant.length) });

  const scoreDiffs = pairs.map(([a, b]) => Math.abs((Number(a.sentiment_score) || 0) - (Number(b.sentiment_score) || 0)));
  const aspectJ = pairs.map(([a, b]) => jaccard(a.aspects, b.aspects));
  const emotionJ = pairs.map(([a, b]) => jaccard(a.emotion, b.emotion));
  const quoteStats = (lane) => {
    const list = labels[lane];
    const present = list.filter((l) => Boolean(l.evidence_quote)).length;
    const verified = list.filter((l) => l?.meta?.quoteVerified === true).length;
    const sources = {};
    for (const l of list) {
      const key = l?.meta?.evidenceSource ?? "(未记录)";
      sources[key] = (sources[key] ?? 0) + 1;
    }
    return { present, verified, total: list.length, sourceCounts: sources };
  };

  const sentimentDist = (lane) => {
    const dist = {};
    for (const l of labels[lane]) dist[l.sentiment] = (dist[l.sentiment] ?? 0) + 1;
    return dist;
  };

  const fields = {
    is_relevant: { label: "相关性判断", ...rate(([a, b]) => a.is_relevant === b.is_relevant) },
    sentiment: { label: "情感极性", ...rate(([a, b]) => a.sentiment === b.sentiment) },
    intent: { label: "意图", ...rate(([a, b]) => a.intent === b.intent) },
    sentiment_score: {
      label: "情感分数（容差内一致）",
      tolerance: SCORE_TOLERANCE,
      agree: scoreDiffs.filter((d) => d <= SCORE_TOLERANCE).length,
      total: pairs.length,
      rate: pct(scoreDiffs.filter((d) => d <= SCORE_TOLERANCE).length, pairs.length),
      looseTolerance: SCORE_TOLERANCE_LOOSE,
      looseAgree: scoreDiffs.filter((d) => d <= SCORE_TOLERANCE_LOOSE).length,
      looseRate: pct(scoreDiffs.filter((d) => d <= SCORE_TOLERANCE_LOOSE).length, pairs.length),
      meanAbsDiff: round(mean(scoreDiffs), 4),
      maxAbsDiff: scoreDiffs.length ? round(Math.max(...scoreDiffs), 4) : null,
    },
    aspects: {
      label: "维度标签（aspects）",
      comparable: false, // 机制不同源：不得与 is_relevant/sentiment/intent 放在同一张效果表里比
      mechanismNote: MECHANISM_NOTE,
      meanJaccard: round(mean(aspectJ), 4),
      exactMatch: aspectJ.filter((v) => v === 1).length,
      total: pairs.length,
      exactRate: pct(aspectJ.filter((v) => v === 1).length, pairs.length),
    },
    emotion: {
      label: "情绪标签（emotion）",
      comparable: false,
      mechanismNote: MECHANISM_NOTE,
      meanJaccard: round(mean(emotionJ), 4),
      exactMatch: emotionJ.filter((v) => v === 1).length,
      total: pairs.length,
      exactRate: pct(emotionJ.filter((v) => v === 1).length, pairs.length),
    },
  };

  // 相关性是上游闸门：两边都判相关时，情感/意图/分数的分歧才有解释意义
  const conditional = {
    bothRelevant: bothRelevant.length,
    sentiment: { label: "情感极性（双方都判相关）", ...rateBR(([a, b]) => a.sentiment === b.sentiment) },
    intent: { label: "意图（双方都判相关）", ...rateBR(([a, b]) => a.intent === b.intent) },
    sentiment_score: {
      label: "情感分数容差内（双方都判相关）",
      tolerance: SCORE_TOLERANCE,
      agree: bothRelevant.filter(([a, b]) => Math.abs((Number(a.sentiment_score) || 0) - (Number(b.sentiment_score) || 0)) <= SCORE_TOLERANCE).length,
      total: bothRelevant.length,
      rate: pct(bothRelevant.filter(([a, b]) => Math.abs((Number(a.sentiment_score) || 0) - (Number(b.sentiment_score) || 0)) <= SCORE_TOLERANCE).length, bothRelevant.length),
    },
  };

  // 一致性分布：两道各自判了多少 relevant，用于解释 paired 集里为何有大量 irrelevant
  const relevanceDist = (lane) => {
    const list = labels[lane];
    return { true: list.filter((l) => l.is_relevant === true).length, false: list.filter((l) => l.is_relevant !== true).length, total: list.length };
  };

  return {
    paired: pairs.length,
    pairedDenominator: `两道都成功且 comment_id 相同的 ${pairs.length} 条`,
    fields,
    conditionalBothRelevant: conditional,
    distributions: {
      sentiment: { jev: sentimentDist("jev"), deepseek: sentimentDist("deepseek") },
      relevance: { jev: relevanceDist("jev"), deepseek: relevanceDist("deepseek") },
    },
    quote: { jev: quoteStats("jev"), deepseek: quoteStats("deepseek") },
    note: "所有 rate 的分母都是 paired；conditionalBothRelevant 的分母是其中双方都判 is_relevant=true 的条数。"
      + "aspects/emotion 的 Jaccard 因两边产出机制不同源，标为 comparable:false，只作仪器差异展示，不是准确度指标。",
  };
}

/** 平台 × 情感交叉表：证明这批示样本不是单一平台，同时看两道的分歧是否集中在某个平台。 */
function computePlatformCross({ labels, rowsById }) {
  const dsById = new Map(labels.deepseek.map((l) => [String(l.comment_id), l]));
  const groups = new Map();
  for (const jl of labels.jev) {
    const dl = dsById.get(String(jl.comment_id));
    if (!dl) continue;
    const platform = rowsById?.get(String(jl.comment_id))?.platform ?? "(未知)";
    if (!groups.has(platform)) groups.set(platform, []);
    groups.get(platform).push([jl, dl]);
  }
  const dist = (list, idx) => {
    const out = { positive: 0, negative: 0, neutral: 0, mixed: 0, other: 0 };
    for (const pair of list) {
      const s = pair[idx].sentiment;
      if (out[s] === undefined) out.other++;
      else out[s]++;
    }
    return out;
  };
  return [...groups.entries()]
    .map(([platform, list]) => ({
      platform,
      paired: list.length,
      jevSentiment: dist(list, 0),
      deepseekSentiment: dist(list, 1),
      sentimentAgreement: {
        agree: list.filter(([a, b]) => a.sentiment === b.sentiment).length,
        total: list.length,
        rate: pct(list.filter(([a, b]) => a.sentiment === b.sentiment).length, list.length),
      },
    }))
      .sort((a, b) => b.paired - a.paired);
}

/** 分歧样本：视频里最有价值的素材，按「分歧严重度」排序取前 N。 */
function computeDivergences({ labels, rowsById, limit = 10 }) {
  const dsById = new Map(labels.deepseek.map((l) => [String(l.comment_id), l]));
  const items = [];
  for (const jl of labels.jev) {
    const dl = dsById.get(String(jl.comment_id));
    if (!dl) continue;
    const relevanceDiff = Number(jl.is_relevant) !== Number(dl.is_relevant);
    const sentimentDiff = jl.sentiment !== dl.sentiment;
    const intentDiff = jl.intent !== dl.intent;
    const scoreDiff = Math.abs((Number(jl.sentiment_score) || 0) - (Number(dl.sentiment_score) || 0));
    const aspectJ = jaccard(jl.aspects, dl.aspects);
    const emotionJ = jaccard(jl.emotion, dl.emotion);
    const divergenceScore = round(
      3 * Number(relevanceDiff) + 3 * Number(sentimentDiff) + 2 * Number(intentDiff) + 2 * Math.min(1, scoreDiff)
      + (1 - aspectJ) + (1 - emotionJ),
      3,
    );
    const reasons = [];
    if (relevanceDiff) reasons.push(`相关性判断相反（Jev ${jl.is_relevant} / DeepSeek ${dl.is_relevant}）`);
    if (sentimentDiff) reasons.push(`情感不同（${jl.sentiment} vs ${dl.sentiment}）`);
    if (intentDiff) reasons.push(`意图不同（${jl.intent} vs ${dl.intent}）`);
    if (scoreDiff > SCORE_TOLERANCE) reasons.push(`情感分差 ${round(scoreDiff, 3)}`);
    if (aspectJ < 1) reasons.push(`维度 Jaccard ${round(aspectJ, 2)}`);
    if (emotionJ < 1) reasons.push(`情绪 Jaccard ${round(emotionJ, 2)}`);
    const row = rowsById?.get(String(jl.comment_id));
    const compact = (l) => ({
      is_relevant: l.is_relevant,
      sentiment: l.sentiment,
      sentiment_score: l.sentiment_score,
      intent: l.intent,
      aspects: l.aspects ?? [],
      emotion: l.emotion ?? [],
      evidence_quote: l.evidence_quote ?? "",
      evidenceSource: l?.meta?.evidenceSource ?? null,
      quoteVerified: l?.meta?.quoteVerified ?? null,
    });
    items.push({
      comment_id: String(jl.comment_id),
      platform: row?.platform ?? "(未知)",
      topic_title: row?.topic_title ?? null,
      content: row ? truncate(row.content, 300) : null,
      divergenceScore,
      reasons,
      jev: compact(jl),
      deepseek: compact(dl),
    });
  }
  return items
    .filter((item) => item.divergenceScore > 0)
    .sort((a, b) => b.divergenceScore - a.divergenceScore || a.comment_id.localeCompare(b.comment_id))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function renderMarkdown(report) {
  const { coverage, time, money, speed, effect, platformCross, divergences } = report;
  const L = [];
  const laneName = (id) => LANE_NAMES[id] ?? id;

  L.push(`# Jev vs DeepSeek Flash 对比报告`);
  L.push("");
  L.push(`- 运行：\`${report.runId}\`（${report.runDir}）`);
  L.push(`- 数据集：${report.dataset.total ?? "未知"} 条，本次运行 ${report.dataset.rowsInRun ?? "未知"} 条，指纹 \`${report.dataset.fingerprint ?? "未知"}\``);
  L.push(`- 平台分布（整个数据集）：${report.dataset.platformText ?? "未知"}`);
  L.push(`- 开始：${time.startedAt ?? "未知"}　结束：${time.finishedAt ?? "未知"}　总墙钟：${time.wallSec ?? "未知"} 秒`);
  L.push(`- 生成时间：${report.generatedAt}`);
  L.push("");
  L.push(`> 本报告的每个数字都从 \`manifest.json\`、\`events.jsonl\`、\`labels.jev.jsonl\`、\`labels.deepseek.jsonl\` 复算，无硬编码。`);
  L.push("");

  // --- 覆盖度 ---
  L.push(`## 0. 覆盖度对账（先看分母，再看比例）`);
  L.push("");
  L.push(`| 指标 | Jev | DeepSeek Flash |`);
  L.push(`|---|---:|---:|`);
  L.push(`| 成功打标 | ${coverage.lanes.jev.success} | ${coverage.lanes.deepseek.success} |`);
  L.push(`| 失败（已记账） | ${coverage.lanes.jev.failed} | ${coverage.lanes.deepseek.failed} |`);
  L.push(`| 未跑 | ${coverage.lanes.jev.notRun ?? "未知"} | ${coverage.lanes.deepseek.notRun ?? "未知"} |`);
  L.push(`| 本次运行条数（manifest.config.rows） | ${coverage.total ?? "未知"} | ${coverage.total ?? "未知"} |`);
  L.push(`| 成功率（分母 = 总条数） | ${coverage.lanes.jev.successRate ?? "未知"}% | ${coverage.lanes.deepseek.successRate ?? "未知"}% |`);
  L.push("");
  L.push(`**配对集：${coverage.paired} 条**（两道都成功且 comment_id 相同；占总数 ${coverage.pairedOfTotalRate ?? "未知"}%）。`
    + `所有效果对比的分母都是这 ${coverage.paired} 条，绝不拿两个不同分母的比例直接比。`);
  if (coverage.denominatorWarning) L.push(`> ⚠️ ${coverage.denominatorWarning}`);
  L.push(`> ${coverage.note}`);
  L.push("");

  // --- 时间 ---
  L.push(`## 1. 时间`);
  L.push("");
  L.push(`| 指标 | Jev | DeepSeek Flash |`);
  L.push(`|---|---:|---:|`);
  L.push(`| 墙钟时长（秒） | ${time.lanes.jev.durationSec ?? "未知"} | ${time.lanes.deepseek.durationSec ?? "未知"} |`);
  L.push(`| 开始时间戳 | ${time.lanes.jev.startedAt ?? "未知"} | ${time.lanes.deepseek.startedAt ?? "未知"} |`);
  L.push(`| 结束时间戳 | ${time.lanes.jev.finishedAt ?? "未知"} | ${time.lanes.deepseek.finishedAt ?? "未知"} |`);
  L.push("");
  if (time.fasterLane) {
    L.push(`**先跑完：${laneName(time.firstFinished)}**；时长上 ${laneName(time.fasterLane)} 更快，快 **${time.fasterRatio}×**。`);
  } else {
    L.push(`没有足够的双道事件数据来比较谁先跑完。`);
  }
  L.push(`> ${time.note}`);
  L.push("");

  // --- 金钱 ---
  L.push(`## 2. 金钱`);
  L.push("");
  L.push(`| 指标 | Jev | DeepSeek Flash |`);
  L.push(`|---|---:|---:|`);
  L.push(`| 总费用（美元） | ${fmtUsd(money.lanes.jev.costUsd)} | ${fmtUsd(money.lanes.deepseek.costUsd)} |`);
  L.push(`| 总费用（人民币，按 1:${money.fx.usdToCny}） | ${fmtCny(money.lanes.jev.costUsd)} | ${fmtCny(money.lanes.deepseek.costUsd)} |`);
  L.push(`| 单条均价（分母 = 成功条数） | ${fmtUsd(money.lanes.jev.avgUsd)} / ${money.lanes.jev.success} 条 | ${fmtUsd(money.lanes.deepseek.avgUsd)} / ${money.lanes.deepseek.success} 条 |`);
  L.push(`| 单条均价（人民币） | ${fmtCny(money.lanes.jev.avgUsd)} | ${fmtCny(money.lanes.deepseek.avgUsd)} |`);
  L.push("");
  if (money.cheaperLane) {
    L.push(`**更便宜：${laneName(money.cheaperLane)}**，按单条均价算便宜 **${money.cheaperRatioByAvg}×**。`);
  }
  L.push("");
  L.push(`**计费口径（必须分清，否则数字没有意义）：**`);
  L.push(`- Jev：${money.basis.jev}`);
  L.push(`- DeepSeek Flash：${money.basis.deepseek}`);
  L.push(`- DeepSeek 命中档位（按运行开始时刻判定）：**${money.peak.labelAtRunStart ?? "未知"}**；逐条记录到的档位：${Object.entries(money.peak.observedRateCounts).map(([k, v]) => `${k}×${v}`).join("、") || "无"}。`);
  if (money.lanes.jev.missingCostSource > 0) {
    L.push(`- ⚠️ Jev 有 ${money.lanes.jev.missingCostSource} 条没有记录到 \`usage.cost\`（meta.costSource 缺失），总费用偏低。`);
  }
  L.push(`- 费用对账（events.jsonl 的 decision.costUsd 累加 vs labels 文件 meta.costUsd 累加）：`
    + LANE_IDS.map((l) => `${laneName(l)} ${money.reconcile[l].consistent ? "✅" : "❌"} ${fmtUsd(money.reconcile[l].eventCostUsd)} / ${fmtUsd(money.reconcile[l].labelCostUsd)}（差 ${fmtUsd(money.reconcile[l].diffUsd)}）`).join("；")
    + `。`);
  L.push(`> ${money.note}`);
  L.push("");

  // --- 速度 ---
  L.push(`## 3. 速度`);
  L.push("");
  L.push(`| 指标 | Jev | DeepSeek Flash |`);
  L.push(`|---|---:|---:|`);
  L.push(`| 吞吐（条/秒，分母 = 各自墙钟） | ${speed.lanes.jev.cps ?? "未知"} | ${speed.lanes.deepseek.cps ?? "未知"} |`);
  L.push(`| 单条平均延迟（毫秒，批次均摊） | ${speed.lanes.jev.avgLatencyMs ?? "未知"} | ${speed.lanes.deepseek.avgLatencyMs ?? "未知"} |`);
  L.push(`| P50 延迟（毫秒） | ${speed.lanes.jev.p50Ms ?? "未知"} | ${speed.lanes.deepseek.p50Ms ?? "未知"} |`);
  L.push(`| P95 延迟（毫秒） | ${speed.lanes.jev.p95Ms ?? "未知"} | ${speed.lanes.deepseek.p95Ms ?? "未知"} |`);
  L.push(`| 延迟样本数（分母） | ${speed.lanes.jev.latencySamples} | ${speed.lanes.deepseek.latencySamples} |`);
  L.push(`| 失败条数 | ${speed.lanes.jev.failed} | ${speed.lanes.deepseek.failed} |`);
  L.push(`| 重试后仍失败（下界） | ${speed.lanes.jev.retriedThenFailed} | ${speed.lanes.deepseek.retriedThenFailed} |`);
  L.push("");
  if (speed.fasterThroughputLane) {
    L.push(`**吞吐更高：${laneName(speed.fasterThroughputLane)}**，高 **${speed.throughputRatio}×**。`);
  }
  L.push(`> ${speed.note}`);
  L.push("");

  // --- 效果 ---
  // 主表只放两边机制同源的字段（都是「在同一个受控词表里选一个」）。
  // aspects/emotion 的 Jaccard 是仪器差异，移到下面的独立小节，不得混进「效果」主表。
  L.push(`## 4. 效果（一致率，分母 = 配对集 ${effect.paired} 条）`);
  L.push("");
  L.push(`| 字段 | 一致条数 | 分母 | 一致率 |`);
  L.push(`|---|---:|---:|---:|`);
  L.push(`| 相关性 is_relevant | ${effect.fields.is_relevant.agree} | ${effect.fields.is_relevant.total} | ${effect.fields.is_relevant.rate}% |`);
  L.push(`| 情感 polarity | ${effect.fields.sentiment.agree} | ${effect.fields.sentiment.total} | ${effect.fields.sentiment.rate}% |`);
  L.push(`| 意图 intent | ${effect.fields.intent.agree} | ${effect.fields.intent.total} | ${effect.fields.intent.rate}% |`);
  L.push(`| 情感分数 ±${effect.fields.sentiment_score.tolerance} | ${effect.fields.sentiment_score.agree} | ${effect.fields.sentiment_score.total} | ${effect.fields.sentiment_score.rate}% |`);
  L.push(`| 情感分数 ±${effect.fields.sentiment_score.looseTolerance}（宽松） | ${effect.fields.sentiment_score.looseAgree} | ${effect.fields.sentiment_score.total} | ${effect.fields.sentiment_score.looseRate}% |`);
  L.push("");
  L.push(`- 情感分数平均绝对差：**${effect.fields.sentiment_score.meanAbsDiff}**（最大 ${effect.fields.sentiment_score.maxAbsDiff}，分母 ${effect.paired}）。`);
  L.push(`- 上表字段都是「在同一受控词表里选一个」，机制同源，可以直接比较一致率。`);
  L.push("");
  L.push(`### 4.1 仪器差异观察（**不是准确度，禁止当作效果指标引用**）`);
  L.push("");
  L.push(`| 字段 | 平均 Jaccard | 完全一致 | 分母 | 为什么不能比 |`);
  L.push(`|---|---:|---:|---:|---|`);
  const mech = effect.fields.aspects.mechanismNote;
  L.push(`| aspects | ${effect.fields.aspects.meanJaccard} | ${effect.fields.aspects.exactMatch} | ${effect.fields.aspects.total} | ${mdCell(mech)} |`);
  L.push(`| emotion | ${effect.fields.emotion.meanJaccard} | ${effect.fields.emotion.exactMatch} | ${effect.fields.emotion.total} | ${mdCell(mech)} |`);
  L.push("");
  L.push(`> ⚠️ **两边列举机制不同，此数字是仪器差异而非准确度**：一方在固定维度集合上逐个判定「是否提到」（可能一次命中多个、也可能为空），`);
  L.push(`> 另一方自由列举 1~2 个。报得多不代表报得准，Jaccard 低也不代表错。谁更准只能看独立盲评（\`review.md\`），`);
  L.push(`> 且盲评里 aspects 只作为附加观察轮，不计入胜负。`);
  L.push("");
  L.push(`**条件一致率（只看双方都判 is_relevant=true 的 ${effect.conditionalBothRelevant.bothRelevant} 条）**`);
  L.push("");
  L.push(`| 字段 | 一致条数 | 分母 | 一致率 |`);
  L.push(`|---|---:|---:|---:|`);
  L.push(`| 情感 polarity | ${effect.conditionalBothRelevant.sentiment.agree} | ${effect.conditionalBothRelevant.sentiment.total} | ${effect.conditionalBothRelevant.sentiment.rate}% |`);
  L.push(`| 意图 intent | ${effect.conditionalBothRelevant.intent.agree} | ${effect.conditionalBothRelevant.intent.total} | ${effect.conditionalBothRelevant.intent.rate}% |`);
  L.push(`| 情感分数 ±${effect.conditionalBothRelevant.sentiment_score.tolerance} | ${effect.conditionalBothRelevant.sentiment_score.agree} | ${effect.conditionalBothRelevant.sentiment_score.total} | ${effect.conditionalBothRelevant.sentiment_score.rate}% |`);
  L.push("");
  L.push(`**引文来源对账**（这一项不比对错，只防止把程序摘录当成模型输出）：`);
  L.push("");
  L.push(`| | 有引文 | 逐字校验通过 | 总条数 | 来源标记 |`);
  L.push(`|---|---:|---:|---:|---|`);
  for (const lane of LANE_IDS) {
    const q = effect.quote[lane];
    L.push(`| ${laneName(lane)} | ${q.present} | ${q.verified} | ${q.total} | ${Object.entries(q.sourceCounts).map(([k, v]) => `${k}×${v}`).join("、") || "无"} |`);
  }
  L.push("");
  L.push(`> ${effect.note}`);
  L.push("");

  // --- 平台交叉 ---
  L.push(`## 5. 平台 × 情感交叉表（分母 = 各平台配对条数）`);
  L.push("");
  if (report.dataset.loaded === false) {
    L.push(`> ⚠️ 原始数据集未能加载（manifest.dataset.path 缺失或文件不可读），本表平台信息与分歧样本原文已退化为 events.jsonl 的 preview，结论请谨慎引用。`);
    L.push("");
  }
  L.push(`| 平台 | 配对数 | Jev 情感分布 | DeepSeek 情感分布 | 情感一致 |`);
  L.push(`|---|---:|---|---|---:|`);
  for (const p of platformCross) {
    const fmtDist = (d) => Object.entries(d).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(" / ") || "无";
    L.push(`| ${mdCell(p.platform)} | ${p.paired} | ${fmtDist(p.jevSentiment)} | ${fmtDist(p.deepseekSentiment)} | ${p.sentimentAgreement.agree}/${p.sentimentAgreement.total} = ${p.sentimentAgreement.rate}% |`);
  }
  L.push("");

  // --- 分歧样本 ---
  L.push(`## 6. 分歧样本 Top ${divergences.length}（按分歧严重度排序，原始记录复算）`);
  L.push("");
  L.push(`> 下面「分歧点」里的 aspects/emotion 的 Jaccard 只表示两套列举机制的差异，**不是准确度**：`);
  L.push(`> 两道的 aspects 产出机制不同源（固定维度集合逐个判定 vs 自由列举），报得多不等于报得对。`);
  L.push("");
  if (!divergences.length) {
    L.push(`配对集里没有发现分歧。`);
  }
  divergences.forEach((d, i) => {
    L.push(`### ${i + 1}. \`${d.comment_id}\`（${mdCell(d.platform)}，分歧分 ${d.divergenceScore}）`);
    L.push("");
    L.push(`> ${mdCell(d.content ?? "(原文未加载)")}`);
    L.push("");
    L.push(`分歧点：${d.reasons.map(mdCell).join("；")}`);
    L.push("");
    L.push(`| 字段 | Jev | DeepSeek Flash |`);
    L.push(`|---|---|---|`);
    L.push(`| is_relevant | ${d.jev.is_relevant} | ${d.deepseek.is_relevant} |`);
    L.push(`| sentiment | ${d.jev.sentiment} (${d.jev.sentiment_score}) | ${d.deepseek.sentiment} (${d.deepseek.sentiment_score}) |`);
    L.push(`| intent | ${d.jev.intent} | ${d.deepseek.intent} |`);
    L.push(`| aspects | ${mdCell(d.jev.aspects.join("、")) || "—"} | ${mdCell(d.deepseek.aspects.join("、")) || "—"} |`);
    L.push(`| emotion | ${mdCell(d.jev.emotion.join("、")) || "—"} | ${mdCell(d.deepseek.emotion.join("、")) || "—"} |`);
    L.push(`| evidence_quote（来源） | ${mdCell(d.jev.evidence_quote) || "—"}（${d.jev.evidenceSource}） | ${mdCell(d.deepseek.evidence_quote) || "—"}（${d.deepseek.evidenceSource}） |`);
    L.push("");
  });

  // --- 口径与局限 ---
  L.push(`## 7. 口径与局限`);
  L.push("");
  L.push(`- **一致性 ≠ 正确性**：一致率只说明两道答案是否相同，不代表任何一方是对的。谁更准由独立盲评给出（\`review.md\`）。`);
  L.push(`- **aspects/emotion 不可直接比**：两道产出机制不同源（一边是固定维度集合逐个判定是否提到、一边是自由列举），`);
  L.push(`  Jaccard 主要反映输出长度与仪器差异；本报告把它放在 4.1 单独展示，不作为效果指标引用。`);
  L.push(`- **分母纪律**：效果类指标只在配对集（${effect.paired} 条）上算；覆盖率、失败率的分母是总条数；单条均价的分母是各自成功条数。`);
  L.push(`- **延迟口径**：同一批内所有条目共享批次耗时，不是单条独立计时；批大小 10 条/次（两条道相同）。`);
  L.push(`- **费用口径**：Jev 是 OpenRouter 真实账单；DeepSeek 是本地按官方单价计算，可能因价格调整/缓存命中率而与真实账单有偏差。`);
  L.push(`- **重试不可见**：二分重试不会在 events.jsonl 留事件，报告只能给出「重试后仍失败」的下界。`);
  L.push(`- **引文口径**：Jev 的引文由宿主程序从原文机械摘取（evidenceSource=host），DeepSeek 的由模型自己给出（model）。`);
  L.push(`- **未跑完的 run**：若两道成功数不同或存在未跑条目，报告仍可生成，但比较结论只对配对集成立。`);
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * @param {string} runDir runs/<runId> 目录
 * @param {{onProgress?:Function, write?:boolean, divergenceLimit?:number}} [opts]
 * @returns {Promise<{json:object, markdown:string}>}
 */
export async function buildReport(runDir, { onProgress, write = true, divergenceLimit = 10 } = {}) {
  const progress = (phase, extra = {}) => {
    try { onProgress?.({ phase, ...extra }); } catch { /* 进度回调不能拖垮报告 */ }
  };

  const manifest = await readJson(path.join(runDir, "manifest.json"));
  if (!manifest) throw new Error(`读不到 manifest.json：${runDir}`);
  progress("manifest", { message: "manifest 已读取" });

  const [jevText, dsText, eventsText] = await Promise.all([
    readText(path.join(runDir, "labels.jev.jsonl")),
    readText(path.join(runDir, "labels.deepseek.jsonl")),
    readText(path.join(runDir, "events.jsonl")),
  ]);
  const labels = { jev: parseJsonl(jevText ?? ""), deepseek: parseJsonl(dsText ?? "") };
  const events = parseJsonl(eventsText ?? "");
  progress("labels", { message: `Jev ${labels.jev.length} 条 / DeepSeek ${labels.deepseek.length} 条 / 事件 ${events.length} 条` });

  const { rows, path: datasetPath } = await loadRows(runDir, manifest);
  const rowsById = rows ? new Map(rows.map((r) => [String(r.comment_id), r])) : null;
  progress("dataset", { message: rows ? `数据集已加载：${rows.length} 条` : "数据集未能加载，平台与原文将退化为事件里的 preview" });

  const coverage = computeCoverage({ manifest, events, labels });
  const time = computeTime({ manifest, events, coverage });
  progress("time", { message: "时间维度完成" });
  const money = computeMoney({ labels, time, events });
  progress("money", { message: "金钱维度完成" });
  const speed = computeSpeed({ labels, coverage, time });
  progress("speed", { message: "速度维度完成" });
  const effect = computeEffect({ labels });
  progress("effect", { message: "效果维度完成" });
  const platformCross = computePlatformCross({ labels, rowsById });
  const divergences = computeDivergences({ labels, rowsById, limit: divergenceLimit });
  progress("divergences", { message: `分歧样本 ${divergences.length} 条` });

  // 数据集没加载成功时，用 events 里的 preview 兜底给分歧样本补原文，并在报告里注明
  if (!rows) {
    const previews = new Map();
    for (const evt of events) {
      if (evt?.type === "decision" && evt?.commentId) previews.set(String(evt.commentId), evt.preview ?? null);
    }
    for (const d of divergences) {
      if (!d.content) d.content = previews.get(d.comment_id) ?? null;
      if (d.platform === "(未知)") d.platform = "数据集未加载";
    }
  }

  const lanesMeta = {};
  for (const lane of LANE_IDS) {
    const fromManifest = (manifest.lanes ?? []).find((l) => l.id === lane);
    lanesMeta[lane] = { id: lane, label: LANE_NAMES[lane], model: fromManifest?.model ?? null, summary: fromManifest ?? null };
  }

  const json = {
    runId: manifest.runId ?? path.basename(runDir),
    runDir,
    generatedAt: new Date().toISOString(),
    status: manifest.status ?? null,
    stopped: manifest.stopped ?? null,
    dataset: {
      path: datasetPath ?? manifest.dataset?.path ?? null,
      // total = 数据集全量条数；rowsInRun = 本次实际跑的子集（server 支持 limit）
      total: Number(manifest.dataset?.rows) || coverage.total,
      rowsInRun: coverage.total,
      fingerprint: manifest.dataset?.fingerprint ?? null,
      platforms: manifest.dataset?.platforms ?? null,
      platformText: manifest.dataset?.platforms
        ? Object.entries(manifest.dataset.platforms).map(([k, v]) => `${k}=${v}`).join(" ")
        : null,
      loaded: Boolean(rows),
    },
    lanes: lanesMeta,
    coverage,
    time,
    money,
    speed,
    effect,
    platformCross,
    divergences,
  };
  const markdown = renderMarkdown(json);
  progress("markdown", { message: `报告生成完毕（${markdown.length} 字符）` });

  if (write) {
    // 原子写：先 .tmp 再 rename，避免前端/别的进程读到半截
    for (const [name, text] of [["report.json", JSON.stringify(json, null, 2)], ["report.md", markdown]]) {
      const file = path.join(runDir, name);
      const tmp = `${file}.tmp`;
      await writeFile(tmp, text, "utf8");
      await rename(tmp, file);
    }
    progress("written", { message: "report.json / report.md 已落盘" });
  }

  return { json, markdown };
}

export default { buildReport };
