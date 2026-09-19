/**
 * 计费口径。
 *
 * 两条道的账单来源不同，这一点在报告里必须说清楚：
 *  - Jev：OpenRouter 在响应的 `usage.cost` 里直接给真实费用（美元），照抄即可。
 *  - DeepSeek：接口不回费用，必须本地按官方单价算。单价来自
 *    https://api-docs.deepseek.com/quick_start/pricing（2026-09-19 取）。
 */

/** 美元 / 百万 token。 */
export const DEEPSEEK_FLASH = {
  peak: { inputMiss: 0.3, inputHit: 0.006, output: 1.2 },
  offPeak: { inputMiss: 0.15, inputHit: 0.003, output: 0.6 },
};

/**
 * DeepSeek 的高峰时段：周一至周五 01:00–04:00 与 06:00–10:00 UTC。
 * 其余时间（含整个周末）按 off-peak 计价，即高峰价的一半。
 */
export function isPeak(date = new Date()) {
  const day = date.getUTCDay(); // 0=周日 6=周六
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/**
 * 按 usage 计算 DeepSeek 费用（美元）。
 * 缓存命中与未命中分开计价 —— Flash 的缓存价差 50 倍，混在一起算会严重高估。
 */
export function deepseekCost(usage, date = new Date()) {
  const rate = isPeak(date) ? DEEPSEEK_FLASH.peak : DEEPSEEK_FLASH.offPeak;
  const miss = Number(usage?.prompt_cache_miss_tokens ?? usage?.prompt_tokens ?? 0);
  const hit = Number(usage?.prompt_cache_hit_tokens ?? 0);
  const out = Number(usage?.completion_tokens ?? 0);
  return (miss * rate.inputMiss + hit * rate.inputHit + out * rate.output) / 1e6;
}

/** 该次调用适用的单价档（报告里要写清楚）。 */
export function deepseekRateLabel(date = new Date()) {
  return isPeak(date)
    ? "peak（周一至周五 01:00–04:00 / 06:00–10:00 UTC）"
    : "off-peak（高峰价的一半）";
}

/** 美元 → 人民币，只用于展示。汇率写死并在报告里标注。 */
export const USD_TO_CNY = 7.1;

export function fmtUsd(v) {
  const n = Number(v) || 0;
  if (n === 0) return "$0";
  if (n < 0.0001) return `$${n.toExponential(3)}`;
  if (n < 1) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(4)}`;
}

export function fmtCny(v) {
  const n = (Number(v) || 0) * USD_TO_CNY;
  if (n === 0) return "¥0";
  if (n < 0.01) return `¥${n.toFixed(6)}`;
  if (n < 1) return `¥${n.toFixed(4)}`;
  return `¥${n.toFixed(2)}`;
}
