#!/usr/bin/env node
/**
 * 两条道各跑一小批评论，打印标签 / token / 耗时 / 费用，并做合法性校验。
 * 用途：改完后端后快速确认「API 还能通、标签还合法、费用口径没变」，不做全量。
 *
 * 用法：
 *   node scripts/probe.mjs [--n=3] [--offset=0] [--lane=jev|deepseek]
 * 退出码：两条道都通过为 0，任一失败为 1。
 */

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDataset } from "../src/dataset.mjs";
import { SENTIMENTS, INTENTS, ASPECTS, EMOTIONS } from "../src/vocab.mjs";
import * as jev from "../src/backends/jev.mjs";
import * as deepseek from "../src/backends/deepseek.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf("=");
  return eq >= 0 ? hit.slice(eq + 1) : true;
}

const N = Number(arg("n", 3));
const OFFSET = Number(arg("offset", 0));
const ONLY = arg("lane", null);

const { rows, stats } = loadDataset(path.join(ROOT, "data", "comments.csv"));
const sample = rows.slice(OFFSET, OFFSET + N);
if (sample.length === 0) {
  console.error(`offset=${OFFSET} 之后没有数据（总数 ${stats.total}）`);
  process.exit(1);
}

console.log(`数据集：${stats.total} 条 | 本次取样 offset=${OFFSET} n=${sample.length} | 平台 ${stats.platformList.map((p) => `${p.platform}=${p.count}`).join(" ")}`);
for (const row of sample) {
  const content = String(row.content ?? "").replace(/\s+/g, " ").slice(0, 70);
  console.log(`  - [${row.platform}] ${row.comment_id} ${content}${content.length >= 70 ? "…" : ""}`);
}
console.log("");

const lanes = [
  { def: jev, name: "Jev", expectedSource: "host", estimator: true },
  { def: deepseek, name: "DeepSeek Flash", expectedSource: "model", estimator: false },
].filter((lane) => !ONLY || lane.def.id === ONLY);

let allOk = true;
const totals = [];

for (const lane of lanes) {
  const { def, name } = lane;
  console.log(`\n════ ${name}（${def.modelId}） 批大小上限 ${def.maxBatchSize} ════`);
  const t0 = Date.now();
  let result;
  try {
    result = await def.labelBatch(sample, {});
  } catch (err) {
    allOk = false;
    console.log(`❌ 调用失败：${err.code ?? ""} ${err.message}`);
    continue;
  }
  const wall = Date.now() - t0;
  const { labels, usage, ms } = result;

  console.log(`耗时 ${ms}ms（含网络，脚本口径 ${wall}ms） | input ${usage.inputTokens} tok | output ${usage.outputTokens} tok | 费用 $${usage.costUsd.toFixed(8)}`);
  if (usage.reasoningTokens) console.log(`其中 reasoning ${usage.reasoningTokens} tok，缓存命中 ${usage.cacheHitTokens ?? 0} tok`);
  console.log(`每条均价：$${(usage.costUsd / labels.length).toFixed(8)}`);

  // Jev 的本地 token 估算 vs 真实 input_tokens：校准拦截线用
  if (lane.estimator) {
    const comments = sample.map((r) => ({ comment_id: String(r.comment_id), content: String(r.content ?? ""), like_count: Number(r.like_count) || 0, topic_title: String(r.topic_title ?? "") }));
    const estimated = jev.estimateTokens(JSON.stringify({ comments })) + jev.estimateTokens(JSON.stringify(jev.buildQuestions(comments)));
    const errPct = ((estimated / Math.max(1, usage.inputTokens) - 1) * 100).toFixed(1);
    console.log(`本地估算 ${estimated} tok vs 真实 input ${usage.inputTokens} tok（偏差 ${errPct}%，拦截线 ${jev.MAX_ESTIMATED_TOKENS}）`);
  }

  labels.forEach((label, i) => {
    const row = sample[i];
    const problems = validate(label, row, lane.expectedSource);
    if (problems.length) allOk = false;
    const flag = problems.length ? `❌ ${problems.join("；")}` : "✅";
    console.log(`\n[${i + 1}] ${flag} ${label.comment_id}`);
    console.log(`    relevant=${label.is_relevant} sentiment=${label.sentiment}(${label.sentiment_score}) intent=${label.intent} conf=${label.confidence}`);
    console.log(`    aspects=[${label.aspects.join(", ")}] emotion=[${label.emotion.join("、")}]`);
    console.log(`    quote(${label.meta.evidenceSource}${label.meta.quoteVerified ? ",verified" : ",unverified"}): ${label.evidence_quote || "(空)"}`);
    if (label.meta.normalized) console.log(`    归一记录：${JSON.stringify(label.meta.normalized)}`);
    if (label.meta.warnings) console.log(`    警告：${label.meta.warnings.join("；")}`);
  });

  totals.push({ name, costUsd: usage.costUsd, ms, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens, done: labels.length });
}

console.log("\n──────── 汇总 ────────");
for (const t of totals) {
  console.log(`${t.name.padEnd(15)} ${t.done} 条 | ${t.ms}ms | in ${t.tokensIn} / out ${t.tokensOut} | $${t.costUsd.toFixed(8)} | 单条 $${(t.costUsd / t.done).toFixed(8)}`);
}
if (totals.length === 2) {
  const [a, b] = totals;
  console.log(`费用比：${a.name} : ${b.name} = 1 : ${(b.costUsd / Math.max(1e-12, a.costUsd)).toFixed(2)}`);
}
console.log(allOk ? "\n✅ probe 通过：两条道都返回了合法标签" : "\n❌ probe 未通过，请看上面的问题");
process.exit(allOk ? 0 : 1);

/** 合法性校验：枚举必须落在词表内、分数范围、引文必须是原文子串、来源标记正确。 */
function validate(label, row, expectedSource) {
  const problems = [];
  const content = String(row.content ?? "");
  if (!SENTIMENTS.includes(label.sentiment)) problems.push(`sentiment 越界: ${label.sentiment}`);
  if (!INTENTS.includes(label.intent)) problems.push(`intent 越界: ${label.intent}`);
  for (const key of label.aspects) if (!ASPECTS[key]) problems.push(`aspect 越界: ${key}`);
  for (const word of label.emotion) if (!EMOTIONS.includes(word)) problems.push(`emotion 越界: ${word}`);
  if (label.aspects.length > 5) problems.push(`aspects 超过 5 个`);
  if (label.emotion.length > 3) problems.push(`emotion 超过 3 个`);
  if (!(label.sentiment_score >= -1 && label.sentiment_score <= 1)) problems.push(`score 越界: ${label.sentiment_score}`);
  if (typeof label.is_relevant !== "boolean") problems.push("is_relevant 不是布尔");
  if (String(label.comment_id) !== String(row.comment_id)) problems.push("comment_id 对不上");
  if (label.evidence_quote && !content.includes(label.evidence_quote)) problems.push("引文不是原文逐字子串");
  if (label.meta.evidenceSource !== expectedSource) problems.push(`evidenceSource 应为 ${expectedSource}`);
  return problems;
}
