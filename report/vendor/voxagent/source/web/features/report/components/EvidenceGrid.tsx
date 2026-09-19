import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ReportEvidence } from "../../../../contracts/index.ts";
import { formatInteger } from "../../../lib/format";
import { safeExternalUrl } from "../../../lib/safe-url";
import { emptyFilters, evidenceSourceKey, matchesEvidence, type EvidenceFilters } from "../evidence-filter";

interface EvidenceGridProps {
  evidence: ReportEvidence[];
  relevantCount?: number;
  interactive?: boolean;
  aspectLabels?: Record<string, string>;
}

const PAGE_SIZE = 8;

export function EvidenceGrid({ evidence, relevantCount, interactive = false, aspectLabels = {} }: EvidenceGridProps) {
  const section = useRef<HTMLElement>(null);
  const [filters, setFilters] = useState(emptyFilters);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [sort, setSort] = useState("report");
  const [filtersOpen, setFiltersOpen] = useState(() => typeof window === "undefined" || !window.matchMedia("(max-width: 700px)").matches);
  const matching = evidence.filter((item) => matchesEvidence(item, filters));
  const ordered = sort === "likes" ? [...matching].sort((a, b) => b.like_count - a.like_count) : matching;
  const shown = new Set((interactive ? ordered.slice(0, limit) : evidence).map((item) => item.evidence_id));
  const items = interactive ? [...ordered, ...evidence.filter((item) => !matching.includes(item))] : evidence;
  const sources = new Map(evidence.map((item) => [evidenceSourceKey(item), item.topic_title]));
  const intents = new Map(evidence.map((item) => [item.intent, item.intent_label]));
  const targets = new Map(evidence.map((item) => [item.opinion_target, item.opinion_target_label]));
  const aspects = [...new Set(evidence.flatMap((item) => item.aspects ?? []))];
  const activeFilters = Object.values(filters).some(Boolean);
  const change = (key: keyof EvidenceFilters, value: string) => { setFilters((current) => ({ ...current, [key]: value })); setLimit(PAGE_SIZE); };
  const reset = () => { setFilters(emptyFilters); setLimit(PAGE_SIZE); };

  useEffect(() => {
    if (!interactive || !section.current) return;
    const doc = section.current.ownerDocument;
    // A reference must remain reachable even after filtering or pagination.
    // Capture runs before the workbench's same-document anchor handler.
    const reveal = (event: MouseEvent) => {
      const href = (event.target as Element | null)?.closest?.("a[href^='#evidence-']")?.getAttribute("href");
      if (!href || !evidence.some((item) => href === `#evidence-${item.evidence_id}`)) return;
      const destination = doc.getElementById(href.slice(1));
      if (destination?.hidden) flushSync(() => { setFilters(emptyFilters); setLimit(evidence.length); });
    };
    doc.addEventListener("click", reveal, true);
    return () => doc.removeEventListener("click", reveal, true);
  }, [evidence, interactive]);

  return (
    <section className="evidence-section" id="evidence" ref={section}>
      <header className="section-heading section-heading--split">
        <div><p className="eyebrow">Read the comments</p><h2>原文样本库</h2></div>
        <p className="display-count">{formatInteger(evidence.length)} 条原文样本{relevantCount !== undefined ? ` / ${formatInteger(relevantCount)} 条相关评论` : ""}</p>
      </header>
      <p className="evidence-scope">这是报告选取的原文样本，不是全部评论。{interactive ? "筛选只作用于下方样本，结果条数不能推算总体占比。" : "完整保留所选原文；搜索、组合筛选可在工作台中使用。"}</p>
      {interactive && evidence.length > 0 && <div className="evidence-explorer">
        <div className="evidence-search-row">
          <label className="evidence-search"><span>搜索原文</span><input type="search" placeholder="搜索观点、词语、作品或证据编号" value={filters.search} onChange={(event) => change("search", event.target.value)} /></label>
          <label><span>排序</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="report">报告顺序</option><option value="likes">点赞从高到低</option></select></label>
        </div>
        <details className="evidence-filter-options" open={filtersOpen} onToggle={(event) => setFiltersOpen(event.currentTarget.open)}><summary>筛选条件<span>情绪、意图、作品、方面</span></summary><div className="evidence-filters">
          <label><span>情绪</span><select value={filters.sentiment} onChange={(event) => change("sentiment", event.target.value)}><option value="">全部情绪</option><option value="positive">正面</option><option value="negative">负面</option><option value="neutral">中性</option><option value="mixed">复杂 / 混合</option></select></label>
          <label><span>评论意图</span><select value={filters.intent} onChange={(event) => change("intent", event.target.value)}><option value="">全部意图</option>{[...intents].map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
          <label><span>来源作品</span><select value={filters.source} onChange={(event) => change("source", event.target.value)}><option value="">全部 {sources.size} 个来源作品</option>{[...sources].map(([key, title]) => <option value={key} key={key}>{title}</option>)}</select></label>
          {aspects.length > 0 && <label><span>讨论方面</span><select value={filters.aspect} onChange={(event) => change("aspect", event.target.value)}><option value="">全部方面</option>{aspects.map((aspect) => <option key={aspect} value={aspect}>{aspectLabels[aspect] ?? aspect}</option>)}</select></label>}
        </div>
        <details className="evidence-extra-filters"><summary>更多筛选 · 评价对象与立场{filters.target || filters.stance ? "（已应用）" : ""}</summary><div className="evidence-filters"><label><span>评价对象</span><select value={filters.target} onChange={(event) => change("target", event.target.value)}><option value="">全部评价对象</option>{[...targets].map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label><span>立场</span><select value={filters.stance} onChange={(event) => change("stance", event.target.value)}><option value="">全部立场</option><option value="support">支持</option><option value="oppose">反对</option><option value="neutral">中立</option></select></label></div></details>
        </details>
        <div className="evidence-filter-status"><p role="status" aria-live="polite">样本中匹配 <strong>{matching.length}</strong> / {evidence.length} 条 · 当前展示 {Math.min(limit, matching.length)} 条</p>{activeFilters && <button type="button" onClick={reset}>清除筛选</button>}</div>
      </div>}
      {evidence.length === 0 ? <div className="empty-state"><strong>当前报告没有原文样本</strong><p>请只把报告中的确定性统计作为当前快照描述。</p></div> : <>
        {interactive && matching.length === 0 && <div className="empty-state"><strong>所选样本中没有匹配的评论</strong><p>这不代表完整样本不存在此类观点。试试减少筛选条件。</p><button type="button" onClick={reset}>查看全部原文样本</button></div>}
        <div className="evidence-grid">
          {items.map((item) => {
            const sourceUrl = safeExternalUrl(item.source_url);
            const searchTerm = filters.search.trim().toLocaleLowerCase();
            const matchesFullText = Boolean(searchTerm && !item.quote.toLocaleLowerCase().includes(searchTerm) && item.full_text?.toLocaleLowerCase().includes(searchTerm));
            return <article className={`evidence-card evidence-card--${item.sentiment}`} id={`evidence-${item.evidence_id}`} key={item.evidence_id} hidden={!shown.has(item.evidence_id)}>
              <div className="evidence-card__meta"><a className="evidence-card__id" href={`#evidence-${item.evidence_id}`}>{item.evidence_id}</a><span className={`chip-tone chip-tone--${item.sentiment}`}>{item.sentiment_label}</span><span>{item.intent_label}</span><span className="evidence-likes">赞 {formatInteger(item.like_count)}</span></div>
              <blockquote>“{item.quote}”</blockquote>
              {item.full_text && item.full_text !== item.quote ? <details className="evidence-full-text" open={matchesFullText || undefined}><summary>{matchesFullText ? "搜索匹配完整评论" : "查看完整评论"}（{item.full_text.length} 字符）</summary><p>{item.full_text}</p></details> : !item.full_text ? <small className="table-note">仅有摘录，完整上下文请查看原作品。</small> : null}
              <div className="evidence-classification"><span>立场 · {item.stance_label}</span><span>评价 · {item.opinion_target_label}</span>{item.aspects?.length ? <span>方面 · {item.aspects.map((aspect) => aspectLabels[aspect] ?? aspect).join("、")}</span> : null}{item.requires_context && <span className="evidence-review-note">需结合上下文核查</span>}<span className="evidence-review-note">{item.reviewed === true ? "此条标签经模型复核" : item.reviewed === false ? "此条标签未经模型复核" : "此条标签复核未记录"}</span></div>
              <footer><div><details className="evidence-source"><summary><span className="evidence-card__source-label">来源作品 · </span>{item.topic_title}</summary><p>{item.topic_title}</p></details>{item.source_label ? <small>{item.source_label}</small> : null}</div>{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer">查看原作品 ↗</a> : <span className="source-unavailable">来源链接不可用</span>}</footer>
            </article>;
          })}
        </div>
        {interactive && matching.length > limit && <div className="evidence-more"><button type="button" onClick={() => setLimit((count) => count + PAGE_SIZE)}>继续阅读 {Math.min(PAGE_SIZE, matching.length - limit)} 条原文</button><span>还有 {matching.length - limit} 条匹配样本</span></div>}
      </>}
    </section>
  );
}
