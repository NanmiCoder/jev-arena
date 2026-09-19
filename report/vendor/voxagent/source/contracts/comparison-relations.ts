import { z } from "zod";

export const comparisonAspectSchema = z.enum([
  "capability", "quality", "usability", "performance", "reliability", "price", "service",
  "content", "presentation", "production", "trust", "comparison", "other",
]);
const verdict = z.enum(["强于", "接近", "弱于"]);
const integer = z.number().int().nonnegative();
const sourceUrl = z.url().refine((value) => /^https?:\/\//u.test(value));

export const comparisonRelationEvidenceSchema = z.object({
  evidence_id: z.string().regex(/^C\d+$/u), verdict,
  evidence_quote: z.string().min(1).max(1000),
  full_text: z.string().min(1).max(20000),
  full_text_truncated: z.boolean().optional(), source_url: sourceUrl.nullable(),
}).strict().refine((value) => value.full_text_truncated || value.full_text.includes(value.evidence_quote), {
  message: "Comparison evidence must be an exact comment span unless its displayed text is explicitly truncated",
});

export function comparisonRelationKey(row: { subject: string; competitor: string; aspect: string }): string {
  const normalize = (value: string) => value.normalize("NFKC")
    .replace(/[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/gu, " ").replace(/^ +| +$/gu, "").toLowerCase();
  return JSON.stringify([normalize(row.subject), normalize(row.competitor), row.aspect]);
}

export const comparisonRelationSchema = z.object({
  subject: z.string().trim().min(1).max(128), competitor: z.string().trim().min(1).max(128), aspect: comparisonAspectSchema,
  stronger: integer, similar: integer, weaker: integer, total: z.number().int().positive(),
  evidence: z.array(comparisonRelationEvidenceSchema).max(3),
}).strict().superRefine((row, context) => {
  if (row.total !== row.stronger + row.similar + row.weaker) context.addIssue({ code: "custom", message: "Relation total must equal direction counts", path: ["total"] });
  const seen = new Set<string>();
  const counts = { "强于": row.stronger, "接近": row.similar, "弱于": row.weaker };
  row.evidence.forEach((sample, index) => {
    const key = `${sample.evidence_id}:${sample.verdict}`;
    if (seen.has(key) || counts[sample.verdict] <= 0) context.addIssue({ code: "custom", message: "Relation samples must be unique and bound to an observed direction", path: ["evidence", index] });
    seen.add(key); counts[sample.verdict]--;
  });
});

export type ComparisonRelation = z.infer<typeof comparisonRelationSchema>;
