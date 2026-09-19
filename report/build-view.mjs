/**
 * 视图层：facts（+ 正文 narrative）→ 严格 vox-report-view-v1 JSON。
 *
 * 这一层只做三件事，一行统计都不算：
 *  1. **结构组装**：把 facts 摆成 VoxAgent 渲染器认得的区块（分布 / 排行 / 时间线 /
 *     平台 / 作品 / 证据 / 交叉分析 / 六节正文）。
 *  2. **边界收敛**：渲染器的 schema 对每个字段都有长度和取值范围，超界不是「显示难看」
 *     而是**整份报告渲染失败**。所以这里统一截断、取整、夹逼，宁可截掉也不能让
 *     HTML 出不来。
 *  3. **正文事实协议**：正文块的 fact-list 只允许出现 `NFxxxx` 编号，编号必须能在
 *     facts.factCatalog 里查到。查不到直接抛错——那是写作 bug，不能悄悄丢掉一句话。
 *
 * 为什么两道共用这一份代码：报告长得一模一样、只有数字不同，是做 A/B 阅读的前提。
 * 只要区块顺序、标题、口径说明有一处不一样，观众就会怀疑「是不是故意把某一道做好看了」。
 * lane 参数在这里只用来取 lane 自己的 facts，不改变任何布局分支。
 */

import { createHash } from "node:crypto";

import { ASPECTS, EMOTIONS, INTENTS, SENTIMENTS } from "../src/vocab.mjs";
import { INTENT_CN, SENTIMENT_CN } from "./facts.mjs";

export const SCHEMA_VERSION = "vox-report-view-v1";

/** 六节的固定顺序与标题。渲染器的 section id 是闭集，少一节都会让结构对不齐。 */
export const SECTION_ORDER = [
  "executive-summary",
  "method",
  "core-findings",
  "subject-insights",
  "risks",
  "actions",
];

const SECTION_TITLES = {
  "executive-summary": "执行摘要",
  method: "样本与方法",
  "core-findings": "核心发现",
  "subject-insights": "分析对象洞察",
  risks: "风险与争议",
  actions: "行动建议",
};

const SENTIMENT_LABELS = SENTIMENT_CN;
const SENTIMENT_TONES = {
  positive: "positive",
  negative: "negative",
  neutral: "neutral",
  mixed: "mixed",
};
const INTENT_LABELS = INTENT_CN;
const STANCE_LABELS = { support: "支持", oppose: "反对", neutral: "中立" };
// 本批标签没有评价对象字段，统一落「其他」；报告里不会假装有这项判断。
const OPINION_TARGET_LABELS = { other: "其他" };

/** 作品表最多展示多少个作品（facts 里有全部，view 只带前 N 个，避免 HTML 过大）。 */
const MAX_DISPLAYED_TOPICS = 20;

// ---------------------------------------------------------------------------
// 边界收敛工具
// ---------------------------------------------------------------------------

/** 截断到 schema 允许的长度。超长 topic_title / quote 是真实存在的，必须兜住。 */
function text(value, max, fallback = "") {
  const raw = String(value ?? "").trim();
  const base = raw || fallback;
  if (base.length <= max) return base;
  return `${base.slice(0, Math.max(0, max - 1))}…`;
}

const int = (value) => Math.max(0, Math.trunc(Number(value) || 0));
const num = (value, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
};
const percentage = (value) => num(value, 0, 100);
const round1 = (value) => Number((Number(value) || 0).toFixed(1));

/** URL 只允许 http(s)，其余（空串、相对路径、脏数据）一律 null，否则 schema 直接拒收。 */
function httpUrlOrNull(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/** 稳定 UUID：同一份数据集指纹永远得到同一个 public id，两道报告才能并排引用。 */
function datasetPublicId(fingerprint) {
  const hex = createHash("sha256").update(`jev-arena:${fingerprint}`).digest("hex");
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** run_id 只接受正整数：把 "0919-124001" 里的数字抽出来当 id，保持可复算。 */
function runIdNumber(runId) {
  const digits = String(runId ?? "").replace(/\D+/g, "").replace(/^0+/, "");
  const value = Number.parseInt(digits || "1", 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function generatedAt(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

// ---------------------------------------------------------------------------
// 文案（全部由 facts 派生，不写死产品名）
// ---------------------------------------------------------------------------

function defaultSubject(facts) {
  const top = facts.dataset?.topTopicTitle;
  const topics = int(facts.coverage?.topics);
  if (!top) return "评论样本";
  // 样本覆盖几百个作品，用「评论量最大的作品 + 作品数」描述，比编一个产品名诚实
  return text(`${top}（等 ${topics} 个作品的评论样本）`, 240, "评论样本");
}

function defaultResearchQuestion() {
  // identity 不是正文，不受「不许写数字」约束，但这里本来也不需要数字。
  return "同一批评论、两套自动标签：观众分别被判定在认可什么、质疑什么？"
    + "情绪、意图、讨论方面与被提及对象的构成如何，哪些原文能支撑这些数字，"
    + "以及两套标签在哪一类评论上分歧最大？";
}

// ---------------------------------------------------------------------------
// 正文（narrative）组装
// ---------------------------------------------------------------------------

/**
 * narrative 允许两种写法，避免写作者被 schema 细节卡住：
 *  - fact-list 的 item 写成 `{ fact_id: "NF0001" }`：文本由 catalog 自动填（推荐）；
 *  - 或直接写 `{ fact_id, text }`：文本原样使用（必须是 catalog 里的句子，改一个字
 *    就等于把正文数字和表格数字拆成两套，所以 buildView 只信 catalog）。
 */
function resolveFactItem(item, catalog) {
  const factId = typeof item === "string" ? item : String(item?.fact_id ?? "");
  if (!/^NF\d{4}$/.test(factId)) {
    throw new Error(`正文引用了非法的事实编号：${JSON.stringify(item)}（格式必须是 NF0001）`);
  }
  const catalogText = catalog.get(factId);
  if (!catalogText) {
    throw new Error(`正文引用了不存在的事实编号 ${factId}；事实编号必须来自 facts.factCatalog`);
  }
  return { fact_id: factId, text: text(catalogText, 1200) };
}

function sanitizeSpan(span, evidenceIds, where) {
  const type = String(span?.type ?? "text");
  if (type === "evidence-ref") {
    const evidenceId = String(span?.evidence_id ?? "");
    if (!evidenceIds.has(evidenceId)) {
      throw new Error(`${where} 引用了不存在于证据池的 evidence_id：${evidenceId}`);
    }
    return { type: "evidence-ref", evidence_id: evidenceId };
  }
  if (type === "strong" || type === "code") {
    return { type, value: text(span?.value, 400, "—") };
  }
  return { type: "text", value: text(span?.value, 1600, "—") };
}

function sanitizeBlock(block, { catalog, evidenceIds, where }) {
  const type = String(block?.type ?? "");
  if (type === "paragraph") {
    const spans = (Array.isArray(block?.spans) ? block.spans : [])
      .map((span) => sanitizeSpan(span, evidenceIds, where))
      .slice(0, 40);
    // 渲染器要求 paragraph 至少有一个 span；空段落给一个占位符而不是删块，
    // 否则某一节可能整节消失，两道报告的结构就对不齐了。
    return { type: "paragraph", spans: spans.length ? spans : [{ type: "text", value: "—" }] };
  }
  if (type === "fact-list") {
    const items = (Array.isArray(block?.items) ? block.items : [])
      .map((item) => resolveFactItem(item, catalog))
      .slice(0, 24);
    if (items.length === 0) throw new Error(`${where} 的 fact-list 为空，事实清单至少要有 1 条`);
    return { type: "fact-list", items };
  }
  if (type === "evidence-quote") {
    const evidenceId = String(block?.evidence_id ?? "");
    if (!evidenceIds.has(evidenceId)) {
      throw new Error(`${where} 引用了不存在于证据池的 evidence_id：${evidenceId}`);
    }
    return { type: "evidence-quote", evidence_id: evidenceId };
  }
  if (type === "action-list") {
    const items = (Array.isArray(block?.items) ? block.items : [])
      .map((item) => text(item, 1000))
      .filter(Boolean)
      .slice(0, 12);
    if (items.length === 0) throw new Error(`${where} 的 action-list 为空`);
    return { type: "action-list", items };
  }
  throw new Error(`${where} 出现了渲染器不支持的区块类型：${JSON.stringify(block?.type)}（只允许 paragraph / fact-list / evidence-quote / action-list）`);
}

function buildSections(narrative, { catalog, evidenceIds }) {
  const provided = narrative?.sections ?? {};
  return SECTION_ORDER.map((id) => {
    const definition = Array.isArray(provided)
      ? provided.find((item) => item?.id === id)
      : provided[id];
    const where = `章节 ${id}`;
    let blocks = (Array.isArray(definition?.blocks) ? definition.blocks : [])
      .map((block) => sanitizeBlock(block, { catalog, evidenceIds, where }))
      .slice(0, 30);
    if (blocks.length === 0) {
      blocks = [{
        type: "paragraph",
        spans: [{ type: "text", value: "本章节正文尚未撰写；结构与全部数字已在其他区块就位。" }],
      }];
    }
    return { id, title: text(definition?.title ?? SECTION_TITLES[id], 120, SECTION_TITLES[id]), blocks };
  });
}

/**
 * 占位正文：正文还没写的时候，也要能渲染出一份结构完整的 HTML。
 * 只引用 factCatalog 里的编号，所以页面上出现的每个数字都和图表同源。
 */
export function placeholderNarrative(facts) {
  const F = facts.factIds ?? {};
  const analysis = F.analysis ?? {};
  const pick = (...ids) => ids.filter(Boolean);
  const fallback = (facts.factCatalog ?? []).slice(0, 4).map((item) => item.id);
  const topAspect = (facts.analysis?.aspect ?? [])[0];
  const topAspectIds = topAspect ? analysis[`aspect:${topAspect.key}`] : null;
  const topEvidence = (facts.evidence?.items ?? []).slice(0, 3).map((item) => item.evidence_id);

  return {
    identity: {},
    sections: {
      "executive-summary": {
        blocks: [
          {
            type: "paragraph",
            spans: [{
              type: "text",
              value: "这是自动生成的占位正文：报告结构与全部数字已经就位，语义结论待撰写后替换。"
                + "正文中的每个数字都以事实编号引用，不直接书写，避免与图表口径脱节。",
            }],
          },
          {
            type: "fact-list",
            items: pick(F.relevantComments, F.avgSentimentScore, F.topTopicShare)
              .map((fact_id) => ({ fact_id })),
          },
        ],
      },
      method: {
        blocks: [
          {
            type: "paragraph",
            spans: [{
              type: "text",
              value: "本节说明样本口径与引文来源。所有比例的分母、多标签的处理方式与引文校验规则，"
                + "均由程序在同一份代码里计算，两道报告完全一致。",
            }],
          },
          {
            type: "fact-list",
            items: pick(F.snapshotComments, F.labeledComments, F.relevantComments, F.relevantPct, F.quoteSource)
              .map((fact_id) => ({ fact_id })),
          },
        ],
      },
      "core-findings": {
        blocks: [
          {
            type: "fact-list",
            items: (topAspectIds
              ? pick(topAspectIds.count, topAspectIds.negative, topAspectIds.questions)
              : fallback).map((fact_id) => ({ fact_id })),
          },
        ],
      },
      "subject-insights": {
        blocks: [
          {
            type: "paragraph",
            spans: [{ type: "strong", value: "待撰写的分析对象洞察" }],
          },
          {
            type: "paragraph",
            spans: [{
              type: "text",
              value: "这里将放置分主题的洞察段落，每段后面直接挂原文证据，读者可以逐条点开核对。",
            }],
          },
          ...topEvidence.map((evidence_id) => ({ type: "evidence-quote", evidence_id })),
        ],
      },
      risks: {
        blocks: [
          {
            type: "paragraph",
            spans: [{
              type: "text",
              value: "以下限制来自自动标注流程本身，不代表对模型能力的判断；引用原文前请先核对上下文。",
            }],
          },
          {
            type: "fact-list",
            items: pick(F.lowConfidenceCount, F.quoteUnverifiedCount, F.quoteMissingCount)
              .map((fact_id) => ({ fact_id })),
          },
        ],
      },
      actions: {
        blocks: [
          {
            type: "action-list",
            items: [
              "随机抽取若干条被判定为高置信度的评论，回到原文核对标签是否成立。",
              "对引文为空或被截断的条目，回到原作品补全上下文后再引用。",
              "把两道分歧最大的评论整理成对照清单，供人工复核。",
            ],
          },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 各区块
// ---------------------------------------------------------------------------

function buildDistributions(facts) {
  const summary = facts.summary ?? {};
  const sentimentItems = SENTIMENTS.map((key) => ({
    key,
    label: SENTIMENT_LABELS[key] ?? key,
    count: int(summary.sentiment?.[key]?.count),
    pct: percentage(round1(summary.sentiment?.[key]?.pct)),
    tone: SENTIMENT_TONES[key] ?? "neutral",
  }));
  // 意图分布：只展示出现过的取值（未出现的 0 条会让表格看起来像缺数据）
  const intentItems = INTENTS
    .map((key) => ({
      key,
      label: INTENT_LABELS[key] ?? key,
      count: int(summary.intent?.[key]?.count),
      pct: percentage(round1(summary.intent?.[key]?.pct)),
      tone: "neutral",
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return [
    { id: "sentiment", title: "情绪分布", items: sentimentItems },
    {
      id: "intent",
      title: "评论意图",
      items: intentItems.length
        ? intentItems
        : [{ key: "other", label: "其他", count: 0, pct: 0, tone: "neutral" }],
    },
  ];
}

function buildRankings(facts) {
  const relevant = Math.max(1, int(facts.coverage?.relevant_comments));
  const share = (count) => Number(((int(count) * 100) / relevant).toFixed(1));
  const rankings = [];

  const aspects = (facts.analysis?.aspect ?? [])
    .map((row) => ({ key: row.key, label: row.label, count: int(row.count), pct_of_relevant: share(row.count) }))
    .filter((item) => item.count > 0)
    .slice(0, 12);
  if (aspects.length) {
    rankings.push({
      id: "aspects",
      title: "讨论方面",
      note: "每条评论可同时命中多个方面，各行不能相加；占比的分母是该道的相关评论数。",
      items: aspects,
    });
  }

  const emotions = EMOTIONS
    .map((key) => ({ key, label: key, count: int(facts.summary?.emotion?.[key]?.count), pct_of_relevant: share(facts.summary?.emotion?.[key]?.count) }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, 12);
  if (emotions.length) {
    rankings.push({
      id: "emotion",
      title: "高频情绪词",
      note: "受控词表内的情绪词，每条评论最多三个；这里是命中次数，不是人数，也不能相加当占比。",
      items: emotions,
    });
  }

  const competitors = (facts.competitors ?? [])
    .map((row) => ({ key: row.key, label: row.label, count: int(row.count), pct_of_relevant: share(row.count) }))
    .filter((item) => item.count > 0)
    .slice(0, 12);
  if (competitors.length) {
    rankings.push({
      id: "competitors",
      title: "被提及对象",
      note: "名称由评论原文的关键词匹配得到，未经实体消歧、不同写法未合并；被提及不代表构成竞品关系。",
      items: competitors,
    });
  }

  return rankings;
}

function buildPlatforms(facts) {
  return (facts.platforms ?? [])
    // 渲染器的平台枚举只有 bili / xhs / dy / reddit；其余平台的评论计入总数，
    // 在「样本边界」里说明，不在这里假装有第五个平台。
    .filter((row) => row.supported)
    .map((row) => ({
      platform: row.platform,
      label: text(row.label, 32, row.platform),
      topics: int(row.topics),
      snapshot_comments: int(row.snapshot_comments),
      labeled_comments: int(row.labeled_comments),
      relevant_comments: int(row.relevant_comments),
      positive_pct: percentage(round1(row.positive_pct)),
      negative_pct: percentage(round1(row.negative_pct)),
      neutral_pct: percentage(round1(row.neutral_pct)),
      avg_sentiment_score: num(row.avg_sentiment_score, -1, 1),
    }))
    .sort((a, b) => b.relevant_comments - a.relevant_comments || a.platform.localeCompare(b.platform))
    .slice(0, 8);
}

function buildTopics(facts) {
  const all = facts.topics ?? [];
  const topics = all.slice(0, MAX_DISPLAYED_TOPICS).map((row) => ({
    topic_id: text(row.topic_id, 160, "topic"),
    title: text(row.title, 400, "未命名作品"),
    url: httpUrlOrNull(row.url),
    snapshot_comments: int(row.snapshot_comments),
    labeled_relevant: int(row.labeled_relevant),
    positive_pct: percentage(round1(row.positive_pct)),
    negative_pct: percentage(round1(row.negative_pct)),
    controversy_score: percentage(round1(row.controversy_score)),
  }));
  return {
    topic_display: {
      displayed: topics.length,
      total: all.length,
      truncated: all.length > topics.length,
    },
    topics,
  };
}

function buildEvidence(facts) {
  const sourceNote = facts.quality?.evidence_source === "host"
    ? "引文由宿主从原文机械摘取"
    : "引文由模型自己摘录";
  return (facts.evidence?.items ?? []).slice(0, 128).map((item) => ({
    evidence_id: item.evidence_id,
    sentiment: SENTIMENTS.includes(item.sentiment) ? item.sentiment : "neutral",
    sentiment_label: SENTIMENT_LABELS[item.sentiment] ?? "中性",
    stance: STANCE_LABELS[item.stance] ? item.stance : "neutral",
    stance_label: STANCE_LABELS[item.stance] ?? "中立",
    intent: INTENTS.includes(item.intent) ? item.intent : "other",
    intent_label: INTENT_LABELS[item.intent] ?? "其他",
    opinion_target: "other",
    opinion_target_label: OPINION_TARGET_LABELS.other,
    like_count: int(item.like_count),
    quote: text(item.quote, 4000, "（引文不可用）"),
    // full_text 是选填字段（1..20000）：空正文就不带这个键，而不是带一个空串
    ...(String(item.full_text ?? "").trim() ? { full_text: text(item.full_text, 20000) } : {}),
    source_url: httpUrlOrNull(item.source_url),
    topic_title: text(item.topic_title, 400, "未命名作品"),
    // source_label 是证据卡片上唯一能写「这条引文是谁摘的」的位置：
    // Jev 是宿主机械摘取、DeepSeek 是模型自述，必须让读者一眼看到，不能混为一谈。
    source_label: text(
      `评论 ${item.comment_id} · ${item.quote_fallback ? "模型未给引文，此处为宿主从原文截取" : sourceNote}`,
      400,
      null,
    ) || null,
    topic_id: text(item.topic_id, 160, `topic-${item.evidence_id}`),
    aspects: (item.aspects ?? []).slice(0, 5).map((aspect) => text(aspect, 128)).filter(Boolean),
    confidence: num(item.confidence, 0, 1),
    // reviewed 不填：本流程没有人工/外审复核，填 false 会被读成「模型没复核」，
    // 渲染器会显示「复核未记录」，这才是事实。边界说明写在 notices 里。
    requires_context: Boolean(item.requires_context),
  }));
}

function buildAnalysis(facts, evidenceIds) {
  const groups = [];
  const quality = facts.analysis ?? {};

  const toRows = (rows) => (rows ?? []).map((row) => ({
    key: text(row.key, 128, "unknown"),
    label: text(row.label, 128, row.key),
    count: int(row.count),
    pct_of_relevant: percentage(round1(row.pct_of_relevant)),
    topic_count: int(row.topic_count),
    positive: int(row.positive),
    negative: int(row.negative),
    neutral: int(row.neutral),
    mixed: int(row.mixed),
    questions: int(row.questions),
    suggestions: int(row.suggestions),
    corrections: int(row.corrections),
    evidence_ids: (row.evidence_ids ?? []).filter((id) => evidenceIds.has(id)).slice(0, 3),
  })).filter((row) => row.count > 0).slice(0, 16);

  const aspectRows = toRows(quality.aspect);
  if (aspectRows.length) {
    groups.push({
      id: "aspect",
      title: "讨论方面 × 评论情绪",
      note: "按相关评论逐条统计，分母是该道的相关评论数（见覆盖区）。"
        + "同一条评论可命中多个方面，各行不能相加；情绪是整条评论的情绪，不是对该方面单独打分。",
      rows: aspectRows,
    });
  }

  const intentRows = toRows(quality.intent);
  if (intentRows.length) {
    groups.push({
      id: "intent",
      title: "评论意图 × 评论情绪",
      note: "每条相关评论只落一个主要意图，各行相加等于相关评论数。"
        + "提问、建议、纠错三列是该行里对应意图的条数。",
      rows: intentRows,
    });
  }

  const topTopicShare = percentage(round1(facts.quality?.top_topic_share_pct));
  const evidencePool = facts.evidence?.items?.length ?? 0;
  return {
    groups,
    quality: {
      top_topic_share_pct: topTopicShare,
      top_three_topic_share_pct: percentage(round1(facts.quality?.top_three_topic_share_pct)),
      low_confidence_count: int(facts.quality?.low_confidence_count),
      low_confidence_threshold: num(facts.quality?.low_confidence_threshold, 0, 1),
      // 本流程没有「仅有关键词上下文」这种证据类型，恒为 0，不是漏算。
      keyword_context_only_count: 0,
      // 必须等于 evidence 数组长度，否则 schema 判不通过
      evidence_pool_count: evidencePool,
    },
  };
}

function buildQuality(facts) {
  const relevant = int(facts.coverage?.relevant_comments);
  const relevantPct = percentage(round1(facts.coverage?.relevant_pct));
  const lowConfidence = int(facts.quality?.low_confidence_count);
  const topics = int(facts.coverage?.topics);
  const concentration = percentage(round1(facts.quality?.top_topic_share_pct));

  const reasons = [
    "标签由模型自动生成，未经人工逐条复核；结论用于定位问题，不用于定论。",
    facts.quality?.evidence_source === "host"
      ? "本道引文由宿主程序从原文机械摘取（evidenceSource=host）：位置由程序选择，不代表模型的判断依据。"
      : "本道引文由模型自己摘录（evidenceSource=model）：宿主只校验它是否为原文逐字子串，未校验它是否是最有代表性的那句。",
  ];
  if (lowConfidence > 0) {
    reasons.push(`有 ${lowConfidence} 条相关评论的模型自报置信度低于 ${num(facts.quality?.low_confidence_threshold, 0, 1)}；自报置信度不是校准后的准确率。`);
  }
  const quoteMissing = int(facts.quality?.quote_missing_count);
  const quoteUnverified = int(facts.quality?.quote_unverified_count);
  if (quoteMissing > 0 || quoteUnverified > 0) {
    reasons.push(`有 ${quoteMissing} 条评论模型没给引文、${quoteUnverified} 条引文未通过原文逐字校验；这些条目在证据卡片上标注了来源，引用前请核对原文。`);
  }
  let status = "sufficient";
  let title = "样本可用于本次洞察";
  if (relevant === 0) {
    status = "insufficient";
    title = "未获得有效样本";
    reasons.push("相关评论为零，本页只能用于诊断标注流程。");
  } else {
    if (relevant < 30) {
      status = "limited";
      title = "样本边界需要优先阅读";
      reasons.push(`相关评论只有 ${relevant} 条，适合逐条查看，不适合概括稳定结构。`);
    }
    if (relevantPct < 20) {
      status = "limited";
      title = "样本边界需要优先阅读";
      reasons.push(`相关占比只有 ${relevantPct.toFixed(1)}%，可能存在主题漂移。`);
    }
    if (topics > 1 && concentration >= 50) {
      status = "limited";
      title = "样本来源较集中";
      reasons.push(`单个作品贡献了 ${concentration.toFixed(1)}% 的相关评论，整体分布容易受它影响。`);
    }
  }
  reasons.push("本报告只描述本次封存的样本，不代表平台全量用户或未采集人群。");

  return {
    status,
    title,
    summary: "当前报告仅描述本次封存的可见样本，不代表平台全量用户或未采集人群。",
    reasons: reasons.slice(0, 8),
  };
}

function buildNotices(facts) {
  const supported = (facts.platforms ?? []).filter((row) => row.supported);
  const others = (facts.platforms ?? []).filter((row) => !row.supported);
  const otherText = others.length
    ? `其中 ${others.map((row) => `${row.label} ${int(row.snapshot_comments)} 条`).join("、")}`
      + `因报告模板暂不支持该平台而只计入总数、不出现在平台对比表里。`
    : "";
  return [
    {
      kind: "review",
      title: "自动标注，未经人工逐条复核",
      // 要求①：说清楚这是自动标注，读者不能把它当人工结论
      text: "本报告的全部标签由模型自动生成，未经人工逐条复核；"
        + "标签可能误判，引用原文与数字前请回到原作品核对。",
    },
    {
      kind: "boundary",
      title: "样本边界",
      // 要求②：只描述这一万条样本；顺带交代平台表的覆盖范围
      text: `本报告只描述本次封存的 ${int(facts.coverage?.comments_in_snapshot)} 条评论样本，`
        + `不代表平台全量用户或未采集人群；平台对比表覆盖 ${supported.map((row) => row.label).join("、")} `
        + `${supported.length} 个平台。${otherText}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * @param {{facts:object, narrative?:object, lane:"jev"|"deepseek"}} input
 * @returns {object} vox-report-view-v1
 */
export function buildView({ facts, narrative, lane }) {
  void lane; // lane 只影响 facts；布局与文案口径两道完全共用，见文件头注释

  if (!facts) throw new Error("buildView 需要 facts（先跑 buildFacts）");
  const catalog = new Map((facts.factCatalog ?? []).map((item) => [item.id, item.text]));
  const evidence = buildEvidence(facts);
  const evidenceIds = new Set(evidence.map((item) => item.evidence_id));
  const sections = buildSections(narrative, { catalog, evidenceIds });
  const { topic_display, topics } = buildTopics(facts);
  const fingerprint = String(facts.dataset?.fingerprint ?? "").toLowerCase().padEnd(64, "0").slice(0, 64);
  const subject = text(
    narrative?.identity?.subject ?? defaultSubject(facts),
    240,
    "评论样本",
  );

  return {
    schema_version: SCHEMA_VERSION,
    // 声明「数字由宿主事实层给出」，渲染器不会去猜哪些是模型写的
    statistical_narrative: "host-facts-v1",
    identity: {
      subject,
      research_question: text(narrative?.identity?.research_question ?? defaultResearchQuestion(), 1000),
      title: text(narrative?.identity?.title ?? `${subject} · 评论洞察报告`, 320, "评论洞察报告"),
      mode: "keyword",
      generated_at: generatedAt(facts.run?.finishedAt),
      dataset_public_id: datasetPublicId(fingerprint),
      run_id: runIdNumber(facts.run?.id),
      fingerprint,
      sealed: true,
    },
    status: {
      // 本流程没有做任何语义复核：标签是模型直接产出的，引文只做了子串校验。
      // 用 "accepted" 页头会显示「模型自动复核通过」，那是谎报；
      // "unavailable" 显示「模型复核未完成」，与事实一致。
      review_status: "unavailable",
      degraded: false,
      // 本流程没有失败/跳过的条目，标注是完整的
      partial: int(facts.coverage?.failed_comments) > 0 || int(facts.coverage?.unmatched_comments) > 0,
    },
    coverage: {
      topics: int(facts.coverage?.topics),
      comments_in_snapshot: int(facts.coverage?.comments_in_snapshot),
      labeled_comments: int(facts.coverage?.labeled_comments),
      relevant_comments: int(facts.coverage?.relevant_comments),
      labeled_pct: percentage(round1(facts.coverage?.labeled_pct)),
      relevant_pct: percentage(round1(facts.coverage?.relevant_pct)),
      avg_sentiment_score: num(facts.coverage?.avg_sentiment_score, -1, 1),
    },
    quality: buildQuality(facts),
    distributions: buildDistributions(facts),
    rankings: buildRankings(facts),
    comparisons: [],
    // 本批标签没有抽「谁比谁强」的比较关系，按要求留空数组而不是编造关系
    comparison_relations: [],
    timeline: (facts.timeline ?? []).map((row) => ({
      date: String(row.date),
      labeled_comments: int(row.labeled_comments),
      relevant_comments: int(row.relevant_comments),
      positive: int(row.positive),
      negative: int(row.negative),
      neutral: int(row.neutral),
      mixed: int(row.mixed),
    })).slice(0, 45),
    notices: buildNotices(facts),
    sections,
    topic_display,
    topics,
    platforms: buildPlatforms(facts),
    evidence,
    analysis: buildAnalysis(facts, evidenceIds),
    footer_note: "Jev Arena · Dataset-first 评论对照 · 结论仅代表本次封存数据集。",
  };
}

export default { buildView, placeholderNarrative };
