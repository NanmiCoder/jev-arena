/**
 * 独立 AI 盲评：证明「Jev 标得比 DeepSeek 好还是差」时，不能自说自话。
 *
 * 做法：从两道都成功的评论里分层抽样，对每条构造「原文 + 匿名标签组 A + 匿名标签组 B」，
 * 交给本地 claude CLI 逐条判胜负，最后再反盲化映射回 jev / deepseek。
 *
 * 为什么「随机化」与「反盲化」必须分离（这是全片可信度的核心）：
 *  - 评审模型拿到的提示词里**只有 A/B**，没有 lane id、没有模型名、没有费用/耗时/meta，
 *    连 confidence 都剔除了（DeepSeek 恒为 0，留着等于直接告诉评审谁是 DeepSeek）。
 *  - A/B 归属由固定种子的 PRNG 决定，映射表只写进 runs/<runId>/blind_key.json，
 *    **绝不进入提示词**。评审器即使想迎合某一方，也无从知道该迎合谁。
 *  - 反盲化是聚合阶段的独立步骤：先拿到裸判断，再用 key 映射。两者分开，任何一方都无法
 *    在生成判断时「顺带」看到映射；映射文件与提示词之间没有代码路径相连。
 *
 * ---------------------------------------------------------------------------
 * blind-v2 针对独立审计发现的三个方法学缺陷做了修复，改动的「为什么」写在下面：
 *
 * 【缺陷 1】原始判定只在内存里，评审模型/版本/耗时无记录 → 结论不可复核。
 *   修法：每个块（chunk）的脱敏提示词、原始响应、解析结果、claude --version、模型参数、
 *   起止时间与耗时全部落到 runs/<runId>/review_raw.jsonl（一行一块）。
 *   为什么必须落盘：盲评是「一次性 LLM 判断」，事后无法从聚合数字反推它当时看到了什么。
 *   不落原始记录，任何人（包括未来的自己）都只能选择相信 review.md 的汇总，无法重放核对。
 *
 * 【缺陷 2】提示词可被指纹识别出哪份是谁 → 评审在惩罚「风格」而不是惩罚「错误」。
 *   已知指纹：① sentiment_score 网格不同（Jev 是 0.5 档位插值出的小数，DeepSeek 绝大多数
 *   落在 0.1 的整数倍上）；② 引文有无（Jev 恒有、DeepSeek 偶缺）；③ 提示词里直接写了
 *   「某一方的 evidence_quote 可能由程序机械摘取」——等于点名；④ meta / confidence /
 *   costSource / evidenceSource / 模型名 / lane 名等字段本就只在一侧有真实值。
 *   修法：(a) 送审标签只保留受控字段，数值一律量化到同一位小数网格（固定格式字符串）；
 *        (b) 删掉点名句，换成中性表述「引文必须逐字来自原文，只判断是否支撑结论，
 *            不判断它由谁产生」；
 *        (c) 在构造完提示词后做**自检**：扫描泄漏词 + 校验数值格式 + 校验 A/B 字段与顺序
 *            完全对称，自检失败直接抛错，绝不静默把可疑提示词发出去。
 *
 * 【缺陷 3】两道的 aspects 产出机制不同源（一边是固定维度集合逐个判定、一边是自由列举），
 *   直接比会把「报得多」判成「报得好」——审计实测：Jev aspects 更多的 14 条里 DeepSeek
 *   赢了 12 条。修法：分成两轮。
 *   - 主轮（决定胜负）：只比两边机制同源的字段 —— is_relevant / sentiment(+score) / intent /
 *     引文是否支撑结论。这些字段两边都是「在同一个受控词表里选一个」，可以直接比。
 *   - 附加轮（只作观察，不计入胜负）：单独评 aspects / emotion，提示词明确说明数量可能不同、
 *     只判断列出的准不准与关键维度有没有漏。
 *   另外主轮必须给 Wilson 95% 置信区间：60 条样本的点估计（如 15.9%）本身带 ±9 个百分点
 *   量级的抽样误差，不给区间就等于把噪声当结论。评审模型还有采样随机性，因此支持
 *   seeds:[1,2,3] 多次重复，报告各次结果与波动范围。
 *
 * 失败策略：claude 调用失败不抛异常，把错误当数据写进结果（verdict.error / detail[].error），
 * 报告流程照常产出 —— 视频录制中不能因为一个外部 CLI 挂掉就全盘中断。
 * **例外**：盲评提示词自检失败会抛错并中止本轮 —— 提示词可疑属于方法学失效，
 * 此时「有结论」比「没结论」更危险，必须显式失败。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadDataset } from "./dataset.mjs";

/** 每次 claude 调用评审多少条。太大容易输出截断/JSON 坏掉，太小则进程启动开销占比过高。 */
const CHUNK_SIZE = 8;
/** 单次 claude 调用超时。评审要读 8 条评论 + 两组标签，给足余量。 */
const CLAUDE_TIMEOUT_MS = 240000;
/** 单次 codex 调用超时。实测 8 条约 12~20 秒（含模型启动开销），给同样的余量。 */
const CODEX_TIMEOUT_MS = 240000;
/** 探测 claude 版本号的超时。它只打印一行，给 15 秒足够。 */
const VERSION_TIMEOUT_MS = 15000;
/**
 * 支持的评审适配器。每个适配器的参数协议、取结果方式、「实际模型名从哪读」都不同，
 * 写成一个通用函数只会把差异藏进一堆 if 里。
 * claude 走 `-p --output-format json`，实际模型从信封 modelUsage 读；
 * codex 走 `exec --output-schema -o`，实际模型从 banner 的 `model:` 行读。
 */
const REVIEW_AGENTS = ["claude", "codex"];

/**
 * 由 agent 名（或可执行文件路径）判定适配器种类，认不出就返回 null。
 * 为什么要认路径：agent 原本就同时充当「标签」和「要 spawn 的命令」，允许传
 * `/opt/xxx/codex` 这类路径是既有能力，不该因为加了白名单就丢掉；
 * 但白名单必须保留 —— 认不出的名字直接报错，绝不能悄悄按 claude 跑，
 * 否则「用哪个适配器」这种决定结论口径的事就变成了默认值。
 */
function agentKind(agent) {
  const base = path.basename(String(agent ?? "")).toLowerCase();
  if (base.includes("codex")) return "codex";
  if (base.includes("claude")) return "claude";
  return null;
}
/** 盲评格式版本，写进 blind_key.json，便于复现时确认算法没有漂移。v2 = 量化 + 分两轮 + 原始记录。 */
const BLIND_VERSION = "blind-v2";
/** 数值统一网格：sentiment_score 一律量化到 1 位小数。0.1 是两边原始精度都能容纳的粗网格。 */
const SCORE_DECIMALS = 1;
/** 量化后分数的字符串表示，同时用于自检。 */
const SCORE_RE = /^-?\d\.\d$/;
/**
 * 送审字段清单（顺序即 JSON 键顺序，A/B 必须完全一致）。
 * 主轮只放机制同源的字段；aspects/emotion 移到附加轮。
 */
const MAIN_FIELDS = ["is_relevant", "sentiment", "sentiment_score", "intent", "evidence_quote"];
const ASPECTS_FIELDS = ["aspects", "emotion"];
/**
 * 泄漏词黑名单：这些词一旦出现在提示词（不含原文正文）里，就等于告诉评审哪组是谁，
 * 或暴露了本该被抹掉的字段。用词边界匹配，避免误伤 "separate" 里的 "rate" 之类。
 */
const LEAK_PATTERNS = [
  /\bjev\b/i, /\bdeepseek\b/i, /\bnoul\b/i, /\bopenrouter\b/i, /\btypesafe\b/i,
  /\bflash\b/i, /\bconfidence\b/i, /\bcostsource\b/i, /\bevidencesource\b/i,
  /\bcostusd\b/i, /\bcost\b/i, /\bmeta\b/i, /\bbackend\b/i, /\blane\b/i,
  /\blatency\b/i, /\btokens?\b/i, /\bmodel\b/i, /\bclaude\b/i, /\bgpt\b/i,
  /\bapi\b/i, /\bopenai\b/i, /\banthropic\b/i,
];

// ---------------------------------------------------------------------------
// 读盘与小工具
// ---------------------------------------------------------------------------

function parseJsonl(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* 半截行 */ }
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

async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

const truncate = (text, max) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

const mdCell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
const pct = (num, den) => (den > 0 ? Number(((num / den) * 100).toFixed(2)) : null);
const sha256 = (text) => createHash("sha256").update(String(text), "utf8").digest("hex");
const round4 = (v) => (v == null ? null : Number(Number(v).toFixed(4)));

// ---------------------------------------------------------------------------
// 统计学：Wilson 置信区间（不引依赖）
// ---------------------------------------------------------------------------

/**
 * Wilson score interval（95%，z=1.96）。
 *
 * 为什么必须给区间：盲评只跑几十条样本，点估计（例如「Jev 胜率 15.9%」）背后有可观的
 * 抽样误差。60 条里 10 胜 40 负，Wilson 区间大约是 [10%, 27%] —— 结论的方向可能仍然成立，
 * 但「到底差多少」完全不是点估计能承担的。没有区间就无从判断两次 run 的差异是真信号还是噪声。
 *
 * 为什么用 Wilson 而不是正态近似：小样本 + 比例接近 0/1 时正态近似会给出越界/过窄的区间，
 * Wilson 在 n≥10 的极端比例下仍稳定，且计算只需四则运算，不引依赖。
 *
 * @param {number} wins 成功数
 * @param {number} total 分母
 * @param {number} [z] 分位数（默认 1.96 ≈ 95%）
 * @returns {{level:number, z:number, p:number, lower:number, upper:number}|null}
 */
export function wilsonInterval(wins, total, z = 1.96) {
  const n = Number(total);
  const k = Number(wins);
  if (!Number.isFinite(n) || !Number.isFinite(k) || n <= 0) return null;
  const p = Math.min(1, Math.max(0, k / n));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    level: z === 1.96 ? 0.95 : null,
    z,
    p: round4(p),
    lower: round4(Math.max(0, center - half)),
    upper: round4(Math.min(1, center + half)),
  };
}

// ---------------------------------------------------------------------------
// 可复现随机：固定种子 PRNG
// ---------------------------------------------------------------------------

/** FNV-1a：把 runId 等字符串折成一个 32 位种子，保证同一 run 每次抽样的结果完全一致。 */
function hashSeed(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(text).length; i++) {
    h ^= String(text).charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：小而快的确定性 PRNG，够盲评随机化用，不引依赖。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates（原地）。所有洗牌都走同一个 rng，顺序确定可复现。 */
function shuffle(list, rng) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

const toSeed32 = (value) => {
  if (Number.isFinite(Number(value))) return Number(value) >>> 0;
  return hashSeed(String(value));
};

// ---------------------------------------------------------------------------
// 分层抽样
// ---------------------------------------------------------------------------

/**
 * 按平台分层抽样：平台按样本数降序（同数按名字），配额用最大余数法按比例分配；
 * 平台数不超过样本量时每个平台至少 1 条，保证 1 万条里的各平台都能进入盲评。
 */
function stratifiedSample(pool, size, rng, platformOf) {
  const groups = new Map();
  for (const item of pool) {
    const platform = platformOf(item) ?? "(未知)";
    if (!groups.has(platform)) groups.set(platform, []);
    groups.get(platform).push(item);
  }
  const platforms = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length || String(a).localeCompare(String(b)));
  const target = Math.min(size, pool.length);
  const quota = new Map();

  if (target <= platforms.length) {
    // 样本量比平台还少：只从最大的几个平台各取 1 条
    for (const platform of platforms.slice(0, target)) quota.set(platform, 1);
  } else {
    const total = pool.length;
    let assigned = 0;
    const remainders = [];
    for (const platform of platforms) {
      quota.set(platform, 1); // 保底 1 条
      assigned += 1;
    }
    const rest = target - assigned;
    for (const platform of platforms) {
      const exact = (groups.get(platform).length / total) * rest;
      const base = Math.floor(exact);
      quota.set(platform, quota.get(platform) + base);
      assigned += base;
      remainders.push({ platform, remainder: exact - base });
    }
    remainders.sort((a, b) => b.remainder - a.remainder || String(a.platform).localeCompare(String(b.platform)));
    for (const { platform } of remainders) {
      if (assigned >= target) break;
      quota.set(platform, quota.get(platform) + 1);
      assigned += 1;
    }
  }

  const picked = [];
  for (const platform of platforms) {
    const want = Math.min(quota.get(platform) ?? 0, groups.get(platform).length);
    picked.push(...shuffle([...groups.get(platform)], rng).slice(0, want));
  }
  return shuffle(picked, rng);
}

// ---------------------------------------------------------------------------
// 盲评呈现层：量化 + 去身份字段（缺陷 2）
// ---------------------------------------------------------------------------

/**
 * 把 sentiment_score 量化到统一网格，并以**固定一位小数的字符串**呈现。
 *
 * 为什么要量化：审计实测 DeepSeek 的分数几乎全落在 0.1 的整数倍上（0.8/0.9/0.5），
 * 而 Jev 是 0.5 档位插值出来的任意小数（0.63/0.955/0.845）。原始数值一摆出来，
 * 评审模型不用猜身份就能按「小数位数」区分两组，胜负里就混进了格式偏好。
 * 为什么用字符串而不是 number：JSON.stringify(1.0) 会变成 1、0.5 会变成 0.5，
 * 小数位数的差异本身又会变成指纹；固定 "x.y" 字符串保证两边的呈现字节级同构，
 * 也让自检可以用一个正则卡死。
 */
function quantizeScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.max(-1, Math.min(1, n));
  return clamped.toFixed(SCORE_DECIMALS);
}

/** 数组字段归一：去重 + 排序 + 转字符串。排序是为了抹掉「列举顺序」这种无意义的呈现差异。 */
function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => String(v)))].sort((a, b) => a.localeCompare(b));
}

/**
 * 只保留送审白名单字段，并做统一呈现。
 *
 * **剔除 meta、confidence、comment_id**：
 *  - meta 里有 costSource / evidenceSource / rate / 模型名，直接泄底；
 *  - confidence 更能泄底：Jev 有真实置信度，DeepSeek 契约上恒为 0，留着等于点名；
 *  - comment_id 可用于事后查库对号，没必要给。
 * 键顺序由 fields 固定，保证 A/B 两份在字节层面完全同构（自检会验证）。
 */
function blindLabel(label, fields = MAIN_FIELDS) {
  const out = {};
  for (const field of fields) {
    if (field === "is_relevant") out.is_relevant = label?.is_relevant === true;
    else if (field === "sentiment") out.sentiment = label?.sentiment == null ? null : String(label.sentiment);
    else if (field === "sentiment_score") out.sentiment_score = quantizeScore(label?.sentiment_score);
    else if (field === "intent") out.intent = label?.intent == null ? null : String(label.intent);
    else if (field === "evidence_quote") out.evidence_quote = String(label?.evidence_quote ?? "");
    else if (field === "aspects") out.aspects = normalizeList(label?.aspects);
    else if (field === "emotion") out.emotion = normalizeList(label?.emotion);
    else throw new Error(`盲评白名单里有未知字段「${field}」`);
  }
  return out;
}

/**
 * 序列化送审数据。
 *
 * redactData=true 时把「原文/平台/引文」这些**数据字段**替换成占位符，只用于泄漏词扫描：
 * 评论正文与逐字引文里出现品牌名（deepseek / flash / model 等）是数据本身，两边都可能有，
 * 不构成泄漏；结构字段（键名、枚举值、数值格式）原样保留，泄漏词若出现在那里才是真泄漏。
 * 注意：真实发出去的提示词里这些字段是原样的，扫描文本只影响自检，不影响送审内容。
 */
function serializeUnits(units, { redactData = false } = {}) {
  const redactLabel = (label) => {
    const out = {};
    for (const [k, v] of Object.entries(label)) {
      out[k] = (redactData && k === "evidence_quote") ? "«quote»" : v;
    }
    return out;
  };
  const items = units.map((u) => ({
    id: u.id,
    platform: redactData ? "«platform»" : u.platform,
    comment: redactData ? "«comment»" : u.comment,
    A: redactLabel(u.A),
    B: redactLabel(u.B),
  }));
  return JSON.stringify({ items }, null, 1);
}

/**
 * 提示词自检（缺陷 2.3）：构造完必须检查，失败就抛错而不是静默继续。
 *
 * 检查三件事：
 *  1. 泄漏词：**完整模板 + 脱敏后的送审 JSON** 里不得出现 jev/deepseek/model/confidence/
 *     evidenceSource/cost 等词 —— 正文里出现品牌名是数据本身，不算泄漏，所以先把正文/平台
 *     换成占位符再扫；模板本身必须全量参与扫描，否则「某一方的引文可能由程序机械摘取」
 *     这类点名句会漏网。
 *  2. 数值格式：所有 sentiment_score 必须匹配 ^-?\d\.\d$，不允许任何一边保留原始精度。
 *  3. 结构对称：A/B 的键集合与顺序必须完全一致，且与白名单一致 —— 任何单边字段都是指纹。
 *
 * @param {string} scanText 完整模板 + 脱敏 payload
 * @param {string} payloadJson 真正要发出去的送审 JSON
 * @param {string[]} fields 白名单字段（顺序敏感）
 * @param {number} unitCount 本块条数
 * @returns {{ok:boolean, checkedPrompts:number, leakWords:number, scoreGrid:string, structuralSymmetry:boolean}}
 */
function assertPromptSafe(scanText, payloadJson, fields, unitCount) {
  const problems = [];

  for (const pattern of LEAK_PATTERNS) {
    const hit = scanText.match(pattern);
    if (hit) problems.push(`提示词含泄漏词「${hit[0]}」（${pattern}）`);
  }

  // 结构对称与数值格式：直接检查真正要发出去的 payload（不含模板文字）
  let payload = null;
  try { payload = JSON.parse(payloadJson); } catch { /* 下面统一报错 */ }
  if (!payload?.items) {
    problems.push("提示词里的送审 JSON 无法解析");
  } else {
    for (const item of payload.items) {
      for (const side of ["A", "B"]) {
        const label = item[side] ?? {};
        const keys = Object.keys(label);
        if (keys.join(",") !== fields.join(",")) {
          problems.push(`${item.id}.${side} 字段集/顺序不对称：${keys.join(",") || "(空)"}`);
        }
        const score = label.sentiment_score;
        if (score !== undefined && score !== null && !SCORE_RE.test(String(score))) {
          problems.push(`${item.id}.${side}.sentiment_score 未量化到 ${SCORE_DECIMALS} 位小数：${JSON.stringify(score)}`);
        }
        if (label.aspects !== undefined && !Array.isArray(label.aspects)) problems.push(`${item.id}.${side}.aspects 不是数组`);
        if (label.emotion !== undefined && !Array.isArray(label.emotion)) problems.push(`${item.id}.${side}.emotion 不是数组`);
      }
      // A/B 必须来自同一份字段清单，且键顺序一致（blindLabel 保证，自检兜底）
      const ka = Object.keys(item.A ?? {}).join(",");
      const kb = Object.keys(item.B ?? {}).join(",");
      if (ka !== kb) problems.push(`${item.id} 的 A/B 字段顺序不一致：A=${ka} B=${kb}`);
    }
  }

  if (problems.length) {
    const detail = [...new Set(problems)].slice(0, 8).join("；");
    throw new Error(`盲评提示词自检失败（${problems.length} 项）：${detail}`);
  }
  return { ok: true, checkedPrompts: unitCount, leakWords: LEAK_PATTERNS.length, scoreGrid: `0.${"0".repeat(SCORE_DECIMALS - 1)}1`, structuralSymmetry: true };
}

// ---------------------------------------------------------------------------
// 两轮提示词（缺陷 3）
// ---------------------------------------------------------------------------

const OUTPUT_SPEC = [
  "输出严格 JSON（不要 Markdown 代码块、不要多余文字），格式：",
  '{"judgments":[{"id":"<原样回填>","winner":"A"|"B"|"tie","reason":"一句话中文理由"}]}',
  "每一条 id 都必须有且只有一条判断。",
];

/**
 * 提示词模板与 payload 分开拼装：同一份模板数组同时生成「真实提示词」与「脱敏扫描文本」，
 * 保证自检扫到的模板与真正发出去的模板字符级一致（如果各写一份，模板漂移会绕过自检）。
 */
function composePrompt(template, payload) {
  return [...template, "", "待评审数据：", payload].join("\n");
}

/** 主轮模板：决定胜负。只比两套机制真正同源的字段。
 * 为什么只比这些：is_relevant / sentiment / intent 两边都是「在同一个受控词表里选一个」，
 * aspects 则是「一边固定维度集合逐个判定、一边自由列举」，机制不同源，放进同一轮
 * 会让评审惩罚「报得多」而不是惩罚「报得错」。
 */
const MAIN_TEMPLATE = [
  "你是独立、严格的标注质量评审。下面给你若干条中文/英文评论，每条有两组匿名标注 A 和 B，",
  "来自两个不同的标注系统。你不知道也不关心哪一组来自哪个系统，请只依据标注与原文的吻合度判断，",
  "不要根据标注风格去猜测来源。",
  "",
  "本轮只评以下四项（分析维度与情绪在另一轮单独评，本轮完全不要考虑）：",
  "1. is_relevant（是否在讨论/评价某个 AI 模型或产品）判断是否正确；",
  "2. sentiment 与 sentiment_score 是否贴合原文的真实态度与强度（分数范围 -1.0 ~ 1.0，已统一到一位小数）；",
  "3. intent 是否概括了评论的主要意图；",
  "4. evidence_quote 是否逐字来自原文，并且能支撑该组给出的结论。",
  "   引文必须逐字来自原文；评审时只判断引文是否支撑结论，不判断它由谁产生。",
  "",
  "说明：",
  "- 两组各有对错时判 tie；不要为了分出胜负而强行选择。",
  "- 只依据下面 JSON 中的信息，不要参考任何外部知识，也不要猜测系统身份。",
  "",
  ...OUTPUT_SPEC,
];

/** 附加轮模板：只作观察，不计入胜负。
 * 明确写出「数量多寡本身不是优劣」，把评审的注意力从「报了几个」掰回「报得准不准、关键维度漏没漏」。
 */
const ASPECTS_TEMPLATE = [
  "你是独立、严格的标注质量评审。下面给你若干条中文/英文评论，每条有两组匿名标注 A 和 B 的",
  "分析维度（aspects）与情绪（emotion），来自两个不同的标注系统。",
  "你不知道也不关心哪一组来自哪个系统，请只依据标注与原文的吻合度判断。",
  "",
  "注意：两组列举维度的机制可能不同，列举数量与粒度都可能有差异。",
  "**数量多寡本身不是优劣**：不要因为列得多就加分，也不要因为列得少就减分。",
  "",
  "逐条判断哪一组的维度与情绪更准确：",
  "1. 列出的每个维度是否确实被原文支持（凭空硬凑要扣分）；",
  "2. 原文明确提到的关键维度是否有遗漏（明显遗漏要扣分）；",
  "3. emotion 是否贴合原文的情绪。",
  "",
  "说明：",
  "- 两组各有对错时判 tie；不要为了分出胜负而强行选择。",
  "- 本轮是附加观察项，不计入总体胜负。",
  "- 只依据下面 JSON 中的信息，不要参考任何外部知识，也不要猜测系统身份。",
  "",
  ...OUTPUT_SPEC,
];

function buildMainPrompt(units) {
  const payload = serializeUnits(units);
  const scanPayload = serializeUnits(units, { redactData: true });
  return {
    prompt: composePrompt(MAIN_TEMPLATE, payload),
    scanText: composePrompt(MAIN_TEMPLATE, scanPayload),
    payload,
    fields: MAIN_FIELDS,
  };
}

function buildAspectsPrompt(units) {
  const payload = serializeUnits(units);
  const scanPayload = serializeUnits(units, { redactData: true });
  return {
    prompt: composePrompt(ASPECTS_TEMPLATE, payload),
    scanText: composePrompt(ASPECTS_TEMPLATE, scanPayload),
    payload,
    fields: ASPECTS_FIELDS,
  };
}

const JUDGMENT_SCHEMA = {
  type: "object",
  properties: {
    judgments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          winner: { type: "string", enum: ["A", "B", "tie"] },
          reason: { type: "string" },
        },
        required: ["id", "winner", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["judgments"],
  additionalProperties: false,
};

/** 从 claude 的 result / structured_output 里抠出 JSON；容忍代码块包裹。 */
function coerceJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  const text = String(value).trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* 继续抠 */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* 放弃 */ }
  }
  return null;
}

function parseEnvelope(stdout) {
  let envelope;
  try { envelope = JSON.parse(String(stdout).trim()); } catch {
    throw new Error(`claude 输出不是 JSON 信封：${truncate(stdout, 200)}`);
  }
  if (envelope?.is_error) {
    throw new Error(`claude 返回错误：${truncate(envelope.result ?? envelope.subtype ?? "unknown", 200)}`);
  }
  const parsed = coerceJson(envelope.structured_output) ?? coerceJson(envelope.result);
  if (!parsed) throw new Error(`claude 输出里没有可解析的 JSON：${truncate(envelope.result, 200)}`);
  const judgments = Array.isArray(parsed) ? parsed : parsed.judgments;
  if (!Array.isArray(judgments)) throw new Error("claude 输出缺少 judgments 数组");
  return { judgments, envelope };
}

// ---------------------------------------------------------------------------
// claude CLI 调用（缺陷 1：把调用参数与版本记录下来）
// ---------------------------------------------------------------------------

/**
 * 非交互调用本地 claude CLI。
 * 已用 `claude --help` 确认：`-p/--print` 是非交互入口，`--output-format json` 返回 JSON 信封，
 * `--json-schema` 约束结构化输出，`--tools ""` 禁用工具（盲评不需要读文件/跑命令，禁用后更快也更安全）。
 * 老版本不认 --json-schema 时自动降级为纯提示词约束。
 *
 * model 参数会原样传给 `--model`，并写进 review_raw.jsonl —— 审计要求「评审模型名/版本/耗时」
 * 可追溯，否则同一份 review.md 在不同时间跑出来对不上也没人知道换了模型。
 */
function runClaudeOnce(command, prompt, { withSchema, model }) {
  const args = ["-p", prompt, "--output-format", "json", "--tools", "", "--no-session-persistence"];
  if (model) args.push("--model", String(model));
  if (withSchema) args.push("--json-schema", JSON.stringify(JUDGMENT_SCHEMA));
  return new Promise((resolve) => {
    let settled = false;
    // 同 runCodexOnce：timer 先声明，避免 spawn 同步抛错时 done 踩 TDZ
    let timer = null;
    const done = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    let child;
    try {
      child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return done({ ok: false, code: err?.code ?? null, error: String(err?.message ?? err), stdout: "", stderr: "", args, argvSansPrompt: args.filter((a) => a !== prompt) });
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* 已经退了 */ }
    }, CLAUDE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => done({ ok: false, code: err?.code ?? null, error: String(err?.message ?? err), stdout, stderr, args, argvSansPrompt: args.filter((a) => a !== prompt) }));
    child.on("close", (code) => done({
      ok: code === 0 && !timedOut,
      code,
      timedOut,
      error: timedOut ? `claude 调用超时（${CLAUDE_TIMEOUT_MS}ms）` : (code === 0 ? null : `claude 退出码 ${code}：${truncate(stderr || stdout, 200)}`),
      stdout,
      stderr,
      args,
      argvSansPrompt: args.filter((a) => a !== prompt),
    }));
  });
}

async function callClaude(command, prompt, { model } = {}) {
  const t0 = Date.now();
  let result = await runClaudeOnce(command, prompt, { withSchema: true, model });
  // 老版本 CLI 不认 --json-schema：识别到 unknown option 就退回纯提示词模式
  if (!result.ok && /unknown option|unrecognized|--json-schema/i.test(String(result.error ?? ""))) {
    result = await runClaudeOnce(command, prompt, { withSchema: false, model });
  }
  const ms = Date.now() - t0;
  if (!result.ok) {
    const err = new Error(result.error ?? "claude 调用失败");
    err.code = result.code;
    err.ms = ms;
    err.raw = result;
    throw err;
  }
  const { judgments, envelope } = parseEnvelope(result.stdout);
  // finalMessage：本次调用的「原始响应正文」。claude 的正文就是 stdout（JSON 信封）。
  // 统一成同一个字段名，聚合层才能对两种适配器用同一套哈希/落盘逻辑。
  return { judgments, ms, raw: { ...result, finalMessage: result.stdout }, envelope };
}

// ---------------------------------------------------------------------------
// codex CLI 调用（真正的第三方裁判：OpenAI gpt-5.6-sol）
// ---------------------------------------------------------------------------

/**
 * 非交互调用本地 codex CLI。
 *
 * 为什么必须换掉 claude：本机 `ANTHROPIC_BASE_URL/ANTHROPIC_MODEL` 把 claude CLI 路由到了
 * `deepseek-flash[1m]`，即右道本尊 —— 让选手给自己打分，胜负结论无效。codex 走 OpenAI，
 * 与两道（TypeSafe/OpenRouter 与 DeepSeek）都无关联。
 *
 * 调用协议（已用 `codex exec --help` 与实测确认）：
 *   codex exec --skip-git-repo-check -c model='"<model>"' \
 *         --output-schema <schema.json> -o <last-message.json> -
 * - 提示词从 stdin 传入（末尾的 `-`）：提示词含 8 条中文评论 + 两组标签，动辄数千字符，
 *   走 argv 容易踩 ARG_MAX，也可能被进程列表看到；stdin 更稳。
 * - `-o/--output-last-message` 把最终消息写成文件。**这是取结果的唯一路径**：
 *   stdout 里混着 banner/进度/`tokens used`，用正则去抠等于把解析错误当成评审结论。
 * - `--output-schema` 直接复用 JUDGMENT_SCHEMA（与 claude 的 --json-schema 是同一个对象），
 *   保证两条适配器的输出契约完全一致，解析层不需要分叉。
 * - `-c model='"gpt-5.6-sol"'`：`-c` 的值按 TOML 解析，所以模型名必须带引号才是字符串。
 * - cwd 设为临时目录：codex 会把 cwd 下的 AGENTS.md / skills 注入上下文，
 *   在项目目录里跑等于给裁判塞了「这是 jev-arena 项目」的额外信息，会破坏盲评。
 */
function runCodexOnce(command, prompt, { model, schemaFile, outFile, cwd }) {
  // TOML 字符串：模型名里的 " 和 \ 需要转义，否则 -c 会解析失败
  const modelToml = `"${String(model).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const args = [
    "exec",
    "--skip-git-repo-check",
    "-c", `model=${modelToml}`,
    "--output-schema", schemaFile,
    "-o", outFile,
    "-", // 提示词从 stdin 读
  ];
  return new Promise((resolve) => {
    let settled = false;
    // timer 必须先声明再进 done：spawn 同步抛错时 done 会在 setTimeout 赋值前被调用，
    // 用 const 会产生 TDZ ReferenceError，把一个「启动失败」变成「报错信息丢失」。
    let timer = null;
    const done = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    let child;
    try {
      child = spawn(command, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return done({ ok: false, code: err?.code ?? null, error: String(err?.message ?? err), stdout: "", stderr: "", args });
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* 已经退了 */ }
    }, CODEX_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => done({ ok: false, code: err?.code ?? null, error: String(err?.message ?? err), stdout, stderr, args }));
    child.on("close", (code) => done({
      ok: code === 0 && !timedOut,
      code,
      timedOut,
      error: timedOut ? `codex 调用超时（${CODEX_TIMEOUT_MS}ms）` : (code === 0 ? null : `codex 退出码 ${code}：${truncate(stderr || stdout, 200)}`),
      stdout,
      stderr,
      args,
    }));
    // 提示词写进 stdin 后立刻关闭：codex 阻塞等 EOF 才不会卡死
    try {
      child.stdin.on("error", () => { /* 子进程提前退出时忽略 EPIPE */ });
      child.stdin.end(prompt);
    } catch { /* stdin 已关闭 */ }
  });
}

/**
 * 从 codex 的 banner 里读「实际生效的模型/provider」。
 * 为什么值得解析：`-c model=` 只能证明我们**要求**了什么，证明不了它真的连了谁——
 * 与 claude 信封 modelUsage 的意义相同。banner 是 codex 自己打印的固定格式：
 *   OpenAI Codex v0.153.4
 *   --------
 *   workdir: /tmp/xxx
 *   model: gpt-5.6-sol
 *   provider: openai
 * 逐行前缀匹配（不是从结果里抠 JSON），失败就返回 null，绝不猜。
 */
function parseCodexBanner(stderr) {
  const meta = { cliVersion: null, model: null, provider: null, sessionId: null, reasoningEffort: null, sandbox: null };
  for (const rawLine of String(stderr ?? "").split("\n")) {
    const line = rawLine.trim();
    const m = /^([a-z][a-z ]*):\s*(.+)$/i.exec(line);
    if (!m) {
      const v = /^OpenAI Codex v(.+)$/i.exec(line);
      if (v) meta.cliVersion = v[1].trim();
      continue;
    }
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "model") meta.model = value;
    else if (key === "provider") meta.provider = value;
    else if (key === "session id") meta.sessionId = value;
    else if (key === "reasoning effort") meta.reasoningEffort = value;
    else if (key === "sandbox") meta.sandbox = value;
  }
  return meta;
}

/** codex 的返回体解析：唯一来源是 -o 文件（不是 stdout）。 */
function parseCodexMessage(text) {
  const parsed = coerceJson(text);
  if (!parsed) throw new Error(`codex 的 -o 文件没有可解析的 JSON：${truncate(text, 200)}`);
  const judgments = Array.isArray(parsed) ? parsed : parsed.judgments;
  if (!Array.isArray(judgments)) throw new Error("codex 输出缺少 judgments 数组");
  return judgments;
}

async function callCodex(command, prompt, { model } = {}) {
  if (!model) throw new Error("codex 适配器要求显式指定 model（-c model=），否则无法确认裁判是谁，也无法做同源守卫");
  const t0 = Date.now();
  // 临时目录放在系统 temp 下：① 不污染 run 目录（评审产物只有 review.md/review_raw.jsonl）；
  // ② 该目录不是 git 仓库、没有 AGENTS.md，codex 注入的上下文最少。
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "jev-arena-review-"));
  const schemaFile = path.join(tmpDir, "judgment.schema.json");
  const outFile = path.join(tmpDir, "last-message.json");
  let result;
  try {
    await writeFile(schemaFile, JSON.stringify(JUDGMENT_SCHEMA, null, 2), "utf8");
    result = await runCodexOnce(command, prompt, { model, schemaFile, outFile, cwd: tmpDir });
    let finalMessage = null;
    try { finalMessage = await readFile(outFile, "utf8"); } catch { /* 失败时可能没写出来 */ }
    const ms = Date.now() - t0;
    const banner = parseCodexBanner(result.stderr);
    // 落盘用的原始记录：argv 里的临时路径在清理后无意义，替换成占位符，
    // 真正需要复核的是「调了哪个可执行文件 + 哪些语义参数」。
    const argsSansPaths = (result.args ?? []).map((a) => (a === schemaFile ? "<schema.json>" : a === outFile ? "<last-message.json>" : a));
    const raw = {
      ...result,
      args: argsSansPaths,
      argvSansPrompt: argsSansPaths,
      finalMessage,
      banner,
      // codex 不返回 token/费用信封；banner 里的模型名就是「实际生效模型」的证据
      resultSource: "codex -o last-message.json",
    };
    if (!result.ok) {
      const err = new Error(result.error ?? "codex 调用失败");
      err.code = result.code;
      err.ms = ms;
      err.raw = raw;
      throw err;
    }
    if (finalMessage == null || !String(finalMessage).trim()) {
      const err = new Error(`codex 退出码 0 但没有写出 -o 文件内容（stdout 尾部：${truncate(result.stdout, 160)}）`);
      err.code = result.code;
      err.ms = ms;
      err.raw = raw;
      throw err;
    }
    const judgments = parseCodexMessage(finalMessage);
    // envelope 保持与 claude 同形，聚合层无需分叉；modelEffective 复用「实际生效模型名」的语义
    const envelope = {
      subtype: "codex-exec",
      session_id: banner.sessionId,
      modelUsage: banner.model ? { [banner.model]: { provider: banner.provider } } : null,
      codex: banner,
      usage: null,
    };
    return { judgments, ms, raw, envelope };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => { /* 临时目录清理失败不影响结论 */ });
  }
}

/** 统一入口：按 agent 分派到对应适配器。未知 agent 直接抛错，而不是静默按 claude 跑。 */
async function callJudge(agent, prompt, { model } = {}) {
  const kind = agentKind(agent);
  if (kind === "codex") return callCodex(agent, prompt, { model });
  if (kind === "claude") return callClaude(agent, prompt, { model });
  throw new Error(`不支持的评审 agent「${agent}」（可选：${REVIEW_AGENTS.join(" / ")}，也可传它们的可执行文件路径）`);
}

/**
 * 离线重放：不调用任何 CLI，直接用已落盘的 review_raw.jsonl 重新聚合、重新渲染。
 *
 * 为什么需要它（不是锦上添花）：
 *  ① 审计要求「同一份原始记录能重放出同一份结论」—— 重放是检验这条要求的唯一手段，
 *     否则 review_raw.jsonl 只是躺在磁盘上的装饰。
 *  ② 裁判额度是真实约束。本次改完结论文案（区间跨 50% 时不再宣布胜者）后重跑了一遍，
 *     结果撞上 codex 用量上限，seed3 的 44 条主轮判定全部失败 —— 那次重跑本可以用重放避免。
 *     模型涨价/下线/改名之后，历史 run 也必须还能按新口径重新出报告。
 *
 * 完整性校验：重放时必须逐块比对 promptSha256。对不上说明 review_raw.jsonl 与当前
 * 抽样算法/blind 版本已经不一致（换了种子算法、改了提示词、换了 run），此时重放出来的
 * 结论与原始记录无关，必须报错而不是照用。
 */
async function loadReplayEntries(runDir) {
  const text = await readText(path.join(runDir, "review_raw.jsonl"));
  if (text == null) throw new Error(`重放需要 review_raw.jsonl，但读不到：${runDir}`);
  const lines = parseJsonl(text);
  const header = lines.find((l) => l?.type === "header") ?? null;
  if (!header) throw new Error("review_raw.jsonl 缺少 header，无法确认重放口径");
  const entries = new Map();
  // 兼容早期记录：那一版的 `chunk` 字段误存了块内容（数组）而不是序号，
  // 只能按同一 (seed, round) 分组内的出现顺序推导序号 —— 记录本身就是按序写入的。
  const seen = new Map();
  for (const line of lines) {
    if (line?.type !== "chunk") continue;
    const group = `${line.seed}|${line.round}`;
    const idx = Number.isInteger(line.chunk) ? line.chunk : (seen.get(group) ?? 0);
    seen.set(group, idx + 1);
    entries.set(`${group}|${idx}`, line);
  }
  if (entries.size === 0) throw new Error("review_raw.jsonl 里没有任何 chunk 记录，无法重放");
  return { header, entries };
}

/** 把一条落盘记录还原成 callJudge 的返回形状，让重放与实时调用走完全相同的聚合路径。 */
function replayedCall(entry, builtPrompt) {
  // 提示词哈希不一致 = 记录与当前代码/参数不是同一套，重放结论无效
  const fresh = sha256(builtPrompt);
  if (entry.promptSha256 !== fresh) {
    const err = new Error(
      `重放校验失败：seed ${entry.seed} / ${entry.round} / 块 ${entry.chunk} 的提示词哈希与记录不符`
      + `（记录 ${String(entry.promptSha256).slice(0, 12)}…，重算 ${fresh.slice(0, 12)}…）。`
      + "说明抽样算法、盲评版本或提示词模板已变化，这份 review_raw.jsonl 不能用来重放当前口径。",
    );
    err.code = "REPLAY_MISMATCH";
    throw err;
  }
  if (!entry.ok) {
    const err = new Error(`重放的历史记录本身是失败块：${entry.error ?? "未知原因"}`);
    err.code = entry.exitCode;
    err.raw = null;
    throw err;
  }
  return {
    judgments: entry.judgments ?? [],
    ms: entry.ms ?? 0,
    // 原始起止时间原样带回：否则重放一次就把「当时什么时候跑的」改写成「重放的时间」
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    // 原样回填，保证重放产出的 review_raw.jsonl 与原始记录逐字段一致（哈希也一样）
    raw: {
      code: entry.exitCode,
      timedOut: Boolean(entry.timedOut),
      stdout: entry.responseStdout,
      stderr: entry.responseStderr,
      finalMessage: entry.responseFinalMessage,
      argvSansPrompt: entry.argvSansPrompt,
      banner: entry.banner ?? null,
      resultSource: entry.resultSource,
    },
    envelope: {
      subtype: entry.envelopeMeta?.subtype ?? null,
      session_id: entry.envelopeMeta?.session_id ?? null,
      usage: entry.envelopeMeta?.usage ?? null,
      codex: entry.envelopeMeta?.codex ?? null,
      modelUsage: entry.modelUsage ?? null,
    },
  };
}

/**
 * review_raw.jsonl 的每块记录（成功/失败共用同一个构造函数）。
 * 为什么合并：审计要求「实际 agent 名、CLI 版本、模型参数、耗时、退出码、原始响应哈希」全部落盘，
 * 失败的那一块同样要能回答这些问题（失败的调用往往才最需要复核）。两条路径各写一份对象，
 * 迟早会漂移成「失败记录缺字段」，所以只留一个构造函数。
 */
function buildChunkEntry({
  pass, seed, round, chunkIndex, chunkCount, chunkSize, ids,
  agent, model, agentVersion, prompt, startedAt, finishedAt, ms, raw, envelope, ok, error, judgments, unmatched,
}) {
  const finalMessage = raw?.finalMessage ?? raw?.stdout ?? null;
  const usage = envelope?.usage ?? null;
  return {
    type: "chunk",
    pass,
    seed,
    round: round.name,
    roundNote: round.note,
    chunk: chunkIndex, // 块序号（不是块内容）：块内容在 prompt 里已有全文，重复存一份只会让记录膨胀且丢索引
    chunkCount,
    chunkSize,
    ids,
    // --- 审计要求①：实际 agent 名 / CLI 版本 / 模型参数 ---
    agent,
    agentVersion: agentVersion ?? null,
    cliVersion: agentVersion ?? null,
    claudeVersion: agentVersion ?? null, // 兼容上一轮审计已落盘的字段名
    modelArg: model ?? null,
    model: model ?? null,
    argvSansPrompt: raw?.argvSansPrompt ?? null,
    commandShape: (raw?.argvSansPrompt ?? []).length ? [agent, ...raw.argvSansPrompt].join(" ") : null,
    // --- 审计要求②：提示词原文 + 哈希 / 耗时 / 起止 / 退出码 ---
    // 提示词必须留全文（不只是哈希）：否则「当时到底给裁判看了什么」无法复核，
    // 而盲评最容易被质疑的恰恰是提示词是否泄漏了身份。
    prompt,
    promptSha256: sha256(prompt),
    // 起止时间默认取「现在」；重放时由调用方传入原始记录里的时间，
    // 否则重放一次就把「当时什么时候跑的」覆盖成「重放的时间」，审计时间线就假了。
    startedAt,
    finishedAt: finishedAt ?? new Date().toISOString(),
    ms,
    ok: Boolean(ok),
    exitCode: raw?.code ?? null,
    timedOut: Boolean(raw?.timedOut),
    error: error ?? null,
    // --- 审计要求③：原始响应的哈希（正文来自 -o 文件 / stdout，不是从日志里抠出来的）---
    resultSource: raw?.resultSource ?? "claude stdout（JSON 信封）",
    responseSha256: finalMessage != null ? sha256(finalMessage) : null,
    responseStdoutSha256: raw?.stdout != null ? sha256(raw.stdout) : null,
    responseStderrSha256: raw?.stderr != null ? sha256(raw.stderr) : null,
    responseFinalMessage: finalMessage,
    responseStdout: raw?.stdout ?? null,
    responseStderr: raw?.stderr ?? null,
    // --- 实际生效的评审模型（拿不到就是空数组，报告里如实写「未能确认」）---
    // claude：信封 modelUsage；codex：banner 的 model: 行（它自己报的，比我们的参数可信）
    modelEffective: envelope?.modelUsage
      ? Object.keys(envelope.modelUsage)
      : (raw?.banner?.model ? [raw.banner.model] : []),
    modelUsage: envelope?.modelUsage ?? null,
    banner: raw?.banner ?? null,
    envelopeMeta: {
      subtype: envelope?.subtype ?? null,
      session_id: envelope?.session_id ?? null,
      duration_ms: envelope?.duration_ms ?? null,
      num_turns: envelope?.num_turns ?? null,
      total_cost_usd: envelope?.total_cost_usd ?? null,
      usage,
      codex: envelope?.codex ?? null,
    },
    // --- 审计要求④：解析结果 ---
    parsed: Boolean(ok),
    parseError: ok ? null : (error ?? null),
    judgments,
    unmatchedJudgments: unmatched,
  };
}

/**
 * 评审模型与参赛两道「同名/同源」检测。
 *
 * 为什么必须做：`claude --version` 只能证明 CLI 版本，**证明不了实际跑的是哪个模型**——
 * 本地 CLI 的模型来自配置（settings.json 的 ANTHROPIC_MODEL 等），完全可能指向第三方模型。
 * 实测本机默认 `ANTHROPIC_MODEL=deepseek-flash[1m]`，即右道本尊：上一轮「DeepSeek 赢」的
 * 盲评里裁判就是选手自己，结论无效。评审者与参赛者同源时，它的偏好会直接伪装成
 * 「独立结论」，这比样本量小严重得多。
 */
const REVIEWER_LANE_PATTERNS = [
  { lane: "deepseek", re: /deepseek/i },
  { lane: "jev", re: /\bjev\b/i },
];

/**
 * 各 CLI 真正会读的「模型路由」环境变量。
 * 为什么要按 agent 分开：codex 根本不读 ANTHROPIC_*，拿它去拒绝 codex 运行属于误报；
 * 反过来，只看显式 `--model` 参数又会漏掉「参数是 A、环境变量把它路由到 B」这个真实翻车姿势。
 */
const CLAUDE_ROUTING_ENV = [
  "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_REASONING_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
];
const CODEX_ROUTING_ENV = ["OPENAI_MODEL", "CODEX_MODEL", "OPENAI_DEFAULT_MODEL", "CODEX_DEFAULT_MODEL"];
/** 跨 CLI 记录、用于审计的变量：即使对当前 agent 不生效也要落盘，方便解释「为什么这次没触发守卫」。 */
const AUDIT_ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "OPENAI_BASE_URL", "OPENAI_MODEL"];

/** 归一化模型名：去掉 `[1m]` 这类上下文长度后缀、空格与大小写差异。 */
function normalizeModelName(name) {
  return String(name ?? "").toLowerCase().replace(/\[[^\]]*\]/g, "").replace(/\s+/g, "").trim();
}

/**
 * 两个模型名是否指向同一个模型。
 * 判据：归一化后相等，或一方是另一方的子串（去掉 provider 前缀后再比一次，
 * 覆盖 `typesafe/jev-1.13` vs `jev-1.13` 这种写法）。子串判定要求长度 ≥ 4，
 * 避免 `gpt` 之类短名把无关模型误判成撞车。
 */
function modelNamesCollide(a, b) {
  const x = normalizeModelName(a);
  const y = normalizeModelName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const tail = (v) => (v.includes("/") ? v.slice(v.lastIndexOf("/") + 1) : v);
  if (tail(x) === tail(y) && tail(x).length >= 4) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 4) return false;
  return long.includes(short) || tail(long).includes(tail(short));
}

/**
 * 同源守卫（硬性）：裁判模型与任一参赛道「同名/同源」时**直接抛错拒绝运行**。
 *
 * 为什么从「告警」升级成「抛错」：上一轮已经在 review.md 顶部写了警告，但报告照样产出了
 * 一份「DeepSeek 赢」的结论并被拿去做视频 —— 告警是可以被忽略的，拒绝运行不能。
 * 裁判与选手同源属于方法学失效，此时「有结论」比「没结论」更危险。
 *
 * 检查范围（三路取证，任一命中即拒绝）：
 *   ① 显式模型参数（claude `--model` / codex `-c model=`）；
 *   ② 该 CLI 真正会读的路由环境变量（claude 的 ANTHROPIC_ 前缀组，codex 的 OPENAI_ / CODEX_ 前缀组）；
 *   ③ 运行时元数据里的实际模型名（claude 信封 modelUsage / codex banner 的 model:）。
 * 对照面是 manifest 里两条道的真实模型名 + 家族级正则（deepseek / jev）。
 */
function checkJudgeSameSource({ agent, model, modelEffective, laneModels, env = process.env }) {
  // 按适配器种类决定「哪些环境变量会影响这个裁判」，而不是按传入的字符串字面量
  const isCodex = agentKind(agent) === "codex";
  const routingEnv = isCodex ? CODEX_ROUTING_ENV : CLAUDE_ROUTING_ENV;
  // 不适用于当前 agent 的那组变量：记录但不参与判定，避免误报（ANTHROPIC_* 不影响 codex）
  const inapplicableEnv = isCodex ? CLAUDE_ROUTING_ENV : CODEX_ROUTING_ENV;

  const judgeModels = [];
  const addJudge = (name, source) => {
    const value = String(name ?? "").trim();
    if (value) judgeModels.push({ name: value, source });
  };
  addJudge(model, isCodex ? "-c model= 参数" : "--model 参数");
  for (const key of routingEnv) addJudge(env?.[key], `环境变量 ${key}`);
  addJudge(modelEffective, "运行时元数据里的实际模型");

  const rivals = (laneModels ?? [])
    .filter((l) => l?.model)
    .map((l) => ({ name: String(l.model), source: `manifest「${l.label ?? l.id}」道的模型` }));

  const conflicts = [];
  const seen = new Set();
  const push = (c) => {
    const key = `${normalizeModelName(c.judgeModel)}|${c.lane ?? normalizeModelName(c.rivalModel)}`;
    if (seen.has(key)) return;
    seen.add(key);
    conflicts.push(c);
  };
  for (const j of judgeModels) {
    for (const r of rivals) {
      if (modelNamesCollide(j.name, r.name)) {
        push({ judgeModel: j.name, judgeSource: j.source, rivalModel: r.name, rivalSource: r.source, kind: "同名/同源", lane: null });
      }
    }
    for (const { lane, re } of REVIEWER_LANE_PATTERNS) {
      if (re.test(j.name)) {
        push({ judgeModel: j.name, judgeSource: j.source, rivalModel: null, rivalSource: null, kind: "家族级同源", lane });
      }
    }
  }

  const envSnapshot = {};
  for (const key of AUDIT_ENV) if (env?.[key] != null) envSnapshot[key] = env[key];
  const inapplicable = {};
  for (const key of inapplicableEnv) if (env?.[key] != null) inapplicable[key] = env[key];

  return {
    ok: conflicts.length === 0,
    agent,
    judgeModels,
    rivals,
    conflicts,
    env: envSnapshot,
    // 明确记录「哪些同源信号对当前 agent 不适用」，防止事后误读成漏检
    inapplicableEnv: inapplicable,
  };
}

/** 守卫失败时抛出的错误：带 code 便于上层区分「拒绝运行」与「评审调用失败」。 */
function assertJudgeNotSameSource(args) {
  const guard = checkJudgeSameSource(args);
  if (guard.ok) return guard;
  const lines = guard.conflicts.map((c) => c.rivalModel
    ? `  - 裁判模型「${c.judgeModel}」（来自 ${c.judgeSource}）与 ${c.rivalSource}「${c.rivalModel}」撞车`
    : `  - 裁判模型「${c.judgeModel}」（来自 ${c.judgeSource}）与「${c.lane}」道家族级同源`);
  const err = new Error(
    `同源守卫拒绝运行：裁判与参赛道同源，此时任何胜负都只是该模型的自我偏好，不是独立结论。\n${lines.join("\n")}\n`
    + `请换一个与两道都无关的裁判（例如：agent:"codex", model:"gpt-5.6-sol"）。`,
  );
  err.code = "REVIEWER_SAME_SOURCE";
  err.guard = guard;
  throw err;
}

/** 兼容层：软性检测（只用于报告里展示「实际生效模型」，不再承担拦截职责）。 */
function detectReviewerConflict(models) {
  const list = [...new Set((models ?? []).filter(Boolean))];
  const conflicts = [];
  for (const model of list) {
    for (const { lane, re } of REVIEWER_LANE_PATTERNS) {
      if (re.test(model)) conflicts.push({ model, lane });
    }
  }
  return {
    reviewerModels: list,
    conflicts,
    warning: conflicts.length
      ? `评审模型 ${conflicts.map((c) => `「${c.model}」`).join("、")} 与「${conflicts.map((c) => c.lane).join("、")}」道同名/同源，`
        + "存在自我偏好风险：本报告的胜负不能当作独立第三方的结论，需换一个与两道都无关的评审模型复跑。"
      : null,
  };
}

/** 探测 CLI 版本（claude 与 codex 都支持 `--version`）。失败不抛错，返回 null + 错误信息。 */
function runCliVersion(command) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    let child;
    try {
      child = spawn(command, ["--version"], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return done({ version: null, error: String(err?.message ?? err) });
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }, VERSION_TIMEOUT_MS);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (err) => done({ version: null, error: String(err?.message ?? err) }));
    child.on("close", (code) => done({
      version: code === 0 ? String(stdout).trim().split("\n")[0] : null,
      error: code === 0 ? null : truncate(stderr || stdout, 200),
    }));
  });
}

// ---------------------------------------------------------------------------
// 输入加载（多个 seed 共用，避免重复读盘）
// ---------------------------------------------------------------------------

async function loadReviewInputs(runDir) {
  const manifest = await readJson(path.join(runDir, "manifest.json"));
  const [jevText, dsText, eventsText] = await Promise.all([
    readText(path.join(runDir, "labels.jev.jsonl")),
    readText(path.join(runDir, "labels.deepseek.jsonl")),
    readText(path.join(runDir, "events.jsonl")),
  ]);
  if (jevText == null || dsText == null) throw new Error(`labels.<lane>.jsonl 不存在：${runDir}`);
  const labels = { jev: parseJsonl(jevText), deepseek: parseJsonl(dsText) };
  const events = parseJsonl(eventsText ?? "");

  const dsById = new Map(labels.deepseek.map((l) => [String(l.comment_id), l]));
  const paired = [];
  for (const jl of labels.jev) {
    const dl = dsById.get(String(jl.comment_id));
    if (dl) paired.push({ comment_id: String(jl.comment_id), jev: jl, deepseek: dl });
  }
  if (paired.length === 0) throw new Error("没有两道都成功的评论，无法盲评");

  // 正文/platform 只在数据集里，labels.jsonl 没有；取不到就退化为 events 的 preview 并声明局限
  let rowsById = null;
  let datasetNote = null;
  try {
    const csvPath = manifest?.dataset?.path ?? process.env.DATA_PATH ?? path.resolve(runDir, "..", "..", "data", "comments.csv");
    const { rows } = loadDataset(csvPath);
    rowsById = new Map(rows.map((r) => [String(r.comment_id), r]));
  } catch (err) {
    datasetNote = `原始数据集未能加载（${err.message}），评论正文退化为 events.jsonl 里的 preview（截断），可能影响评审判断。`;
  }
  if (!rowsById) {
    rowsById = new Map();
    for (const evt of events) {
      if (evt?.type === "decision" && evt?.commentId && !rowsById.has(String(evt.commentId))) {
        rowsById.set(String(evt.commentId), { comment_id: String(evt.commentId), content: evt.preview ?? "", platform: "(未知)" });
      }
    }
  }
  return { manifest, labels, events, paired, rowsById, datasetNote };
}

// ---------------------------------------------------------------------------
// 单次盲评 pass（一个 seed 一条道，含主轮 + 附加轮）
// ---------------------------------------------------------------------------

/**
 * 跑一个 seed 的完整盲评。
 * @returns {Promise<object>} 含 verdict.main / verdict.aspects / detail / rawEntries / keyEntries / selfCheck
 */
async function runPass(ctx, { seed, passIndex, passCount, agent, model, write, progress }) {
  const { runId, paired, rowsById, claudeVersion } = ctx;
  const rng = mulberry32(seed);
  const platformOf = (item) => rowsById.get(item.comment_id)?.platform ?? "(未知)";
  const sampled = stratifiedSample(paired, ctx.sampleSize, rng, platformOf);
  progress("sample", {
    done: sampled.length,
    total: ctx.sampleSize,
    message: `盲评 pass ${passIndex + 1}/${passCount}：分层抽样 ${sampled.length} 条（配对集 ${paired.length} 条，种子 ${seed}）`,
  });

  // --- 构造盲评单元 + A/B 随机化。映射只进 key，不进提示词 ---
  const keyEntries = {};
  const units = sampled.map((item, i) => {
    const id = `s${String(i + 1).padStart(3, "0")}`;
    const aIsJev = rng() < 0.5;
    keyEntries[id] = {
      comment_id: item.comment_id,
      A: aIsJev ? "jev" : "deepseek",
      B: aIsJev ? "deepseek" : "jev",
      platform: platformOf(item),
    };
    const row = rowsById.get(item.comment_id) ?? {};
    const jevLabel = item.jev;
    const dsLabel = item.deepseek;
    return {
      id,
      platform: row.platform ?? "(未知)",
      comment: truncate(row.content, 2000),
      A: aIsJev ? jevLabel : dsLabel,
      B: aIsJev ? dsLabel : jevLabel,
      // 主轮与附加轮分别送审：主轮剥掉 aspects/emotion，防止「报得多」混进胜负
      mainA: blindLabel(aIsJev ? jevLabel : dsLabel, MAIN_FIELDS),
      mainB: blindLabel(aIsJev ? dsLabel : jevLabel, MAIN_FIELDS),
      aspectsA: blindLabel(aIsJev ? jevLabel : dsLabel, ASPECTS_FIELDS),
      aspectsB: blindLabel(aIsJev ? dsLabel : jevLabel, ASPECTS_FIELDS),
    };
  });

  const blindKey = {
    version: BLIND_VERSION,
    runId,
    generatedAt: new Date().toISOString(),
    algorithm: `mulberry32(fnv1a(runId::sampleSize::${BLIND_VERSION}))`,
    seed,
    passIndex,
    passCount,
    sampleSize: units.length,
    requestedSampleSize: ctx.sampleSize,
    pairedPool: paired.length,
    // 反盲化唯一依据：A/B → lane。**绝不进入给评审模型的提示词**。
    mapping: keyEntries,
    note: "A/B 归属随机化并可复现；评审提示词只含 A/B 与白名单字段，不含本文件任何内容。",
  };
  // 分离点：映射**先落盘**，反盲化阶段再从磁盘读回。提示词构造与映射读取之间没有共享变量，
  // 代码层面就不存在「把 key 顺手带进 prompt」的路径。
  let mappingForDeblind = keyEntries;
  if (write) {
    const keyFile = path.join(ctx.runDir, passCount > 1 ? `blind_key.seed${seed}.json` : "blind_key.json");
    await writeAtomic(keyFile, JSON.stringify(blindKey, null, 2));
    mappingForDeblind = JSON.parse(await readFile(keyFile, "utf8")).mapping;
  }
  progress("blind", {
    done: units.length,
    total: units.length,
    message: `盲评单元构造完成（pass ${passIndex + 1}/${passCount}），A/B 映射已${write ? "落盘并读回" : "生成（未落盘）"}`,
  });

  // --- 调用：主轮与附加轮分开跑 ---
  const rounds = [
    { name: "main", build: buildMainPrompt, note: "决定胜负：只比机制同源的字段" },
    { name: "aspects", build: buildAspectsPrompt, note: "附加观察：不计入胜负" },
  ];
  const verdicts = {};
  const rawEntries = [];
  const selfChecks = [];
  let claudeMs = 0;
  let agentMissing = false;
  // 同源守卫第二道（fail-fast）是否已用「运行时实际模型名」验过。整个 pass 只需验一次。
  let guardVerified = false;

  for (const round of rounds) {
    const payloadUnits = units.map((u) => ({
      id: u.id,
      platform: u.platform,
      comment: u.comment,
      A: round.name === "main" ? u.mainA : u.aspectsA,
      B: round.name === "main" ? u.mainB : u.aspectsB,
    }));
    const chunks = [];
    for (let i = 0; i < payloadUnits.length; i += CHUNK_SIZE) chunks.push(payloadUnits.slice(i, i + CHUNK_SIZE));

    const bySampleId = new Map();
    let fatal = agentMissing ? `找不到可执行文件「${agent}」，本轮跳过` : null;

    for (let c = 0; c < chunks.length && !agentMissing; c++) {
      const chunk = chunks[c];
      const built = round.build(chunk);
      // 自检在调用之前：可疑提示词宁可失败，也不能发出去产生「看起来有效」的结论
      const selfCheck = assertPromptSafe(built.scanText, built.payload, built.fields, chunk.length);
      selfChecks.push({ round: round.name, chunk: c, ...selfCheck });

      const replayEntry = ctx.replay ? ctx.replay.entries.get(`${seed}|${round.name}|${c}`) : null;
      const startedAt = replayEntry?.startedAt ?? new Date().toISOString();
      const t0 = Date.now();
      const entryBase = {
        pass: passIndex, seed, round, chunkIndex: c, chunks, ids: chunk.map((u) => u.id),
        agent, model, agentVersion: claudeVersion, prompt: built.prompt, startedAt,
      };
      let entry = null;
      try {
        // 重放模式绝不退回实时调用：调用一次就花一次裁判额度，静默补跑会让
        // 「重放」变成「重跑」，也会让同一份报告混进两个时间点的判定。
        if (ctx.replay && !replayEntry) {
          throw new Error(`重放缺少该块的历史记录（seed ${seed} / ${round.name} / 第 ${c} 块），已拒绝退回实时调用`);
        }
        const called = replayEntry
          ? replayedCall(replayEntry, built.prompt)
          : await callJudge(agent, built.prompt, { model });
        const { judgments, ms, raw, envelope } = called;
        claudeMs += ms;
        const expected = new Set(chunk.map((u) => u.id));
        const matched = [];
        const unmatched = [];
        for (const j of judgments) {
          const id = String(j?.id ?? "");
          if (!expected.has(id)) { unmatched.push(j); continue; }
          const parsed = { id, winner: String(j?.winner ?? "").trim().toLowerCase(), reason: String(j?.reason ?? "").trim() };
          matched.push(parsed);
          bySampleId.set(id, { winner: parsed.winner, reason: parsed.reason });
        }
        entry = buildChunkEntry({
          ...entryBase,
          chunkSize: chunk.length,
          chunkCount: chunks.length,
          finishedAt: called.finishedAt,
          ms, raw, envelope, ok: true, error: null,
          judgments: matched, unmatched,
        });
      } catch (err) {
        const raw = err?.raw ?? {};
        for (const u of chunk) bySampleId.set(u.id, { winner: "error", reason: `评审调用失败：${err.message}` });
        entry = buildChunkEntry({
          ...entryBase,
          chunkSize: chunk.length,
          chunkCount: chunks.length,
          ms: Date.now() - t0,
          raw, envelope: null, ok: false, error: err.message,
          judgments: [], unmatched: [],
        });
        // 重放校验失败 = 这份记录与当前口径不是同一套，继续跑只会产出一份看似正常的错报告
        if (err?.code === "REPLAY_MISMATCH") throw err;
        if (err?.code === "ENOENT") {
          fatal = `找不到可执行文件「${agent}」：${err.message}`;
          agentMissing = true;
          for (const rest of chunks.slice(c + 1)) {
            for (const u of rest) bySampleId.set(u.id, { winner: "error", reason: fatal });
          }
        }
      }
      rawEntries.push(entry);
      // 同源守卫第二道（fail-fast）：第一块成功返回后，用运行时元数据里的**实际模型名**再验一次。
      // 参数和环境变量都可能被 CLI 忽略/被 profile 覆盖，只有这里报出来的名字是它自己的身份。
      // 刻意放在内层 try/catch 之外：守卫失败不能被当成「这一块评审失败」吞掉。
      // 异常会一路穿到 runBlindReview 的 catch，那里对 REVIEWER_SAME_SOURCE 直接 rethrow。
      if (!guardVerified && entry.ok && (entry.modelEffective ?? []).length > 0) {
        guardVerified = true;
        assertJudgeNotSameSource({
          agent, model, modelEffective: entry.modelEffective,
          laneModels: ctx.laneModels, env: process.env,
        });
      }
      progress("review", {
        done: Math.min((c + 1) * CHUNK_SIZE, units.length),
        total: units.length,
        message: `pass ${passIndex + 1}/${passCount} · ${round.name === "main" ? "主轮" : "附加轮"}第 ${c + 1}/${chunks.length} 块`,
      });
      if (fatal) break;
    }
    // 命令不存在时后续轮次直接跳过：把原因写给本轮所有条目，而不是留下含糊的「没有返回判断」
    if (agentMissing) {
      for (const u of units) {
        if (!bySampleId.has(u.id)) bySampleId.set(u.id, { winner: "error", reason: fatal ?? `找不到可执行文件「${agent}」` });
      }
    }

    // --- 反盲化：A/B → jev/deepseek。附加轮同样反盲化，但只作观察 ---
    const counter = { jevWins: 0, deepseekWins: 0, ties: 0, errors: 0, byPlatform: {} };
    const perItem = new Map();
    for (const unit of units) {
      const key = mappingForDeblind[unit.id];
      const judgment = bySampleId.get(unit.id) ?? { winner: "error", reason: "评审没有返回该条判断" };
      const normalized = ["a", "b", "tie"].includes(judgment.winner) ? judgment.winner : "error";
      let winnerLane = null;
      if (normalized === "a") winnerLane = key.A;
      else if (normalized === "b") winnerLane = key.B;
      else if (normalized === "tie") winnerLane = "tie";

      if (winnerLane === "tie") counter.ties++;
      else if (winnerLane === "jev") counter.jevWins++;
      else if (winnerLane === "deepseek") counter.deepseekWins++;
      else counter.errors++;

      if (winnerLane) {
        const bucket = counter.byPlatform[key.platform] ?? { jevWins: 0, deepseekWins: 0, ties: 0, total: 0 };
        if (winnerLane === "jev") bucket.jevWins++;
        else if (winnerLane === "deepseek") bucket.deepseekWins++;
        else bucket.ties++;
        bucket.total++;
        counter.byPlatform[key.platform] = bucket;
      }
      perItem.set(unit.id, {
        winner: winnerLane ?? "error",
        winnerRaw: normalized === "error" ? "error" : normalized.toUpperCase(),
        reason: judgment.reason || "（无理由）",
      });
    }

    // --- 位置效应：同一份标签放在 A 位还是 B 位，裁判的判决可能不同 ---
    // 为什么必须单独统计：A/B 位置是随机分配的，位置偏好会**直接混进 lane 胜负**，
    // 而它与标签质量毫无关系。这是盲评里最隐蔽的噪声源 —— 只看汇总数永远发现不了，
    // 一旦位置偏好随抽样波动（本次实测三个种子分别是 -34pp / +25pp / +21pp），
    // 种子之间的"稳定性"其实有很大一块是位置噪声而非真实差异。
    const positionStats = { A: { jev: 0, deepseek: 0, tie: 0 }, B: { jev: 0, deepseek: 0, tie: 0 } };
    for (const unit of units) {
      const key = mappingForDeblind[unit.id];
      const judged = perItem.get(unit.id);
      if (!judged || judged.winner === "error") continue;
      // 以「Jev 在哪一侧」为视角：A 位/B 位分别统计 Jev 的战绩
      const jevSide = key.A === "jev" ? "A" : "B";
      positionStats[jevSide][judged.winner] += 1;
    }
    const posShare = (side) => {
      const b = positionStats[side];
      const dec = b.jev + b.deepseek;
      return { ...b, decisiveTotal: dec, jevShareDecisive: pct(b.jev, dec) };
    };
    const atA = posShare("A");
    const atB = posShare("B");
    const positionEffect = {
      jevAtA: atA,
      jevAtB: atB,
      deltaPp: atA.jevShareDecisive != null && atB.jevShareDecisive != null
        ? Number((atA.jevShareDecisive - atB.jevShareDecisive).toFixed(2))
        : null,
      note: "deltaPp = Jev 在 A 位的去平局胜率 − 在 B 位的去平局胜率。A/B 位置随机分配，"
        + "因此理想情况下两个数应当接近（|deltaPp| 小）；数值大说明裁判存在位置偏好，"
        + "它不反映标签质量，却会直接改变胜负。样本量小时该差值本身也有很大的抽样误差。",
    };

    const total = counter.jevWins + counter.deepseekWins + counter.ties;
    const decisiveTotal = counter.jevWins + counter.deepseekWins;
    verdicts[round.name] = {
      round: round.name,
      countsAsWin: round.name === "main", // 附加轮明确不计入胜负
      note: round.note,
      jevWins: counter.jevWins,
      deepseekWins: counter.deepseekWins,
      ties: counter.ties,
      errors: counter.errors,
      total,
      decisiveTotal,
      jevWinRate: pct(counter.jevWins, total),
      deepseekWinRate: pct(counter.deepseekWins, total),
      tieRate: pct(counter.ties, total),
      jevShareDecisive: pct(counter.jevWins, decisiveTotal),
      // 置信区间必须给：点估计背后是几十条样本的抽样噪声，不给区间无法判断差异是不是真的
      wilson: {
        // 主口径：去掉平局后的 Jev 胜率区间（「决出胜负时谁赢」）
        decisive: wilsonInterval(counter.jevWins, decisiveTotal),
        // 副口径：把平局计入分母（「所有样本里 Jev 直接胜出的比例」）
        withTies: wilsonInterval(counter.jevWins, total),
      },
      byPlatform: counter.byPlatform,
      positionEffect,
      error: fatal ?? undefined,
      perItem,
    };
  }

  const main = verdicts.main;
  const aspects = verdicts.aspects;
  const detail = units.map((unit) => {
    const key = mappingForDeblind[unit.id];
    const row = rowsById.get(key.comment_id) ?? {};
    return {
      id: unit.id,
      comment_id: key.comment_id,
      platform: key.platform,
      content: truncate(row.content, 300),
      labels: {
        jev: blindLabel(mappingForDeblind[unit.id].A === "jev" ? unit.A : unit.B, [...MAIN_FIELDS, ...ASPECTS_FIELDS]),
        deepseek: blindLabel(mappingForDeblind[unit.id].A === "deepseek" ? unit.A : unit.B, [...MAIN_FIELDS, ...ASPECTS_FIELDS]),
      },
      blind: { A: key.A, B: key.B },
      main: main.perItem.get(unit.id),
      aspects: aspects.perItem.get(unit.id),
      // 兼容旧字段：winner/reason 指向主轮（决定胜负的那一轮）
      winner: main.perItem.get(unit.id).winner,
      winnerRaw: main.perItem.get(unit.id).winnerRaw,
      reason: main.perItem.get(unit.id).reason,
    };
  });

  // perItem 是聚合用的内部 Map，逐条结果已经进了 detail；从 verdict 里摘掉，
  // 保证 verdict 可以被 JSON.stringify（Map 会被序列化成 {}，留着是坑）
  delete main.perItem;
  delete aspects.perItem;

  const selfCheckSummary = {
    ok: true,
    scoreGrid: selfChecks[0]?.scoreGrid ?? null,
    leakWordsChecked: LEAK_PATTERNS.length,
    structuralSymmetry: true,
    promptsChecked: selfChecks.length,
  };
  // 实际生效的评审模型（claude：信封 modelUsage；codex：banner 的 model: 行；拿不到就是空数组）
  const reviewerModels = [...new Set(rawEntries.flatMap((e) => e.modelEffective ?? []))];

  return {
    seed, passIndex, blindKey, units: units.length, main, aspects, detail, rawEntries,
    selfCheck: selfCheckSummary, claudeMs, judgeMs: claudeMs, reviewerModels,
    // 该 pass 用过的 agent / 版本 / 模型参数：写进 review_raw.jsonl 的 header，便于跨 pass 复核
    agent, model: model ?? null, agentVersion: claudeVersion,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * @param {string} runDir runs/<runId>
 * @param {{sampleSize?:number, agent?:string, onProgress?:Function, write?:boolean, seed?:number,
 *          seeds?:number[], model?:string, replay?:boolean}} [opts]
 *   - seed：单次评审的种子（向后兼容）。
 *   - seeds：[1,2,3] 时按每个种子各跑一遍，报告各次结果与波动范围（评审模型有采样随机性）。
 *   - agent：`claude`（默认，走 `-p --output-format json`）或 `codex`（走 `exec --output-schema -o`）。
 *   - model：claude 传给 `--model`，codex 传给 `-c model=`，并写进 review_raw.jsonl。
 *     codex 下必填 —— 不显式指定就无法回答「裁判到底是谁」，同源守卫也就无从判起。
 *   - replay：true 时不调用任何 CLI，直接用 runDir 下已落盘的 review_raw.jsonl 重新聚合与渲染
 *     （用于在换裁判模型/改报告口径后，零成本、零额度地重出结论）。agent/model 默认取记录里的值。
 * @returns {Promise<{verdict:object, markdown:string, detail:object[], error?:string}>}
 * @throws 同源守卫命中时抛出 code=REVIEWER_SAME_SOURCE；重放校验失败抛出 code=REPLAY_MISMATCH（**都不产出报告**）。
 */
export async function runBlindReview(runDir, { sampleSize = 60, agent, onProgress, write = true, seed, seeds, model, replay = false } = {}) {
  const progress = (phase, extra = {}) => {
    try { onProgress?.({ phase, ...extra }); } catch { /* 进度回调不能拖垮评审 */ }
  };
  const runId = path.basename(runDir);
  const detail = [];
  let blindKey = null;
  const rawLines = [];

  // --- -1. 重放模式：先读落盘记录，后面所有「谁在评」的事实都以记录为准，而不是以调用参数为准 ---
  const replayData = replay ? await loadReplayEntries(runDir) : null;
  const agentName = agent ?? replayData?.header?.agent ?? "claude";
  const modelArg = model ?? replayData?.header?.modelArg ?? null;
  // 重放的 sampleSize 必须以记录为准：它决定抽样与提示词，显式传别的值只会在校验时报错，
  // 不如直接用记录值（传错时的兜底仍是每块的 promptSha256 校验）。
  const effectiveSampleSize = replayData?.header?.sampleSize ?? sampleSize;

  // --- 0. 同源守卫（第一道，跑之前）---
  // 刻意放在 try 之外：守卫失败必须直接抛出、拒绝运行，绝不能被下面的 catch 兜成
  // 一份「评审未完成」的软报告 —— 上一轮就是因为只告警不拦截，才让「裁判=选手」的
  // 结论照样被产出并被引用。重放模式同样要过守卫：历史记录若本来就是同源产物，
  // 重放只会把不成立的结论再印一遍。
  if (!agentKind(agentName)) {
    throw new Error(`不支持的评审 agent「${agentName}」（可选：${REVIEW_AGENTS.join(" / ")}，也可传它们的可执行文件路径）`);
  }
  const laneModels = (await readJson(path.join(runDir, "manifest.json")))?.lanes ?? null;
  const preGuard = assertJudgeNotSameSource({ agent: agentName, model: modelArg, modelEffective: null, laneModels, env: process.env });
  progress("guard", {
    message: `同源守卫通过：裁判「${preGuard.judgeModels.map((j) => j.name).join("、")}」与参赛道（${preGuard.rivals.map((r) => r.name).join("、")}）无同名/同源`,
  });

  try {
    // --- 1. 读原始记录，取两道都成功的交集（多 seed 共用） ---
    const ctx = {
      ...(await loadReviewInputs(runDir)),
      runDir,
      runId,
      sampleSize: effectiveSampleSize,
      laneModels,
      claudeVersion: replayData?.header?.agentVersion ?? replayData?.header?.claudeVersion ?? null,
      replay: replayData,
    };

    // --- 2. 种子列表：seeds 优先；否则沿用旧的单 seed 语义（默认由 runId 决定） ---
    const explicitSeeds = Array.isArray(seeds) && seeds.length > 0 ? seeds.map(toSeed32) : null;
    const defaultSeed = Number.isFinite(seed) ? Number(seed) >>> 0 : hashSeed(`${runId}::${effectiveSampleSize}::${BLIND_VERSION}`);
    // 重放时种子同样以记录为准：种子决定抽样与 A/B 映射，用别的种子只会查不到历史块
    const recordedSeeds = replayData?.header?.seeds;
    const seedList = explicitSeeds
      ?? (Array.isArray(recordedSeeds) && recordedSeeds.length > 0 ? recordedSeeds.map(toSeed32) : [defaultSeed]);

    // --- 3. 记录评审器版本：结论可复核的必要条件之一（claude/codex 都支持 --version）---
    // 重放不探测：版本信息以记录为准，再去跑一次 CLI 既无意义也可能因为二进制已升级而写进假事实。
    const versionProbe = replayData
      ? { version: ctx.claudeVersion, error: null }
      : await runCliVersion(agentName);
    ctx.claudeVersion = versionProbe.version;
    if (!versionProbe.version) {
      progress("version", { message: `无法获取「${agentName} --version」：${versionProbe.error ?? "未知错误"}（已记录为 null）` });
    }

    // --- 4. 逐 seed 跑 pass ---
    const passes = [];
    for (let i = 0; i < seedList.length; i++) {
      const pass = await runPass(ctx, { seed: seedList[i], passIndex: i, passCount: seedList.length, agent: agentName, model: modelArg, write, progress });
      passes.push(pass);
      rawLines.push(...pass.rawEntries);
      if (i === 0) blindKey = pass.blindKey;
    }

    // --- 5. 汇总。主轮决定胜负，附加轮只作观察；多种子给波动范围 ---
    const primary = passes[0];
    detail.push(...primary.detail); // 逐条明细取主 pass（多种子时其余 pass 的逐条结果在 review_raw.jsonl 里可查）
    const seedRuns = passes.map((p) => ({
      seed: p.seed,
      pass: p.passIndex,
      main: p.main,
      aspects: p.aspects,
      claudeMs: p.claudeMs,
      error: p.main.error ?? undefined,
    }));

    // 跨 seed 合并：只作描述性参考。不同 seed 会抽到不同（部分重叠）的样本，
    // 因此合并计数不是独立样本，不能当成一个更大的 n 来用 —— 报告里会写明。
    const pooledMain = { jevWins: 0, deepseekWins: 0, ties: 0, errors: 0 };
    const pooledAspects = { jevWins: 0, deepseekWins: 0, ties: 0, errors: 0 };
    for (const p of passes) {
      for (const [k, v] of Object.entries(p.main)) if (k in pooledMain) pooledMain[k] += v;
      for (const [k, v] of Object.entries(p.aspects)) if (k in pooledAspects) pooledAspects[k] += v;
    }
    const pooledDecisive = pooledMain.jevWins + pooledMain.deepseekWins;
    const pooledTotal = pooledDecisive + pooledMain.ties;

    const stabilityValues = seedRuns
      .map((r) => ({ seed: r.seed, value: r.main.jevShareDecisive }))
      .filter((v) => v.value != null);
    const stability = {
      metric: "主轮去平局后 Jev 胜率（%）",
      seeds: seedRuns.map((r) => r.seed),
      values: stabilityValues,
      min: stabilityValues.length ? Math.min(...stabilityValues.map((v) => v.value)) : null,
      max: stabilityValues.length ? Math.max(...stabilityValues.map((v) => v.value)) : null,
      mean: stabilityValues.length ? Number((stabilityValues.reduce((a, b) => a + b.value, 0) / stabilityValues.length).toFixed(2)) : null,
      spread: stabilityValues.length ? Number((Math.max(...stabilityValues.map((v) => v.value)) - Math.min(...stabilityValues.map((v) => v.value))).toFixed(2)) : null,
      note: "多次重复只覆盖评审模型的采样随机性 + 抽样差异；波动范围比单次点估计更值得引用。",
    };

    const main = primary.main;
    const aspects = primary.aspects;
    const reviewerConflict = detectReviewerConflict(passes.flatMap((p) => p.reviewerModels));
    const errorList = [];
    if (main.error) errorList.push(main.error);
    if (aspects.error && aspects.error !== main.error) errorList.push(aspects.error);
    const fatal = errorList[0] ?? null;

    const verdict = {
      version: BLIND_VERSION,
      // --- 两轮分开报（缺陷 3.2）---
      main: {
        ...main,
        // 兼容旧字段（旧消费方读 verdict.jevWins 等）
        seed: primary.seed,
        wilsonNote: "95% Wilson 区间；decisive = 去平局后的 Jev 胜率，withTies = 平局计入分母。",
      },
      aspects: {
        ...aspects,
        seed: primary.seed,
        note: "附加轮只作观察，不计入胜负；两边 aspects 列举机制不同（固定维度集合逐个判定 vs 自由列举），数量多寡不是优劣。",
      },
      seeds: seedList,
      passCount: passes.length,
      seedRuns,
      stability,
      pooled: {
        main: {
          ...pooledMain,
          total: pooledTotal,
          decisiveTotal: pooledDecisive,
          jevShareDecisive: pct(pooledMain.jevWins, pooledDecisive),
          wilson: { decisive: wilsonInterval(pooledMain.jevWins, pooledDecisive), withTies: wilsonInterval(pooledMain.jevWins, pooledTotal) },
        },
        aspects: { ...pooledAspects, total: pooledAspects.jevWins + pooledAspects.deepseekWins + pooledAspects.ties },
        note: "跨 seed 合并计数包含重复样本，不是独立样本；只用于看方向一致性，不作为独立证据。",
      },
      // --- 旧字段镜像主轮，保证既有调用方不坏 ---
      jevWins: main.jevWins,
      deepseekWins: main.deepseekWins,
      ties: main.ties,
      total: main.total,
      sampleSize: primary.units,
      requestedSampleSize: effectiveSampleSize,
      errors: main.errors,
      jevWinRate: main.jevWinRate,
      deepseekWinRate: main.deepseekWinRate,
      tieRate: main.tieRate,
      decisiveTotal: main.decisiveTotal,
      jevShareDecisive: main.jevShareDecisive,
      byPlatform: main.byPlatform,
      judged: main.total,
      claudeMs: passes.reduce((a, p) => a + p.claudeMs, 0),
      judgeMs: passes.reduce((a, p) => a + p.claudeMs, 0),
      // --- 可复核性（缺陷 1）---
      agent: agentName,
      agentVersion: versionProbe.version,
      claudeVersion: versionProbe.version,
      claudeVersionError: versionProbe.error,
      model: modelArg,
      modelArg,
      reviewerModels: reviewerConflict.reviewerModels,
      reviewerConflict,
      // 同源守卫的完整取证记录：三路候选模型、对照的两道模型、检查过的环境变量。
      // 守卫已通过才会走到这里；记录它是为了让「为什么这次不算同源」可被独立核对。
      sameSourceGuard: {
        passed: true,
        judgeModels: preGuard.judgeModels,
        rivals: preGuard.rivals,
        conflicts: preGuard.conflicts,
        env: preGuard.env,
        inapplicableEnv: preGuard.inapplicableEnv,
        note: "守卫在跑之前 + 第一块响应返回后各校验一次；命中即抛错拒绝运行，不产出报告。",
      },
      reviewRaw: write ? path.join(runDir, "review_raw.jsonl") : null,
      selfCheck: primary.selfCheck,
      error: fatal ?? undefined,
    };
    if (!verdict.error && main.errors === primary.units && primary.units > 0) {
      verdict.error = `全部 ${main.errors} 条主轮评审都失败了，请检查「${agentName}」是否可用（例如：${agentName} --version）`;
    }

    // --- 6. 原始记录落盘（缺陷 1）：一行一块，事后可重放 ---
    if (write) {
      const header = {
        type: "header",
        version: BLIND_VERSION,
        runId,
        generatedAt: new Date().toISOString(),
        agent: agentName,
        agentVersion: versionProbe.version,
        model: modelArg,
        modelArg,
        replay,
        modelEffective: reviewerConflict.reviewerModels,
        reviewerConflict: reviewerConflict.warning,
        claudeVersion: versionProbe.version,
        claudeVersionError: versionProbe.error,
        sameSourceGuard: {
          passed: true,
          judgeModels: preGuard.judgeModels,
          rivals: preGuard.rivals,
          env: preGuard.env,
          inapplicableEnv: preGuard.inapplicableEnv,
          rule: "裁判的显式模型参数 / CLI 真正读取的路由环境变量 / 运行时实际模型名，任一与 manifest 两道模型同名或同源即抛错拒绝运行",
        },
        seeds: seedList,
        passCount: passes.length,
        sampleSize: effectiveSampleSize,
        rounds: ["main（决定胜负）", "aspects（附加观察，不计入胜负）"],
        selfCheck: { ok: true, rule: "泄漏词扫描 + 数值格式（sentiment_score 统一 0.1 网格）+ A/B 字段顺序对称" },
        note: "每块一行：脱敏提示词（标签层已剔除 meta/confidence/模型名/costSource/evidenceSource，数值已量化）、"
          + "原始响应（哈希 + 正文）、解析出的逐条判定、agent 名、CLI 版本、模型参数、起止时间、耗时、退出码。"
          + "正文中的品牌名属于原始数据，不构成泄漏。",
      };
      const jsonl = [header, ...rawLines].map((line) => JSON.stringify(line)).join("\n") + "\n";
      await writeAtomic(path.join(runDir, "review_raw.jsonl"), jsonl);
      progress("raw", { message: `review_raw.jsonl 已落盘（${rawLines.length} 块）` });
    }

    // 多种子时 blind_key.json 汇总各 pass 的映射文件；单种子时就是那份映射（旧行为）
    if (write && passes.length > 1) {
      await writeAtomic(path.join(runDir, "blind_key.json"), JSON.stringify({
        version: BLIND_VERSION,
        runId,
        generatedAt: new Date().toISOString(),
        multiSeed: true,
        passes: passes.map((p) => ({
          seed: p.seed,
          file: `blind_key.seed${p.seed}.json`,
          sampleSize: p.units,
          mappingCount: Object.keys(p.blindKey.mapping).length,
        })),
        note: "每个 pass 的 A/B 映射分别写在自己的 blind_key.seed<seed>.json；本文件只做索引。",
      }, null, 2));
    }

    const markdown = renderReviewMarkdown({ runId, verdict, detail, blindKey: primary.blindKey, datasetNote: ctx.datasetNote, agent: agentName, model: modelArg });
    if (write) {
      await writeAtomic(path.join(runDir, "review.md"), markdown);
      progress("written", { message: "review.md 已落盘" });
    }
    return { verdict, markdown, detail, ...(verdict.error ? { error: verdict.error } : {}) };
  } catch (err) {
    // 同源守卫命中：直接抛出，**不产出任何报告**。
    // 这是与「评审调用失败」本质不同的失败：调用失败只是没数据，同源却是数据在骗人。
    // 上一轮的教训是「有结论」比「没结论」危险得多，所以这里必须硬失败。
    if (err?.code === "REVIEWER_SAME_SOURCE") throw err;
    // 重放校验失败同理：记录与代码对不上时，「重放出来的报告」本身就是一个错误答案
    if (err?.code === "REPLAY_MISMATCH") throw err;
    // 读文件/抽样/自检等前置步骤失败：不抛异常，产出一份「评审未完成」的报告。
    // 注意：自检失败也会走到这里，但 markdown 会明确指出自检失败 —— 不会静默给结论。
    const message = String(err?.message ?? err);
    const emptyRound = (name, note) => ({
      round: name, countsAsWin: name === "main", note,
      jevWins: 0, deepseekWins: 0, ties: 0, errors: 0, total: 0, decisiveTotal: 0,
      jevWinRate: null, deepseekWinRate: null, tieRate: null, jevShareDecisive: null,
      wilson: { decisive: null, withTies: null }, byPlatform: {},
    });
    const verdict = {
      version: BLIND_VERSION,
      main: emptyRound("main", "决定胜负：只比机制同源的字段"),
      aspects: emptyRound("aspects", "附加观察：不计入胜负"),
      seeds: [], passCount: 0, seedRuns: [],
      stability: { metric: "主轮去平局后 Jev 胜率（%）", seeds: [], values: [], min: null, max: null, mean: null, spread: null },
      pooled: { main: { jevWins: 0, deepseekWins: 0, ties: 0, errors: 0, total: 0, decisiveTotal: 0, jevShareDecisive: null, wilson: { decisive: null, withTies: null } }, aspects: { jevWins: 0, deepseekWins: 0, ties: 0, errors: 0, total: 0 } },
      jevWins: 0, deepseekWins: 0, ties: 0, total: 0, sampleSize: 0, requestedSampleSize: sampleSize,
      errors: 0, jevWinRate: null, deepseekWinRate: null, tieRate: null,
      decisiveTotal: 0, jevShareDecisive: null, byPlatform: {},
      agent: agentName, agentVersion: null, replay,
      claudeVersion: null, model: modelArg, reviewerModels: [], reviewerConflict: { reviewerModels: [], conflicts: [], warning: null },
      sameSourceGuard: null,
      reviewRaw: null, selfCheck: null,
      error: message,
    };
    const markdown = renderReviewMarkdown({ runId, verdict, detail, blindKey, datasetNote: null, agent: agentName, model: modelArg, fatalError: message });
    if (write) await writeAtomic(path.join(runDir, "review.md"), markdown).catch(() => {});
    return { verdict, markdown, detail, error: message };
  }
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const fmtCi = (ci) => (ci ? `${round4(ci.lower * 100)}% ~ ${round4(ci.upper * 100)}%` : "—");

function renderReviewMarkdown({ runId, verdict, detail, blindKey, datasetNote, agent, model, fatalError }) {
  const L = [];
  const main = verdict.main ?? {};
  const aspects = verdict.aspects ?? {};
  L.push(`# 独立 AI 盲评报告（${verdict.version ?? BLIND_VERSION}）`);
  L.push("");
  L.push(`- 运行：\`${runId}\``);
  const judgeInvocation = agentKind(agent) === "codex"
    ? "`codex exec --skip-git-repo-check -c model=... --output-schema <schema> -o <last-message> -`（提示词走 stdin，结果从 `-o` 文件读）"
    : "`claude -p --output-format json --json-schema ...`";
  L.push(`- 评审方式：本地 \`${agent}\` CLI 非交互调用（${judgeInvocation}），评审模型不知道 A/B 分别来自哪一方`);
  L.push(`- 评审器版本：\`${verdict.agentVersion ?? verdict.claudeVersion ?? "未能获取"}\`${verdict.claudeVersionError ? `（探测失败：${mdCell(verdict.claudeVersionError)}）` : ""}；模型参数：\`${verdict.modelArg ?? verdict.model ?? "未指定（用 CLI 本地配置的默认模型）"}\``);
  L.push(`- 实际生效的评审模型（codex 从 banner 的 \`model:\` 行读，claude 从响应信封读）：${(verdict.reviewerModels ?? []).map((m) => `\`${m}\``).join("、") || "**未能确认**"}`);
  L.push(`- 抽样：${main.total ?? 0} 条有效判断（分层抽样，种子 ${verdict.seeds?.join("、") ?? blindKey?.seed ?? "未生成"}，可复现）`);
  L.push(`- 轮次设计：**主轮**只比机制同源的字段并决定胜负；**附加轮**单独评 aspects/emotion，只作观察，不计入胜负`);
  L.push(`- A/B 映射：只写入 \`blind_key.json\`（多种子时为 \`blind_key.seed<seed>.json\`），**未进入评审提示词**；本报告是反盲化之后的视角`);
  L.push(`- 原始判定：\`review_raw.jsonl\`（每块一行：脱敏提示词、原始响应、解析结果、CLI 版本、耗时）；提示词自检：${verdict.selfCheck?.ok ? `✅ 通过（${verdict.selfCheck.promptsChecked} 个提示词，扫描 ${verdict.selfCheck.leakWordsChecked} 类泄漏词，${verdict.selfCheck.scoreGrid} 网格，A/B 字段对称）` : "未执行/未通过"}`);
  L.push("");
  // 同源守卫的结果必须在最显眼处声明：读报告的人第一眼要知道「裁判是谁、它跟选手有没有关系」
  if (verdict.sameSourceGuard?.passed) {
    const g = verdict.sameSourceGuard;
    L.push(`- **同源守卫（跑之前已通过）**：裁判候选模型 ${g.judgeModels.map((j) => `\`${j.name}\`（${j.source}）`).join("、")}；`
      + `对照的参赛道模型 ${g.rivals.map((r) => `\`${r.name}\``).join("、") || "未从 manifest 读到"}${g.conflicts.length ? `，命中 ${g.conflicts.length} 条冲突` : "，无同名/同源命中"}。`);
    L.push(`  命中即抛错拒绝运行、不产出报告 —— 上一轮「裁判就是 DeepSeek 本尊却照样出结论」的失效模式已被硬性阻断。`);
  }
  if (verdict.reviewerConflict?.warning) {
    L.push(`> 🚨 **评审者与参赛者同源**：${mdCell(verdict.reviewerConflict.warning)}`);
    L.push(`> 这条警告由 \`review_raw.jsonl\` 里记录的**实际生效模型名**触发，与模型参数是否显式指定无关；`);
    L.push(`> 在换评审模型复跑之前，下面的胜负只能当作「该模型的偏好」而不是独立结论。`);
    L.push("");
  }
  if (fatalError || verdict.error) {
    L.push(`> ⚠️ **评审未完整完成**：${mdCell(fatalError ?? verdict.error)}`);
    L.push("");
  }
  if (datasetNote) {
    L.push(`> ⚠️ ${mdCell(datasetNote)}`);
    L.push("");
  }

  // --- 主轮结论 ---
  L.push(`## 结论（主轮：决定胜负）`);
  L.push("");
  L.push(`主轮只比较两套机制真正同源的字段：\`is_relevant\`、\`sentiment\`（含统一量化后的 \`sentiment_score\`）、`);
  L.push(`\`intent\`、以及\`引文是否支撑结论\`。这些字段两边都是「在同一个受控词表里选一个」，可以直接比。`);
  L.push(`aspects/emotion 因为产出机制不同源，已移到附加轮，**不计入下面的胜负**。`);
  L.push("");
  if (!main.total) {
    L.push(`没有拿到任何有效的主轮判断（失败 ${main.errors ?? 0} 条），无法给出结论。`);
  } else {
    // 结论必须过统计显著性这一关：区间跨过 50% 时点估计（谁多赢 3 条）方向不可信。
    // 为什么不能只按 jevWins vs deepseekWins 报「谁更好」：45 条决出胜负的样本里
    // 相差 3 条完全在抽样噪声内，把这种差距写成结论就是把噪声当证据 —— 与文件开头
    // 声明的宗旨直接冲突，也正是「不能上视频」的那类表述。
    const ci = main.wilson?.decisive;
    const inconclusive = Boolean(ci) && ci.lower <= 0.5 && ci.upper >= 0.5;
    const leader = inconclusive
      ? "**统计上无法区分**（Wilson 95% 区间跨过 50%）"
      : (main.jevWins === main.deepseekWins
        ? "双方打平"
        : (main.jevWins > main.deepseekWins ? "**Jev 更好**" : "**DeepSeek Flash 更好**"));
    L.push(`评审 ${main.total} 条有效样本后：${leader}。`);
    if (inconclusive) {
      L.push("");
      L.push(`> 点估计上 ${main.jevWins > main.deepseekWins ? "Jev" : (main.deepseekWins > main.jevWins ? "DeepSeek Flash" : "双方")} 多赢 ${Math.abs(main.jevWins - main.deepseekWins)} 条，`);
      L.push(`> 但这个差距落在抽样噪声范围内（区间 ${fmtCi(ci)} 覆盖 50%），**不能据此宣布某一方更好**。`);
      L.push(`> 要得到可用结论，需要扩大样本量或改用在更细粒度上可验证的指标。`);
    }
    L.push("");
    L.push(`| | 条数 | 占有效样本（分母 ${main.total}） |`);
    L.push(`|---|---:|---:|`);
    L.push(`| Jev 胜 | ${main.jevWins} | ${main.jevWinRate}% |`);
    L.push(`| DeepSeek Flash 胜 | ${main.deepseekWins} | ${main.deepseekWinRate}% |`);
    L.push(`| 平局 | ${main.ties} | ${main.tieRate}% |`);
    if (main.errors > 0) L.push(`| 评审失败（不计入分母） | ${main.errors} | — |`);
    L.push("");
    L.push(`去掉平局后：Jev 在 ${main.decisiveTotal} 条决出胜负的样本里赢下 **${main.jevShareDecisive ?? "—"}%**；`);
    L.push(`**Wilson 95% 置信区间：${fmtCi(main.wilson?.decisive)}**（把平局计入分母时：Jev 胜率 ${main.jevWinRate ?? "—"}%，区间 ${fmtCi(main.wilson?.withTies)}）。`);
    L.push("");
    L.push(`> 为什么必须看区间：${main.decisiveTotal} 条决出胜负的样本不足以支撑点估计当定论，`);
    L.push(`> 区间跨过 50% 就意味着「谁更好」在统计上还说不清；两次 run 的差异若落在区间内，也不构成新证据。`);
  }
  L.push("");

  // --- 附加轮观察 ---
  L.push(`## 附加轮（观察项，不计入胜负）`);
  L.push("");
  if (!aspects.total) {
    L.push(`附加轮没有拿到有效判断。`);
  } else {
    L.push(`| | 条数 | 占附加轮样本（分母 ${aspects.total}） |`);
    L.push(`|---|---:|---:|`);
    L.push(`| Jev 胜 | ${aspects.jevWins} | ${aspects.jevWinRate}% |`);
    L.push(`| DeepSeek Flash 胜 | ${aspects.deepseekWins} | ${aspects.deepseekWinRate}% |`);
    L.push(`| 平局 | ${aspects.ties} | ${aspects.tieRate}% |`);
    if (aspects.errors > 0) L.push(`| 评审失败（不计入分母） | ${aspects.errors} | — |`);
    L.push("");
    L.push(`去平局后 Jev 占比 ${aspects.jevShareDecisive ?? "—"}%（区间 ${fmtCi(aspects.wilson?.decisive)}，仅供参考）。`);
    L.push("");
    L.push(`> ⚠️ **这一轮不能与主轮同等解读**：两边的 aspects 产出机制不同 —— `);
    L.push(`> 一方在固定的维度集合上逐个判定「是否提到」，另一方自由列举 1~2 个。数量多寡反映的是仪器差异，不是准确度；`);
    L.push(`> 提示词已明确要求「不要因为列得多/少而加减分」，但该指令能否被完全执行无法验证，所以本轮只作观察。`);
  }
  L.push("");

  // --- 多种子 ---
  if ((verdict.seedRuns ?? []).length > 1) {
    L.push(`## 多种子重复（评审模型有采样随机性）`);
    L.push("");
    L.push(`| seed | 主轮 Jev 胜 | DeepSeek 胜 | 平 | 失败 | 去平局后 Jev 胜率 | Wilson 95% CI | 附加轮 Jev 胜率 |`);
    L.push(`|---|---:|---:|---:|---:|---:|---|---:|`);
    for (const r of verdict.seedRuns) {
      L.push(`| ${r.seed} | ${r.main.jevWins} | ${r.main.deepseekWins} | ${r.main.ties} | ${r.main.errors} | ${r.main.jevShareDecisive ?? "—"}% | ${fmtCi(r.main.wilson?.decisive)} | ${r.aspects.jevShareDecisive ?? "—"}% |`);
    }
    L.push("");
    const st = verdict.stability ?? {};
    L.push(`**波动范围**：主轮去平局后 Jev 胜率在 ${st.min ?? "—"}% ~ ${st.max ?? "—"}% 之间（均值 ${st.mean ?? "—"}%，极差 ${st.spread ?? "—"} 个百分点，${st.values?.length ?? 0} 次重复）。`);
    // 只看均值会把「有时 Jev 领先、有时 DeepSeek 领先」压成一个数；方向本身不稳定时必须点破
    const dirs = (st.values ?? []).map((v) => v.value);
    if (dirs.length > 1 && dirs.some((v) => v > 50) && dirs.some((v) => v < 50)) {
      L.push("");
      L.push(`> ⚠️ **不同种子的胜负方向不一致**（${dirs.map((v) => `${v}%`).join(" / ")}，50% 为分界）：`);
      L.push(`> 这意味着「谁更好」的结论对抽样与评审采样高度敏感，单次结果（无论哪个种子）都不足以支撑公开发表。`);
    }
    L.push("");
    L.push(`> 单次结果不足以定论：同一套数据换一个种子（重抽样本 + 重新随机 A/B + 评审模型重新采样）就会出现这样的波动。`);
    L.push(`> 引用时应给区间或波动范围，不要只报一个点估计。跨 seed 合并计数（主轮 Jev ${verdict.pooled?.main?.jevWins ?? 0} / DeepSeek ${verdict.pooled?.main?.deepseekWins ?? 0}）包含重复样本，不是独立样本，只用于看方向一致性。`);
    L.push("");

    // --- 位置效应：A/B 是随机位置，位置偏好会直接污染 lane 胜负 ---
    const pe = main.positionEffect;
    if (pe) {
      L.push(`### 位置效应（A/B 随机位置是否影响判决）`);
      L.push("");
      L.push(`| Jev 所在位置 | Jev 胜 | DeepSeek 胜 | 平 | 去平局后 Jev 胜率 |`);
      L.push(`|---|---:|---:|---:|---:|`);
      L.push(`| A 位 | ${pe.jevAtA.jev} | ${pe.jevAtA.deepseek} | ${pe.jevAtA.tie} | ${pe.jevAtA.jevShareDecisive ?? "—"}% |`);
      L.push(`| B 位 | ${pe.jevAtB.jev} | ${pe.jevAtB.deepseek} | ${pe.jevAtB.tie} | ${pe.jevAtB.jevShareDecisive ?? "—"}% |`);
      L.push("");
      L.push(`**位置差：${pe.deltaPp ?? "—"} 个百分点**（A 位胜率 − B 位胜率）。A/B 归属是随机分配的，`);
      L.push(`理想的裁判应当两行接近；差值大 = 裁判对「标签放在前面还是后面」有偏好，而这个偏好与标签质量无关。`);
      if (pe.deltaPp != null && Math.abs(pe.deltaPp) >= 15) {
        L.push("");
        L.push(`> 🚨 **本次位置差达到 ${Math.abs(pe.deltaPp)} 个百分点，属于严重水平**：`);
        L.push(`> 它意味着汇总出来的「谁更好」里有相当一部分只是「谁被放在了裁判偏好的那一侧」，`);
        L.push(`> 在样本量只有几十条时，位置偏好的随机波动足以单独翻转结论 —— 这是本报告最需要警惕的数字。`);
      }
      L.push("");
    }
  }

  // --- 分平台 ---
  if (Object.keys(main.byPlatform ?? {}).length > 0) {
    L.push(`### 分平台（主轮）`);
    L.push("");
    L.push(`| 平台 | Jev 胜 | DeepSeek 胜 | 平 | 合计 |`);
    L.push(`|---|---:|---:|---:|---:|`);
    for (const [platform, b] of Object.entries(main.byPlatform).sort((a, b) => b[1].total - a[1].total)) {
      L.push(`| ${mdCell(platform)} | ${b.jevWins} | ${b.deepseekWins} | ${b.ties} | ${b.total} |`);
    }
    L.push("");
  }

  // --- 逐条明细 ---
  L.push(`## 逐条明细（反盲化后）`);
  L.push("");
  L.push(`| # | 平台 | 评论摘要 | Jev 标签 | DeepSeek 标签 | 主轮胜者 | 附加轮（aspects/emotion） | 评审理由（主轮） |`);
  L.push(`|---|---|---|---|---|---|---|---|`);
  const tagText = (l) => `${l.sentiment}/${l.intent}(${l.sentiment_score ?? "—"}); aspects: ${(l.aspects ?? []).join("、") || "—"}; emotion: ${(l.emotion ?? []).join("、") || "—"}`;
  for (const d of detail) {
    const w = (x) => (x?.winner === "tie" ? "平局" : (x?.winner === "jev" ? "**Jev**" : x?.winner === "deepseek" ? "**DeepSeek**" : "失败"));
    L.push(`| ${d.id} | ${mdCell(d.platform)} | ${mdCell(truncate(d.content, 60))} | ${mdCell(tagText(d.labels.jev))} | ${mdCell(tagText(d.labels.deepseek))} | ${w(d.main)} | ${w(d.aspects)} | ${mdCell(truncate(d.reason, 120))} |`);
  }
  L.push("");

  // --- 可复核性 ---
  L.push(`## 可复核性（审计要求）`);
  L.push("");
  L.push(`- **原始判定已落盘**：\`review_raw.jsonl\`，每块一行，含该块完整提示词（标签层已脱敏）、原始响应正文与哈希、解析出的逐条判定、`);
  L.push(`  \`agent\` 名、\`${agent} --version\`（${verdict.agentVersion ?? verdict.claudeVersion ?? "未能获取"}）、模型参数（${verdict.modelArg ?? verdict.model ?? "未指定"}）、**实际生效模型名**（${(verdict.reviewerModels ?? []).join("、") || "未能确认"}）、`);
  L.push(`  调用起止时间与耗时、退出码、是否超时、CLI 参数形态（提示词除外）、stdout/stderr 哈希。`);
  L.push(`  任何人对同一 run 重跑都能对照「当时到底发了什么、模型回了什么、怎么解析的」。`);
  L.push(`- **提示词自检**：构造后、调用前扫描泄漏词（${verdict.selfCheck?.leakWordsChecked ?? LEAK_PATTERNS.length} 类：jev/deepseek/model/confidence/evidenceSource/cost 等），`);
  L.push(`  校验 \`sentiment_score\` 全部落在统一的 0.1 网格（固定一位小数字符串），并校验 A/B 字段集合与顺序完全对称；自检失败直接抛错中止，不会静默发出可疑提示词。`);
  L.push(`- **数值量化**：两边分数统一四舍五入到 0.1 再送审，抹掉「小数位数」这一指纹（原始网格不同：一边是档位插值、一边是自由给分）。`);
  L.push(`- **未剔除的指纹**（诚实披露）：引文的有无仍可能与来源相关；正文里出现的品牌名属于原始数据。这些会在下面的局限里说明。`);
  if (blindKey) {
    const multi = (verdict.seedRuns ?? []).length > 1;
    L.push(`- 抽样与 A/B 随机化使用 \`${blindKey.algorithm}\`，种子 \`${verdict.seeds?.join("、") ?? blindKey.seed}\`，版本 \`${blindKey.version}\`。`);
    L.push(`- 抽样池：两道都成功的 ${blindKey.pairedPool} 条；映射表在 ${multi ? `\`blind_key.seed<seed>.json\`（每个种子一份，\`blind_key.json\` 是索引）` : "`blind_key.json`"}（本 pass ${Object.keys(blindKey.mapping).length} 条，主体报告只展示第一个 pass 的逐条明细）。`);
  }
  L.push("");

  // --- 局限 ---
  L.push(`## 局限性声明（必须和结论一起引用）`);
  L.push("");
  L.push(`1. **样本量与抽样误差**：主轮只评了 ${main.total ?? 0} 条（配对池 ${blindKey?.pairedPool ?? "未知"} 条）。分层抽样保证平台覆盖，但区间仍然很宽（见上），不能外推成「全量 1 万条上谁更准」。`);
  L.push(`2. **单一评审模型，但已确认它与两道无关**：只有 \`${agent}\` 一个评审者（CLI 版本 ${verdict.agentVersion ?? verdict.claudeVersion ?? "未知"}，实际生效模型 ${(verdict.reviewerModels ?? []).map((m) => `\`${m}\``).join("、") || "未能确认"}），它自身有偏好与盲区；没有多评审交叉验证，也没有人类标注做金标准。`
    + (verdict.reviewerConflict?.warning
      ? "**当前评审模型与参赛道同源（见顶部警告），这是比样本量更严重的威胁。**"
      : "同源守卫已确认裁判与两条道不同源（这是必要条件，不是充分条件：不同源不等于没有偏好）。"));
  L.push(`3. **仍有残留指纹**：数值已量化、身份字段已剔除、点名句已删除，但引文有无（一边恒有、一边偶缺）等分布差异无法在不伪造数据的前提下抹平；评审若据此猜出来源，仍可能有风格偏好。`);
  L.push(`4. **引文口径差异已要求忽略**：两边引文的产生方式不同；提示词只要求判断「是否逐字来自原文、是否支撑结论，不判断由谁产生」，但该指令能否被完全执行无法验证。`);
  L.push(`5. **aspects 附加轮不可当准确度**：两边列举机制不同源（固定集合逐个判定 vs 自由列举），数量多寡是仪器差异；本轮只作观察，不计入胜负。`);
  L.push(`6. **「更好」是评审模型的主观判断**：判据已写明，但同一份数据换一个评审模型可能给出不同胜负。`);
  L.push(`7. **评审模型有采样随机性**：${(verdict.seedRuns ?? []).length > 1 ? `本次跑了 ${verdict.seedRuns.length} 个种子，波动见上表；` : "本次只跑了一个种子，单次结果不足以定论（可用 seeds:[1,2,3] 复跑）；"}应看区间与波动范围，不要把个位数差距当成定论。`);
  L.push(`8. **A/B 位置偏好未被消除，只能被测量**：位置由随机数决定，但裁判对「A 在前」或「B 在前」可能有偏好，`
    + `它会直接改变胜负。本报告在「位置效应」一节给出量化值${main.positionEffect?.deltaPp != null ? `（本次 ${main.positionEffect.deltaPp} 个百分点）` : ""}；`
    + `该数字本身就是小样本估计，不能当作精确校正，但它的大小决定了胜负结论能不能被引用。`);
  L.push(`9. **只比较配对集**：两道未同时成功的评论不在盲评范围内，失败率差异本身不构成质量证据。`);
  L.push("");
  return L.join("\n");
}

export default { runBlindReview };
