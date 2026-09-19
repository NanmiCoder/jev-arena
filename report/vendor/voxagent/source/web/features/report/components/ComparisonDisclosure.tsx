import type { ComparisonRelation, ComparisonRow } from "../../../../contracts/index.ts";
import { formatInteger } from "../../../lib/format";
import { ComparisonTable } from "./ComparisonTable";

export function ComparisonDisclosure({ rows, relations = [] }: { rows: ComparisonRow[]; relations?: ComparisonRelation[] }) {
  if (rows.length === 0 && relations.length === 0) return null;
  const hasRelations = relations.length > 0;
  const displayedRelations = relations.reduce((total, row) => total + row.total, 0);
  return <div id={hasRelations ? "comparisons" : undefined} className="comparison-disclosure">
    {hasRelations && <p className="table-note comparison-boundary">该维度尚未形成经核验的强弱结论；主体或方向仍可能误标，报告正文复核不覆盖这些关系。当前展示 {formatInteger(displayedRelations)} 条原始关系标签，分为 {formatInteger(relations.length)} 组。</p>}
    <details className="report-detail">
      <summary><span>{hasRelations ? "自动比较标签（待核查）" : "比较标签"}</span><small>{hasRelations ? "展开核查模型标签及评论原文" : `${rows.length} 个对象，旧标签的主体与方向未定义`}</small></summary>
      <ComparisonTable rows={rows} relations={relations} />
    </details>
  </div>;
}
