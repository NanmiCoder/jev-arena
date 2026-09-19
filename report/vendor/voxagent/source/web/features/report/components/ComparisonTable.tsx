import type { ComparisonRelation, ComparisonRow } from "../../../../contracts/index.ts";
import { ComparisonRelations } from "./ComparisonRelations";

import { formatInteger } from "../../../lib/format";

interface ComparisonTableProps {
  rows: ComparisonRow[];
  relations?: ComparisonRelation[];
}

export function ComparisonTable({ rows, relations = [] }: ComparisonTableProps) {
  if (rows.length === 0 && relations.length === 0) return null;
  return (
    <section className="comparison-section" id={relations.length ? undefined : "comparisons"}>
      <header className="section-heading section-heading--split">
        <div>
          <p className="eyebrow">Automatic comparison labels</p>
          <h2>{relations.length ? "原始比较关系标签" : "比较标签（待核查）"}</h2>
        </div>
        <p className="display-count">保留原始模型标签，未逐项确认比较关系</p>
      </header>
      {relations.length > 0 && <ComparisonRelations rows={relations} />}
      {rows.length > 0 && <>
      <p className="table-note">旧版比较标签：主体与方向未定义，不能据此得出谁强于谁的结论。</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">被比较对象</th>
              <th scope="col">「强于」标签</th>
              <th scope="col">「接近」标签</th>
              <th scope="col">「弱于」标签</th>
              <th scope="col">标签总数</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.competitor.toLocaleLowerCase()}>
                <th scope="row">{row.competitor}</th>
                <td>{formatInteger(row.stronger)}</td>
                <td>{formatInteger(row.similar)}</td>
                <td>{formatInteger(row.weaker)}</td>
                <td>{formatInteger(row.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="table-note">
        标签可能误判，不能据此认定评论明确比较了两个对象。需核对原文中的比较主语、对象及维度；推荐或提及不等于强弱判断。名称仅合并大小写差异。
      </p>
      </>}
    </section>
  );
}
