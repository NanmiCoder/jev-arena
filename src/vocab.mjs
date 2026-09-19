/**
 * 受控标签词表与确定性归一。
 *
 * 实测 DeepSeek 会写出词表外的值（`intent:"观望"`），Jev 的 Choice 结构上跑不出
 * 选项之外。为了两边的标签能逐字段对比，所有枚举都在这里收敛：**归一 + 记账，
 * 而不是丢弃整条** —— 为一个拼写差异重跑一条评论是白花钱。
 */

export const SENTIMENTS = ["positive", "negative", "neutral", "mixed"];
export const STANCES = ["support", "oppose", "neutral"];
export const INTENTS = [
  "praise", "complaint", "question", "suggestion", "correction",
  "agreement", "disagreement", "joke", "information", "other",
];

/** 分析维度。key 进 JSON，中文给人和模型看。 */
export const ASPECTS = {
  capability: "能力与效果",
  quality: "质量",
  usability: "易用性",
  performance: "速度与性能",
  reliability: "稳定性",
  price: "价格与性价比",
  service: "服务与体验",
  content: "内容与选题",
  presentation: "表达与结构",
  production: "制作质量",
  trust: "可信度",
  comparison: "竞品比较",
  other: "其他",
};

/** 情绪闭集。自由词表会让「好奇/curiosity/疑惑」变成三个标签，跨模型没法统计。 */
export const EMOTIONS = ["认可", "惊喜", "期待", "质疑", "失望", "担忧", "调侃", "愤怒"];

export const MAX_ASPECTS = 5;
export const MAX_EMOTIONS = 3;

// 只收录语义等价、映射无歧义的别名。拿不准一律落兜底值。
const INTENT_ALIASES = {
  comparison: "information", compare: "information", informational: "information",
  对比: "information", 比较: "information", 赞扬: "praise", 表扬: "praise",
  抱怨: "complaint", 吐槽: "complaint", 提问: "question", 询问: "question",
  建议: "suggestion", 纠错: "correction", 赞同: "agreement", 反对: "disagreement",
  玩梗: "joke", 调侃: "joke", 信息: "information", 分享: "information",
  观望: "other", 中立: "other", 陈述: "information", 描述: "information",
};
const SENTIMENT_ALIASES = {
  "mixed-positive": "mixed", "positive-negative": "mixed",
  正面: "positive", 负面: "negative", 中性: "neutral", 混合: "mixed",
  积极: "positive", 消极: "negative", 客观: "neutral",
};

const ASPECT_ALIASES = {
  // 中文写法
  能力: "capability", 能力与效果: "capability", 效果: "capability",
  质量: "quality", 易用性: "usability", 易用: "usability",
  速度: "performance", 性能: "performance", 速度与性能: "performance", 延迟: "performance",
  稳定性: "reliability", 稳定: "reliability", 可靠性: "reliability",
  价格: "price", 性价比: "price", 价格与性价比: "price", 费用: "price",
  服务: "service", 服务与体验: "service", 体验: "service",
  内容: "content", 内容与选题: "content", 选题: "content",
  表达: "presentation", 表达与结构: "presentation", 结构: "presentation",
  制作: "production", 制作质量: "production",
  可信度: "trust", 信任: "trust",
  竞品: "comparison", 竞品比较: "comparison", 对比: "comparison",
  其他: "other",
};

const EMOTION_ALIASES = {
  curiosity: "期待", 好奇: "期待", 认可: "认可", 赞同: "认可",
  surprise: "惊喜", 惊讶: "惊喜", expectancy: "期待", anticipation: "期待",
  doubt: "质疑", skepticism: "质疑", disappointment: "失望",
  concern: "担忧", worry: "担忧", mockery: "调侃", teasing: "调侃",
  anger: "愤怒", angry: "愤怒", 愤怒: "愤怒",
};

function fold(value) {
  return String(value ?? "").trim();
}

/**
 * 把模型给的枚举值收敛到词表内。
 * @returns {{value:string, changed:boolean}}
 */
export function toEnum(raw, allowed, aliases = {}, fallback = "other") {
  const text = fold(raw);
  const lower = text.toLowerCase();
  if (allowed.includes(lower)) return { value: lower, changed: lower !== text };
  if (allowed.includes(text)) return { value: text, changed: false };
  const mapped = aliases[lower] ?? aliases[text];
  if (mapped && allowed.includes(mapped)) return { value: mapped, changed: true };
  return { value: fallback, changed: true };
}

/** aspects：先丢未知项再截断，避免一个词表外的值把合法项挤出上限。 */
export function toAspects(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const known = [];
  let dropped = 0;
  for (const item of list) {
    // DeepSeek 实测会返回 [{aspect, sentiment, sentiment_score}] 这种对象数组
    const key = typeof item === "string" ? item : item?.aspect ?? item?.key ?? item?.name;
    const text = fold(key);
    if (!text) { dropped++; continue; }
    const lower = text.toLowerCase();
    const resolved = ASPECTS[lower] ? lower : ASPECT_ALIASES[lower] ?? ASPECT_ALIASES[text];
    if (!resolved || !ASPECTS[resolved]) { dropped++; continue; }
    if (!known.includes(resolved)) known.push(resolved);
  }
  const truncated = Math.max(0, known.length - MAX_ASPECTS);
  return { value: known.slice(0, MAX_ASPECTS), dropped, truncated };
}

export function toEmotions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const kept = [];
  let dropped = 0;
  for (const item of list) {
    const text = fold(typeof item === "string" ? item : item?.emotion ?? item?.label);
    if (!text) { dropped++; continue; }
    const resolved = EMOTIONS.includes(text) ? text : EMOTION_ALIASES[text.toLowerCase()] ?? EMOTION_ALIASES[text];
    if (!resolved) { dropped++; continue; }
    if (!kept.includes(resolved)) kept.push(resolved);
  }
  const truncated = Math.max(0, kept.length - MAX_EMOTIONS);
  return { value: kept.slice(0, MAX_EMOTIONS), dropped, truncated };
}

export function clamp(value, low, high, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(high, Math.max(low, n));
}

/**
 * 把任意来源的原始标签对象归一成契约里的 Label。
 * @param {object} raw   模型给的原始对象
 * @param {object} opts  { commentId, content, backend, evidenceSource, meta }
 */
export function normalizeLabel(raw, opts) {
  const { commentId, content, backend, evidenceSource = "model", meta = {} } = opts;
  const changes = [];

  const sentiment = toEnum(raw?.sentiment, SENTIMENTS, SENTIMENT_ALIASES, "neutral");
  if (sentiment.changed) changes.push({ field: "sentiment", from: raw?.sentiment, to: sentiment.value });

  const intent = toEnum(raw?.intent, INTENTS, INTENT_ALIASES, "other");
  if (intent.changed) changes.push({ field: "intent", from: raw?.intent, to: intent.value });

  const aspects = toAspects(raw?.aspects);
  if (aspects.dropped || aspects.truncated) {
    changes.push({ field: "aspects", from: raw?.aspects, to: aspects.value });
  }
  const emotion = toEmotions(raw?.emotion ?? raw?.emotions);
  if (emotion.dropped || emotion.truncated) {
    changes.push({ field: "emotion", from: raw?.emotion ?? raw?.emotions, to: emotion.value });
  }

  const score = clamp(raw?.sentiment_score, -1, 1, 0);
  if (Number(raw?.sentiment_score) !== score) {
    changes.push({ field: "sentiment_score", from: raw?.sentiment_score, to: score });
  }

  // 引文必须是原文逐字子串。不是就置空并记账 —— 编造的引文会变成报告里的假证据。
  let quote = fold(raw?.evidence_quote ?? raw?.evidence_span ?? raw?.quote);
  let quoteOk = Boolean(quote) && typeof content === "string" && content.includes(quote);
  if (quote && !quoteOk) {
    changes.push({ field: "evidence_quote", from: quote, to: "" });
    quote = "";
  }
  if (!quote || !quoteOk) quoteOk = false;

  const isRelevant = raw?.is_relevant === true || raw?.is_relevant === "true";

  return {
    comment_id: String(commentId),
    is_relevant: isRelevant,
    sentiment: sentiment.value,
    sentiment_score: score,
    confidence: clamp(raw?.confidence, 0, 1, 0),
    intent: intent.value,
    aspects: aspects.value,
    emotion: emotion.value,
    evidence_quote: quote,
    meta: {
      backend,
      evidenceSource,
      quoteVerified: quoteOk,
      ...(changes.length ? { normalized: changes } : {}),
      ...meta,
    },
  };
}
