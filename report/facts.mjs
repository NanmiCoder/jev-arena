/**
 * 事实层：把「一路标签」压成可复算的数字，并给每个数字发一个 NF 编号。
 *
 * 三条设计约束，都是为了左右并排对比时不被口径差异骗到：
 *
 * 1. **两道共用同一份计算代码**。lane 只决定读哪个标签文件、以及引文来源怎么标注；
 *    分母、四舍五入、多标签 aspect 的展开方式全部走同一条分支。如果给 Jev 和
 *    DeepSeek 各写一套统计，任何一处口径漂移（比如一边按相关评论做分母、另一边按
 *    已标注评论）都会在并排看报告时被误读成「模型判断差异」。
 *
 * 2. **每个数字都能从原始 JSONL 复算**。这里不做抽样、不做估计、不写常量：事实要么
 *    来自 labels.<lane>.jsonl 的逐条标签，要么来自 comments.csv 的评论快照，
 *    要么由这两个集合直接聚合得到。manifest.json 只用于取 run 元信息。
 *
 * 3. **正文不许写阿拉伯数字**。每个数字都进 factCatalog，正文只引用 `NFxxxx`。
 *    原因：改一份数据不用重写文案；也不会出现「正文说 178 条、表格说 175 条」
 *    这种两套数字对不上的事故。报告里出现的数字只有一个来源。
 *
 * 口径（报告里会原样写出来）：
 *  - 情感 / 意图 / 方面 / 情绪词的占比，分母一律是**该道的相关评论数**；
 *  - 相关评论 = `is_relevant === true` 的评论，是否相关由该道自己判定，因此两道分母
 *    可能不同（这是被观察的差异，不是口径不一致）；
 *  - 平均情感分 = 相关评论 `sentiment_score` 的算术平均；
 *  - 方面是多标签，同一条评论可命中多个方面，各行不能相加。
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { loadDataset } from "../src/dataset.mjs";
import { ASPECTS, EMOTIONS, INTENTS, SENTIMENTS } from "../src/vocab.mjs";

/**
 * 两道的最小配置：只放「读哪个文件」「叫什么名字」「引文是谁摘的」。
 * model 优先从 manifest / 标签 meta 里读，这里的值只是标签缺字段时的兜底。
 */
export const LANES = {
  jev: {
    id: "jev",
    label: "Jev",
    backend: "jev",
    model: "typesafe/jev-1.13",
    file: "labels.jev.jsonl",
    // 宿主机械摘取：引文一定能在原文里逐字找到，但摘哪一句不是模型决定的。
    evidenceSource: "host",
    evidenceSourceNote: "引文由宿主程序从原文机械摘取（evidenceSource=host），不是模型自述",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek Flash",
    backend: "deepseek",
    model: "deepseek-flash",
    file: "labels.deepseek.jsonl",
    // 模型自述摘录：可能为空（模型没给），也可能与原文有细微出入（会被校验置空）。
    evidenceSource: "model",
    evidenceSourceNote: "引文由模型自己摘录（evidenceSource=model）",
  },
};

const PLATFORM_LABELS = {
  bili: "B站",
  xhs: "小红书",
  dy: "抖音",
  reddit: "Reddit",
  twitter: "Twitter",
  v2ex: "V2EX",
};

/** 渲染器的平台枚举只认这四个；其余平台的评论计入总数，但不进平台对比表。 */
export const VIEW_PLATFORMS = ["bili", "xhs", "dy", "reddit"];

export const LOW_CONFIDENCE_THRESHOLD = 0.7;

/** 引文池规模：够正文引用、够读者翻样本，又不至于把报告撑成数据转储。 */
const EVIDENCE_POOL_SIZE = 64;
const EVIDENCE_POOL_MAX = 128;

/**
 * 竞品/被提及对象的匹配词表。
 *
 * 标签契约里没有实体字段（aspects 只有「竞品比较」这个维度），所以「提及了谁」只能
 * 从评论原文里做确定性匹配。词表是配置不是数字：改词表会改变统计结果，所以报告正文
 * 必须写明「名称由原文关键词匹配得到，未做实体消歧，被提及不代表构成竞品关系」。
 */
const COMPETITOR_LEXICON = [
  { key: "deepseek", label: "DeepSeek", pattern: /deepseek/i },
  { key: "gpt", label: "GPT", pattern: /gpt/i },
  { key: "claude", label: "Claude", pattern: /claude/i },
  { key: "codex", label: "Codex", pattern: /codex/i },
  { key: "glm", label: "GLM", pattern: /glm/i },
  { key: "kimi", label: "Kimi", pattern: /kimi/i },
  { key: "qwen", label: "Qwen", pattern: /qwen|通义/i },
  { key: "gemini", label: "Gemini", pattern: /gemini/i },
  { key: "llama", label: "Llama", pattern: /llama/i },
  { key: "grok", label: "Grok", pattern: /grok/i },
  { key: "doubao", label: "豆包", pattern: /豆包/i },
  { key: "wenxin", label: "文心一言", pattern: /文心/i },
  { key: "ollama", label: "Ollama", pattern: /ollama/i },
  { key: "cursor", label: "Cursor", pattern: /cursor/i },
  { key: "copilot", label: "Copilot", pattern: /copilot/i },
  { key: "chatgpt", label: "ChatGPT", pattern: /chatgpt/i },
  { key: "mistral", label: "Mistral", pattern: /mistral/i },
  { key: "midjourney", label: "Midjourney", pattern: /midjourney/i },
];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const sum = (list) => list.reduce((a, b) => a + b, 0);

/** 百分比：分母为 0 时返回 0，避免 NaN 让整份 view 校验失败。 */
const pct = (num, den) => (den > 0 ? round(num * 100 / den, 1) : 0);

function round(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number((Math.round(n * 10 ** digits) / 10 ** digits).toFixed(digits));
}

const fmtInt = (n) => String(Math.trunc(Number(n) || 0));
const fmtPct = (n) => `${round(n, 1).toFixed(1)}%`;
const fmtScore = (n) => round(n, 3).toFixed(3);

/** 逐行解析 JSONL。半截行（进程被 kill 时留下的）跳过，报告要能在中断的 run 上出。 */
function parseJsonl(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* 半截行，忽略 */ }
  }
  return out;
}

function readJsonIfExists(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** 评论正文/引文截断：schema 对 quote（4000）和 full_text（20000）有硬上限。 */
function clampText(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** 作品 id：platform + URL 短哈希。作品表和证据卡片共用，保证两边指向同一个作品。 */
function topicIdOf(row) {
  const key = row.topic_url ? `${row.platform}|${row.topic_url}` : `${row.platform}|${row.topic_title}`;
  return `${row.platform}:${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
}

/**
 * evidence_id 必须匹配渲染器的 /^C[1-9]\d*$/。
 *
 * 纯数字 comment_id（B 站/抖音这类雪花号）直接拼 `C<id>`：报告里的编号能一眼对回
 * 原始 JSONL，不用查映射表。但 Reddit 的 id 是 base36 字母数字混排（p0tt7ff），
 * 「只保留数字位」会把 p0tt7ff 和 p0v7lhk 都榨成 7 —— 两条证据撞成同一个编号，
 * 渲染器会以「evidence IDs must be unique」拒绝整份报告。所以非纯数字的走摘要取数字。
 */
export function evidenceIdFor(commentId) {
  const raw = String(commentId ?? "").trim();
  if (/^[1-9]\d*$/.test(raw)) return `C${raw}`;
  const digits = BigInt(`0x${createHash("sha1").update(raw).digest("hex").slice(0, 12)}`);
  return `C${digits % 8999999999n + 1000000000n}`;
}

/** 兜底：极端情况下两个原始 id 仍可能归一到同一编号，加盐重算直到唯一。 */
function uniqueEvidenceId(commentId, used) {
  let id = evidenceIdFor(commentId);
  let salt = 0;
  while (used.has(id)) {
    salt += 1;
    id = evidenceIdFor(`${commentId}#${salt}`);
  }
  used.add(id);
  return id;
}

/**
 * 编号发放器。编号按「计算顺序」递增，因此同一份输入永远得到同一套编号；
 * 两道各自独立编号，报告结构才能一一对应。
 */
class FactBook {
  constructor() {
    this.items = [];
  }

  /** @returns {string} NFxxxx */
  add(text) {
    const id = `NF${String(this.items.length + 1).padStart(4, "0")}`;
    this.items.push({ id, text: String(text) });
    return id;
  }
}

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

/** 按 key 计数，返回 Map（保持插入顺序，调用方负责排序）。 */
function countBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key == null) continue;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

/** 单值维度（情感/意图）：每个相关评论恰好落一格，占比之和为 100%。 */
function singleValueSummary(items, values, keyOf, book, idSink, labelOf) {
  const counts = countBy(items, keyOf);
  const out = {};
  for (const value of values) {
    const count = counts.get(value) ?? 0;
    const share = pct(count, items.length);
    out[value] = { count, pct: share };
    idSink[value] = {
      count: book.add(`${labelOf(value)}的相关评论数量：${fmtInt(count)} 条。`),
      pct: book.add(`${labelOf(value)}的相关评论占比：${fmtPct(share)}。`),
    };
  }
  return out;
}

/** 多标签维度（方面/情绪词）：一条评论可命中多个值，各值与相关评论数之比才是 pct。 */
function multiValueSummary(items, values, valuesOf, book, idSink, labelOf) {
  const counts = new Map();
  for (const item of items) {
    for (const value of valuesOf(item)) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const out = {};
  for (const value of values) {
    const count = counts.get(value) ?? 0;
    out[value] = { count, pct: pct(count, items.length) };
    idSink[value] = {
      count: book.add(`含「${labelOf(value)}」标签的评论数量：${fmtInt(count)} 条。`),
      pct: book.add(`含「${labelOf(value)}」标签的评论占相关评论比例：${fmtPct(pct(count, items.length))}。`),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * @param {"jev"|"deepseek"} lane
 * @param {{runDir:string, datasetPath:string}} opts
 * @returns {{facts:object, factCatalog:Array<{id:string,text:string}>}}
 */
export function buildFacts(lane, { runDir, datasetPath }) {
  const config = LANES[lane] ? { ...LANES[lane] } : null;
  if (!config) throw new Error(`未知的 lane "${lane}"，可选：${Object.keys(LANES).join(" / ")}`);
  if (!runDir) throw new Error("buildFacts 缺少 runDir");
  if (!datasetPath) throw new Error("buildFacts 缺少 datasetPath");

  const runPath = path.resolve(runDir);
  const dataPath = path.resolve(datasetPath);
  const labelPath = path.join(runPath, config.file);
  const manifest = readJsonIfExists(path.join(runPath, "manifest.json"));

  const labels = parseJsonl(readFileSync(labelPath, "utf8"));
  if (labels.length === 0) throw new Error(`标签文件为空：${labelPath}`);
  const { rows } = loadDataset(dataPath);
  const seen = new Set();
  for (const label of labels) {
    const id = String(label.comment_id ?? '');
    if (!id || seen.has(id)) throw new Error(`标签 ID 为空或重复：${id}`);
    seen.add(id);
  }

  // —— JOIN：两道的 comment_id 集合完全一致，直接按 id 对齐 ——
  const rowById = new Map(rows.map((row) => [String(row.comment_id), row]));
  const joined = [];
  let unmatched = 0;
  for (const label of labels) {
    const row = rowById.get(String(label.comment_id));
    if (!row) { unmatched++; continue; }
    joined.push({ label, row });
  }

  if (unmatched) throw new Error(`${unmatched} 条标签找不到原文，请提供这次运行的 CSV 快照`);

  const relevant = joined.filter(({ label }) => label.is_relevant === true);

  const book = new FactBook();
  const ids = { sentiment: {}, intent: {}, aspect: {}, emotion: {}, platform: {}, timeline: {} };

  const laneMeta = (manifest?.lanes ?? []).find((item) => item?.id === lane) ?? {};
  config.label = laneMeta.label || config.label;
  config.backend = labels.find(label => label.meta?.backend)?.meta?.backend || config.backend;
  const source = labels.find(label => label.evidenceSource || label.meta?.evidenceSource);
  const evidenceSource = source?.evidenceSource || source?.meta?.evidenceSource;
  if (evidenceSource === 'host' || evidenceSource === 'model') {
    config.evidenceSource = evidenceSource;
    config.evidenceSourceNote = evidenceSource === 'host'
      ? '引文由宿主程序从原文机械摘取，不是模型自述'
      : '引文由模型摘录，宿主校验原文子串';
  }
  const model = String(
    labels.find((label) => label?.meta?.model)?.meta?.model
      ?? laneMeta.model
      ?? config.model,
  );

  // —— run / dataset ——
  const datasetFingerprint = createHash("sha256").update(readFileSync(dataPath)).digest("hex");
  const platformCounts = countBy(rows, (row) => String(row.platform || "unknown"));
  const platformList = [...platformCounts.entries()]
    .map(([platform, count]) => ({ platform, label: PLATFORM_LABELS[platform] ?? platform, count }))
    .sort((a, b) => b.count - a.count || a.platform.localeCompare(b.platform));
  const topicKeyOf = (row) => (row.topic_url ? `${row.platform}|${row.topic_url}` : `${row.platform}|${row.topic_title}`);
  const topicCount = new Set(rows.map(topicKeyOf)).size;
  const dates = [...new Set(joined.map(({ row }) => String(row.created_at || "").slice(0, 10)).filter(Boolean))].sort();

  const run = {
    id: String(manifest?.runId ?? path.basename(runPath)),
    lane,
    label: config.label,
    model,
    backend: config.backend,
    evidenceSource: config.evidenceSource,
    labelFile: labelPath,
    datasetPath: dataPath,
    startedAt: manifest?.startedAt ?? null,
    finishedAt: manifest?.finishedAt ?? manifest?.reportAt ?? null,
  };

  const dataset = {
    total: rows.length,
    topicCount,
    topicCountInLabels: new Set(joined.map(({ row }) => topicKeyOf(row))).size,
    // 报告的分析对象名默认取「评论量最大的作品」——它是这批样本里真实存在的东西，
    // 而不是某个写死的产品名。真正的标题由 narrative.identity.subject 覆盖。
    topTopicTitle: null,
    platforms: Object.fromEntries(platformList.map((item) => [item.platform, item.count])),
    platformList,
    dates,
    fingerprint: datasetFingerprint,
  };

  // —— coverage ——
  const labeledCount = joined.length;
  const relevantCount = relevant.length;
  const avgSentimentScore = relevantCount
    ? round(sum(relevant.map(({ label }) => Number(label.sentiment_score) || 0)) / relevantCount, 3)
    : 0;

  const idSnapshot = book.add(`快照评论数：${fmtInt(dataset.total)} 条。`);
  const idLabeled = book.add(`成功标注并进入统计的评论数：${fmtInt(labeledCount)} 条。`);
  const idRelevant = book.add(`相关评论数：${fmtInt(relevantCount)} 条。`);
  const idLabeledPct = book.add(`标注完成率：${fmtPct(pct(labeledCount, dataset.total))}。`);
  const idRelevantPct = book.add(`已标注评论中的相关占比：${fmtPct(pct(relevantCount, labeledCount))}。`);
  const idAvgScore = book.add(`相关评论的平均情感分：${fmtScore(avgSentimentScore)}（取值区间 -1 到 1）。`);
  const idUnmatched = book.add(`标签里未能在评论表中找到原文的评论数：${fmtInt(unmatched)} 条。`);
  const idTopicCount = book.add(`本批样本覆盖的作品数：${fmtInt(topicCount)} 个。`);
  const idPlatformCount = book.add(`本批样本覆盖的平台数：${fmtInt(platformList.length)} 个。`);
  const idDateCount = book.add(`本批样本覆盖的日期数：${fmtInt(dates.length)} 天。`);

  const coverage = {
    topics: topicCount,
    comments_in_snapshot: dataset.total,
    labeled_comments: labeledCount,
    relevant_comments: relevantCount,
    irrelevant_comments: labeledCount - relevantCount,
    failed_comments: 0, // 决斗场的 runner 只把成功标签写进 JSONL，失败条目不落盘
    labeled_pct: pct(labeledCount, dataset.total),
    relevant_pct: pct(relevantCount, labeledCount),
    avg_sentiment_score: avgSentimentScore,
    unmatched_comments: unmatched,
  };

  // —— summary：情感 / 立场 / 意图 / 方面 / 情绪词 ——
  const sentimentSummary = singleValueSummary(
    relevant,
    SENTIMENTS,
    ({ label }) => String(label.sentiment || "neutral"),
    book,
    ids.sentiment,
    (key) => `情绪为「${SENTIMENT_CN[key]}」`,
  );

  // 立场：本批标签没有 stance 字段，用情绪做确定性映射并如实标注为派生口径。
  const stanceOf = ({ label }) => STANCE_FROM_SENTIMENT[String(label.sentiment || "neutral")] ?? "neutral";
  const stanceSummary = {};
  for (const value of ["support", "oppose", "neutral"]) {
    const count = relevant.filter((item) => stanceOf(item) === value).length;
    stanceSummary[value] = { count, pct: pct(count, relevantCount) };
  }
  const idStanceNote = book.add(
    `立场为派生字段：由情绪确定性映射（正面→支持、负面→反对、其余→中立），`
    + `支持 ${fmtInt(stanceSummary.support.count)} 条、反对 ${fmtInt(stanceSummary.oppose.count)} 条、`
    + `中立 ${fmtInt(stanceSummary.neutral.count)} 条。`,
  );

  const intentSummary = singleValueSummary(
    relevant,
    INTENTS,
    ({ label }) => String(label.intent || "other"),
    book,
    ids.intent,
    (key) => `意图为「${INTENT_CN[key]}」`,
  );

  const aspectSummary = multiValueSummary(
    relevant,
    Object.keys(ASPECTS),
    ({ label }) => (Array.isArray(label.aspects) ? label.aspects : []),
    book,
    ids.aspect,
    (key) => ASPECTS[key],
  );

  const emotionSummary = multiValueSummary(
    relevant,
    EMOTIONS,
    ({ label }) => (Array.isArray(label.emotion) ? label.emotion : []),
    book,
    ids.emotion,
    (key) => key,
  );

  const summary = {
    sentiment: sentimentSummary,
    stance: stanceSummary,
    intent: intentSummary,
    aspects: aspectSummary,
    emotion: emotionSummary,
  };

  const idSentimentMethod = book.add(
    `情感占比的分母是相关评论数（${fmtInt(relevantCount)} 条），不是已标注评论数。`,
  );
  const idAspectMethod = book.add(
    `方面是多标签：同一条评论可同时命中多个方面，因此各方面占比之和大于 100% 属正常，`
    + `有方面标签的相关评论共 ${fmtInt(relevant.filter(({ label }) => (label.aspects ?? []).length > 0).length)} 条。`,
  );

  // —— analysis：方面 × 情绪、意图 × 情绪 ——
  // members 只在这里内部用：facts 是要被 JSON.stringify 的，塞进整条评论会让
  // 事实层体积失控（一万条评论 × 两个维度）。对外只留聚合数字 + 成员 comment_id。
  // key 必须带维度前缀：ASPECTS 和 INTENTS 里都有 "other"，裸 key 会串台。
  const rowMemberIds = new Map();
  const buildRow = (dimension, key, label, members) => {
    const sentimentCounts = countBy(members, ({ label: item }) => String(item.sentiment || "neutral"));
    const intentCounts = countBy(members, ({ label: item }) => String(item.intent || "other"));
    const count = members.length;
    rowMemberIds.set(`${dimension}:${key}`, new Set(members.map(({ label: item }) => String(item.comment_id))));
    return {
      key,
      label,
      count,
      pct_of_relevant: pct(count, relevantCount),
      topic_count: new Set(members.map(({ row }) => topicKeyOf(row))).size,
      positive: sentimentCounts.get("positive") ?? 0,
      negative: sentimentCounts.get("negative") ?? 0,
      neutral: sentimentCounts.get("neutral") ?? 0,
      mixed: sentimentCounts.get("mixed") ?? 0,
      questions: intentCounts.get("question") ?? 0,
      suggestions: intentCounts.get("suggestion") ?? 0,
      corrections: intentCounts.get("correction") ?? 0,
    };
  };

  const aspectRows = Object.keys(ASPECTS)
    .map((key) => buildRow(
      "aspect",
      key,
      ASPECTS[key],
      relevant.filter(({ label }) => (label.aspects ?? []).includes(key)),
    ))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  const intentRows = INTENTS
    .map((key) => buildRow(
      "intent",
      key,
      INTENT_CN[key],
      relevant.filter(({ label }) => String(label.intent || "other") === key),
    ))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  // 每行把正文要用的数字都登记成事实，正文只引用编号。
  // 「方面」和「意图」说的话不一样：方面是「含 X 方面标签的评论」，意图是「意图为 X 的评论」，
  // 两个维度里都有一个叫「其他」的取值，不区分措辞就会读成同一件事。
  const rowFactIds = {};
  for (const [dimension, rows] of [["aspect", aspectRows], ["intent", intentRows]]) {
    for (const row of rows) {
      const phrase = dimension === "aspect"
        ? `含「${row.label}」方面标签的评论`
        : `意图为「${row.label}」的相关评论`;
      rowFactIds[`${dimension}:${row.key}`] = {
        count: book.add(`${phrase}数量：${fmtInt(row.count)} 条。`),
        pct: book.add(`${phrase}占相关评论比例：${fmtPct(row.pct_of_relevant)}。`),
        positive: book.add(`${phrase}中整条评论情绪为正面的数量：${fmtInt(row.positive)} 条。`),
        negative: book.add(`${phrase}中整条评论情绪为负面的数量：${fmtInt(row.negative)} 条。`),
        neutral: book.add(`${phrase}中整条评论情绪为中性的数量：${fmtInt(row.neutral)} 条。`),
        mixed: book.add(`${phrase}中整条评论情绪为混合的数量：${fmtInt(row.mixed)} 条。`),
        questions: book.add(`${phrase}中提问数量：${fmtInt(row.questions)} 条。`),
        suggestions: book.add(`${phrase}中建议数量：${fmtInt(row.suggestions)} 条。`),
        corrections: book.add(`${phrase}中纠错数量：${fmtInt(row.corrections)} 条。`),
        topicCount: book.add(`${phrase}来自 ${fmtInt(row.topic_count)} 个作品。`),
      };
    }
  }

  // —— platforms ——
  const platformRows = platformList.map(({ platform, label, count }) => {
    const members = joined.filter(({ row }) => String(row.platform) === platform);
    const relMembers = members.filter(({ label: item }) => item.is_relevant === true);
    const sentimentCounts = countBy(relMembers, ({ label: item }) => String(item.sentiment || "neutral"));
    const avg = relMembers.length
      ? round(sum(relMembers.map(({ label: item }) => Number(item.sentiment_score) || 0)) / relMembers.length, 3)
      : 0;
    const row = {
      platform,
      label,
      supported: VIEW_PLATFORMS.includes(platform),
      topics: new Set(members.map(topicKeyOf)).size,
      snapshot_comments: count,
      labeled_comments: members.length,
      relevant_comments: relMembers.length,
      positive_pct: pct(sentimentCounts.get("positive") ?? 0, relMembers.length),
      negative_pct: pct(sentimentCounts.get("negative") ?? 0, relMembers.length),
      neutral_pct: pct(sentimentCounts.get("neutral") ?? 0, relMembers.length),
      mixed_pct: pct(sentimentCounts.get("mixed") ?? 0, relMembers.length),
      avg_sentiment_score: avg,
    };
    ids.platform[platform] = {
      snapshot: book.add(`平台「${label}」的快照评论数：${fmtInt(row.snapshot_comments)} 条。`),
      relevant: book.add(`平台「${label}」的相关评论数：${fmtInt(row.relevant_comments)} 条。`),
      positivePct: book.add(`平台「${label}」相关评论中的正面占比：${fmtPct(row.positive_pct)}。`),
      negativePct: book.add(`平台「${label}」相关评论中的负面占比：${fmtPct(row.negative_pct)}。`),
      avgScore: book.add(`平台「${label}」相关评论的平均情感分：${fmtScore(row.avg_sentiment_score)}。`),
    };
    return row;
  });

  // —— timeline ——
  const timelineRows = dates.map((date) => {
    const members = joined.filter(({ row }) => String(row.created_at || "").startsWith(date));
    const relMembers = members.filter(({ label }) => label.is_relevant === true);
    const sentimentCounts = countBy(relMembers, ({ label }) => String(label.sentiment || "neutral"));
    const row = {
      date,
      labeled_comments: members.length,
      relevant_comments: relMembers.length,
      positive: sentimentCounts.get("positive") ?? 0,
      negative: sentimentCounts.get("negative") ?? 0,
      neutral: sentimentCounts.get("neutral") ?? 0,
      mixed: sentimentCounts.get("mixed") ?? 0,
    };
    ids.timeline[date] = {
      labeled: book.add(`${date} 当天进入统计的评论数：${fmtInt(row.labeled_comments)} 条。`),
      relevant: book.add(`${date} 当天的相关评论数：${fmtInt(row.relevant_comments)} 条。`),
    };
    return row;
  });

  // —— topics：作品级明细 ——
  // topic_id 用 platform + URL 短哈希：报告里要能唯一定位一个作品（同名作品在不同平台
  // 是两条），但完整 URL 带 query 太长，直接进 UI 会把表格撑爆。
  const topicGroups = new Map();
  for (const item of joined) {
    const key = topicKeyOf(item.row);
    let group = topicGroups.get(key);
    if (!group) {
      group = { key, row: item.row, members: [] };
      topicGroups.set(key, group);
    }
    group.members.push(item);
  }

  const topicRows = [...topicGroups.values()].map((group) => {
    const relMembers = group.members.filter(({ label }) => label.is_relevant === true);
    const sentimentCounts = countBy(relMembers, ({ label }) => String(label.sentiment || "neutral"));
    const positivePct = pct(sentimentCounts.get("positive") ?? 0, relMembers.length);
    const negativePct = pct(sentimentCounts.get("negative") ?? 0, relMembers.length);
    return {
      topic_id: topicIdOf(group.row),
      title: String(group.row.topic_title || "未命名作品"),
      url: String(group.row.topic_url || "").trim() || null,
      platform: String(group.row.platform || ""),
      platform_label: PLATFORM_LABELS[String(group.row.platform)] ?? String(group.row.platform),
      snapshot_comments: group.members.length,
      labeled_relevant: relMembers.length,
      positive_pct: positivePct,
      negative_pct: negativePct,
      // 正负情绪均衡度：正负两边越接近越接近 100（0 表示情绪一边倒）。
      // 用「1 - 差/和」而不是「min/max」，是为了和参考报告的 96.4 这种量级对得上。
      controversy_score: positivePct + negativePct > 0
        ? round((1 - Math.abs(positivePct - negativePct) / (positivePct + negativePct)) * 100, 1)
        : 0,
    };
  }).sort((a, b) => b.snapshot_comments - a.snapshot_comments
    || b.labeled_relevant - a.labeled_relevant
    || a.title.localeCompare(b.title));

  dataset.topTopicTitle = topicRows[0]?.title ?? "未命名样本";
  const idSubject = book.add(
    `本批样本覆盖 ${fmtInt(topicCount)} 个作品，评论量最大的是「${clampText(dataset.topTopicTitle, 100)}」。`,
  );

  const idTopicRows = {};
  topicRows.slice(0, 5).forEach((topic, index) => {
    idTopicRows[index + 1] = {
      title: book.add(`评论量第 ${fmtInt(index + 1)} 的作品标题：${clampText(topic.title, 120)}。`),
      snapshot: book.add(`作品「${clampText(topic.title, 60)}」的快照评论数：${fmtInt(topic.snapshot_comments)} 条。`),
      relevant: book.add(`作品「${clampText(topic.title, 60)}」的相关评论数：${fmtInt(topic.labeled_relevant)} 条。`),
    };
  });

  // —— competitors：被提及对象（原文关键词匹配，不是模型标签）——
  // 标签契约里没有实体字段，所以「提到了谁」只能从原文里确定性匹配。
  // 这是词表匹配，不是实体识别：同一产品的不同写法不会合并，也不会消歧。
  const competitorRows = COMPETITOR_LEXICON
    .map(({ key, label, pattern }) => {
      const count = relevant.filter(({ row }) => pattern.test(String(row.content || ""))).length;
      return { key, label, count, pct_of_relevant: pct(count, relevantCount) };
    })
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  const idCompetitors = {};
  competitorRows.slice(0, 5).forEach((row) => {
    idCompetitors[row.key] = book.add(
      `评论原文中提到「${row.label}」的相关评论数量：${fmtInt(row.count)} 条`
      + `（占相关评论 ${fmtPct(row.pct_of_relevant)}；关键词匹配，未做实体消歧）。`,
    );
  });
  const idCompetitorMethod = book.add(
    `「被提及对象」由 ${fmtInt(COMPETITOR_LEXICON.length)} 个关键词从评论原文匹配得到，`
    + `不是模型给出的实体标签；被提及不代表构成竞品关系，不同写法也未合并。`,
  );

  // —— 口碑 / 质量口径 ——
  const lowConfidence = relevant.filter(({ label }) => (Number(label.confidence) || 0) < LOW_CONFIDENCE_THRESHOLD);
  const quoteMissing = joined.filter(({ label }) => !String(label.evidence_quote || "").trim());
  const quoteUnverified = joined.filter(({ label }) => String(label.evidence_quote || "").trim() && label?.meta?.quoteVerified !== true);
  const hostExtracted = joined.filter(({ label }) => label?.meta?.evidenceSource === "host");
  const modelExtracted = joined.filter(({ label }) => label?.meta?.evidenceSource === "model");

  const idLowConf = book.add(
    `模型自报置信度低于 ${LOW_CONFIDENCE_THRESHOLD} 的相关评论数量：${fmtInt(lowConfidence.length)} 条`
    + `（占相关评论 ${fmtPct(pct(lowConfidence.length, relevantCount))}；置信度是模型自报值，不是校准后的准确率）。`,
  );
  const idQuoteMissing = book.add(
    `没有可用引文的相关评论数量：${fmtInt(quoteMissing.filter(({ label }) => label.is_relevant === true).length)} 条`
    + `（引文为空时由宿主从原文截取并标注，全文共 ${fmtInt(quoteMissing.length)} 条相关或无关评论没有引文）。`,
  );
  const idQuoteUnverified = book.add(
    `引文未通过「原文逐字子串」校验因而被置空的评论数量：${fmtInt(quoteUnverified.length)} 条。`,
  );
  const idQuoteSource = book.add(
    config.evidenceSource === "host"
      ? `本道引文来源：宿主从原文机械摘取（${fmtInt(hostExtracted.length)} 条）。引用位置由程序选择，不是模型给出的证据。`
      : `本道引文来源：模型自己摘录（${fmtInt(modelExtracted.length)} 条），宿主只做「是否为原文子串」的机械校验。`,
  );

  const quality = {
    low_confidence_count: lowConfidence.length,
    low_confidence_threshold: LOW_CONFIDENCE_THRESHOLD,
    low_confidence_pct: pct(lowConfidence.length, relevantCount),
    quote_missing_count: quoteMissing.length,
    quote_missing_relevant_count: quoteMissing.filter(({ label }) => label.is_relevant === true).length,
    quote_unverified_count: quoteUnverified.length,
    evidence_source: config.evidenceSource,
    evidence_source_note: config.evidenceSourceNote,
    host_extracted_quote_count: hostExtracted.length,
    model_extracted_quote_count: modelExtracted.length,
    // 样本集中度：单个作品/前三个作品占相关评论的比例，避免把一部视频的情绪当成全网
    top_topic_share_pct: topTopicShare(relevant, topicKeyOf, 1),
    top_three_topic_share_pct: topTopicShare(relevant, topicKeyOf, 3),
  };

  const idTopTopic = book.add(
    `相关评论最多的单个作品占相关评论的 ${fmtPct(quality.top_topic_share_pct)}；`
    + `前三个作品合计占 ${fmtPct(quality.top_three_topic_share_pct)}。`,
  );

  // —— evidence：按点赞排序的证据池 ——
  const evidence = selectEvidence({ relevant, book });

  // 交叉分析表每行挂最多 3 条证据编号，读者能直接点进原文样本库核对。
  // 只能引用证据池里真实存在的编号，否则渲染器的 schema 校验会直接拒绝整份 view。
  const attachEvidence = (rows, dimension) => {
    for (const row of rows) {
      const memberIds = rowMemberIds.get(`${dimension}:${row.key}`) ?? new Set();
      row.evidence_ids = evidence.items
        .filter((item) => memberIds.has(item.comment_id)) // evidence.items 已按点赞降序
        .slice(0, 3)
        .map((item) => item.evidence_id);
    }
  };
  attachEvidence(aspectRows, "aspect");
  attachEvidence(intentRows, "intent");

  const facts = {
    run,
    dataset,
    coverage,
    summary,
    analysis: { aspect: aspectRows, intent: intentRows },
    platforms: platformRows,
    timeline: timelineRows,
    topics: topicRows,
    competitors: competitorRows,
    quality,
    evidence,
    /** 名字 → NF 编号。正文写作时按名字取编号，不要手抄编号（抄错会指到别的数字上）。 */
    factIds: {
      snapshotComments: idSnapshot,
      labeledComments: idLabeled,
      relevantComments: idRelevant,
      labeledPct: idLabeledPct,
      relevantPct: idRelevantPct,
      avgSentimentScore: idAvgScore,
      unmatchedComments: idUnmatched,
      topicCount: idTopicCount,
      subject: idSubject,
      platformCount: idPlatformCount,
      dateCount: idDateCount,
      sentenceMethod: idSentimentMethod,
      aspectMethod: idAspectMethod,
      stanceMethod: idStanceNote,
      lowConfidenceCount: idLowConf,
      quoteMissingCount: idQuoteMissing,
      quoteUnverifiedCount: idQuoteUnverified,
      quoteSource: idQuoteSource,
      topTopicShare: idTopTopic,
      distribution: {
        sentiment: ids.sentiment,
        intent: ids.intent,
        aspect: ids.aspect,
        emotion: ids.emotion,
      },
      analysis: rowFactIds,
      platform: ids.platform,
      timeline: ids.timeline,
      topic: idTopicRows,
      competitor: idCompetitors,
      competitorMethod: idCompetitorMethod,
    },
  };

  // facts 上挂一份 catalog 副本：buildView 的签名是 { facts, narrative, lane }，
  // 不带第三个参数，所以 catalog 要能从 facts 里拿到，才能把 fact_id 还原成正文。
  facts.factCatalog = book.items;

  return { facts, factCatalog: book.items };
}

/** 样本集中度：相关评论里，评论量前 n 的作品合计占比。 */
function topTopicShare(relevant, topicKeyOf, n) {
  if (relevant.length === 0) return 0;
  const counts = countBy(relevant, ({ row }) => topicKeyOf(row));
  const top = [...counts.values()].sort((a, b) => b - a).slice(0, n);
  return pct(sum(top), relevant.length);
}

/**
 * 证据池：按点赞数从高到低取前 N 条。
 *
 * 这里刻意**不看标签**（不按情绪/方面/意图分层抽样）。两道报告的标签一定不同，
 * 一旦证据挑选依赖标签，左右两栏就会显示不同的评论，读者没办法判断差异来自
 * 「模型判断不同」还是「程序挑了不同的样本」。按点赞排序是纯数据的、与标签无关的
 * 规则，两道看到的原文样本库因此几乎完全一致（相关性判定本身仍各算各的），
 * 差别只剩评论上的标签——这正是要对比的东西。
 *
 * 排序完全确定：同赞数按 comment_id 兜底，换机器重跑顺序一致。
 */
function selectEvidence({ relevant, book }) {
  const byLikes = (a, b) => (Number(b.row.like_count) || 0) - (Number(a.row.like_count) || 0)
    || String(a.label.comment_id).localeCompare(String(b.label.comment_id));

  const ordered = [...relevant].sort(byLikes).slice(0, Math.min(EVIDENCE_POOL_SIZE, EVIDENCE_POOL_MAX));

  const usedIds = new Set();
  const items = ordered.map(({ label, row }) => {
    const rawQuote = String(label.evidence_quote || "").trim();
    const content = String(row.content || "");
    const hostFallback = !rawQuote;
    // 引文为空时从原文截取：截取片段必须标记出来，不能让读者以为是模型给的证据。
    const quote = clampText(rawQuote || `${content.slice(0, 160)}${content.length > 160 ? "…" : ""}`, 4000) || "（原文为空）";
    const evidenceId = uniqueEvidenceId(label.comment_id, usedIds);
    return {
      evidence_id: evidenceId,
      comment_id: String(label.comment_id),
      sentiment: SENTIMENTS.includes(String(label.sentiment)) ? String(label.sentiment) : "neutral",
      intent: INTENTS.includes(String(label.intent)) ? String(label.intent) : "other",
      // 立场是派生口径（本批标签没有 stance 字段），报告正文会写明映射规则
      stance: STANCE_FROM_SENTIMENT[String(label.sentiment || "neutral")] ?? "neutral",
      opinion_target: "other", // 本批标签未标注评价对象，统一落「其他」，不假装有这项判断
      like_count: Math.max(0, Math.trunc(Number(row.like_count) || 0)),
      quote,
      quote_from_host: hostFallback || label?.meta?.evidenceSource === "host",
      quote_fallback: hostFallback,
      full_text: clampText(content, 20000),
      source_url: String(row.topic_url || "").trim() || null,
      topic_id: topicIdOf(row),
      topic_title: clampText(String(row.topic_title || "未命名作品").trim(), 400),
      platform: String(row.platform || ""),
      author: String(row.author || ""),
      created_at: String(row.created_at || ""),
      aspects: (label.aspects ?? []).slice(0, 5),
      confidence: Math.min(1, Math.max(0, Number(label.confidence) || 0)),
      requires_context: hostFallback,
      evidence_source: label?.meta?.evidenceSource ?? null,
    };
  });

  // 每条证据的引文来源单独登记，正文/图注可以直接引用
  const perItemFactIds = {};
  items.forEach((item, index) => {
    perItemFactIds[item.evidence_id] = book.add(
      `证据 ${item.evidence_id}（点赞 ${fmtInt(item.like_count)}）的引文来源：`
      + `${item.quote_from_host ? "宿主从原文机械摘取" : "模型自己摘录"}`
      + `${item.quote_fallback ? "（模型未给引文，此处为宿主截取）" : ""}。`,
    );
    void index;
  });

  const poolSizeId = book.add(
    `报告选取的原文样本数：${fmtInt(items.length)} 条（按点赞数优先选取，属于诊断样本，不保证覆盖每个类别或代表总体）。`,
  );

  return {
    items,
    pool_size: items.length,
    factId: poolSizeId,
    factIds: perItemFactIds,
    evidence_source: items[0]?.evidence_source ?? null,
  };
}

/** 情绪 → 立场。本批标签没有 stance 字段，映射规则固定且会写进报告。 */
const STANCE_FROM_SENTIMENT = {
  positive: "support",
  negative: "oppose",
  neutral: "neutral",
  mixed: "neutral",
};

export const SENTIMENT_CN = {
  positive: "正面",
  negative: "负面",
  neutral: "中性",
  mixed: "复杂/混合",
};

export const INTENT_CN = {
  praise: "赞扬",
  complaint: "抱怨",
  question: "提问",
  suggestion: "建议",
  correction: "纠错",
  agreement: "赞同",
  disagreement: "反对观点",
  joke: "玩梗",
  information: "信息补充",
  other: "其他",
};

export default { buildFacts, LANES, evidenceIdFor };
