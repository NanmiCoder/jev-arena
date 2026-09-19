import type { DistributionGroup } from "../../../../contracts/index.ts";

import {
  formatInteger,
  formatPercent,
} from "../../../lib/format";

interface DistributionGridProps {
  groups: DistributionGroup[];
  relevantCount: number;
}

export function DistributionGrid({ groups, relevantCount }: DistributionGridProps) {
  return (
    <section className="distribution-grid" id="distributions">
      {groups.map((group) => {
        const singleTone = new Set(group.items.map((item) => item.tone)).size <= 1;
        return (
        <article className="distribution-panel" key={group.id}>
          <header>
            <p className="eyebrow">{group.id}</p>
            <h2>{group.title}</h2>
            <p className="table-note">模型分类 · 分母 {formatInteger(relevantCount)} 条相关评论</p>
          </header>
          {!singleTone && <div
            className="stacked-bar"
            role="img"
            aria-label={group.items
              .map(
                (item) =>
                  `${item.label} ${formatPercent(item.pct)}，${formatInteger(item.count)} 条`,
              )
              .join("；")}
          >
            {group.items.map((item) => (
              <span
                className={`stacked-bar__seg stacked-bar__seg--${item.tone}`}
                key={item.key}
                style={{ width: `${Math.max(0, Math.min(100, item.pct))}%` }}
              />
            ))}
          </div>}
          <ul className={`distribution-legend${singleTone ? " distribution-legend--bars" : ""}`}>
            {group.items.map((item) => (
              <li key={item.key}>
                {!singleTone && <span
                  className={`legend-dot legend-dot--${item.tone}`}
                  aria-hidden="true"
                />}
                <span className="legend-label">{item.label}</span>
                <strong>{formatInteger(item.count)} / {formatInteger(relevantCount)} 条</strong>
                <small>{formatPercent(item.pct)}</small>
                {singleTone && <span className="distribution-meter" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, item.pct))}%` }} /></span>}
              </li>
            ))}
          </ul>
        </article>
      );})}
    </section>
  );
}
