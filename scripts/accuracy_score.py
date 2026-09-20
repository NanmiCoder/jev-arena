#!/usr/bin/env python3
"""Offline, deterministic scoring against saved blinded AI references."""
import collections, csv, html, json, math, pathlib, statistics, sys
from accuracy_audit import ROOT, OUT, SOURCE, data, sha, dump, validate, SENTIMENTS, INTENTS, ASPECTS, EMOTIONS

FIELDS={'is_relevant':'r','sentiment':'s','intent':'i'}
def ratio(a,b): return a/b if b else None
def mean(xs): return sum(xs)/len(xs) if xs else None
def reference(phase,expected):
    records={}
    for d in sorted((OUT/phase).glob('[0-9][0-9][0-9][0-9]')):
        ids=[x['id'] for x in json.loads((d/'input.json').read_text())['comments']]
        if not (d/'accepted.json').exists(): raise ValueError(f'Missing batch: {d}')
        accepted=json.loads((d/'accepted.json').read_text())
        raw_matches=[]
        for response in d.glob('attempt-*/response.json'):
            try:raw=json.loads(response.read_text())
            except json.JSONDecodeError:continue
            if raw==accepted:raw_matches.append(response)
        if not raw_matches:raise ValueError(f'Accepted reference has no matching raw response: {d}')
        provenance_ok=False
        for response in raw_matches:
            metadata=json.loads((response.parent/'metadata.json').read_text())
            if metadata.get('ok') and metadata.get('prompt_sha256')==sha((d/'prompt.txt').read_bytes()) and metadata.get('response_sha256')==sha(response.read_bytes()):provenance_ok=True
            if (d/'validation-recovery.json').exists() and response.parent.name=='attempt-1':provenance_ok=True
        if not provenance_ok:raise ValueError(f'Reference provenance mismatch: {d}')
        for x in validate(accepted,ids):
            if x['id'] in records: raise ValueError('Duplicate reference ID')
            records[x['id']]=x
    if len(records)!=expected: raise ValueError(f'Expected {expected}, got {len(records)}')
    return records
def labels(lane,ids):
    result={}
    for line in (SOURCE/f'labels.{lane}.jsonl').read_text().splitlines():
        x=json.loads(line)
        if x['comment_id'] in result: raise ValueError('Duplicate candidate ID')
        result[x['comment_id']]=x
    if set(result)!=set(ids): raise ValueError('Candidate/source ID mismatch')
    return result
def categorical(refs,preds,categories):
    n=len(refs);decidable=sum(bool(r) for r in refs);clear=sum(len(r)==1 for r in refs)
    strict=sum(bool(r) and p==r[0] for r,p in zip(refs,preds));accepted=sum(p in r for r,p in zip(refs,preds))
    clear_correct=sum(len(r)==1 and p==r[0] for r,p in zip(refs,preds))
    confusion={str(c):{str(p):0 for p in categories} for c in categories}
    for r,p in zip(refs,preds):
        if r: confusion[str(r[0])][str(p)]+=1
    per_class={}
    for c in categories:
        tp=confusion[str(c)][str(c)];fp=sum(confusion[str(o)][str(c)] for o in categories if o!=c);fn=sum(confusion[str(c)][str(o)] for o in categories if o!=c)
        per_class[str(c)]={'support':tp+fn,'tp':tp,'fp':fp,'fn':fn,'precision':ratio(tp,tp+fp),'recall':ratio(tp,tp+fn),'f1':ratio(2*tp,2*tp+fp+fn)}
    majority=max(categories,key=lambda c:per_class[str(c)]['support'])
    return {'n':n,'decidable':decidable,'unjudgeable':n-decidable,'clear':clear,'ambiguous':decidable-clear,'strict_correct':strict,'accepted_correct':accepted,'strict_accuracy_all':ratio(strict,n),'accepted_accuracy_all':ratio(accepted,n),'strict_accuracy_decidable':ratio(strict,decidable),'accepted_accuracy_decidable':ratio(accepted,decidable),'clear_correct':clear_correct,'clear_wrong':clear-clear_correct,'clear_accuracy':ratio(clear_correct,clear),'ambiguous_hit':accepted-clear_correct,'ambiguous_miss':decidable-clear-(accepted-clear_correct),'confusion_primary_reference':confusion,'per_class':per_class,'macro_f1':mean([v['f1'] for v in per_class.values() if v['support'] and v['f1'] is not None]),'majority_reference_class':majority,'majority_baseline_strict_accuracy_all':ratio(per_class[str(majority)]['support'],n)}
def multilabel(refs,preds):
    tp=fp=fn=exact=0;jaccards=[]
    for r,p in zip(refs,preds):
        r,p=set(r),set(p);tp+=len(r&p);fp+=len(p-r);fn+=len(r-p);exact+=r==p;jaccards.append(len(r&p)/len(r|p) if r|p else 1)
    return {'n':len(refs),'exact_correct':exact,'exact_accuracy':ratio(exact,len(refs)),'tp':tp,'fp':fp,'fn':fn,'micro_precision':ratio(tp,tp+fp),'micro_recall':ratio(tp,tp+fn),'micro_f1':ratio(2*tp,2*tp+fp+fn),'mean_jaccard':mean(jaccards)}
def evaluate(rows,ref,pred):
    ids=[r['comment_id'] for r in rows];n=len(ids)
    result={f:categorical([ref[i][k] for i in ids],[pred[i][f] for i in ids],cats) for f,k,cats in [('is_relevant','r',[True,False]),('sentiment','s',SENTIMENTS),('intent','i',INTENTS)]}
    result['core']={'n':n,'strict_correct':sum(all(ref[i][k] and pred[i][f]==ref[i][k][0] for f,k in FIELDS.items()) for i in ids),'accepted_correct':sum(all(pred[i][f] in ref[i][k] for f,k in FIELDS.items()) for i in ids),'decidable':sum(all(ref[i][k] for k in FIELDS.values()) for i in ids),'clear':sum(all(len(ref[i][k])==1 for k in FIELDS.values()) for i in ids)}
    for key in ['strict','accepted']:
        result['core'][key+'_accuracy_all']=ratio(result['core'][key+'_correct'],n)
        result['core'][key+'_accuracy_decidable']=ratio(result['core'][key+'_correct'],result['core']['decidable'])
    for f,k in [('aspects','a'),('emotion','e')]: result[f]=multilabel([ref[i][k] for i in ids],[pred[i][f] for i in ids])
    result['aspects']['other_reference_rows']=sum('other' in ref[i]['a'] for i in ids)
    result['aspects']['other_predicted_rows']=sum('other' in pred[i]['aspects'] for i in ids)
    result['aspects']['excluding_other']=multilabel([[x for x in ref[i]['a'] if x!='other'] for i in ids],[[x for x in pred[i]['aspects'] if x!='other'] for i in ids])
    errors=[abs(pred[i]['sentiment_score']-ref[i]['score']) for i in ids if ref[i]['score'] is not None]
    result['score']={'n':len(errors),'mae':mean(errors),'rmse':math.sqrt(mean([e*e for e in errors])) if errors else None}
    return result
def mechanical(rows,pred):
    n=len(rows);counts=collections.Counter();problems=[]
    for row in rows:
        p=pred[row['comment_id']];issues=[];q=p.get('evidence_quote')
        if not q:counts['empty_quote']+=1
        elif isinstance(q,str) and q in row['content']:counts['verbatim_quote']+=1
        else:counts['non_verbatim_quote']+=1;issues.append('non_verbatim_quote')
        for f,cats in [('sentiment',SENTIMENTS),('intent',INTENTS)]:
            if p.get(f) not in cats:issues.append(f)
        if type(p.get('is_relevant'))!=bool:issues.append('is_relevant')
        for f,cats,lim in [('aspects',ASPECTS,5),('emotion',EMOTIONS,3)]:
            v=p.get(f)
            if not isinstance(v,list) or len(v)>lim or len(v)!=len(set(v)) or any(x not in cats for x in v):issues.append(f)
        for f,lo,hi in [('sentiment_score',-1,1),('confidence',0,1)]:
            v=p.get(f)
            if type(v) not in [float,int] or not math.isfinite(v) or not lo<=v<=hi:issues.append(f)
        counts['evidence_source_'+str(p.get('meta',{}).get('evidenceSource'))]+=1
        if p.get('meta',{}).get('normalized'):counts['rows_normalized']+=1
        if issues:problems.append({'comment_id':row['comment_id'],'issues':issues})
    return {'n':n,'counts':dict(counts),'schema_or_quote_problem_rows':len(problems),'problems':problems}
def wilson(k,n):
    if not n:return None
    z=1.96;p=k/n;d=1+z*z/n;c=(p+z*z/(2*n))/d;h=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d
    return [max(0,c-h),min(1,c+h)]
def pct(v):return '—' if v is None else f'{100*v:.2f}%'
def fmt(v):return '—' if v is None else f'{v:.4f}'
def table(headers,rows):return '| '+' | '.join(headers)+' |\n| '+' | '.join(['---']*len(headers))+' |\n'+'\n'.join('| '+' | '.join(str(x).replace('|','\\|').replace('\n',' ') for x in r)+' |' for r in rows)+'\n'
def main():
    rows=data();ids=[r['comment_id'] for r in rows];ref=reference('primary',10000);repeat=reference('repeat',400)
    manifest=json.loads((OUT/'manifest.json').read_text())
    for f,h in manifest['sources'].items():assert sha((SOURCE/f).read_bytes())==h,'Source changed'
    assert sha((OUT/'rubric.md').read_bytes())==manifest['rubric_sha256'],'Rubric changed'
    assert set(ref)==set(ids) and set(repeat)<=set(ids)
    candidates={l:labels(l,ids) for l in ['jev','deepseek']}
    results={'run_id':'0919-124001','n':len(rows),'reference_kind':'independent AI reference; not human ground truth','lanes':{},'repeat':{},'paired':{},'scoring_code_sha256':sha(pathlib.Path(__file__).read_bytes()),'source_manifest_sha256':sha((OUT/'manifest.json').read_bytes())}
    for lane,pred in candidates.items():
        results['lanes'][lane]={'overall':evaluate(rows,ref,pred),'mechanical':mechanical(rows,pred),'platform':{p:evaluate([r for r in rows if r['platform']==p],ref,pred) for p in sorted({r['platform'] for r in rows})}}
    for f,k in FIELDS.items():
        both=jo=do=neither=0
        for i in ids:
            a=candidates['jev'][i][f] in ref[i][k];b=candidates['deepseek'][i][f] in ref[i][k]
            both+=a and b;jo+=a and not b;do+=b and not a;neither+=not a and not b
        results['paired'][f]={'both_hit':both,'jev_only':jo,'deepseek_only':do,'neither_hit':neither,'difference_jev_minus_deepseek_pp':100*(jo-do)/len(ids)}
        agree=sum(bool(ref[i][k]) and bool(repeat[i][k]) and ref[i][k][0]==repeat[i][k][0] for i in repeat)
        overlap=sum(bool(set(ref[i][k])&set(repeat[i][k])) for i in repeat)
        results['repeat'][f]={'n':400,'unjudgeable_in_either':sum(not ref[i][k] or not repeat[i][k] for i in repeat),'primary_answer_agree':agree,'primary_answer_agreement':agree/400,'wilson95':wilson(agree,400),'acceptable_set_overlap':overlap,'acceptable_set_overlap_rate':overlap/400}
    subset=[r for r in rows if r['comment_id'] in repeat]
    results['repeat']['candidate_sensitivity']={l:{'first_reference':evaluate(subset,ref,p),'second_reference':evaluate(subset,repeat,p)} for l,p in candidates.items()}
    historical=json.loads((SOURCE/'manifest.json').read_text())
    results['efficiency']={}
    for lane in historical['lanes']:
        l=lane['id'];correct=results['lanes'][l]['overall']['core']['accepted_correct']
        results['efficiency'][l]={'historical_cost_usd':lane['costUsd'],'historical_elapsed_seconds':lane['elapsedMs']/1000,'accepted_core_correct':correct,'usd_per_1000_accepted_core':lane['costUsd']/correct*1000 if correct else None,'accepted_core_per_second':correct/(lane['elapsedMs']/1000),'cost_source':'provider reported' if l=='jev' else 'historical local pricing estimate'}
    usage=collections.Counter();elapsed=[];failures=0
    for f in OUT.glob('*/*/attempt-*/metadata.json'):
        x=json.loads(f.read_text());failures+=not x['ok'];elapsed.append(x['elapsed_s'])
    # Include all completed calls, including outputs rejected by the initial warning validator.
    for f in OUT.glob('*/*/attempt-*/events.jsonl'):
        for line in f.read_text().splitlines():
            try:event=json.loads(line)
            except json.JSONDecodeError:continue
            if event.get('type')=='turn.completed':
                for k,v in (event.get('usage') or {}).items():
                    if isinstance(v,(int,float)):usage[k]+=v
    results['inference']={'requested_model':manifest['model_requested'],'successful_reference_rows':10400,'initially_failed_or_rejected_attempt_records':failures,'usage_reported':dict(usage),'sum_recorded_call_seconds':sum(elapsed),'cost_usd':None,'model_identity_limit':'Model is explicitly requested via Codex CLI. JSON event protocol does not attest server-side model revision.'}
    dump(OUT/'metrics.json',results)
    with open(OUT/'reference.jsonl','w') as f:
        for i in ids:f.write(json.dumps(ref[i],ensure_ascii=False)+'\n')
    with open(OUT/'repeat-comparison.jsonl','w') as f:
        for row in subset:
            i=row['comment_id']
            f.write(json.dumps({'comment_id':i,'content':row['content'],'topic_title':row['topic_title'],'first':ref[i],'second':repeat[i],'primary_agree':{field:bool(ref[i][k]) and bool(repeat[i][k]) and ref[i][k][0]==repeat[i][k][0] for field,k in FIELDS.items()}},ensure_ascii=False)+'\n')
    details=[]
    for row in rows:
        i=row['comment_id'];record={'comment_id':i,'platform':row['platform'],'content':row['content'],'topic_title':row['topic_title'],'reference':ref[i]}
        for l,p in candidates.items():
            record[l]={'label':{f:p[i][f] for f in ['is_relevant','sentiment','intent','aspects','emotion','sentiment_score','evidence_quote']},'accepted':{f:p[i][f] in ref[i][k] for f,k in FIELDS.items()},'strict':{f:bool(ref[i][k]) and p[i][f]==ref[i][k][0] for f,k in FIELDS.items()}}
        details.append(record)
    with open(OUT/'scored.jsonl','w') as f:
        for r in details:f.write(json.dumps(r,ensure_ascii=False)+'\n')
    flat=[]
    for r in details:
        item={k:r[k] for k in ['comment_id','platform','content','topic_title']}
        item.update({'reference_'+k:json.dumps(v,ensure_ascii=False) if not isinstance(v,str) else v for k,v in r['reference'].items() if k!='id'})
        for l in candidates:
            item.update({l+'_'+k:json.dumps(v,ensure_ascii=False) for k,v in r[l]['label'].items()});item.update({l+'_hit_'+k:v for k,v in r[l]['accepted'].items()})
        flat.append(item)
    with open(OUT/'逐条核查.csv','w',encoding='utf-8-sig',newline='') as f:
        w=csv.DictWriter(f,fieldnames=list(flat[0]));w.writeheader()
        # Protect spreadsheet viewers from untrusted comment formula execution; JSONL retains exact text.
        for row in flat:w.writerow({k: "'"+v if isinstance(v,str) and (k=='comment_id' or v.lstrip().startswith(('=','+','-','@'))) else v for k,v in row.items()})
    write_report(results,details)
    print(json.dumps({'n':results['n'],'core':{l:x['overall']['core'] for l,x in results['lanes'].items()},'repeat':{k:v for k,v in results['repeat'].items() if k!='candidate_sensitivity'}},ensure_ascii=False,indent=2))
def write_report(m,details):
    lanes=m['lanes'];names={'jev':'Jev','deepseek':'DeepSeek Flash'};zh={'is_relevant':'相关性','sentiment':'情感','intent':'意图','core':'三项全对'}
    text='# 一万条评论全量准确率复核\n\n历史运行：0919-124001。原始评论 10,000 条，两侧各 10,000 条，逐 ID 对齐。\n\n**本报告的“准确率”是相对独立 AI 参考标注的得分，不是经过人工金标准验证的真实准确率。** 全量计数精确，但裁判仍可能出错。参考标注由 Codex CLI 请求 gpt-6-astra，先只看正文和原有标题完成，再读取两侧结果统一评分；不按 A/B 风格投票，不使用旧抽样胜负替代全量得分。评分对象是保存的最终标签，包含原流程的归一化效果，不是未处理的模型原始响应。\n\n'
    text+='## 1. 主结果\n\n每一项分母均为 10,000。严格=命中参考首选；可接受=命中预先规则允许的任一合理答案。三项全对指相关性、情感、意图同时命中，未把多标签、连续分值和引文混入。\n\n'
    text+=table(['指标','Jev 严格 / 可接受','DeepSeek 严格 / 可接受','Jev 可接受正确数','DeepSeek 可接受正确数'],[[zh[f],*[pct(lanes[l]['overall'][f]['strict_accuracy_all'])+' / '+pct(lanes[l]['overall'][f]['accepted_accuracy_all']) for l in names],*[lanes[l]['overall'][f]['accepted_correct'] for l in names]] for f in zh])
    j=lanes['jev']['overall']['core'];d=lanes['deepseek']['overall']['core'];delta=100*(d['accepted_accuracy_all']-j['accepted_accuracy_all'])
    text+=f"\n在这套统一参考下，三项全对的可接受命中数为 Jev {j['accepted_correct']:,} 条、DeepSeek {d['accepted_correct']:,} 条；DeepSeek − Jev 为 {delta:+.2f} 个百分点。这个差值描述本次语料与本次参考口径，不代表人工真值差距。\n"
    text+='\n类别不均衡的辅助检查：多数类基线是假设所有评论都预测为参考中最常见的一类；macro F1 对有参考样本的类别等权平均，使用严格首选参考。以下均为同一语料内的描述指标。\n\n'
    text+=table(['字段','参考多数类','多数类严格基线','Jev macro F1','DeepSeek macro F1'],[[zh[f],str(lanes['jev']['overall'][f]['majority_reference_class']),pct(lanes['jev']['overall'][f]['majority_baseline_strict_accuracy_all']),*[pct(lanes[l]['overall'][f]['macro_f1']) for l in names]] for f in FIELDS])
    text+='\n情感分类还应按类别看：总体准确率会更多受样本较多的中性类别影响；各类别等权的 macro F1 与总体准确率可能给出不同排序。\n\n'
    text+=table(['情感类别','参考首选条数','Jev F1','DeepSeek F1'],[[c,lanes['jev']['overall']['sentiment']['per_class'][c]['support'],*[pct(lanes[l]['overall']['sentiment']['per_class'][c]['f1']) for l in names]] for c in SENTIMENTS])
    text+='\n## 2. 歧义与明确错误\n\n单值参考为确定项，多值为歧义项，空值为不可判。歧义项不命中也不与确定项错误混为一谈；不可判项未计为正确。\n\n'
    text+=table(['字段','确定 / 歧义 / 不可判','Jev 确定项错误','DeepSeek 确定项错误','Jev 确定项准确率','DeepSeek 确定项准确率'],[[zh[f],'/'.join(str(lanes['jev']['overall'][f][k]) for k in ['clear','ambiguous','unjudgeable']),*[lanes[l]['overall'][f]['clear_wrong'] for l in names],*[pct(lanes[l]['overall'][f]['clear_accuracy']) for l in names]] for f in FIELDS])
    text+='\n只在可判定条目内计算的可接受命中率（与主表不同分母，不用于掩盖不可判项）：\n\n'
    text+=table(['字段','可判定分母','覆盖率','Jev','DeepSeek'],[[zh[f],lanes['jev']['overall'][f]['decidable'],pct(lanes['jev']['overall'][f]['decidable']/m['n']),*[pct(lanes[l]['overall'][f]['accepted_accuracy_decidable']) for l in names]] for f in zh])
    text+='\n以下配对计数显示两侧谁命中同一条参考；双方都命中并不构成人工真值。\n\n'
    text+=table(['字段','双方命中','仅 Jev 命中','仅 DeepSeek 命中','双方未命中','Jev − DeepSeek'],[[zh[f],v['both_hit'],v['jev_only'],v['deepseek_only'],v['neither_hit'],f"{v['difference_jev_minus_deepseek_pp']:+.2f} 个百分点"] for f,v in m['paired'].items()])
    text+='\n主要误判方向（按单值、可确定参考计数，排除可接受备选；每侧每字段列前三项）：\n\n'
    confusion_rows=[]
    for l in names:
        for f,k in FIELDS.items():
            counter=collections.Counter((r['reference'][k][0],r[l]['label'][f]) for r in details if len(r['reference'][k])==1 and not r[l]['accepted'][f])
            for (truth,pred),count in counter.most_common(3):confusion_rows.append([names[l],zh[f],str(truth),str(pred),count])
    text+=table(['模型','字段','参考','被标成','条数'],confusion_rows)
    text+='\n## 3. 多标签与连续分值\n\n集合完全一致要求不多标、不漏标；micro F1 兼顾多标与漏标。两侧多标签生成机制不同，指标描述保存下来的最终产出，不能单独归因于基础模型能力。\n\n'
    text+=table(['字段 / 模型','集合完全一致','micro precision','micro recall','micro F1','平均 Jaccard'],[[f+' / '+names[l],*[pct(lanes[l]['overall'][f][k]) for k in ['exact_accuracy','micro_precision','micro_recall','micro_f1','mean_jaccard']]] for f in ['aspects','emotion'] for l in names])
    text+='\n“other”与空集的边界容易受标注习惯影响，因此另列两侧使用次数及去掉 other 后的敏感性结果；去掉 other 并不等于它的原始标注正确。\n\n'
    text+=table(['模型','参考含 other 条数','模型含 other 条数','排除 other 后集合全对','排除 other 后 micro F1'],[[names[l],lanes[l]['overall']['aspects']['other_reference_rows'],lanes[l]['overall']['aspects']['other_predicted_rows'],pct(lanes[l]['overall']['aspects']['excluding_other']['exact_accuracy']),pct(lanes[l]['overall']['aspects']['excluding_other']['micro_f1'])] for l in names])
    text+='\n情感分值没有客观的小数标准，仅报告平均绝对误差 MAE（越小越接近参考），不将微小分差算成分类错误。\n\n'+table(['模型','有效分数条数','MAE','RMSE'],[[names[l],lanes[l]['overall']['score']['n'],fmt(lanes[l]['overall']['score']['mae']),fmt(lanes[l]['overall']['score']['rmse'])] for l in names])
    text+='\n## 4. 按平台结果\n\n固定样本不是全平台随机样本，以下结果仅属于本次语料。\n\n'+table(['平台','条数','Jev 相关性 / 情感 / 意图','DeepSeek 相关性 / 情感 / 意图','Jev / DeepSeek 三项全对'],[[p,lanes['jev']['platform'][p]['core']['n'],*[' / '.join(pct(lanes[l]['platform'][p][f]['accepted_accuracy_all']) for f in FIELDS) for l in names],' / '.join(pct(lanes[l]['platform'][p]['core']['accepted_accuracy_all']) for l in names)] for p in lanes['jev']['platform']])
    text+='\n## 5. 裁判复标稳定性\n\n用预先固定的随机种子抽取400条，裁判在不看初次参考和候选答案的情况下再次独立标注。它是同模型重复性检查，不是第二个独立模型或人工复核。95%区间只适用于这400条抽查的稳定率，不是全量准确率的可信区间。只要任一次不可判，就不计作首选一致或集合交集，分母仍保留400。\n\n'+table(['字段','首选一致数 / 400','首选一致率','Wilson 95%','可接受集合有交集','任一次不可判条数'],[[zh[f],v['primary_answer_agree'],pct(v['primary_answer_agreement']),'–'.join(pct(x) for x in v['wilson95']),pct(v['acceptable_set_overlap_rate']),v['unjudgeable_in_either']] for f,v in m['repeat'].items() if f in FIELDS])
    text+='\n同一400条换一次参考标注后的得分敏感性（可接受口径）：\n\n'+table(['模型 / 字段','初次参考','复标参考','变化'],[[names[l]+' / '+zh[f],pct(v['first_reference'][f]['accepted_accuracy_all']),pct(v['second_reference'][f]['accepted_accuracy_all']),f"{100*(v['second_reference'][f]['accepted_accuracy_all']-v['first_reference'][f]['accepted_accuracy_all']):+.2f} 个百分点"] for l,v in m['repeat']['candidate_sensitivity'].items() for f in zh])
    text+='\n## 6. 硬性数据检查\n\n完整性检查已要求两侧与评论ID集合完全一致、无重复，源文件指纹未改变。逐字引文有效只说明来自原文，不证明支持整条判断。Jev 的引文为宿主机械摘取；DeepSeek 为模型输出经归一化校验，不能把这个指标当作两模型引用能力的公平比较。\n\n'+table(['模型','逐字有效引文','空引文','非原文引文','字段/引文问题条数','发生归一化的条数'],[[names[l],*[lanes[l]['mechanical']['counts'].get(k,0) for k in ['verbatim_quote','empty_quote','non_verbatim_quote']],lanes[l]['mechanical']['schema_or_quote_problem_rows'],lanes[l]['mechanical']['counts'].get('rows_normalized',0)] for l in names])
    text+='\n## 7. 可复查案例\n\n以下为确定项错误的诊断性示例，各侧按“确定项错误数降序、ID排序”取前5条；它们不是随机样本，不能用示例比例估算总体。完整原文及全部逐条结果在附带CSV/JSONL。\n\n'
    for l in names:
        cases=[]
        for r in details:
            bad=[f for f,k in FIELDS.items() if len(r['reference'][k])==1 and not r[l]['accepted'][f]]
            if bad:cases.append((len(bad),r['comment_id'],r,bad))
        cases.sort(key=lambda x:(-x[0],x[1]))
        text+='### '+names[l]+'\n\n'
        for _,i,r,bad in cases[:5]:
            text+=f"- **{i}**（{r['platform']}）：{r['content'][:350].replace(chr(10),' ')}\n  - 字段："+'、'.join(zh[f] for f in bad)+'；候选：'+json.dumps({f:r[l]['label'][f] for f in bad},ensure_ascii=False)+'；参考：'+json.dumps({f:r['reference'][FIELDS[f]] for f in bad},ensure_ascii=False)+'。\n  - 参考依据：'+r['reference']['reason']+'\n'
    text+='\n## 8. 加入质量后的速度与成本\n\n沿用原运行耗时和费用，以“相关性、情感、意图三项同时命中可接受参考”定义一条合格结果。费用除以合格条数只用于本次结果折算，不是重新运行保证得到正确结果的真实采购价格；未包括参考评审、人工修正、失败重试等成本。DeepSeek 为历史本地估价，非供应商账单。\n\n'
    text+=table(['模型','历史费用 / 美元','历史耗时 / 秒','每千条合格结果 / 美元','每秒合格结果'],[[names[l],f"{v['historical_cost_usd']:.8f}",f"{v['historical_elapsed_seconds']:.3f}",fmt(v['usd_per_1000_accepted_core']),fmt(v['accepted_core_per_second'])] for l,v in m['efficiency'].items()])
    text+='\n## 9. 方法边界与交付文件\n\n- 本次是10,000条全覆盖，不是抽样外推，不给全量计数套抽样置信区间。误差主要来自裁判、标签定义和缺失上下文；精确到两位小数不表示人工真值也精确到该程度。\n- 标题仅补足指代，没有读取父评论、视频或网页；多语种、梗、反讽、混合情感及意图主次更容易发生裁判分歧。\n- 复标同模型只检验稳定性，不能排除两次一致地判断错误。原始分类契约未细化所有边界，本次统一规则补充可能影响结果。\n- confidence 是模型自报，不当正确率；引文语义支撑未做独立逐项裁定。多标签仅使用一个参考集合，其歧义未像单选一样枚举全部可接受集合。\n- CLI显式请求 gpt-6-astra；JSON事件不提供服务端实际模型修订证明，不能声称已验证具体后端快照。未获得本次裁判账单，费用记未知，不能写成免费。\n- 历史速度/费用保持原口径，本报告不重跑选手，也不修改原始结果；不能把一次语料优势推广为通用模型能力结论。\n- 首批校验器曾把CLI技能提示误当工具调用，保留三次输出并采用最早合格响应；随后修正校验规则。网络中断的未完成调用没有进入参考集，重连后断点续跑。全部失败日志保留。\n\n'+table(['文件','用途'],[['rubric.md','事前判定规则与评分口径'],['manifest.json','原始数据与规则SHA256、批次配置'],['metrics.json','完整指标、分类混淆矩阵、按类别P/R/F1'],['reference.jsonl','10,000条盲标参考'],['scored.jsonl','10,000条原文、双方输出与逐字段评分'],['逐条核查.csv','Excel可读完整明细；公式前缀保护，原文以JSONL为准'],['primary/*、repeat/*','完整输入、提示词、原始输出、使用量与失败记录'],['../../scripts/accuracy_audit.py','可断点续跑的独立参考标注器'],['../../scripts/accuracy_score.py','离线复算报告，不调用模型']])
    inf=m['inference'];usage=inf['usage_reported']
    text+='\n裁判运行统计（这是本次核查的资源记录，与原来两侧打标费用分开）：\n\n'
    text+=table(['项目','结果'],[['请求模型',inf['requested_model']],['最终接纳的参考条目',f"{inf['successful_reference_rows']:,}（10,000主标注 + 400复标）"],['曾中断或被校验器拒收的调用记录',inf['initially_failed_or_rejected_attempt_records']],['CLI上报输入token合计',f"{usage.get('input_tokens',0):,}"],['CLI上报输出token合计',f"{usage.get('output_tokens',0):,}"],['本次裁判美元账单','未知；没有供应商账单，不等于免费']])
    text+='\n## 10. 对外引用建议\n\n'
    text+=f"我们对同一批10,000条评论做了全量独立AI复核：裁判不看两个模型的答案，先根据原文和原有标题独立标注，再逐条比对。按允许合理歧义答案的统一口径，相关性、情感、意图三项全对率分别为 Jev {pct(j['accepted_accuracy_all'])}、DeepSeek {pct(d['accepted_accuracy_all'])}。这属于AI参考下的准确率，不是人工金标准准确率；另有400条独立复标检验裁判稳定性，完整规则和逐条结果均可核查。\n"
    (OUT/'report.md').write_text(text)
    # Render generated markdown safely; untrusted comments are always escaped.
    chunks=[];in_table=False
    for line in text.splitlines():
        if line.startswith('|'):
            if not in_table:chunks.append('<div class="scroll"><table>');in_table=True
            cells=line.strip('|').split(' | ')
            if all(c.strip()=='---' for c in cells):continue
            chunks.append('<tr>'+''.join('<td>'+html.escape(c.strip())+'</td>' for c in cells)+'</tr>');continue
        if in_table:chunks.append('</table></div>');in_table=False
        if not line:continue
        if line.startswith('# '):chunks.append('<h1>'+html.escape(line[2:])+'</h1>')
        elif line.startswith('## '):chunks.append('<h2>'+html.escape(line[3:])+'</h2>')
        elif line.startswith('### '):chunks.append('<h3>'+html.escape(line[4:])+'</h3>')
        else:chunks.append('<p>'+html.escape(line)+'</p>')
    if in_table:chunks.append('</table></div>')
    (OUT/'report.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>一万条评论准确率复核</title><style>body{font:16px/1.8 system-ui,sans-serif;color:#15283b;background:#f4f7fb;max-width:1140px;margin:40px auto;padding:0 24px}h1{font-size:36px}h2{margin-top:48px;border-top:1px solid #c9d4df;padding-top:24px}table{border-collapse:collapse;width:100%;background:white;font-size:14px}td{border:1px solid #dbe3ec;padding:10px 14px}tr:first-child{font-weight:700;background:#e5eef8}.scroll{overflow:auto}p{overflow-wrap:anywhere}a{color:#1163ad}</style><body><p><a href="逐条核查.csv">下载10,000条核查明细</a> · <a href="metrics.json">机器可读指标</a> · <a href="report.md">Markdown报告</a></p>'+''.join(chunks)+'</body></html>')
if __name__=='__main__':main()
