import type { TimelinePoint } from "../../../../contracts/index.ts";

import { formatInteger } from "../../../lib/format";

interface TimelineTableProps {
  points: TimelinePoint[];
}

export function TimelineTable({ points }: TimelineTableProps) {
  if (points.length < 2) return null;
  return (
    <section className="timeline-section" id="timeline">
      <header className="section-heading section-heading--split">
        <div>
          <p className="eyebrow">Dated slices</p>
          <h2>评论日期切片</h2>
        </div>
        <p className="display-count">展示 {formatInteger(points.length)} 个日期切片</p>
      </header>
      <p className="timeline-boundary">
        日期来自当前快照中的评论时间；不能仅凭这些切片判断增长、下降或持续性。
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">日期</th>
              <th scope="col">已标注</th>
              <th scope="col">相关</th>
              <th scope="col">正面</th>
              <th scope="col">负面</th>
              <th scope="col">中性</th>
              <th scope="col">混合</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.date}>
                <th scope="row">{point.date}</th>
                <td>{formatInteger(point.labeled_comments)}</td>
                <td>{formatInteger(point.relevant_comments)}</td>
                <td>{formatInteger(point.positive)}</td>
                <td>{formatInteger(point.negative)}</td>
                <td>{formatInteger(point.neutral)}</td>
                <td>{formatInteger(point.mixed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
