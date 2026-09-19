#!/usr/bin/env node
/**
 * 报告生成入口。
 *
 *   node report/cli.mjs --lane jev --run runs/0919-124001 --out runs/0919-124001/report.jev.html
 *   node report/cli.mjs --lane deepseek --run runs/0919-124001 --out runs/0919-124001/report.deepseek.html
 *
 * 两条命令走的是同一条流水线（buildFacts → buildView → renderReport），唯一的变量是
 * --lane 决定的那份 labels.<lane>.jsonl。这样两份 HTML 的每个区块、每句口径提示都一样，
 * 并排看的时候差异只可能来自标签本身。
 *
 * 常用可选参数：
 *   --dataset <csv>     评论快照，默认 data/comments.csv
 *   --narrative <json>  正文（六节 blocks）；不传则用占位正文，保证结构完整
 *   --view <json>       顺手把 view JSON 落盘，便于排查渲染失败
 *   --voxagent <dir>    VoxAgent 检出根目录，默认读环境变量 VOXAGENT_ROOT
 */

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { buildFacts, LANES } from "./facts.mjs";
import { buildView, placeholderNarrative } from "./build-view.mjs";
import { renderReport, VOXAGENT_ROOT } from "./render.mjs";

const USAGE = `用法：node report/cli.mjs --lane <jev|deepseek> --run <runDir> [--out <html>] [选项]

必填：
  --lane <id>          jev | deepseek（决定读哪份 labels.<lane>.jsonl）
  --run <dir>          run 目录，例如 runs/0919-124001

可选：
  --out <html>         HTML 输出路径，默认 <runDir>/report.<lane>.html
  --dataset <csv>      评论快照，默认 data/comments.csv
  --narrative <json>   正文定义；不传用占位正文（六节结构与数字仍然完整）
  --view <json>        额外把 view JSON 写到这里
  --voxagent <dir>     VoxAgent 检出根目录（默认 ${VOXAGENT_ROOT}）
  -h, --help           显示本帮助
`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "-h" || token === "--help") { args.help = true; continue; }
    if (!token.startsWith("--")) throw new Error(`无法识别的参数：${token}`);
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`参数 ${token} 缺少数值`);
    args[key] = value;
    i += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(USAGE); return; }

  if (!args.lane) throw new Error(`缺少 --lane\n\n${USAGE}`);
  if (!args.run) throw new Error(`缺少 --run\n\n${USAGE}`);
  const config = LANES[args.lane];
  if (!config) throw new Error(`未知 lane "${args.lane}"，可选：${Object.keys(LANES).join(" / ")}`);

  const runDir = path.resolve(process.cwd(), args.run);
  const datasetPath = path.resolve(process.cwd(), args.dataset ?? "data/comments.csv");
  const outPath = path.resolve(process.cwd(), args.out ?? path.join(args.run, `report.${args.lane}.html`));
  const voxagentRoot = args.voxagent ? path.resolve(process.cwd(), args.voxagent) : VOXAGENT_ROOT;

  const { facts, factCatalog } = buildFacts(args.lane, { runDir, datasetPath });

  // 没有正文也要能出报告：占位正文把事实清单前几条塞进 fact-list，
  // 保证六节结构、图表、数字全部就位，等正文写好直接替换 narrative 即可。
  let narrative = null;
  if (args.narrative) {
    narrative = JSON.parse(await readFile(path.resolve(process.cwd(), args.narrative), "utf8"));
  }
  const usingPlaceholder = !narrative;
  if (!narrative) narrative = placeholderNarrative(facts);

  const view = buildView({ facts, narrative, lane: args.lane });
  if (args.view) {
    await writeFile(path.resolve(process.cwd(), args.view), `${JSON.stringify(view, null, 2)}\n`, "utf8");
  }

  const htmlPath = await renderReport(view, outPath, { voxagentRoot });
  const html = await readFile(htmlPath);
  const info = await stat(htmlPath);

  process.stdout.write(`${JSON.stringify({
    lane: args.lane,
    lane_label: config.label,
    model: facts.run.model,
    evidence_source: facts.quality.evidence_source,
    run_id: facts.run.id,
    label_file: path.relative(process.cwd(), facts.run.labelFile),
    dataset: path.relative(process.cwd(), datasetPath),
    narrative: usingPlaceholder ? "placeholder" : args.narrative,
    facts: factCatalog.length,
    sections: view.sections.map((section) => section.id),
    evidence_pool: view.evidence.length,
    coverage: {
      comments_in_snapshot: view.coverage.comments_in_snapshot,
      relevant_comments: view.coverage.relevant_comments,
      relevant_pct: view.coverage.relevant_pct,
      avg_sentiment_score: view.coverage.avg_sentiment_score,
    },
    output: htmlPath,
    bytes: info.size,
    sha256: createHash("sha256").update(html).digest("hex"),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`报告生成失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
