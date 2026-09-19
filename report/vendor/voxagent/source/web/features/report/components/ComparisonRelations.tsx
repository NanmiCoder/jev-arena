import type { ComparisonRelation } from "../../../../contracts/index.ts";
import { formatInteger } from "../../../lib/format";

const aspectLabels: Record<string, string> = {
  capability: "能力与效果", quality: "质量", usability: "易用性", performance: "速度与性能", reliability: "稳定性",
  price: "价格与性价比", service: "服务与体验", content: "内容与选题", presentation: "表达与结构", production: "制作质量",
  trust: "可信度", comparison: "竞品比较", other: "其他",
};

export function ComparisonRelations({ rows }: { rows: ComparisonRelation[] }) {
  const sampleId = (rowIndex: number, sampleIndex: number) => `comparison-source-${rowIndex}-${sampleIndex}`;
  return <div className="comparison-relations">
    <h3>按主体、对象与方面查看关系</h3>
    <p className="table-note">方向为「主体相对比较对象」。数字是关系标签次数：同一评论、主体、对象、方面和方向只计一次；同一评论可有多条关系，因此合计不是评论人数、作者数或胜率。不同任务条件下可有不同方向，表格不代表统一性能排名。</p>
    <div className="table-wrap" tabIndex={0} aria-label="比较关系表，可横向滚动"><table><thead><tr>
      <th scope="col">比较主体</th><th scope="col">比较对象</th><th scope="col">方面</th>
      <th scope="col">主体强于对象</th><th scope="col">接近</th><th scope="col">主体弱于对象</th><th scope="col">关系合计</th><th scope="col">核查原文</th>
    </tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={`${row.subject}:${row.competitor}:${row.aspect}`}>
      <th scope="row">{row.subject}</th><td>{row.competitor}</td><td>{aspectLabels[row.aspect] ?? row.aspect}</td>
      <td>{formatInteger(row.stronger)}</td><td>{formatInteger(row.similar)}</td><td>{formatInteger(row.weaker)}</td><td>{formatInteger(row.total)}</td>
      <td><div className="cross-evidence">{row.evidence.length ? row.evidence.map((sample, sampleIndex) => <a key={`${sample.evidence_id}:${sample.verdict}`} href={`#${sampleId(rowIndex, sampleIndex)}`} onClick={(event) => event.currentTarget.ownerDocument.getElementById(sampleId(rowIndex, sampleIndex))?.setAttribute("open", "")}>{sample.evidence_id} ↗</a>) : <span>暂无片段</span>}</div></td>
    </tr>)}</tbody></table></div>
    <p className="table-note">这些关系由模型标注，未逐条独立复核。价格更高不等于表现更好；先核对片段中的方向、条件和具体版本。名称仅按字符宽度、大小写与空白归一，不合并语义别名。</p>
    <div className="comparison-sources">{rows.flatMap((row, rowIndex) => row.evidence.map((sample, sampleIndex) => <details className="comparison-source" id={sampleId(rowIndex, sampleIndex)} key={sampleId(rowIndex, sampleIndex)}>
      <summary>{sample.evidence_id} · {row.subject} 相对 {row.competitor} · {aspectLabels[row.aspect] ?? row.aspect} · {sample.verdict}</summary>
      <p className="table-note">比较片段 · 此关系标签未经独立模型复核</p>
      <blockquote>{sample.evidence_quote}</blockquote>
      <details><summary>{sample.full_text_truncated ? "查看已保存的评论文本（已截断）" : "查看完整评论"}</summary><p className="comparison-source__full">{sample.full_text}</p></details>
      {sample.source_url && <a href={sample.source_url} target="_blank" rel="noreferrer">查看原作品 ↗</a>}
    </details>))}</div>
  </div>;
}
