import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateReport, enrichReport } from '../src/report-view.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const label=(id,sentiment,extra={})=>({comment_id:id,is_relevant:true,sentiment,intent:'praise',aspects:['capability'],emotion:['认可'],evidence_quote:'模型不错',meta:{evidenceSource:'model',costSource:'unknown'},...extra});

test('全量标签分布按成功数计算，重复 ID 不扩大分母，匹配对只比较共同 ID',()=>{
 const report={lanes:[{id:'jev',label:'模型 A',model:'a',total:3},{id:'deepseek',label:'模型 B',model:'b',total:3}]};
 const a=aggregateReport(report,{jev:[label('1','positive'),label('1','positive'),label('2','negative')],deepseek:[label('1','neutral'),label('3','positive')]},[{comment_id:'1',content:'完整原文：模型不错',platform:'demo'}]);
 assert.equal(a.lanes[0].success,2);assert.equal(a.lanes[0].sentiment.positive,1);assert.equal(a.paired,1);
 assert.equal(a.agreements.sentiment.rate,0);assert.equal(a.agreements.is_relevant.rate,100);
 assert.equal(a.samples[0].content,'完整原文：模型不错');assert.equal(a.samples[0].left.sentiment,'positive');assert.equal(a.samples[0].right.sentiment,'neutral');
 assert.equal(a.lanes[0].costSources.unknown,2);
});
test('历史对象 lanes、无共同样本、不存在的完整报告',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'report-view-'));
 try {
  const report={lanes:{jev:{id:'jev',label:'历史 A',summary:{done:1}},deepseek:{id:'deepseek',label:'历史 B',summary:{done:1}}}};
  await writeFile(path.join(dir,'labels.jev.jsonl'),JSON.stringify(label('a','neutral'))+'\n');
  await writeFile(path.join(dir,'labels.deepseek.jsonl'),JSON.stringify(label('b','positive'))+'\n');
  await writeFile(path.join(dir,'report.jev.html'),'<h1>existing</h1>');
  const r=await enrichReport(report,dir);
  assert.deepEqual(r.artifacts,{jev:true,deepseek:false});assert.equal(r.analysis.lanes[0].label,'历史 A');
  assert.equal(r.analysis.paired,0);assert.equal(r.analysis.agreements.sentiment.rate,null);assert.deepEqual(r.analysis.samples,[]);
 } finally {await rm(dir,{recursive:true,force:true});}
});
