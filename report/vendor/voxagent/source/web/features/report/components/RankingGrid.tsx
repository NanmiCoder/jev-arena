import type { RankingGroup } from "../../../../contracts/index.ts";

import { formatInteger, formatPercent } from "../../../lib/format";

interface RankingGridProps {
  groups: RankingGroup[];
}

const emotionLabels: Record<string, string> = {
  curiosity: "好奇", amusement: "觉得有趣", approval: "认可", enthusiasm: "热情",
  frustration: "受挫", skepticism: "怀疑", disappointment: "失望", anger: "愤怒",
  confusion: "困惑", gratitude: "感谢", admiration: "赞赏", surprise: "惊讶",
  excitement: "兴奋", sarcasm: "讽刺", concern: "担忧",
};

export function RankingGrid({ groups }: RankingGridProps) {
  if (groups.length === 0) return null;
  return (
    <section className="ranking-section" id="signals">
      <header className="section-heading section-heading--split">
        <div>
          <p className="eyebrow">Conversation signals</p>
          <h2>讨论焦点与情绪信号</h2>
        </div>
        <p className="display-count">模型标签命中次数；同一评论可有多个标签</p>
      </header>
      <div className="ranking-grid">
        {groups.map((group) => {
          const labels = group.items.map((item) => group.id === "emotion"
            ? emotionLabels[item.key] ?? item.label : item.label);
          const repeatedLabels = new Set(labels.filter((label, index) => labels.indexOf(label) !== index));
          return (
            <article className="ranking-panel" key={group.id}>
              <header>
                <p className="eyebrow">{group.id}</p>
                <h3>{group.title}</h3>
                <small>{group.note}</small>
                {group.id === "emotion" && repeatedLabels.size > 0 && (
                  <p className="table-note">原始情绪标签含不同语言的同义写法，暂未归并；括号保留原标签，各行不能相加当作人数。</p>
                )}
              </header>
              <ol>
                {group.items.map((item, index) => (
                  <li key={item.key}>
                    <div className="ranking-panel__label">
                      <span>{labels[index]}{repeatedLabels.has(labels[index]!) && item.key !== labels[index] ? `（${item.key}）` : ""}</span>
                      <strong>{formatInteger(item.count)}</strong>
                    </div>
                    <div className="ranking-panel__track" aria-hidden="true">
                      <span style={{ width: `${Math.min(100, item.pct_of_relevant)}%` }} />
                    </div>
                    <small>命中次数 / 相关评论数：{formatPercent(item.pct_of_relevant)}{item.pct_of_relevant > 100 ? "（条形上限为 100%）" : ""}</small>
                  </li>
                ))}
              </ol>
            </article>
          );
        })}
      </div>
    </section>
  );
}
