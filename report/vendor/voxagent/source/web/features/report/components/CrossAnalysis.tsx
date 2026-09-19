import { useState } from "react";
import type { ReportAnalysis } from "../../../../contracts/index.ts";
import { formatInteger, formatPercent } from "../../../lib/format";

export function CrossAnalysis({ analysis, relevantCount, interactive = false }: { analysis: ReportAnalysis; relevantCount: number; interactive?: boolean }) {
  const [active, setActive] = useState(analysis.groups[0]?.id);
  if (!analysis.groups.some((group) => group.rows.length)) return null;
  return <section id="cross-analysis" className="cross-analysis">
    <header className="section-heading"><p className="eyebrow">Connect the dimensions</p><h2>讨论焦点与评论行为</h2><p className="table-note">将讨论内容与情绪、提问和建议交叉查看。总占比分母为 {formatInteger(relevantCount)} 条相关评论；每行的情绪数之和等于该行评论数。</p></header>
    {interactive && <div className="analysis-tabs" role="group" aria-label="交叉分析维度">{analysis.groups.map((group) => <button key={group.id} type="button" aria-pressed={active === group.id} onClick={() => setActive(group.id)}>{group.title}</button>)}</div>}
    {analysis.groups.map((group, index) => <details className="analysis-group" open={interactive ? active === group.id : index === 0} key={group.id} hidden={interactive && active !== group.id}>
      <summary>{group.title}<span>{group.rows.length} 个分组</span></summary>
      <p className="table-note">{group.note}</p>
      <div className="table-wrap" tabIndex={0} aria-label={`${group.title}交叉分析表，可横向滚动`}><table className="cross-table"><thead><tr><th scope="col">{group.title}</th><th scope="col">评论 / 总占比</th><th scope="col">情绪构成</th><th scope="col">提问 / 建议 / 纠错</th><th scope="col">跨作品</th><th scope="col">核查原文</th></tr></thead><tbody>{group.rows.map((row) => <tr key={row.key}>
        <th scope="row">{row.label}</th><td><strong>{formatInteger(row.count)}</strong><small>{formatPercent(row.pct_of_relevant)}</small></td>
        <td><div className="cross-sentiment" aria-label={`正面 ${row.positive}，负面 ${row.negative}，中性 ${row.neutral}，混合 ${row.mixed}`}><span className="cell-pos">正 {row.positive}</span><span className="cell-neg">负 {row.negative}</span><span>中 {row.neutral}</span><span>混 {row.mixed}</span></div><div className="cross-bar" aria-hidden="true">{(["positive", "negative", "neutral", "mixed"] as const).map((tone) => <span key={tone} className={`stacked-bar__seg--${tone}`} style={{ width: `${row.count ? row[tone] / row.count * 100 : 0}%` }} />)}</div></td>
        <td className="cross-followups">{row.questions > 0 && <span>提问 {row.questions}</span>}{row.suggestions > 0 && <span>建议 {row.suggestions}</span>}{row.corrections > 0 && <span>纠错 {row.corrections}</span>}{!row.questions && !row.suggestions && !row.corrections && <span>—</span>}</td>
        <td>{row.topic_count} 个</td><td><div className="cross-evidence">{row.evidence_ids.length ? row.evidence_ids.map((id) => <a key={id} href={`#evidence-${id}`} aria-label={`${row.label}的原文 ${id}`}>{id} ↗</a>) : <span className="table-note">暂无样例</span>}</div></td>
      </tr>)}</tbody></table></div>
    </details>)}
    <details className="sample-diagnostics"><summary>这份样本偏向哪里？</summary><dl><div><dt>最多评论的作品</dt><dd>{formatPercent(analysis.quality.top_topic_share_pct)}<small>占快照评论</small></dd></div><div><dt>前三个作品</dt><dd>{formatPercent(analysis.quality.top_three_topic_share_pct)}<small>占快照评论</small></dd></div><div><dt>低置信标签</dt><dd>{analysis.quality.low_confidence_count}<small>模型置信度低于 {analysis.quality.low_confidence_threshold}</small></dd></div><div><dt>未满足独立引用条件</dt><dd>{analysis.quality.keyword_context_only_count}<small>关键词未自包含，或评价对象并非研究目标</small></dd></div></dl><p className="table-note">作品集中度高时，应先检查少数作品是否主导讨论。模型置信度是自评分，不能当作准确率；未满足独立引用条件也不等于与研究问题无关。</p></details>
  </section>;
}
