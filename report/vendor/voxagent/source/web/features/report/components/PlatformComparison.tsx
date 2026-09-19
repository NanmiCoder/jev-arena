import type { ReportPlatform } from "../../../../contracts/index.ts";

import { formatInteger, formatPercent } from "../../../lib/format";

interface PlatformComparisonProps {
  platforms: ReportPlatform[];
}

/**
 * 跨平台对比。单平台研究没有可比的对象，此时整节不渲染——数据仍在
 * report-view.json 里保留，供审计与复算。
 */
export function PlatformComparison({ platforms }: PlatformComparisonProps) {
  if (platforms.length < 2) return null;

  const maxRelevant = Math.max(...platforms.map((item) => item.relevant_comments), 1);

  return (
    <section className="platform-section" id="platforms">
      <header className="section-heading section-heading--split">
        <div>
          <p className="eyebrow">Cross-platform comparison</p>
          <h2>平台差异</h2>
        </div>
        <p className="display-count">
          共 <strong>{formatInteger(platforms.length)}</strong> 个平台
        </p>
      </header>

      <p className="truncation-note" role="note">
        各平台的样本量由该平台实际采集到的可见评论决定，彼此不可直接当作等权重
        对比；下表的百分比是各平台内部的占比。
      </p>

      <div
        className="table-wrap"
        tabIndex={0}
        aria-label="平台差异对比表，可横向滚动"
      >
        <table>
          <caption className="sr-only">
            各平台的内容数、评论数与情绪分布对比
          </caption>
          <thead>
            <tr>
              <th scope="col">平台</th>
              <th scope="col">内容</th>
              <th scope="col">快照评论</th>
              <th scope="col">相关</th>
              <th scope="col">正面</th>
              <th scope="col">负面</th>
              <th scope="col">平均情绪</th>
            </tr>
          </thead>
          <tbody>
            {platforms.map((item) => (
              <tr key={item.platform}>
                <th scope="row">{item.label}</th>
                <td>{formatInteger(item.topics)}</td>
                <td>{formatInteger(item.snapshot_comments)}</td>
                <td>
                  <span className="contro-cell">
                    <span className="contro-bar" aria-hidden="true">
                      <span
                        style={{
                          width: `${(item.relevant_comments / maxRelevant) * 100}%`,
                        }}
                      />
                    </span>
                    {formatInteger(item.relevant_comments)}
                  </span>
                </td>
                <td className="cell-pos">{formatPercent(item.positive_pct)}</td>
                <td className="cell-neg">{formatPercent(item.negative_pct)}</td>
                <td>{item.avg_sentiment_score.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
