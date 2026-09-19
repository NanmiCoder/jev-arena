/** Read-only aggregation of saved labels. No model requests. */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export function aggregateReport(report, labelsByLane, rows = []) {
  const definitions = Array.isArray(report.lanes) ? report.lanes : Object.values(report.lanes ?? {});
  const definitionsById = new Map(definitions.map(d => [d.id, d]));
  const ids = ['jev', 'deepseek'];
  const maps = ids.map(id => new Map((labelsByLane[id] ?? []).map(l => [String(l.comment_id), l])));
  const counts = values => { const result = Object.create(null); for (const value of values) { const key = String(value ?? 'unknown'); result[key] = (result[key] ?? 0) + 1; } return result; };
  const lanes = ids.map((id,i) => {
    const def = definitionsById.get(id) ?? {id,label:id};
    const summary = def.summary ?? def;
    const labels = [...maps[i].values()];
    return { ...summary, id, label: def.label ?? id, model: def.model ?? summary.model,
      total: Number(summary.total ?? report.dataset?.rowsInRun ?? report.dataset?.total) || labels.length,
      success: labels.length, relevant: labels.filter(l=>l.is_relevant === true).length,
      sentiment: counts(labels.map(l=>l.sentiment)), intent: counts(labels.map(l=>l.intent)),
      aspects: counts(labels.flatMap(l=>[...new Set(l.aspects ?? [])])),
      emotion: counts(labels.flatMap(l=>[...new Set(l.emotion ?? [])])),
      evidenceSources: counts(labels.map(l=>l.meta?.evidenceSource ?? l.evidenceSource)),
      costSources: counts(labels.map(l=>l.meta?.costSource)),
    };
  });
  const originalById = new Map(rows.map(r => [String(r.comment_id),r]));
  const savedById = new Map([...(report.samples ?? []), ...(report.divergences ?? [])].map(s=>[String(s.comment_id),s]));
  const pairs = [...maps[0]].filter(([id])=>maps[1].has(id)).map(([id,left])=>({id,left,right:maps[1].get(id)}));
  const agreements = Object.fromEntries(['is_relevant','sentiment','intent'].map(field=>{
    const agree=pairs.filter(p=>p.left[field]===p.right[field]).length;
    return [field,{agree,total:pairs.length,rate:pairs.length ? 100*agree/pairs.length : null}];
  }));
  const samples = pairs.map(({id,left,right}) => {
    const saved = savedById.get(id); const original=originalById.get(id);
    const reasons=[];
    if(left.is_relevant!==right.is_relevant) reasons.push('相关性判断不同');
    if(left.sentiment!==right.sentiment) reasons.push('情感判断不同');
    if(left.intent!==right.intent) reasons.push('意图判断不同');
    if(Math.abs(Number(left.sentiment_score)-Number(right.sentiment_score))>0.25) reasons.push('情感分数相差超过 0.25');
    const sameSet = (a,b) => JSON.stringify([...new Set(a ?? [])].sort()) === JSON.stringify([...new Set(b ?? [])].sort());
    if (!sameSet(left.aspects,right.aspects)) reasons.push('讨论维度不同');
    if (!sameSet(left.emotion,right.emotion)) reasons.push('情绪标签不同');
    const compact = label => ({is_relevant:label.is_relevant,sentiment:label.sentiment,sentiment_score:label.sentiment_score,intent:label.intent,aspects:label.aspects,emotion:label.emotion,evidence_quote:label.evidence_quote,evidenceSource:label.meta?.evidenceSource ?? label.evidenceSource});
    return {comment_id:id,content:original?.content ?? saved?.content ?? left.evidence_quote ?? right.evidence_quote ?? '',
      contentSource:original ? 'original' : saved ? 'saved-report' : 'evidence-excerpt',
      platform:original?.platform ?? saved?.platform ?? '',left:compact(left),right:compact(right),reasons};
  }).sort((a,b)=>b.reasons.length-a.reasons.length);
  // Keep disagreements and a few agreements, with honest selection/denominator metadata.
  const different=samples.filter(s=>s.reasons.length); const same=samples.filter(s=>!s.reasons.length);
  return {source:'labels',lanes,paired:pairs.length,agreements,samples:[...different.slice(0,60),...same.slice(0,10)],
    disagreementCount:different.length,sampleCount:Math.min(60,different.length)+Math.min(10,same.length),
    sampleNote:'优先展示最多 60 条分歧样本与 10 条一致样本；这是诊断样本，不是随机抽样。分布分母为各侧成功打标数，多标签占比之和可超过 100%。'};
}

export async function enrichReport(report, runDir, dataset) {
  const artifacts = Object.fromEntries(await Promise.all(['jev','deepseek'].map(async id=>{
    try { return [id,(await stat(path.join(runDir,`report.${id}.html`))).isFile()]; } catch { return [id,false]; }
  })));
  const labels = {};
  for (const id of ['jev','deepseek']) {
    try {
      labels[id]=(await readFile(path.join(runDir,`labels.${id}.jsonl`),'utf8')).split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    } catch (err) { if(err.code!=='ENOENT') throw err; }
  }
  const sameDataset = dataset && report.dataset?.fingerprint && dataset.stats.fingerprint === report.dataset.fingerprint.slice(0,16);
  return {...report,artifacts,...(labels.jev && labels.deepseek ? {analysis:aggregateReport(report,labels,sameDataset?dataset.rows:[])} : {})};
}
