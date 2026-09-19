import type { ReportEvidence } from "../../../contracts/index.ts";

export const emptyFilters = { search: "", sentiment: "", intent: "", source: "", aspect: "", target: "", stance: "" };
export type EvidenceFilters = typeof emptyFilters;

export const evidenceSourceKey = (item: ReportEvidence) => item.topic_id ?? item.source_url ?? item.topic_title;

export function matchesEvidence(item: ReportEvidence, filters: EvidenceFilters) {
  const search = filters.search.trim().toLocaleLowerCase();
  return (!search || [item.quote, item.full_text, item.topic_title, item.evidence_id].filter(Boolean).join(" ").toLocaleLowerCase().includes(search))
    && (!filters.sentiment || item.sentiment === filters.sentiment)
    && (!filters.intent || item.intent === filters.intent)
    && (!filters.target || item.opinion_target === filters.target)
    && (!filters.stance || item.stance === filters.stance)
    && (!filters.source || evidenceSourceKey(item) === filters.source)
    && (!filters.aspect || item.aspects?.includes(filters.aspect));
}
