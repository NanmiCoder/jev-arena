/**
 * Jev 后端（左道）。OpenRouter alpha/decisions 接口。
 *
 * 几个踩过的坑，改代码前先看这里：
 *  1. URL 是 {OPENROUTER_BASE_URL}/alpha/decisions，**没有 /v1**（实测 /v1/alpha/... 404）。
 *  2. `score` 返回的是档位下标（实测样例 1.42，可以落在两档之间），不是分值。
 *     5 档 → sentiment_score = -1 + score * 0.5。
 *  3. `usage.cost` 是 OpenRouter 直接给的真实美元费用，只能照抄，不要拿单价表自己乘。
 *  4. 官方限制 state + 问题定义 ≤ 32k token；实测输入 token 的主要开销是「每个评论 25 个
 *     问题的定义」（3 条评论就烧了 4195 input token），所以**发请求前必须本地估算**，
 *     超线直接抛 STATE_TOO_LARGE 让上层二分，别打过去换个 422 回来（白花钱还慢）。
 *  5. Jev 不产文本，evidence_quote 只能由宿主从原文机械摘取，并标 evidenceSource:"host"。
 */

import {
  SENTIMENTS, INTENTS, ASPECTS, EMOTIONS, MAX_ASPECTS, MAX_EMOTIONS,
  normalizeLabel, clamp,
} from "../vocab.mjs";

export const id = "jev";
export const displayName = "Jev";
export const modelId = "typesafe/jev-1.13";

/**
 * 一批多少条。实测（4 组样本）：3 条评论 ≈ 6.1k input token，其中绝大部分是
 * 「每条 25 个问题的定义」，正文只占小头 → 单条 ≈ 2.0k token。
 * 10 条 ≈ 2.4 万（本地估算），落在 2.8 万安全线内；再大就要靠二分兜底，不划算。
 */
export const maxBatchSize = 10;

/** 本地拦截线。官方硬限 32k，留 ~4k 余量给估算误差。 */
export const MAX_ESTIMATED_TOKENS = 28000;

/** 请求超时：一批 15 条最慢见过 ~8s，给足余量但不至于挂死。 */
const REQUEST_TIMEOUT_MS = 180000;
const MAX_RETRIES = 3; // 429/5xx 的重试次数（不含首次）

const SENTIMENT_DESC = {
  positive: "整体正面，认可、喜欢或推荐",
  negative: "整体负面，批评、失望或反对",
  neutral: "就事论事，没有明显褒贬",
  mixed: "既有肯定也有批评，两种态度都明显",
};

const INTENT_DESC = {
  praise: "称赞、夸奖产品或团队",
  complaint: "抱怨、吐槽遇到的问题",
  question: "提出疑问、求助或询问信息",
  suggestion: "给出改进建议或功能请求",
  correction: "指出事实、数据或说法有误",
  agreement: "赞同他人的观点",
  disagreement: "反对他人的观点",
  joke: "玩梗、调侃、幽默表达",
  information: "分享信息、经验或客观陈述",
  other: "以上都不属于",
};

/** 5 档下标 → -1..1。第 2 档是中性。 */
const SCORE_TIERS = ["强烈负面", "偏负面", "中性/无法判断", "偏正面", "强烈正面"];

// ---------------------------------------------------------------------------
// 错误与请求工具
// ---------------------------------------------------------------------------

function backendError(message, extra = {}) {
  const err = new Error(message);
  err.backend = id;
  Object.assign(err, extra);
  return err;
}

function baseUrl() {
  return (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api").replace(/\/+$/, "");
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(timer); reject(backendError("请求已中止", { code: "ABORTED", retryable: false, splittable: false })); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function requestSignal(ctx) {
  const timeout = AbortSignal.timeout(ctx.timeoutMs ?? REQUEST_TIMEOUT_MS);
  return ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
}

/**
 * POST JSON + 重试。429/5xx 指数退避重试；400/401/422 是确定性错误，重试只会重复烧钱。
 */
async function postJson(url, body, ctx) {
  const headers = {
    Authorization: `Bearer ${ctx.apiKey ?? process.env.OPENROUTER_API_KEY ?? ""}`,
    "Content-Type": "application/json",
  };
  // 便于在 OpenRouter 后台按这次演示筛选用量，不影响计费
  if (ctx.referer) headers["HTTP-Referer"] = ctx.referer;
  if (ctx.title) headers["X-Title"] = ctx.title;

  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // 指数退避 + 抖动，避免和别的请求撞在一起
      await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250), ctx.signal);
    }

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: requestSignal(ctx),
      });
    } catch (cause) {
      if (ctx.signal?.aborted) throw backendError("请求已中止", { code: "ABORTED", retryable: false, splittable: false });
      lastError = backendError(`网络错误：${cause?.message ?? cause}`, {
        code: cause?.name === "TimeoutError" ? "TIMEOUT" : "NETWORK",
        retryable: true,
        splittable: true,
      });
      continue;
    }

    const text = await res.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应（网关 HTML）走下面分支 */ }

    if (res.ok && json) return { json, status: res.status };

    const apiMessage = json?.error?.message ?? text.slice(0, 300) ?? res.statusText;
    const apiCode = json?.error?.code ?? res.status;

    if (res.status === 429 || res.status >= 500) {
      lastError = backendError(`HTTP ${res.status}：${apiMessage}`, {
        code: apiCode, httpStatus: res.status, retryable: true, splittable: true,
      });
      continue;
    }
    // 4xx 一律不重试（重试只是白花钱）。但 400/422 可能是某一条评论内容触发的，
    // 把 splittable 留给上层：二分到单条能救回同批其它评论；401/402/403 则是整道不可用，
    // 二分没意义，直接标成不可分割。
    const authFailure = res.status === 401 || res.status === 402 || res.status === 403;
    throw backendError(`HTTP ${res.status}：${apiMessage}`, {
      code: apiCode, httpStatus: res.status, retryable: false, splittable: !authFailure,
    });
  }

  throw lastError ?? backendError("请求失败", { code: "UNKNOWN", retryable: true, splittable: true });
}

// ---------------------------------------------------------------------------
// Token 估算
// ---------------------------------------------------------------------------

/**
 * 粗估 token：中文 1.05 token/字，其余（JSON 结构、英文、标点）0.5 token/字符。
 *
 * 系数是拿真实响应校准出来的，不是拍的：四组样本（英文推文 / 中文长评 / 混合）的
 * 估算值都比真实 input_tokens 高 14%~17%，即真实值 ≈ 估算值 × 0.85。
 * 宁可高估（多切一刀、多一次往返）也不能低估 —— 低估的代价是撞 32k 硬限拿 422。
 * 这个函数只服务「本地拦截」，不参与计费。
 */
const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

export function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of String(text)) {
    if (CJK_RE.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 1.05 + other * 0.5);
}

// ---------------------------------------------------------------------------
// 问题定义
// ---------------------------------------------------------------------------

/**
 * 每条评论一组问题，id 形如 c3_relevant（3 是该批内的下标）。
 * 之所以用「映射 + 带下标 id」而不是数组：decisions 接口的 answers 是以 id 为键的对象，
 * 一批多条时只能靠 id 把答案认回评论。
 */
export function buildQuestions(comments) {
  const questions = {};
  comments.forEach((comment, i) => {
    const p = `c${i}`;

    questions[`${p}_relevant`] = {
      type: "noul",
      instructions: `第 ${i + 1} 条评论是否在讨论或评价某个 AI 模型/产品（而不是纯闲聊、广告、纯表情）？`,
      criteria: { true: "提到了某个模型/产品并与之相关", false: "没提到或完全无关" },
    };

    questions[`${p}_sentiment`] = {
      type: "choice",
      instructions: `第 ${i + 1} 条评论的整体态度是哪一种？`,
      criteria: Object.fromEntries(SENTIMENTS.map((s) => [s, SENTIMENT_DESC[s] ?? null])),
    };

    questions[`${p}_intent`] = {
      type: "choice",
      instructions: `第 ${i + 1} 条评论的主要意图是什么？`,
      criteria: Object.fromEntries(INTENTS.map((s) => [s, INTENT_DESC[s] ?? null])),
    };

    questions[`${p}_score`] = {
      type: "score",
      instructions: `第 ${i + 1} 条评论的情绪落在哪一档？`,
      criteria: [...SCORE_TIERS],
    };

    for (const [key, zh] of Object.entries(ASPECTS)) {
      questions[`${p}_aspect_${key}`] = {
        type: "noul",
        instructions: `第 ${i + 1} 条评论是否明确涉及「${zh}」这个维度？`,
        criteria: { true: `明确涉及${zh}`, false: `没有涉及${zh}` },
      };
    }

    for (const word of EMOTIONS) {
      questions[`${p}_emotion_${word}`] = {
        type: "noul",
        instructions: `第 ${i + 1} 条评论是否表达了「${word}」这种情绪？`,
        criteria: { true: `明确表达${word}`, false: `没有表达${word}` },
      };
    }
  });
  return questions;
}

// ---------------------------------------------------------------------------
// 宿主摘引文
// ---------------------------------------------------------------------------

/**
 * Jev 不产文本，引文由宿主机械摘取：取最长的一句（按中英文句末标点切），截到 200 字以内。
 * 截断/去空白之后的字符串仍然是原文子串，能通过 normalizeLabel 的逐字校验。
 * @param {string} content
 * @param {number} maxLen
 */
export function hostQuote(content, maxLen = 200) {
  const text = String(content ?? "");
  if (!text.trim()) return "";
  const sentences = text.match(/[^。！？!?；;…\n]+[。！？!?；;…]*/g) ?? [text];
  let best = "";
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length > best.length) best = trimmed;
  }
  return best.length > maxLen ? best.slice(0, maxLen) : best;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * @param {object[]} rows
 * @param {{signal?:AbortSignal, modelId?:string, timeoutMs?:number}} [ctx]
 * @returns {Promise<{labels:object[], usage:{inputTokens:number,outputTokens:number,costUsd:number}, ms:number}>}
 */
export async function labelBatch(rows, ctx = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { labels: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, ms: 0 };
  }

  const comments = rows.map((r) => ({
    comment_id: String(r.comment_id),
    content: String(r.content ?? ""),
    like_count: Number(r.like_count) || 0,
    topic_title: String(r.topic_title ?? ""),
  }));
  const state = { comments };
  const questions = buildQuestions(comments);

  // 本地估算：questions 的定义才是 token 大头（25 问/条），不能只看 state
  const estimatedTokens = estimateTokens(JSON.stringify(state)) + estimateTokens(JSON.stringify(questions));
  if (estimatedTokens > MAX_ESTIMATED_TOKENS) {
    throw backendError(
      `本地估算 ${estimatedTokens} token，超过安全线 ${MAX_ESTIMATED_TOKENS}（官方硬限 32k）`,
      { code: "STATE_TOO_LARGE", estimatedTokens, retryable: false, splittable: true },
    );
  }

  const t0 = Date.now();
  const { json } = await postJson(`${(ctx.baseUrl ?? baseUrl()).replace(/\/+$/, "").replace(/\/alpha\/decisions$/, "")}/alpha/decisions`, {
    model: ctx.modelId ?? modelId,
    state,
    questions,
  }, ctx);
  const ms = Date.now() - t0;

  const answers = json?.answers;
  if (!answers || typeof answers !== "object") {
    throw backendError("响应缺少 answers 字段", { code: "BAD_RESPONSE", retryable: true, splittable: true });
  }

  const usage = {
    inputTokens: Number(json?.usage?.input_tokens) || 0,
    outputTokens: Number(json?.usage?.output_tokens) || 0,
    // 坑 3：直接取 OpenRouter 返回的真实费用，不要自己按单价算
    costUsd: Number(json?.usage?.cost) || 0,
  };
  const share = {
    costUsd: usage.costUsd / comments.length,
    tokensIn: usage.inputTokens / comments.length,
    tokensOut: usage.outputTokens / comments.length,
  };

  const labels = comments.map((comment, i) => buildLabel(comment, i, answers, {
    ...share, backend: ctx.id ?? id, latencyMs: ms, model: json?.model ?? modelId, usageCostPresent: Number.isFinite(Number(json?.usage?.cost)),
  }));

  return { labels, usage, ms };
}

/** 单条评论的答案 → 契约 Label。 */
function buildLabel(comment, i, answers, meta) {
  const p = `c${i}`;
  const relevantAnswer = answers[`${p}_relevant`];
  const sentimentAnswer = answers[`${p}_sentiment`];
  const intentAnswer = answers[`${p}_intent`];
  const scoreAnswer = answers[`${p}_score`];

  const relevantProb = Number(relevantAnswer?.noul);
  const scoreIndex = Number(scoreAnswer?.score);

  const raw = {
    // 坑：noul 是「为真」的概率，0.5 是分界
    is_relevant: Number.isFinite(relevantProb) && relevantProb >= 0.5,
    sentiment: sentimentAnswer?.choice,
    intent: intentAnswer?.choice,
    // 坑 2：score 是档位下标（可为小数），5 档 → -1..1；保留 3 位小数，
    // 否则报告里会出现 0.014999999999999902 这种浮点噪声
    sentiment_score: Number.isFinite(scoreIndex)
      ? Number((-1 + clamp(scoreIndex, 0, SCORE_TIERS.length - 1) * 0.5).toFixed(3))
      : 0,
    confidence: Number(confidenceOf(relevantProb, [sentimentAnswer, intentAnswer, scoreAnswer]).toFixed(3)),
    aspects: pickByProbability(answers, p, "aspect_", Object.keys(ASPECTS), MAX_ASPECTS),
    emotion: pickByProbability(answers, p, "emotion_", EMOTIONS, MAX_EMOTIONS),
    // 坑 5：引文是宿主摘的，不是模型给的；evidenceSource 会把这件事一路带进报告
    evidence_quote: hostQuote(comment.content),
  };

  const label = normalizeLabel(raw, {
    commentId: comment.comment_id,
    content: comment.content,
    backend: meta.backend ?? id,
    evidenceSource: "host",
    meta: {
      costUsd: Number(meta.costUsd.toFixed(8)),
      tokensIn: Math.round(meta.tokensIn),
      tokensOut: Math.round(meta.tokensOut),
      latencyMs: meta.latencyMs,
      model: meta.model,
      costSource: meta.usageCostPresent ? "openrouter-usage" : "missing",
      // 概率明细留着做报告里的「Jev 有多确定」，但不塞整个 answers
      raw: {
        relevant: Number.isFinite(relevantProb) ? relevantProb : null,
        sentimentProbabilities: sentimentAnswer?.probabilities ?? null,
        scoreProbabilities: scoreAnswer?.probabilities ?? null,
      },
      missingAnswers: ["_relevant", "_sentiment", "_intent", "_score"]
        .filter((suffix) => answers[`${p}${suffix}`] === undefined).length,
    },
  });

  if (!label.evidence_quote) {
    label.meta.warnings = [...(label.meta.warnings ?? []), "评论正文为空或全是空白，宿主无法摘出引文"];
  }
  return label;
}

/** noul 概率 ≥ 0.5 视为命中，按概率从高到低取，再按上限截断。 */
function pickByProbability(answers, prefix, kind, keys, limit) {
  const hits = [];
  for (const key of keys) {
    const prob = Number(answers[`${prefix}_${kind}${key}`]?.noul);
    if (Number.isFinite(prob) && prob >= 0.5) hits.push({ key, prob });
  }
  hits.sort((a, b) => b.prob - a.prob);
  return hits.slice(0, limit).map((h) => h.key);
}

/**
 * 整体置信度。choice/score 答案自带 confidence；noul 没有，用「离 0.5 的距离」当把握度：
 * 0.5 → 0，0 或 1 → 1。没有任何可用信号时返回 0（契约允许）。
 */
function confidenceOf(relevantProb, answers) {
  const values = answers
    .map((a) => Number(a?.confidence))
    .filter((v) => Number.isFinite(v));
  if (values.length > 0) {
    return clamp(values.reduce((sum, v) => sum + v, 0) / values.length, 0, 1);
  }
  return Number.isFinite(relevantProb) ? clamp(0.5 + Math.abs(relevantProb - 0.5), 0, 1) : 0;
}
