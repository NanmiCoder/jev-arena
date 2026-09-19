import type {
  ReportTopic,
  ReportTopicDisplay,
} from "../../../../contracts/index.ts";

import {
  formatInteger,
  formatPercent,
} from "../../../lib/format";
import { safeExternalUrl } from "../../../lib/safe-url";

interface TopicTableProps {
  display: ReportTopicDisplay;
  topics: ReportTopic[];
}

export function TopicTable({ display, topics }: TopicTableProps) {
  return (
    <section className="topic-section" id="topics">
      <header className="section-heading section-heading--split">
        <div>
          <p className="eyebrow">Topic-level detail</p>
          <h2>作品级明细</h2>
        </div>
        <p className="display-count">
          展示 <strong>{formatInteger(display.displayed)}</strong>
          <span aria-hidden="true"> / </span>
          共 {formatInteger(display.total)}
        </p>
      </header>

      {display.truncated ? (
        <p className="truncation-note" role="note">
          当前报告只展示排序后的前 {formatInteger(display.displayed)} 个作品，共{" "}
          {formatInteger(display.total)} 个；完整统计仍保留在数据产物中。
        </p>
      ) : null}

      {topics.length === 0 ? (
        <div className="empty-state">
          <strong>当前没有可展示的作品明细</strong>
          <p>报告仍可查看总体分布、方法边界与证据。</p>
        </div>
      ) : (
        <div
          className="table-wrap"
          tabIndex={0}
          aria-label="作品级明细表，可横向滚动"
        >
          <table>
            <caption className="sr-only">
              作品级评论、相关性、情绪与正负情绪均衡明细
            </caption>
            <thead>
              <tr>
                <th scope="col">作品</th>
                <th scope="col">快照评论</th>
                <th scope="col">相关</th>
                <th scope="col">正面</th>
                <th scope="col">负面</th>
                <th scope="col">正负情绪均衡</th>
              </tr>
            </thead>
            <tbody>
              {topics.map((topic) => {
                const url = safeExternalUrl(topic.url);
                return (
                  <tr key={topic.topic_id}>
                    <th scope="row">
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {topic.title}
                        </a>
                      ) : (
                        topic.title
                      )}
                    </th>
                    <td>{formatInteger(topic.snapshot_comments)}</td>
                    <td>{formatInteger(topic.labeled_relevant)}</td>
                    <td className="cell-pos">{formatPercent(topic.positive_pct)}</td>
                    <td className="cell-neg">{formatPercent(topic.negative_pct)}</td>
                    <td>
                      <span className="contro-cell">
                        <span className="contro-bar" aria-hidden="true">
                          <span
                            style={{
                              width: `${Math.max(0, Math.min(100, topic.controversy_score))}%`,
                            }}
                          />
                        </span>
                        {topic.controversy_score.toFixed(1)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="table-note">正面、负面的分母为各作品的相关评论。正负情绪均衡 = 200 × min(正面数, 负面数) / (正面数 + 负面数)，无正负评论时为 0；不含中性评论，不表示争议人数占比或争议强度。</p>
    </section>
  );
}
