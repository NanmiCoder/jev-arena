#!/usr/bin/env node
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { buildFacts, LANES } from './facts.mjs';
import { buildView, placeholderNarrative } from './build-view.mjs';
import { renderReport } from './render.mjs';

const help = `npm run report -- --run runs/<runId> [options]
默认离线生成左右两份 HTML，不调用模型。
--lane jev|deepseek       仅生成一侧
--dataset <csv>          原评论 CSV，默认 <run>/comments.csv
--prepare-only           只输出事实、正文示例和视图，供 Agent 撰写
--narrative-dir <dir>     读取 narrative.jev.json / narrative.deepseek.json（必须存在）
--narrative <json>        单侧正文（需要 --lane）
--out <html> --view <json> 单侧输出路径（需要 --lane）
缺少正文时使用明确标注的事实草稿。详见 docs/report-generation.md。`;
async function main() {
  const args = {};
  for (let i=2; i<process.argv.length; i++) {
    const key=process.argv[i];
    if (['--help','-h'].includes(key)) { console.log(help); return; }
    if (key==='--prepare-only') { args.prepare=true; continue; }
    if (!['--run','--lane','--dataset','--narrative-dir','--narrative','--out','--view'].includes(key)) throw new Error(`未知参数 ${key}`);
    const value=process.argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${key} 缺少值`);
    args[key.slice(2)]=value;
  }
  if (!args.run) throw new Error(help);
  if (args.lane && !LANES[args.lane]) throw new Error('lane 必须为 jev 或 deepseek');
  if (!args.lane && (args.out || args.view || args.narrative)) throw new Error('--out/--view/--narrative 需要 --lane');
  const runDir=path.resolve(args.run);
  const datasetPath=path.resolve(args.dataset || path.join(runDir,'comments.csv'));
  try { await access(datasetPath); } catch { throw new Error('找不到评论快照；请用 --dataset 指定这次运行的原始 CSV。'); }
  // Validate both sides before writing reports.
  const prepared=[];
  for (const lane of args.lane ? [args.lane] : ['jev','deepseek']) {
    const {facts}=buildFacts(lane,{runDir,datasetPath});
    const example=placeholderNarrative(facts);
    const narrativePath=args.narrative || (args['narrative-dir'] && path.join(args['narrative-dir'],`narrative.${lane}.json`));
    const narrative=narrativePath ? JSON.parse(await readFile(narrativePath,'utf8')) : example;
    const view=buildView({facts,narrative,lane});
    prepared.push({lane,facts,example,view,narrativePath});
  }
  const save=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2)+'\n');};
  for (const {lane,facts,example,view,narrativePath} of prepared) {
    await save(path.join(runDir,`report.${lane}.facts.json`),facts);
    await save(path.join(runDir,`narrative.${lane}.example.json`),example);
    await save(path.resolve(args.view || path.join(runDir,`report.${lane}.view.json`)),view);
    const output=path.resolve(args.out || path.join(runDir,`report.${lane}.html`));
    if (!args.prepare) await renderReport(view,output);
    console.log(JSON.stringify({lane,runId:facts.run.id,comments:facts.dataset.total,narrative:narrativePath || '事实草稿',output:args.prepare?'仅准备上下文':output}));
  }
}
main().catch(error=>{console.error(`报告生成失败：${error.message}`);process.exitCode=1;});
