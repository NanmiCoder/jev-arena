import type { ReportCoverage } from "../../../../contracts/index.ts";

import {
  formatInteger,
  formatPercent,
} from "../../../lib/format";

interface KpiStripProps {
  coverage: ReportCoverage;
}

export function KpiStrip({ coverage }: KpiStripProps) {
  const metrics = [
    {
      label: "快照评论",
      value: formatInteger(coverage.comments_in_snapshot),
      detail: `${formatInteger(coverage.topics)} 个作品`,
    },
    {
      label: "已分析评论",
      value: formatInteger(coverage.labeled_comments),
      detail: `占 ${formatInteger(coverage.comments_in_snapshot)} 条快照的 ${formatPercent(coverage.labeled_pct)}`,
    },
    {
      label: "相关评论",
      value: formatInteger(coverage.relevant_comments),
      detail: `占 ${formatInteger(coverage.labeled_comments)} 条已分析的 ${formatPercent(coverage.relevant_pct)}`,
    },
    {
      label: "覆盖作品",
      value: formatInteger(coverage.topics),
      detail: "仅代表本次实际采集的样本",
    },
  ];

  return (
    <section className="kpi-strip" id="overview" aria-label="数据概览">
      {metrics.map((metric) => (
        <div className="kpi" key={metric.label}>
          <span className="kpi__label">{metric.label}</span>
          <strong className="kpi__value">
            {metric.value}
          </strong>
          <small className="kpi__detail">{metric.detail}</small>
        </div>
      ))}
    </section>
  );
}
