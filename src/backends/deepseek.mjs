/**
 * DeepSeek 后端（右道）。OpenAI 兼容的 /chat/completions。
 *
 * 几个踩过的坑：
 *  1. 接口**不回费用**，必须用 pricing.mjs 的 deepseekCost() 本地按单价算（缓存命中/未命中分开）。
 *  2. 它是推理模型：实测单条 completion_tokens=369，其中 reasoning_tokens=293。
 *     输出 token 是大头，所以批大小压到 10 条/次，别贪大。
 *  3. response_format:{type:"json_object"} + temperature:0 是必须的；即便如此也可能吐坏 JSON，
 *     解析失败要抛「可重试」错误让上层二分，而不是把整批标成失败。
 *  4. 受控词表原样写进系统提示词（含中文维度名和中文情绪词），否则实测它会自创枚举值（如 intent:"观望"）。
 *     vocab.normalizeLabel 仍是最后一道归一，两边都要有。
 */

import {
  SENTIMENTS, INTENTS, ASPECTS, EMOTIONS, MAX_ASPECTS, MAX_EMOTIONS,
  normalizeLabel,
} from "../vocab.mjs";
import { deepseekCost, deepseekRateLabel } from "../pricing.mjs";

export const id = "deepseek";
export const displayName = "DeepSeek Flash";
export const modelId = "deepseek-flash";

/** 10 条/次。再大推理 token 会把 max_tokens 撑爆，坏 JSON 概率显著上升。 */
export const maxBatchSize = 10;

const REQUEST_TIMEOUT_MS = 300000;
const MAX_RETRIES = 3;
const MAX_TOKENS = 8192;

function backendError(message, extra = {}) {
  const err = new Error(message);
  err.backend = id;
  Object.assign(err, extra);
  return err;
}

function baseUrl() {
  return (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
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

async function postJson(url, body, ctx) {
  const headers = {
    Authorization: `Bearer ${ctx.apiKey ?? process.env.DEEPSEEK_API_KEY ?? ""}`,
    "Content-Type": "application/json",
  };

  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
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
    try { json = text ? JSON.parse(text) : null; } catch { /* 网关 HTML 之类 */ }

    if (res.ok && json) return { json, status: res.status };

    const apiMessage = json?.error?.message ?? text.slice(0, 300) ?? res.statusText;
    const apiCode = json?.error?.code ?? res.status;

    if (res.status === 429 || res.status >= 500) {
      lastError = backendError(`HTTP ${res.status}：${apiMessage}`, {
        code: apiCode, httpStatus: res.status, retryable: true, splittable: true,
      });
      continue;
    }
    // 4xx 一律不重试。400/422 可能是某条评论内容触发的，留给上层二分隔离；
    // 401/402/403 是整道不可用，二分没意义。
    const authFailure = res.status === 401 || res.status === 402 || res.status === 403;
    throw backendError(`HTTP ${res.status}：${apiMessage}`, {
      code: apiCode, httpStatus: res.status, retryable: false, splittable: !authFailure,
    });
  }

  throw lastError ?? backendError("请求失败", { code: "UNKNOWN", retryable: true, splittable: true });
}

// ---------------------------------------------------------------------------
// 提示词：受控词表直接由 vocab.mjs 拼出来，避免两处词表悄悄漂移
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = [
  "你是中文评论结构化标注器。只输出 JSON，不要解释、不要 Markdown 代码块。",
  "对输入 JSON 里 comments 数组的每一条评论，输出一个标注对象；labels 的顺序、数量必须与 comments 完全一致，不得遗漏。",
  "",
  "所有枚举字段的取值必须严格来自下面的受控词表（禁止自创、禁止翻译、禁止近义词）：",
  `- sentiment（整体态度，单选）：${SENTIMENTS.join(" | ")}`,
  `- intent（意图，单选）：${INTENTS.join(" | ")}`,
  `- aspects（分析维度，可多选，最多 ${MAX_ASPECTS} 个）：${Object.entries(ASPECTS).map(([k, zh]) => `${k}（${zh}）`).join("、")}`,
  `- emotion（情绪，可多选，最多 ${MAX_EMOTIONS} 个）：${EMOTIONS.join("、")}`,
  "",
  "其余字段：",
  "- comment_id：原样回填输入里的 comment_id",
  "- is_relevant：布尔值，评论是否在讨论或评价该 AI 模型/产品（纯闲聊、纯广告、纯表情为 false）",
  "- sentiment_score：-1 到 1 的小数，-1 最负面，0 中立，1 最正面",
  "- confidence：0 到 1，你对该条标注的把握",
  "- evidence_quote：必须逐字摘录自该条评论原文的连续子串，不许改写、缩写、拼接或跨句拼接；找不到合适的就填空字符串",
  "",
  '输出格式：{"labels":[{...}]}。',
].join("\n");

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * @param {object[]} rows
 * @param {{signal?:AbortSignal, modelId?:string, timeoutMs?:number}} [ctx]
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

  const t0 = Date.now();
  const { json } = await postJson(`${(ctx.baseUrl ?? baseUrl()).replace(/\/+$/, "").replace(/\/chat\/completions$/, "")}/chat/completions`, {
    model: ctx.modelId ?? modelId,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `标注下面这批评论：\n${JSON.stringify({ comments })}` },
    ],
    temperature: 0,
    max_tokens: MAX_TOKENS,
    ...(ctx.jsonMode === false ? {} : { response_format: { type: "json_object" } }),
  }, ctx);
  const ms = Date.now() - t0;

  const choice = json?.choices?.[0];
  const finishReason = choice?.finish_reason;
  if (finishReason === "length") {
    // 截断的 JSON 必然解析失败；直接抛可重试错误，让上层对半切
    throw backendError(`输出被 max_tokens=${MAX_TOKENS} 截断（${rows.length} 条）`, {
      code: "TRUNCATED", retryable: true, splittable: true,
    });
  }

  const content = String(choice?.message?.content ?? "");
  const parsed = parseLabels(content, comments);

  const usageRaw = json?.usage ?? {};
  const usage = {
    inputTokens: Number(usageRaw.prompt_tokens) || 0,
    outputTokens: Number(usageRaw.completion_tokens) || 0,
    // 坑 1：接口不给费用，本地按单价算（缓存命中/未命中分开计价）
    costUsd: Number.isFinite(usageRaw.cost) ? usageRaw.cost : ctx.configured ? ((Number(usageRaw.prompt_tokens) || 0) * ctx.inputPrice + (Number(usageRaw.completion_tokens) || 0) * ctx.outputPrice) / 1e6 : deepseekCost(usageRaw, new Date()),
    // 推理 token 是这条道成本/速度的大头，单独带出来给报告讲故事
    reasoningTokens: Number(usageRaw.completion_tokens_details?.reasoning_tokens) || 0,
    cacheHitTokens: Number(usageRaw.prompt_cache_hit_tokens) || 0,
  };
  const share = {
    costUsd: usage.costUsd / comments.length,
    tokensIn: usage.inputTokens / comments.length,
    tokensOut: usage.outputTokens / comments.length,
    reasoningOut: (Number(usageRaw.completion_tokens_details?.reasoning_tokens) || 0) / comments.length,
  };
  const rateLabel = deepseekRateLabel(new Date());

  const labels = comments.map((comment, i) => {
    const item = parsed[i];
    const label = normalizeLabel(item, {
      commentId: comment.comment_id,
      content: comment.content,
      backend: ctx.id ?? id,
      evidenceSource: "model", // 这条引文是模型给的，报告里必须和 Jev 的 host 摘取区分开
      meta: {
        costUsd: Number(share.costUsd.toFixed(8)),
        tokensIn: Math.round(share.tokensIn),
        tokensOut: Math.round(share.tokensOut),
        reasoningTokens: Math.round(share.reasoningOut),
        latencyMs: ms,
        model: json?.model ?? modelId,
        costSource: Number.isFinite(usageRaw.cost) ? "provider" : ctx.configured ? (ctx.inputPrice || ctx.outputPrice ? "custom-estimate" : "unknown") : "local-pricing",
        rate: ctx.configured ? "自定义单价；未设置时费用未知" : rateLabel,
        cacheHitTokens: Number(usageRaw.prompt_cache_hit_tokens) || 0,
      },
    });
    if (!label.evidence_quote) {
      label.meta.warnings = [...(label.meta.warnings ?? []),
        item?.evidence_quote ? "模型引文未通过逐字校验，已置空" : "模型没有给出引文"];
    }
    return label;
  });

  return { labels, usage, ms };
}

/**
 * 解析模型输出。坏 JSON / 缺字段 / 条数对不上都抛可重试错误 —— 上层会二分重试，
 * 单条还失败才记账跳过。这里不吞错，也不自己造标签。
 */
function parseLabels(content, comments) {
  const cleaned = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  if (!cleaned) {
    throw backendError("模型返回空内容", { code: "PARSE_ERROR", retryable: true, splittable: true });
  }
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (cause) {
    throw backendError(`JSON 解析失败：${cause.message}；片段：${cleaned.slice(0, 160)}`, {
      code: "PARSE_ERROR", retryable: true, splittable: true,
    });
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.labels;
  if (!Array.isArray(list)) {
    throw backendError("响应里没有 labels 数组", { code: "PARSE_ERROR", retryable: true, splittable: true });
  }

  const byId = new Map();
  for (const item of list) {
    const key = String(item?.comment_id ?? "");
    if (key) byId.set(key, item);
  }
  const missing = comments.filter((c) => !byId.has(c.comment_id)).map((c) => c.comment_id);
  if (missing.length > 0) {
    throw backendError(`有 ${missing.length} 条评论没有对应标签（${missing.slice(0, 5).join("、")}）`, {
      code: "MISSING_LABELS", retryable: true, splittable: true,
    });
  }

  // 顺序按输入评论排，防止模型打乱顺序后张冠李戴
  return comments.map((c) => byId.get(c.comment_id));
}
