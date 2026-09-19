// source/renderer/cli.ts
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// source/contracts/report-view.ts
import { z as z2 } from "zod";

// source/contracts/comparison-relations.ts
import { z } from "zod";
var comparisonAspectSchema = z.enum([
  "capability",
  "quality",
  "usability",
  "performance",
  "reliability",
  "price",
  "service",
  "content",
  "presentation",
  "production",
  "trust",
  "comparison",
  "other"
]);
var verdict = z.enum(["\u5F3A\u4E8E", "\u63A5\u8FD1", "\u5F31\u4E8E"]);
var integer = z.number().int().nonnegative();
var sourceUrl = z.url().refine((value) => /^https?:\/\//u.test(value));
var comparisonRelationEvidenceSchema = z.object({
  evidence_id: z.string().regex(/^C\d+$/u),
  verdict,
  evidence_quote: z.string().min(1).max(1e3),
  full_text: z.string().min(1).max(2e4),
  full_text_truncated: z.boolean().optional(),
  source_url: sourceUrl.nullable()
}).strict().refine((value) => value.full_text_truncated || value.full_text.includes(value.evidence_quote), {
  message: "Comparison evidence must be an exact comment span unless its displayed text is explicitly truncated"
});
function comparisonRelationKey(row) {
  const normalize = (value) => value.normalize("NFKC").replace(/[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/gu, " ").replace(/^ +| +$/gu, "").toLowerCase();
  return JSON.stringify([normalize(row.subject), normalize(row.competitor), row.aspect]);
}
var comparisonRelationSchema = z.object({
  subject: z.string().trim().min(1).max(128),
  competitor: z.string().trim().min(1).max(128),
  aspect: comparisonAspectSchema,
  stronger: integer,
  similar: integer,
  weaker: integer,
  total: z.number().int().positive(),
  evidence: z.array(comparisonRelationEvidenceSchema).max(3)
}).strict().superRefine((row, context) => {
  if (row.total !== row.stronger + row.similar + row.weaker) context.addIssue({ code: "custom", message: "Relation total must equal direction counts", path: ["total"] });
  const seen = /* @__PURE__ */ new Set();
  const counts = { "\u5F3A\u4E8E": row.stronger, "\u63A5\u8FD1": row.similar, "\u5F31\u4E8E": row.weaker };
  row.evidence.forEach((sample, index) => {
    const key = `${sample.evidence_id}:${sample.verdict}`;
    if (seen.has(key) || counts[sample.verdict] <= 0) context.addIssue({ code: "custom", message: "Relation samples must be unique and bound to an observed direction", path: ["evidence", index] });
    seen.add(key);
    counts[sample.verdict]--;
  });
});

// source/contracts/report-view.ts
var boundedText = (minimum, maximum) => z2.string().trim().min(minimum).max(maximum);
var nonNegativeInteger = z2.number().int().nonnegative();
var percentage = z2.number().finite().min(0).max(100);
var httpUrl = z2.url().refine((value) => value.startsWith("https://") || value.startsWith("http://"), {
  message: "Only http and https source URLs are allowed"
});
var reportModeSchema = z2.enum(["keyword", "post", "creator"]);
var distributionToneSchema = z2.enum([
  "positive",
  "negative",
  "neutral",
  "mixed",
  "primary"
]);
var reportIdentitySchema = z2.object({
  subject: boundedText(1, 240),
  research_question: z2.string().max(1e3).optional(),
  title: boundedText(1, 320),
  mode: reportModeSchema,
  generated_at: z2.iso.datetime({ offset: true }),
  dataset_public_id: z2.uuid(),
  run_id: z2.number().int().positive(),
  fingerprint: z2.string().regex(/^[a-f0-9]{64}$/u),
  sealed: z2.boolean()
}).strict();
var reportStatusSchema = z2.object({
  review_status: boundedText(1, 96),
  degraded: z2.boolean(),
  partial: z2.boolean(),
  statistics_only: z2.boolean().optional(),
  review_source: z2.literal("codex-agent").optional()
}).strict().refine((value) => !value.statistics_only || value.degraded && value.review_status === "unavailable", {
  message: "statistics-only reports must disclose unavailable semantic review"
}).refine((value) => value.review_status === "external_reviewed" ? value.review_source === "codex-agent" && !value.degraded : value.review_source === void 0, {
  message: "external review requires an explicit Codex Agent source and a non-degraded status"
});
var reportQualitySchema = z2.object({
  status: z2.enum(["sufficient", "limited", "insufficient"]),
  title: boundedText(1, 160),
  summary: boundedText(1, 1200),
  reasons: z2.array(boundedText(1, 800)).min(1).max(8)
}).strict();
var reportCoverageSchema = z2.object({
  topics: nonNegativeInteger,
  comments_in_snapshot: nonNegativeInteger,
  labeled_comments: nonNegativeInteger,
  relevant_comments: nonNegativeInteger,
  labeled_pct: percentage,
  relevant_pct: percentage,
  avg_sentiment_score: z2.number().finite().min(-1).max(1)
}).strict();
var distributionItemSchema = z2.object({
  key: boundedText(1, 64),
  label: boundedText(1, 64),
  count: nonNegativeInteger,
  pct: percentage,
  tone: distributionToneSchema
}).strict();
var distributionGroupSchema = z2.object({
  id: z2.enum(["sentiment", "stance", "intent", "opinion_target"]),
  title: boundedText(1, 80),
  items: z2.array(distributionItemSchema).min(1).max(12)
}).strict();
var rankingItemSchema = z2.object({
  key: boundedText(1, 128),
  label: boundedText(1, 128),
  count: nonNegativeInteger,
  pct_of_relevant: z2.number().finite().nonnegative()
}).strict();
var rankingGroupSchema = z2.object({
  id: z2.enum(["aspects", "emotion", "competitors"]),
  title: boundedText(1, 120),
  note: boundedText(1, 400),
  items: z2.array(rankingItemSchema).min(1).max(12)
}).strict();
var comparisonRowSchema = z2.object({
  competitor: boundedText(1, 160),
  stronger: nonNegativeInteger,
  similar: nonNegativeInteger,
  weaker: nonNegativeInteger,
  total: z2.number().int().positive()
}).strict().refine(
  (value) => value.total === value.stronger + value.similar + value.weaker,
  { message: "Comparison total must equal verdict counts" }
);
var timelinePointSchema = z2.object({
  date: z2.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  labeled_comments: nonNegativeInteger,
  relevant_comments: nonNegativeInteger,
  positive: nonNegativeInteger,
  negative: nonNegativeInteger,
  neutral: nonNegativeInteger,
  mixed: nonNegativeInteger
}).strict();
var reportNoticeSchema = z2.object({
  kind: z2.enum(["boundary", "warning", "partial", "review"]),
  title: boundedText(1, 120),
  text: boundedText(1, 1200)
}).strict();
var inlineSpanSchema = z2.discriminatedUnion("type", [
  z2.object({
    type: z2.literal("text"),
    value: boundedText(1, 1600)
  }).strict(),
  z2.object({
    type: z2.literal("strong"),
    value: boundedText(1, 400)
  }).strict(),
  z2.object({
    type: z2.literal("code"),
    value: boundedText(1, 400)
  }).strict(),
  z2.object({
    type: z2.literal("evidence-ref"),
    evidence_id: z2.string().regex(/^C[1-9]\d*$/u)
  }).strict()
]);
var reportBlockSchema = z2.discriminatedUnion("type", [
  z2.object({
    type: z2.literal("paragraph"),
    spans: z2.array(inlineSpanSchema).min(1).max(40)
  }).strict(),
  z2.object({
    type: z2.literal("fact-list"),
    items: z2.array(
      z2.object({
        fact_id: z2.string().regex(/^NF\d{4}$/u),
        text: boundedText(1, 1200)
      }).strict()
    ).min(1).max(24)
  }).strict(),
  z2.object({
    type: z2.literal("evidence-quote"),
    evidence_id: z2.string().regex(/^C[1-9]\d*$/u)
  }).strict(),
  z2.object({
    type: z2.literal("action-list"),
    items: z2.array(boundedText(1, 1e3)).min(1).max(12)
  }).strict()
]);
var reportSectionSchema = z2.object({
  id: z2.enum([
    "executive-summary",
    "method",
    "core-findings",
    "subject-insights",
    "risks",
    "actions"
  ]),
  title: boundedText(1, 120),
  blocks: z2.array(reportBlockSchema).min(1).max(30)
}).strict();
var reportTopicSchema = z2.object({
  topic_id: boundedText(1, 160),
  title: boundedText(1, 400),
  url: httpUrl.nullable(),
  snapshot_comments: nonNegativeInteger,
  labeled_relevant: nonNegativeInteger,
  positive_pct: percentage,
  negative_pct: percentage,
  controversy_score: percentage
}).strict();
var reportTopicDisplaySchema = z2.object({
  displayed: nonNegativeInteger,
  total: nonNegativeInteger,
  truncated: z2.boolean()
}).strict().refine((value) => value.displayed <= value.total, {
  message: "Displayed topic count cannot exceed the total"
});
var reportPlatformSchema = z2.object({
  platform: z2.enum(["bili", "xhs", "dy", "reddit"]),
  label: boundedText(1, 32),
  topics: nonNegativeInteger,
  snapshot_comments: nonNegativeInteger,
  labeled_comments: nonNegativeInteger,
  relevant_comments: nonNegativeInteger,
  positive_pct: percentage,
  negative_pct: percentage,
  neutral_pct: percentage,
  avg_sentiment_score: z2.number().finite().min(-1).max(1)
}).strict();
var reportEvidenceSchema = z2.object({
  evidence_id: z2.string().regex(/^C[1-9]\d*$/u),
  sentiment: z2.enum(["positive", "negative", "neutral", "mixed"]),
  sentiment_label: boundedText(1, 64),
  stance: z2.enum(["support", "oppose", "neutral"]),
  stance_label: boundedText(1, 64),
  intent: z2.enum([
    "praise",
    "complaint",
    "question",
    "suggestion",
    "correction",
    "agreement",
    "disagreement",
    "joke",
    "information",
    "other"
  ]),
  intent_label: boundedText(1, 64),
  opinion_target: z2.enum([
    "target",
    "post",
    "creator",
    "content",
    "mentioned_entity",
    "other"
  ]),
  opinion_target_label: boundedText(1, 96),
  like_count: nonNegativeInteger,
  quote: boundedText(1, 4e3),
  full_text: boundedText(1, 2e4).optional(),
  source_url: httpUrl.nullable(),
  topic_title: boundedText(1, 400),
  source_label: boundedText(1, 400).nullable(),
  topic_id: boundedText(1, 160).optional(),
  aspects: z2.array(boundedText(1, 128)).max(32).optional(),
  confidence: z2.number().finite().min(0).max(1).optional(),
  reviewed: z2.boolean().optional(),
  requires_context: z2.boolean().optional()
}).strict();
var analysisRowSchema = z2.object({
  key: boundedText(1, 128),
  label: boundedText(1, 128),
  count: nonNegativeInteger,
  pct_of_relevant: percentage,
  topic_count: nonNegativeInteger,
  positive: nonNegativeInteger,
  negative: nonNegativeInteger,
  neutral: nonNegativeInteger,
  mixed: nonNegativeInteger,
  questions: nonNegativeInteger,
  suggestions: nonNegativeInteger,
  corrections: nonNegativeInteger,
  evidence_ids: z2.array(z2.string().regex(/^C[1-9]\d*$/u)).max(3)
}).strict().refine((row) => row.count === row.positive + row.negative + row.neutral + row.mixed, {
  message: "Cross-analysis sentiment counts must equal the group count"
});
var reportAnalysisSchema = z2.object({
  groups: z2.array(z2.object({
    id: z2.enum(["aspect", "opinion_target", "intent"]),
    title: boundedText(1, 120),
    note: boundedText(1, 800),
    rows: z2.array(analysisRowSchema).max(16)
  }).strict()).max(3),
  quality: z2.object({
    top_topic_share_pct: percentage,
    top_three_topic_share_pct: percentage,
    low_confidence_count: nonNegativeInteger,
    low_confidence_threshold: z2.number().finite().min(0).max(1),
    keyword_context_only_count: nonNegativeInteger,
    evidence_pool_count: nonNegativeInteger
  }).strict()
}).strict();
var reportViewSchema = z2.object({
  schema_version: z2.literal("vox-report-view-v1"),
  statistical_narrative: z2.literal("host-facts-v1").optional(),
  identity: reportIdentitySchema,
  status: reportStatusSchema,
  quality: reportQualitySchema,
  coverage: reportCoverageSchema,
  distributions: z2.array(distributionGroupSchema).min(2).max(4),
  rankings: z2.array(rankingGroupSchema).max(3),
  comparisons: z2.array(comparisonRowSchema).max(16),
  comparison_relations: z2.array(comparisonRelationSchema).max(16).optional(),
  timeline: z2.array(timelinePointSchema).max(45),
  notices: z2.array(reportNoticeSchema).max(16),
  sections: z2.array(reportSectionSchema).min(1).max(6),
  topic_display: reportTopicDisplaySchema,
  topics: z2.array(reportTopicSchema).max(100),
  platforms: z2.array(reportPlatformSchema).max(8),
  evidence: z2.array(reportEvidenceSchema).max(128),
  analysis: reportAnalysisSchema.optional(),
  footer_note: boundedText(1, 500)
}).strict().superRefine((report, context) => {
  const unique = (values, path2, label) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        message: `${label} must be unique`,
        path: path2
      });
    }
  };
  unique(
    report.distributions.map((group) => group.id),
    ["distributions"],
    "distribution IDs"
  );
  unique(
    report.rankings.map((group) => group.id),
    ["rankings"],
    "ranking IDs"
  );
  unique(
    report.comparisons.map((item) => item.competitor.toLocaleLowerCase()),
    ["comparisons"],
    "comparison competitors"
  );
  unique((report.comparison_relations ?? []).map(comparisonRelationKey), ["comparison_relations"], "comparison relations");
  unique(
    report.timeline.map((item) => item.date),
    ["timeline"],
    "timeline dates"
  );
  unique(
    report.sections.map((section) => section.id),
    ["sections"],
    "section IDs"
  );
  unique(
    report.topics.map((topic) => topic.topic_id),
    ["topics"],
    "topic IDs"
  );
  unique(
    report.evidence.map((item) => item.evidence_id),
    ["evidence"],
    "evidence IDs"
  );
  unique(
    report.platforms.map((item) => item.platform),
    ["platforms"],
    "platform IDs"
  );
  const platformComments = report.platforms.reduce(
    (total, item) => total + item.snapshot_comments,
    0
  );
  if (platformComments > report.coverage.comments_in_snapshot) {
    context.addIssue({
      code: "custom",
      message: "Per-platform snapshot comments cannot exceed the dataset total",
      path: ["platforms"]
    });
  }
  const evidenceIds = new Set(
    report.evidence.map((item) => item.evidence_id)
  );
  if (report.analysis) {
    unique(report.analysis.groups.map((group) => group.id), ["analysis", "groups"], "analysis group IDs");
    if (report.analysis.quality.evidence_pool_count !== report.evidence.length) {
      context.addIssue({ code: "custom", path: ["analysis", "quality", "evidence_pool_count"], message: "Evidence pool count must equal the number of excerpts" });
    }
    report.analysis.groups.forEach((group, groupIndex) => {
      unique(group.rows.map((row) => row.key), ["analysis", "groups", groupIndex, "rows"], "analysis row keys");
      group.rows.forEach((row, rowIndex) => {
        if (row.count > report.coverage.relevant_comments || row.topic_count > report.coverage.topics || row.questions + row.suggestions + row.corrections > row.count) {
          context.addIssue({ code: "custom", path: ["analysis", "groups", groupIndex, "rows", rowIndex], message: "Cross-analysis counts exceed their denominator" });
        }
        row.evidence_ids.forEach((id) => {
          if (!evidenceIds.has(id)) context.addIssue({ code: "custom", path: ["analysis", "groups", groupIndex, "rows", rowIndex, "evidence_ids"], message: `Unknown evidence reference: ${id}` });
        });
      });
    });
  }
  if (report.topic_display.displayed !== report.topics.length) {
    context.addIssue({
      code: "custom",
      message: "Displayed topic count must equal the number of topic rows",
      path: ["topic_display", "displayed"]
    });
  }
  if (report.topic_display.truncated !== report.topic_display.total > report.topic_display.displayed) {
    context.addIssue({
      code: "custom",
      message: "Topic truncation flag must match displayed and total counts",
      path: ["topic_display", "truncated"]
    });
  }
  report.sections.forEach((section, sectionIndex) => {
    section.blocks.forEach((block, blockIndex) => {
      if (block.type === "evidence-quote" && !evidenceIds.has(block.evidence_id)) {
        context.addIssue({
          code: "custom",
          message: `Unknown evidence reference: ${block.evidence_id}`,
          path: ["sections", sectionIndex, "blocks", blockIndex, "evidence_id"]
        });
      }
      if (block.type === "paragraph") {
        block.spans.forEach((span, spanIndex) => {
          if (span.type === "evidence-ref" && !evidenceIds.has(span.evidence_id)) {
            context.addIssue({
              code: "custom",
              message: `Unknown evidence reference: ${span.evidence_id}`,
              path: [
                "sections",
                sectionIndex,
                "blocks",
                blockIndex,
                "spans",
                spanIndex,
                "evidence_id"
              ]
            });
          }
        });
      }
    });
  });
});
function parseReportView(input) {
  return reportViewSchema.parse(input);
}

// source/web/lib/format.ts
var modeLabels = {
  keyword: "\u5173\u952E\u8BCD",
  post: "\u5355\u4E2A\u4F5C\u54C1",
  creator: "\u535A\u4E3B"
};
function formatInteger(value) {
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.trunc(Math.abs(value)));
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ",")}`;
}
function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}
function formatGeneratedAt(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/u.exec(value);
  const offset = /([+-]\d{2}:\d{2}|Z)$/u.exec(value)?.[1];
  const zone = offset ? ` UTC${offset === "Z" || offset === "+00:00" ? "" : offset}` : "";
  return match ? `${match[1]} ${match[2]}${zone}` : value;
}
function formatMode(mode) {
  return modeLabels[mode];
}

// source/web/features/report/components/DistributionGrid.tsx
import { jsx, jsxs } from "react/jsx-runtime";
function DistributionGrid({ groups, relevantCount }) {
  return /* @__PURE__ */ jsx("section", { className: "distribution-grid", id: "distributions", children: groups.map((group) => {
    const singleTone = new Set(group.items.map((item) => item.tone)).size <= 1;
    return /* @__PURE__ */ jsxs("article", { className: "distribution-panel", children: [
      /* @__PURE__ */ jsxs("header", { children: [
        /* @__PURE__ */ jsx("p", { className: "eyebrow", children: group.id }),
        /* @__PURE__ */ jsx("h2", { children: group.title }),
        /* @__PURE__ */ jsxs("p", { className: "table-note", children: [
          "\u6A21\u578B\u5206\u7C7B \xB7 \u5206\u6BCD ",
          formatInteger(relevantCount),
          " \u6761\u76F8\u5173\u8BC4\u8BBA"
        ] })
      ] }),
      !singleTone && /* @__PURE__ */ jsx(
        "div",
        {
          className: "stacked-bar",
          role: "img",
          "aria-label": group.items.map(
            (item) => `${item.label} ${formatPercent(item.pct)}\uFF0C${formatInteger(item.count)} \u6761`
          ).join("\uFF1B"),
          children: group.items.map((item) => /* @__PURE__ */ jsx(
            "span",
            {
              className: `stacked-bar__seg stacked-bar__seg--${item.tone}`,
              style: { width: `${Math.max(0, Math.min(100, item.pct))}%` }
            },
            item.key
          ))
        }
      ),
      /* @__PURE__ */ jsx("ul", { className: `distribution-legend${singleTone ? " distribution-legend--bars" : ""}`, children: group.items.map((item) => /* @__PURE__ */ jsxs("li", { children: [
        !singleTone && /* @__PURE__ */ jsx(
          "span",
          {
            className: `legend-dot legend-dot--${item.tone}`,
            "aria-hidden": "true"
          }
        ),
        /* @__PURE__ */ jsx("span", { className: "legend-label", children: item.label }),
        /* @__PURE__ */ jsxs("strong", { children: [
          formatInteger(item.count),
          " / ",
          formatInteger(relevantCount),
          " \u6761"
        ] }),
        /* @__PURE__ */ jsx("small", { children: formatPercent(item.pct) }),
        singleTone && /* @__PURE__ */ jsx("span", { className: "distribution-meter", "aria-hidden": "true", children: /* @__PURE__ */ jsx("span", { style: { width: `${Math.max(0, Math.min(100, item.pct))}%` } }) })
      ] }, item.key)) })
    ] }, group.id);
  }) });
}

// source/web/features/report/components/ComparisonRelations.tsx
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var aspectLabels = {
  capability: "\u80FD\u529B\u4E0E\u6548\u679C",
  quality: "\u8D28\u91CF",
  usability: "\u6613\u7528\u6027",
  performance: "\u901F\u5EA6\u4E0E\u6027\u80FD",
  reliability: "\u7A33\u5B9A\u6027",
  price: "\u4EF7\u683C\u4E0E\u6027\u4EF7\u6BD4",
  service: "\u670D\u52A1\u4E0E\u4F53\u9A8C",
  content: "\u5185\u5BB9\u4E0E\u9009\u9898",
  presentation: "\u8868\u8FBE\u4E0E\u7ED3\u6784",
  production: "\u5236\u4F5C\u8D28\u91CF",
  trust: "\u53EF\u4FE1\u5EA6",
  comparison: "\u7ADE\u54C1\u6BD4\u8F83",
  other: "\u5176\u4ED6"
};
function ComparisonRelations({ rows }) {
  const sampleId = (rowIndex, sampleIndex) => `comparison-source-${rowIndex}-${sampleIndex}`;
  return /* @__PURE__ */ jsxs2("div", { className: "comparison-relations", children: [
    /* @__PURE__ */ jsx2("h3", { children: "\u6309\u4E3B\u4F53\u3001\u5BF9\u8C61\u4E0E\u65B9\u9762\u67E5\u770B\u5173\u7CFB" }),
    /* @__PURE__ */ jsx2("p", { className: "table-note", children: "\u65B9\u5411\u4E3A\u300C\u4E3B\u4F53\u76F8\u5BF9\u6BD4\u8F83\u5BF9\u8C61\u300D\u3002\u6570\u5B57\u662F\u5173\u7CFB\u6807\u7B7E\u6B21\u6570\uFF1A\u540C\u4E00\u8BC4\u8BBA\u3001\u4E3B\u4F53\u3001\u5BF9\u8C61\u3001\u65B9\u9762\u548C\u65B9\u5411\u53EA\u8BA1\u4E00\u6B21\uFF1B\u540C\u4E00\u8BC4\u8BBA\u53EF\u6709\u591A\u6761\u5173\u7CFB\uFF0C\u56E0\u6B64\u5408\u8BA1\u4E0D\u662F\u8BC4\u8BBA\u4EBA\u6570\u3001\u4F5C\u8005\u6570\u6216\u80DC\u7387\u3002\u4E0D\u540C\u4EFB\u52A1\u6761\u4EF6\u4E0B\u53EF\u6709\u4E0D\u540C\u65B9\u5411\uFF0C\u8868\u683C\u4E0D\u4EE3\u8868\u7EDF\u4E00\u6027\u80FD\u6392\u540D\u3002" }),
    /* @__PURE__ */ jsx2("div", { className: "table-wrap", tabIndex: 0, "aria-label": "\u6BD4\u8F83\u5173\u7CFB\u8868\uFF0C\u53EF\u6A2A\u5411\u6EDA\u52A8", children: /* @__PURE__ */ jsxs2("table", { children: [
      /* @__PURE__ */ jsx2("thead", { children: /* @__PURE__ */ jsxs2("tr", { children: [
        /* @__PURE__ */ jsx2("th", { scope: "col", children: "\u6BD4\u8F83\u4E3B\u4F53" }),
        /* @__PURE__ */ jsx2("th", { scope: "col", children: "\u6BD4\u8F83\u5BF9\u8C61" }),
        /* @__PURE__ */ jsx2("th", { scope: "col", children: "\u65B9\u9762" }),
        /* @__PURE__ */ jsx2("th", { scope: "col", children: "\u4E3B\u4F53\u5F3A\u4E8E\u5BF9\u8C61" }),
        /* @__PURE__ */ jsx2("th", { scope: "col", children: "\u63A5\u8FD1" }),
        /* @__PURE__ */ jsx2("th", { scope: "col", children: "\u4E3B\u4F53\u5F31\u4E8E\u5BF9\u8C61" }),
        /* @__PURE__ */ jsx2("th", { scope: "col", children: "\u5173\u7CFB\u5408\u8BA1" }),
        /* @__PURE__ */ jsx2("th", { scope: "col", children: "\u6838\u67E5\u539F\u6587" })
      ] }) }),
      /* @__PURE__ */ jsx2("tbody", { children: rows.map((row, rowIndex) => /* @__PURE__ */ jsxs2("tr", { children: [
        /* @__PURE__ */ jsx2("th", { scope: "row", children: row.subject }),
        /* @__PURE__ */ jsx2("td", { children: row.competitor }),
        /* @__PURE__ */ jsx2("td", { children: aspectLabels[row.aspect] ?? row.aspect }),
        /* @__PURE__ */ jsx2("td", { children: formatInteger(row.stronger) }),
        /* @__PURE__ */ jsx2("td", { children: formatInteger(row.similar) }),
        /* @__PURE__ */ jsx2("td", { children: formatInteger(row.weaker) }),
        /* @__PURE__ */ jsx2("td", { children: formatInteger(row.total) }),
        /* @__PURE__ */ jsx2("td", { children: /* @__PURE__ */ jsx2("div", { className: "cross-evidence", children: row.evidence.length ? row.evidence.map((sample, sampleIndex) => /* @__PURE__ */ jsxs2("a", { href: `#${sampleId(rowIndex, sampleIndex)}`, onClick: (event) => event.currentTarget.ownerDocument.getElementById(sampleId(rowIndex, sampleIndex))?.setAttribute("open", ""), children: [
          sample.evidence_id,
          " \u2197"
        ] }, `${sample.evidence_id}:${sample.verdict}`)) : /* @__PURE__ */ jsx2("span", { children: "\u6682\u65E0\u7247\u6BB5" }) }) })
      ] }, `${row.subject}:${row.competitor}:${row.aspect}`)) })
    ] }) }),
    /* @__PURE__ */ jsx2("p", { className: "table-note", children: "\u8FD9\u4E9B\u5173\u7CFB\u7531\u6A21\u578B\u6807\u6CE8\uFF0C\u672A\u9010\u6761\u72EC\u7ACB\u590D\u6838\u3002\u4EF7\u683C\u66F4\u9AD8\u4E0D\u7B49\u4E8E\u8868\u73B0\u66F4\u597D\uFF1B\u5148\u6838\u5BF9\u7247\u6BB5\u4E2D\u7684\u65B9\u5411\u3001\u6761\u4EF6\u548C\u5177\u4F53\u7248\u672C\u3002\u540D\u79F0\u4EC5\u6309\u5B57\u7B26\u5BBD\u5EA6\u3001\u5927\u5C0F\u5199\u4E0E\u7A7A\u767D\u5F52\u4E00\uFF0C\u4E0D\u5408\u5E76\u8BED\u4E49\u522B\u540D\u3002" }),
    /* @__PURE__ */ jsx2("div", { className: "comparison-sources", children: rows.flatMap((row, rowIndex) => row.evidence.map((sample, sampleIndex) => /* @__PURE__ */ jsxs2("details", { className: "comparison-source", id: sampleId(rowIndex, sampleIndex), children: [
      /* @__PURE__ */ jsxs2("summary", { children: [
        sample.evidence_id,
        " \xB7 ",
        row.subject,
        " \u76F8\u5BF9 ",
        row.competitor,
        " \xB7 ",
        aspectLabels[row.aspect] ?? row.aspect,
        " \xB7 ",
        sample.verdict
      ] }),
      /* @__PURE__ */ jsx2("p", { className: "table-note", children: "\u6BD4\u8F83\u7247\u6BB5 \xB7 \u6B64\u5173\u7CFB\u6807\u7B7E\u672A\u7ECF\u72EC\u7ACB\u6A21\u578B\u590D\u6838" }),
      /* @__PURE__ */ jsx2("blockquote", { children: sample.evidence_quote }),
      /* @__PURE__ */ jsxs2("details", { children: [
        /* @__PURE__ */ jsx2("summary", { children: sample.full_text_truncated ? "\u67E5\u770B\u5DF2\u4FDD\u5B58\u7684\u8BC4\u8BBA\u6587\u672C\uFF08\u5DF2\u622A\u65AD\uFF09" : "\u67E5\u770B\u5B8C\u6574\u8BC4\u8BBA" }),
        /* @__PURE__ */ jsx2("p", { className: "comparison-source__full", children: sample.full_text })
      ] }),
      sample.source_url && /* @__PURE__ */ jsx2("a", { href: sample.source_url, target: "_blank", rel: "noreferrer", children: "\u67E5\u770B\u539F\u4F5C\u54C1 \u2197" })
    ] }, sampleId(rowIndex, sampleIndex)))) })
  ] });
}

// source/web/features/report/components/ComparisonTable.tsx
import { Fragment, jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function ComparisonTable({ rows, relations = [] }) {
  if (rows.length === 0 && relations.length === 0) return null;
  return /* @__PURE__ */ jsxs3("section", { className: "comparison-section", id: relations.length ? void 0 : "comparisons", children: [
    /* @__PURE__ */ jsxs3("header", { className: "section-heading section-heading--split", children: [
      /* @__PURE__ */ jsxs3("div", { children: [
        /* @__PURE__ */ jsx3("p", { className: "eyebrow", children: "Automatic comparison labels" }),
        /* @__PURE__ */ jsx3("h2", { children: relations.length ? "\u539F\u59CB\u6BD4\u8F83\u5173\u7CFB\u6807\u7B7E" : "\u6BD4\u8F83\u6807\u7B7E\uFF08\u5F85\u6838\u67E5\uFF09" })
      ] }),
      /* @__PURE__ */ jsx3("p", { className: "display-count", children: "\u4FDD\u7559\u539F\u59CB\u6A21\u578B\u6807\u7B7E\uFF0C\u672A\u9010\u9879\u786E\u8BA4\u6BD4\u8F83\u5173\u7CFB" })
    ] }),
    relations.length > 0 && /* @__PURE__ */ jsx3(ComparisonRelations, { rows: relations }),
    rows.length > 0 && /* @__PURE__ */ jsxs3(Fragment, { children: [
      /* @__PURE__ */ jsx3("p", { className: "table-note", children: "\u65E7\u7248\u6BD4\u8F83\u6807\u7B7E\uFF1A\u4E3B\u4F53\u4E0E\u65B9\u5411\u672A\u5B9A\u4E49\uFF0C\u4E0D\u80FD\u636E\u6B64\u5F97\u51FA\u8C01\u5F3A\u4E8E\u8C01\u7684\u7ED3\u8BBA\u3002" }),
      /* @__PURE__ */ jsx3("div", { className: "table-wrap", children: /* @__PURE__ */ jsxs3("table", { children: [
        /* @__PURE__ */ jsx3("thead", { children: /* @__PURE__ */ jsxs3("tr", { children: [
          /* @__PURE__ */ jsx3("th", { scope: "col", children: "\u88AB\u6BD4\u8F83\u5BF9\u8C61" }),
          /* @__PURE__ */ jsx3("th", { scope: "col", children: "\u300C\u5F3A\u4E8E\u300D\u6807\u7B7E" }),
          /* @__PURE__ */ jsx3("th", { scope: "col", children: "\u300C\u63A5\u8FD1\u300D\u6807\u7B7E" }),
          /* @__PURE__ */ jsx3("th", { scope: "col", children: "\u300C\u5F31\u4E8E\u300D\u6807\u7B7E" }),
          /* @__PURE__ */ jsx3("th", { scope: "col", children: "\u6807\u7B7E\u603B\u6570" })
        ] }) }),
        /* @__PURE__ */ jsx3("tbody", { children: rows.map((row) => /* @__PURE__ */ jsxs3("tr", { children: [
          /* @__PURE__ */ jsx3("th", { scope: "row", children: row.competitor }),
          /* @__PURE__ */ jsx3("td", { children: formatInteger(row.stronger) }),
          /* @__PURE__ */ jsx3("td", { children: formatInteger(row.similar) }),
          /* @__PURE__ */ jsx3("td", { children: formatInteger(row.weaker) }),
          /* @__PURE__ */ jsx3("td", { children: formatInteger(row.total) })
        ] }, row.competitor.toLocaleLowerCase())) })
      ] }) }),
      /* @__PURE__ */ jsx3("p", { className: "table-note", children: "\u6807\u7B7E\u53EF\u80FD\u8BEF\u5224\uFF0C\u4E0D\u80FD\u636E\u6B64\u8BA4\u5B9A\u8BC4\u8BBA\u660E\u786E\u6BD4\u8F83\u4E86\u4E24\u4E2A\u5BF9\u8C61\u3002\u9700\u6838\u5BF9\u539F\u6587\u4E2D\u7684\u6BD4\u8F83\u4E3B\u8BED\u3001\u5BF9\u8C61\u53CA\u7EF4\u5EA6\uFF1B\u63A8\u8350\u6216\u63D0\u53CA\u4E0D\u7B49\u4E8E\u5F3A\u5F31\u5224\u65AD\u3002\u540D\u79F0\u4EC5\u5408\u5E76\u5927\u5C0F\u5199\u5DEE\u5F02\u3002" })
    ] })
  ] });
}

// source/web/features/report/components/ComparisonDisclosure.tsx
import { jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
function ComparisonDisclosure({ rows, relations = [] }) {
  if (rows.length === 0 && relations.length === 0) return null;
  const hasRelations = relations.length > 0;
  const displayedRelations = relations.reduce((total, row) => total + row.total, 0);
  return /* @__PURE__ */ jsxs4("div", { id: hasRelations ? "comparisons" : void 0, className: "comparison-disclosure", children: [
    hasRelations && /* @__PURE__ */ jsxs4("p", { className: "table-note comparison-boundary", children: [
      "\u8BE5\u7EF4\u5EA6\u5C1A\u672A\u5F62\u6210\u7ECF\u6838\u9A8C\u7684\u5F3A\u5F31\u7ED3\u8BBA\uFF1B\u4E3B\u4F53\u6216\u65B9\u5411\u4ECD\u53EF\u80FD\u8BEF\u6807\uFF0C\u62A5\u544A\u6B63\u6587\u590D\u6838\u4E0D\u8986\u76D6\u8FD9\u4E9B\u5173\u7CFB\u3002\u5F53\u524D\u5C55\u793A ",
      formatInteger(displayedRelations),
      " \u6761\u539F\u59CB\u5173\u7CFB\u6807\u7B7E\uFF0C\u5206\u4E3A ",
      formatInteger(relations.length),
      " \u7EC4\u3002"
    ] }),
    /* @__PURE__ */ jsxs4("details", { className: "report-detail", children: [
      /* @__PURE__ */ jsxs4("summary", { children: [
        /* @__PURE__ */ jsx4("span", { children: hasRelations ? "\u81EA\u52A8\u6BD4\u8F83\u6807\u7B7E\uFF08\u5F85\u6838\u67E5\uFF09" : "\u6BD4\u8F83\u6807\u7B7E" }),
        /* @__PURE__ */ jsx4("small", { children: hasRelations ? "\u5C55\u5F00\u6838\u67E5\u6A21\u578B\u6807\u7B7E\u53CA\u8BC4\u8BBA\u539F\u6587" : `${rows.length} \u4E2A\u5BF9\u8C61\uFF0C\u65E7\u6807\u7B7E\u7684\u4E3B\u4F53\u4E0E\u65B9\u5411\u672A\u5B9A\u4E49` })
      ] }),
      /* @__PURE__ */ jsx4(ComparisonTable, { rows, relations })
    ] })
  ] });
}

// source/web/features/report/components/CrossAnalysis.tsx
import { useState } from "react";
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
function CrossAnalysis({ analysis, relevantCount, interactive = false }) {
  const [active, setActive] = useState(analysis.groups[0]?.id);
  if (!analysis.groups.some((group) => group.rows.length)) return null;
  return /* @__PURE__ */ jsxs5("section", { id: "cross-analysis", className: "cross-analysis", children: [
    /* @__PURE__ */ jsxs5("header", { className: "section-heading", children: [
      /* @__PURE__ */ jsx5("p", { className: "eyebrow", children: "Connect the dimensions" }),
      /* @__PURE__ */ jsx5("h2", { children: "\u8BA8\u8BBA\u7126\u70B9\u4E0E\u8BC4\u8BBA\u884C\u4E3A" }),
      /* @__PURE__ */ jsxs5("p", { className: "table-note", children: [
        "\u5C06\u8BA8\u8BBA\u5185\u5BB9\u4E0E\u60C5\u7EEA\u3001\u63D0\u95EE\u548C\u5EFA\u8BAE\u4EA4\u53C9\u67E5\u770B\u3002\u603B\u5360\u6BD4\u5206\u6BCD\u4E3A ",
        formatInteger(relevantCount),
        " \u6761\u76F8\u5173\u8BC4\u8BBA\uFF1B\u6BCF\u884C\u7684\u60C5\u7EEA\u6570\u4E4B\u548C\u7B49\u4E8E\u8BE5\u884C\u8BC4\u8BBA\u6570\u3002"
      ] })
    ] }),
    interactive && /* @__PURE__ */ jsx5("div", { className: "analysis-tabs", role: "group", "aria-label": "\u4EA4\u53C9\u5206\u6790\u7EF4\u5EA6", children: analysis.groups.map((group) => /* @__PURE__ */ jsx5("button", { type: "button", "aria-pressed": active === group.id, onClick: () => setActive(group.id), children: group.title }, group.id)) }),
    analysis.groups.map((group, index) => /* @__PURE__ */ jsxs5("details", { className: "analysis-group", open: interactive ? active === group.id : index === 0, hidden: interactive && active !== group.id, children: [
      /* @__PURE__ */ jsxs5("summary", { children: [
        group.title,
        /* @__PURE__ */ jsxs5("span", { children: [
          group.rows.length,
          " \u4E2A\u5206\u7EC4"
        ] })
      ] }),
      /* @__PURE__ */ jsx5("p", { className: "table-note", children: group.note }),
      /* @__PURE__ */ jsx5("div", { className: "table-wrap", tabIndex: 0, "aria-label": `${group.title}\u4EA4\u53C9\u5206\u6790\u8868\uFF0C\u53EF\u6A2A\u5411\u6EDA\u52A8`, children: /* @__PURE__ */ jsxs5("table", { className: "cross-table", children: [
        /* @__PURE__ */ jsx5("thead", { children: /* @__PURE__ */ jsxs5("tr", { children: [
          /* @__PURE__ */ jsx5("th", { scope: "col", children: group.title }),
          /* @__PURE__ */ jsx5("th", { scope: "col", children: "\u8BC4\u8BBA / \u603B\u5360\u6BD4" }),
          /* @__PURE__ */ jsx5("th", { scope: "col", children: "\u60C5\u7EEA\u6784\u6210" }),
          /* @__PURE__ */ jsx5("th", { scope: "col", children: "\u63D0\u95EE / \u5EFA\u8BAE / \u7EA0\u9519" }),
          /* @__PURE__ */ jsx5("th", { scope: "col", children: "\u8DE8\u4F5C\u54C1" }),
          /* @__PURE__ */ jsx5("th", { scope: "col", children: "\u6838\u67E5\u539F\u6587" })
        ] }) }),
        /* @__PURE__ */ jsx5("tbody", { children: group.rows.map((row) => /* @__PURE__ */ jsxs5("tr", { children: [
          /* @__PURE__ */ jsx5("th", { scope: "row", children: row.label }),
          /* @__PURE__ */ jsxs5("td", { children: [
            /* @__PURE__ */ jsx5("strong", { children: formatInteger(row.count) }),
            /* @__PURE__ */ jsx5("small", { children: formatPercent(row.pct_of_relevant) })
          ] }),
          /* @__PURE__ */ jsxs5("td", { children: [
            /* @__PURE__ */ jsxs5("div", { className: "cross-sentiment", "aria-label": `\u6B63\u9762 ${row.positive}\uFF0C\u8D1F\u9762 ${row.negative}\uFF0C\u4E2D\u6027 ${row.neutral}\uFF0C\u6DF7\u5408 ${row.mixed}`, children: [
              /* @__PURE__ */ jsxs5("span", { className: "cell-pos", children: [
                "\u6B63 ",
                row.positive
              ] }),
              /* @__PURE__ */ jsxs5("span", { className: "cell-neg", children: [
                "\u8D1F ",
                row.negative
              ] }),
              /* @__PURE__ */ jsxs5("span", { children: [
                "\u4E2D ",
                row.neutral
              ] }),
              /* @__PURE__ */ jsxs5("span", { children: [
                "\u6DF7 ",
                row.mixed
              ] })
            ] }),
            /* @__PURE__ */ jsx5("div", { className: "cross-bar", "aria-hidden": "true", children: ["positive", "negative", "neutral", "mixed"].map((tone) => /* @__PURE__ */ jsx5("span", { className: `stacked-bar__seg--${tone}`, style: { width: `${row.count ? row[tone] / row.count * 100 : 0}%` } }, tone)) })
          ] }),
          /* @__PURE__ */ jsxs5("td", { className: "cross-followups", children: [
            row.questions > 0 && /* @__PURE__ */ jsxs5("span", { children: [
              "\u63D0\u95EE ",
              row.questions
            ] }),
            row.suggestions > 0 && /* @__PURE__ */ jsxs5("span", { children: [
              "\u5EFA\u8BAE ",
              row.suggestions
            ] }),
            row.corrections > 0 && /* @__PURE__ */ jsxs5("span", { children: [
              "\u7EA0\u9519 ",
              row.corrections
            ] }),
            !row.questions && !row.suggestions && !row.corrections && /* @__PURE__ */ jsx5("span", { children: "\u2014" })
          ] }),
          /* @__PURE__ */ jsxs5("td", { children: [
            row.topic_count,
            " \u4E2A"
          ] }),
          /* @__PURE__ */ jsx5("td", { children: /* @__PURE__ */ jsx5("div", { className: "cross-evidence", children: row.evidence_ids.length ? row.evidence_ids.map((id) => /* @__PURE__ */ jsxs5("a", { href: `#evidence-${id}`, "aria-label": `${row.label}\u7684\u539F\u6587 ${id}`, children: [
            id,
            " \u2197"
          ] }, id)) : /* @__PURE__ */ jsx5("span", { className: "table-note", children: "\u6682\u65E0\u6837\u4F8B" }) }) })
        ] }, row.key)) })
      ] }) })
    ] }, group.id)),
    /* @__PURE__ */ jsxs5("details", { className: "sample-diagnostics", children: [
      /* @__PURE__ */ jsx5("summary", { children: "\u8FD9\u4EFD\u6837\u672C\u504F\u5411\u54EA\u91CC\uFF1F" }),
      /* @__PURE__ */ jsxs5("dl", { children: [
        /* @__PURE__ */ jsxs5("div", { children: [
          /* @__PURE__ */ jsx5("dt", { children: "\u6700\u591A\u8BC4\u8BBA\u7684\u4F5C\u54C1" }),
          /* @__PURE__ */ jsxs5("dd", { children: [
            formatPercent(analysis.quality.top_topic_share_pct),
            /* @__PURE__ */ jsx5("small", { children: "\u5360\u5FEB\u7167\u8BC4\u8BBA" })
          ] })
        ] }),
        /* @__PURE__ */ jsxs5("div", { children: [
          /* @__PURE__ */ jsx5("dt", { children: "\u524D\u4E09\u4E2A\u4F5C\u54C1" }),
          /* @__PURE__ */ jsxs5("dd", { children: [
            formatPercent(analysis.quality.top_three_topic_share_pct),
            /* @__PURE__ */ jsx5("small", { children: "\u5360\u5FEB\u7167\u8BC4\u8BBA" })
          ] })
        ] }),
        /* @__PURE__ */ jsxs5("div", { children: [
          /* @__PURE__ */ jsx5("dt", { children: "\u4F4E\u7F6E\u4FE1\u6807\u7B7E" }),
          /* @__PURE__ */ jsxs5("dd", { children: [
            analysis.quality.low_confidence_count,
            /* @__PURE__ */ jsxs5("small", { children: [
              "\u6A21\u578B\u7F6E\u4FE1\u5EA6\u4F4E\u4E8E ",
              analysis.quality.low_confidence_threshold
            ] })
          ] })
        ] }),
        /* @__PURE__ */ jsxs5("div", { children: [
          /* @__PURE__ */ jsx5("dt", { children: "\u672A\u6EE1\u8DB3\u72EC\u7ACB\u5F15\u7528\u6761\u4EF6" }),
          /* @__PURE__ */ jsxs5("dd", { children: [
            analysis.quality.keyword_context_only_count,
            /* @__PURE__ */ jsx5("small", { children: "\u5173\u952E\u8BCD\u672A\u81EA\u5305\u542B\uFF0C\u6216\u8BC4\u4EF7\u5BF9\u8C61\u5E76\u975E\u7814\u7A76\u76EE\u6807" })
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsx5("p", { className: "table-note", children: "\u4F5C\u54C1\u96C6\u4E2D\u5EA6\u9AD8\u65F6\uFF0C\u5E94\u5148\u68C0\u67E5\u5C11\u6570\u4F5C\u54C1\u662F\u5426\u4E3B\u5BFC\u8BA8\u8BBA\u3002\u6A21\u578B\u7F6E\u4FE1\u5EA6\u662F\u81EA\u8BC4\u5206\uFF0C\u4E0D\u80FD\u5F53\u4F5C\u51C6\u786E\u7387\uFF1B\u672A\u6EE1\u8DB3\u72EC\u7ACB\u5F15\u7528\u6761\u4EF6\u4E5F\u4E0D\u7B49\u4E8E\u4E0E\u7814\u7A76\u95EE\u9898\u65E0\u5173\u3002" })
    ] })
  ] });
}

// source/web/features/report/components/EvidenceGrid.tsx
import { useEffect, useRef, useState as useState2 } from "react";
import { flushSync } from "react-dom";

// source/web/lib/safe-url.ts
function safeExternalUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

// source/web/features/report/evidence-filter.ts
var emptyFilters = { search: "", sentiment: "", intent: "", source: "", aspect: "", target: "", stance: "" };
var evidenceSourceKey = (item) => item.topic_id ?? item.source_url ?? item.topic_title;
function matchesEvidence(item, filters) {
  const search = filters.search.trim().toLocaleLowerCase();
  return (!search || [item.quote, item.full_text, item.topic_title, item.evidence_id].filter(Boolean).join(" ").toLocaleLowerCase().includes(search)) && (!filters.sentiment || item.sentiment === filters.sentiment) && (!filters.intent || item.intent === filters.intent) && (!filters.target || item.opinion_target === filters.target) && (!filters.stance || item.stance === filters.stance) && (!filters.source || evidenceSourceKey(item) === filters.source) && (!filters.aspect || item.aspects?.includes(filters.aspect));
}

// source/web/features/report/components/EvidenceGrid.tsx
import { Fragment as Fragment2, jsx as jsx6, jsxs as jsxs6 } from "react/jsx-runtime";
var PAGE_SIZE = 8;
function EvidenceGrid({ evidence, relevantCount, interactive = false, aspectLabels: aspectLabels2 = {} }) {
  const section = useRef(null);
  const [filters, setFilters] = useState2(emptyFilters);
  const [limit, setLimit] = useState2(PAGE_SIZE);
  const [sort, setSort] = useState2("report");
  const [filtersOpen, setFiltersOpen] = useState2(() => typeof window === "undefined" || !window.matchMedia("(max-width: 700px)").matches);
  const matching = evidence.filter((item) => matchesEvidence(item, filters));
  const ordered = sort === "likes" ? [...matching].sort((a, b) => b.like_count - a.like_count) : matching;
  const shown = new Set((interactive ? ordered.slice(0, limit) : evidence).map((item) => item.evidence_id));
  const items = interactive ? [...ordered, ...evidence.filter((item) => !matching.includes(item))] : evidence;
  const sources = new Map(evidence.map((item) => [evidenceSourceKey(item), item.topic_title]));
  const intents = new Map(evidence.map((item) => [item.intent, item.intent_label]));
  const targets = new Map(evidence.map((item) => [item.opinion_target, item.opinion_target_label]));
  const aspects = [...new Set(evidence.flatMap((item) => item.aspects ?? []))];
  const activeFilters = Object.values(filters).some(Boolean);
  const change = (key, value) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setLimit(PAGE_SIZE);
  };
  const reset = () => {
    setFilters(emptyFilters);
    setLimit(PAGE_SIZE);
  };
  useEffect(() => {
    if (!interactive || !section.current) return;
    const doc = section.current.ownerDocument;
    const reveal = (event) => {
      const href = event.target?.closest?.("a[href^='#evidence-']")?.getAttribute("href");
      if (!href || !evidence.some((item) => href === `#evidence-${item.evidence_id}`)) return;
      const destination = doc.getElementById(href.slice(1));
      if (destination?.hidden) flushSync(() => {
        setFilters(emptyFilters);
        setLimit(evidence.length);
      });
    };
    doc.addEventListener("click", reveal, true);
    return () => doc.removeEventListener("click", reveal, true);
  }, [evidence, interactive]);
  return /* @__PURE__ */ jsxs6("section", { className: "evidence-section", id: "evidence", ref: section, children: [
    /* @__PURE__ */ jsxs6("header", { className: "section-heading section-heading--split", children: [
      /* @__PURE__ */ jsxs6("div", { children: [
        /* @__PURE__ */ jsx6("p", { className: "eyebrow", children: "Read the comments" }),
        /* @__PURE__ */ jsx6("h2", { children: "\u539F\u6587\u6837\u672C\u5E93" })
      ] }),
      /* @__PURE__ */ jsxs6("p", { className: "display-count", children: [
        formatInteger(evidence.length),
        " \u6761\u539F\u6587\u6837\u672C",
        relevantCount !== void 0 ? ` / ${formatInteger(relevantCount)} \u6761\u76F8\u5173\u8BC4\u8BBA` : ""
      ] })
    ] }),
    /* @__PURE__ */ jsxs6("p", { className: "evidence-scope", children: [
      "\u8FD9\u662F\u62A5\u544A\u9009\u53D6\u7684\u539F\u6587\u6837\u672C\uFF0C\u4E0D\u662F\u5168\u90E8\u8BC4\u8BBA\u3002",
      interactive ? "\u7B5B\u9009\u53EA\u4F5C\u7528\u4E8E\u4E0B\u65B9\u6837\u672C\uFF0C\u7ED3\u679C\u6761\u6570\u4E0D\u80FD\u63A8\u7B97\u603B\u4F53\u5360\u6BD4\u3002" : "\u5B8C\u6574\u4FDD\u7559\u6240\u9009\u539F\u6587\uFF1B\u641C\u7D22\u3001\u7EC4\u5408\u7B5B\u9009\u53EF\u5728\u5DE5\u4F5C\u53F0\u4E2D\u4F7F\u7528\u3002"
    ] }),
    interactive && evidence.length > 0 && /* @__PURE__ */ jsxs6("div", { className: "evidence-explorer", children: [
      /* @__PURE__ */ jsxs6("div", { className: "evidence-search-row", children: [
        /* @__PURE__ */ jsxs6("label", { className: "evidence-search", children: [
          /* @__PURE__ */ jsx6("span", { children: "\u641C\u7D22\u539F\u6587" }),
          /* @__PURE__ */ jsx6("input", { type: "search", placeholder: "\u641C\u7D22\u89C2\u70B9\u3001\u8BCD\u8BED\u3001\u4F5C\u54C1\u6216\u8BC1\u636E\u7F16\u53F7", value: filters.search, onChange: (event) => change("search", event.target.value) })
        ] }),
        /* @__PURE__ */ jsxs6("label", { children: [
          /* @__PURE__ */ jsx6("span", { children: "\u6392\u5E8F" }),
          /* @__PURE__ */ jsxs6("select", { value: sort, onChange: (event) => setSort(event.target.value), children: [
            /* @__PURE__ */ jsx6("option", { value: "report", children: "\u62A5\u544A\u987A\u5E8F" }),
            /* @__PURE__ */ jsx6("option", { value: "likes", children: "\u70B9\u8D5E\u4ECE\u9AD8\u5230\u4F4E" })
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsxs6("details", { className: "evidence-filter-options", open: filtersOpen, onToggle: (event) => setFiltersOpen(event.currentTarget.open), children: [
        /* @__PURE__ */ jsxs6("summary", { children: [
          "\u7B5B\u9009\u6761\u4EF6",
          /* @__PURE__ */ jsx6("span", { children: "\u60C5\u7EEA\u3001\u610F\u56FE\u3001\u4F5C\u54C1\u3001\u65B9\u9762" })
        ] }),
        /* @__PURE__ */ jsxs6("div", { className: "evidence-filters", children: [
          /* @__PURE__ */ jsxs6("label", { children: [
            /* @__PURE__ */ jsx6("span", { children: "\u60C5\u7EEA" }),
            /* @__PURE__ */ jsxs6("select", { value: filters.sentiment, onChange: (event) => change("sentiment", event.target.value), children: [
              /* @__PURE__ */ jsx6("option", { value: "", children: "\u5168\u90E8\u60C5\u7EEA" }),
              /* @__PURE__ */ jsx6("option", { value: "positive", children: "\u6B63\u9762" }),
              /* @__PURE__ */ jsx6("option", { value: "negative", children: "\u8D1F\u9762" }),
              /* @__PURE__ */ jsx6("option", { value: "neutral", children: "\u4E2D\u6027" }),
              /* @__PURE__ */ jsx6("option", { value: "mixed", children: "\u590D\u6742 / \u6DF7\u5408" })
            ] })
          ] }),
          /* @__PURE__ */ jsxs6("label", { children: [
            /* @__PURE__ */ jsx6("span", { children: "\u8BC4\u8BBA\u610F\u56FE" }),
            /* @__PURE__ */ jsxs6("select", { value: filters.intent, onChange: (event) => change("intent", event.target.value), children: [
              /* @__PURE__ */ jsx6("option", { value: "", children: "\u5168\u90E8\u610F\u56FE" }),
              [...intents].map(([key, label]) => /* @__PURE__ */ jsx6("option", { value: key, children: label }, key))
            ] })
          ] }),
          /* @__PURE__ */ jsxs6("label", { children: [
            /* @__PURE__ */ jsx6("span", { children: "\u6765\u6E90\u4F5C\u54C1" }),
            /* @__PURE__ */ jsxs6("select", { value: filters.source, onChange: (event) => change("source", event.target.value), children: [
              /* @__PURE__ */ jsxs6("option", { value: "", children: [
                "\u5168\u90E8 ",
                sources.size,
                " \u4E2A\u6765\u6E90\u4F5C\u54C1"
              ] }),
              [...sources].map(([key, title]) => /* @__PURE__ */ jsx6("option", { value: key, children: title }, key))
            ] })
          ] }),
          aspects.length > 0 && /* @__PURE__ */ jsxs6("label", { children: [
            /* @__PURE__ */ jsx6("span", { children: "\u8BA8\u8BBA\u65B9\u9762" }),
            /* @__PURE__ */ jsxs6("select", { value: filters.aspect, onChange: (event) => change("aspect", event.target.value), children: [
              /* @__PURE__ */ jsx6("option", { value: "", children: "\u5168\u90E8\u65B9\u9762" }),
              aspects.map((aspect) => /* @__PURE__ */ jsx6("option", { value: aspect, children: aspectLabels2[aspect] ?? aspect }, aspect))
            ] })
          ] })
        ] }),
        /* @__PURE__ */ jsxs6("details", { className: "evidence-extra-filters", children: [
          /* @__PURE__ */ jsxs6("summary", { children: [
            "\u66F4\u591A\u7B5B\u9009 \xB7 \u8BC4\u4EF7\u5BF9\u8C61\u4E0E\u7ACB\u573A",
            filters.target || filters.stance ? "\uFF08\u5DF2\u5E94\u7528\uFF09" : ""
          ] }),
          /* @__PURE__ */ jsxs6("div", { className: "evidence-filters", children: [
            /* @__PURE__ */ jsxs6("label", { children: [
              /* @__PURE__ */ jsx6("span", { children: "\u8BC4\u4EF7\u5BF9\u8C61" }),
              /* @__PURE__ */ jsxs6("select", { value: filters.target, onChange: (event) => change("target", event.target.value), children: [
                /* @__PURE__ */ jsx6("option", { value: "", children: "\u5168\u90E8\u8BC4\u4EF7\u5BF9\u8C61" }),
                [...targets].map(([key, label]) => /* @__PURE__ */ jsx6("option", { value: key, children: label }, key))
              ] })
            ] }),
            /* @__PURE__ */ jsxs6("label", { children: [
              /* @__PURE__ */ jsx6("span", { children: "\u7ACB\u573A" }),
              /* @__PURE__ */ jsxs6("select", { value: filters.stance, onChange: (event) => change("stance", event.target.value), children: [
                /* @__PURE__ */ jsx6("option", { value: "", children: "\u5168\u90E8\u7ACB\u573A" }),
                /* @__PURE__ */ jsx6("option", { value: "support", children: "\u652F\u6301" }),
                /* @__PURE__ */ jsx6("option", { value: "oppose", children: "\u53CD\u5BF9" }),
                /* @__PURE__ */ jsx6("option", { value: "neutral", children: "\u4E2D\u7ACB" })
              ] })
            ] })
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsxs6("div", { className: "evidence-filter-status", children: [
        /* @__PURE__ */ jsxs6("p", { role: "status", "aria-live": "polite", children: [
          "\u6837\u672C\u4E2D\u5339\u914D ",
          /* @__PURE__ */ jsx6("strong", { children: matching.length }),
          " / ",
          evidence.length,
          " \u6761 \xB7 \u5F53\u524D\u5C55\u793A ",
          Math.min(limit, matching.length),
          " \u6761"
        ] }),
        activeFilters && /* @__PURE__ */ jsx6("button", { type: "button", onClick: reset, children: "\u6E05\u9664\u7B5B\u9009" })
      ] })
    ] }),
    evidence.length === 0 ? /* @__PURE__ */ jsxs6("div", { className: "empty-state", children: [
      /* @__PURE__ */ jsx6("strong", { children: "\u5F53\u524D\u62A5\u544A\u6CA1\u6709\u539F\u6587\u6837\u672C" }),
      /* @__PURE__ */ jsx6("p", { children: "\u8BF7\u53EA\u628A\u62A5\u544A\u4E2D\u7684\u786E\u5B9A\u6027\u7EDF\u8BA1\u4F5C\u4E3A\u5F53\u524D\u5FEB\u7167\u63CF\u8FF0\u3002" })
    ] }) : /* @__PURE__ */ jsxs6(Fragment2, { children: [
      interactive && matching.length === 0 && /* @__PURE__ */ jsxs6("div", { className: "empty-state", children: [
        /* @__PURE__ */ jsx6("strong", { children: "\u6240\u9009\u6837\u672C\u4E2D\u6CA1\u6709\u5339\u914D\u7684\u8BC4\u8BBA" }),
        /* @__PURE__ */ jsx6("p", { children: "\u8FD9\u4E0D\u4EE3\u8868\u5B8C\u6574\u6837\u672C\u4E0D\u5B58\u5728\u6B64\u7C7B\u89C2\u70B9\u3002\u8BD5\u8BD5\u51CF\u5C11\u7B5B\u9009\u6761\u4EF6\u3002" }),
        /* @__PURE__ */ jsx6("button", { type: "button", onClick: reset, children: "\u67E5\u770B\u5168\u90E8\u539F\u6587\u6837\u672C" })
      ] }),
      /* @__PURE__ */ jsx6("div", { className: "evidence-grid", children: items.map((item) => {
        const sourceUrl2 = safeExternalUrl(item.source_url);
        const searchTerm = filters.search.trim().toLocaleLowerCase();
        const matchesFullText = Boolean(searchTerm && !item.quote.toLocaleLowerCase().includes(searchTerm) && item.full_text?.toLocaleLowerCase().includes(searchTerm));
        return /* @__PURE__ */ jsxs6("article", { className: `evidence-card evidence-card--${item.sentiment}`, id: `evidence-${item.evidence_id}`, hidden: !shown.has(item.evidence_id), children: [
          /* @__PURE__ */ jsxs6("div", { className: "evidence-card__meta", children: [
            /* @__PURE__ */ jsx6("a", { className: "evidence-card__id", href: `#evidence-${item.evidence_id}`, children: item.evidence_id }),
            /* @__PURE__ */ jsx6("span", { className: `chip-tone chip-tone--${item.sentiment}`, children: item.sentiment_label }),
            /* @__PURE__ */ jsx6("span", { children: item.intent_label }),
            /* @__PURE__ */ jsxs6("span", { className: "evidence-likes", children: [
              "\u8D5E ",
              formatInteger(item.like_count)
            ] })
          ] }),
          /* @__PURE__ */ jsxs6("blockquote", { children: [
            "\u201C",
            item.quote,
            "\u201D"
          ] }),
          item.full_text && item.full_text !== item.quote ? /* @__PURE__ */ jsxs6("details", { className: "evidence-full-text", open: matchesFullText || void 0, children: [
            /* @__PURE__ */ jsxs6("summary", { children: [
              matchesFullText ? "\u641C\u7D22\u5339\u914D\u5B8C\u6574\u8BC4\u8BBA" : "\u67E5\u770B\u5B8C\u6574\u8BC4\u8BBA",
              "\uFF08",
              item.full_text.length,
              " \u5B57\u7B26\uFF09"
            ] }),
            /* @__PURE__ */ jsx6("p", { children: item.full_text })
          ] }) : !item.full_text ? /* @__PURE__ */ jsx6("small", { className: "table-note", children: "\u4EC5\u6709\u6458\u5F55\uFF0C\u5B8C\u6574\u4E0A\u4E0B\u6587\u8BF7\u67E5\u770B\u539F\u4F5C\u54C1\u3002" }) : null,
          /* @__PURE__ */ jsxs6("div", { className: "evidence-classification", children: [
            /* @__PURE__ */ jsxs6("span", { children: [
              "\u7ACB\u573A \xB7 ",
              item.stance_label
            ] }),
            /* @__PURE__ */ jsxs6("span", { children: [
              "\u8BC4\u4EF7 \xB7 ",
              item.opinion_target_label
            ] }),
            item.aspects?.length ? /* @__PURE__ */ jsxs6("span", { children: [
              "\u65B9\u9762 \xB7 ",
              item.aspects.map((aspect) => aspectLabels2[aspect] ?? aspect).join("\u3001")
            ] }) : null,
            item.requires_context && /* @__PURE__ */ jsx6("span", { className: "evidence-review-note", children: "\u9700\u7ED3\u5408\u4E0A\u4E0B\u6587\u6838\u67E5" }),
            /* @__PURE__ */ jsx6("span", { className: "evidence-review-note", children: item.reviewed === true ? "\u6B64\u6761\u6807\u7B7E\u7ECF\u6A21\u578B\u590D\u6838" : item.reviewed === false ? "\u6B64\u6761\u6807\u7B7E\u672A\u7ECF\u6A21\u578B\u590D\u6838" : "\u6B64\u6761\u6807\u7B7E\u590D\u6838\u672A\u8BB0\u5F55" })
          ] }),
          /* @__PURE__ */ jsxs6("footer", { children: [
            /* @__PURE__ */ jsxs6("div", { children: [
              /* @__PURE__ */ jsxs6("details", { className: "evidence-source", children: [
                /* @__PURE__ */ jsxs6("summary", { children: [
                  /* @__PURE__ */ jsx6("span", { className: "evidence-card__source-label", children: "\u6765\u6E90\u4F5C\u54C1 \xB7 " }),
                  item.topic_title
                ] }),
                /* @__PURE__ */ jsx6("p", { children: item.topic_title })
              ] }),
              item.source_label ? /* @__PURE__ */ jsx6("small", { children: item.source_label }) : null
            ] }),
            sourceUrl2 ? /* @__PURE__ */ jsx6("a", { href: sourceUrl2, target: "_blank", rel: "noopener noreferrer", children: "\u67E5\u770B\u539F\u4F5C\u54C1 \u2197" }) : /* @__PURE__ */ jsx6("span", { className: "source-unavailable", children: "\u6765\u6E90\u94FE\u63A5\u4E0D\u53EF\u7528" })
          ] })
        ] }, item.evidence_id);
      }) }),
      interactive && matching.length > limit && /* @__PURE__ */ jsxs6("div", { className: "evidence-more", children: [
        /* @__PURE__ */ jsxs6("button", { type: "button", onClick: () => setLimit((count) => count + PAGE_SIZE), children: [
          "\u7EE7\u7EED\u9605\u8BFB ",
          Math.min(PAGE_SIZE, matching.length - limit),
          " \u6761\u539F\u6587"
        ] }),
        /* @__PURE__ */ jsxs6("span", { children: [
          "\u8FD8\u6709 ",
          matching.length - limit,
          " \u6761\u5339\u914D\u6837\u672C"
        ] })
      ] })
    ] })
  ] });
}

// source/web/features/report/components/KpiStrip.tsx
import { jsx as jsx7, jsxs as jsxs7 } from "react/jsx-runtime";
function KpiStrip({ coverage }) {
  const metrics = [
    {
      label: "\u5FEB\u7167\u8BC4\u8BBA",
      value: formatInteger(coverage.comments_in_snapshot),
      detail: `${formatInteger(coverage.topics)} \u4E2A\u4F5C\u54C1`
    },
    {
      label: "\u5DF2\u5206\u6790\u8BC4\u8BBA",
      value: formatInteger(coverage.labeled_comments),
      detail: `\u5360 ${formatInteger(coverage.comments_in_snapshot)} \u6761\u5FEB\u7167\u7684 ${formatPercent(coverage.labeled_pct)}`
    },
    {
      label: "\u76F8\u5173\u8BC4\u8BBA",
      value: formatInteger(coverage.relevant_comments),
      detail: `\u5360 ${formatInteger(coverage.labeled_comments)} \u6761\u5DF2\u5206\u6790\u7684 ${formatPercent(coverage.relevant_pct)}`
    },
    {
      label: "\u8986\u76D6\u4F5C\u54C1",
      value: formatInteger(coverage.topics),
      detail: "\u4EC5\u4EE3\u8868\u672C\u6B21\u5B9E\u9645\u91C7\u96C6\u7684\u6837\u672C"
    }
  ];
  return /* @__PURE__ */ jsx7("section", { className: "kpi-strip", id: "overview", "aria-label": "\u6570\u636E\u6982\u89C8", children: metrics.map((metric) => /* @__PURE__ */ jsxs7("div", { className: "kpi", children: [
    /* @__PURE__ */ jsx7("span", { className: "kpi__label", children: metric.label }),
    /* @__PURE__ */ jsx7("strong", { className: "kpi__value", children: metric.value }),
    /* @__PURE__ */ jsx7("small", { className: "kpi__detail", children: metric.detail })
  ] }, metric.label)) });
}

// source/web/features/report/components/Narrative.tsx
import { jsx as jsx8, jsxs as jsxs8 } from "react/jsx-runtime";
function InlineContent({
  spans
}) {
  return spans.map((span, index) => {
    const key = `${span.type}-${index}`;
    switch (span.type) {
      case "text":
        return /* @__PURE__ */ jsx8("span", { children: span.value }, key);
      case "strong":
        return /* @__PURE__ */ jsx8("strong", { children: span.value }, key);
      case "code":
        return /* @__PURE__ */ jsx8("code", { children: span.value }, key);
      case "evidence-ref":
        return /* @__PURE__ */ jsxs8(
          "a",
          {
            className: "evidence-ref",
            href: `#evidence-${span.evidence_id}`,
            children: [
              "[",
              span.evidence_id,
              "]"
            ]
          },
          key
        );
    }
  });
}
function renderBlock(block, evidenceById, key, compactExplanations = false) {
  switch (block.type) {
    case "paragraph":
      if (compactExplanations && !block.spans.some((span) => span.type === "strong")) {
        return /* @__PURE__ */ jsxs8("details", { className: "model-explanation", children: [
          /* @__PURE__ */ jsx8("summary", { children: "\u67E5\u770B\u6A21\u578B\u89E3\u91CA" }),
          /* @__PURE__ */ jsx8("p", { className: "narrative-paragraph", children: /* @__PURE__ */ jsx8(InlineContent, { spans: block.spans }) })
        ] }, key);
      }
      return /* @__PURE__ */ jsx8("p", { className: "narrative-paragraph", children: /* @__PURE__ */ jsx8(InlineContent, { spans: block.spans }) }, key);
    case "fact-list":
      return /* @__PURE__ */ jsx8("ul", { className: "fact-list", children: block.items.map((item) => /* @__PURE__ */ jsx8("li", { "data-fact-id": item.fact_id, children: item.text }, item.fact_id)) }, key);
    case "action-list":
      return /* @__PURE__ */ jsx8("ol", { className: "action-list", children: block.items.map((item, index) => /* @__PURE__ */ jsx8("li", { children: item }, `${index}-${item.slice(0, 24)}`)) }, key);
    case "evidence-quote": {
      const item = evidenceById.get(block.evidence_id);
      if (!item) return null;
      return /* @__PURE__ */ jsxs8("blockquote", { className: "narrative-evidence", children: [
        /* @__PURE__ */ jsxs8("p", { children: [
          "\u201C",
          item.quote,
          "\u201D"
        ] }),
        /* @__PURE__ */ jsxs8("footer", { children: [
          /* @__PURE__ */ jsxs8("a", { href: `#evidence-${item.evidence_id}`, children: [
            "[",
            item.evidence_id,
            "]"
          ] }),
          /* @__PURE__ */ jsx8("span", { children: item.sentiment_label }),
          /* @__PURE__ */ jsx8("span", { children: item.stance_label }),
          /* @__PURE__ */ jsx8("span", { children: item.intent_label })
        ] })
      ] }, key);
    }
  }
}
function Narrative({ sections, evidence, id = "analysis", title = "\u5206\u6790\u7ED3\u8BBA", compactExplanations = false }) {
  const evidenceById = new Map(
    evidence.map((item) => [item.evidence_id, item])
  );
  return /* @__PURE__ */ jsxs8("article", { className: "narrative", id, children: [
    /* @__PURE__ */ jsxs8("header", { className: "section-heading", children: [
      /* @__PURE__ */ jsx8("p", { className: "eyebrow", children: "Evidence-grounded narrative" }),
      /* @__PURE__ */ jsx8("h2", { children: title })
    ] }),
    /* @__PURE__ */ jsx8("div", { className: "narrative__body", children: sections.map((section) => /* @__PURE__ */ jsxs8(
      "section",
      {
        className: `narrative-section narrative-section--${section.id}`,
        "data-section-id": section.id,
        children: [
          !compactExplanations && /* @__PURE__ */ jsx8("h3", { children: section.title }),
          section.blocks.map(
            (block, blockIndex) => renderBlock(
              block,
              evidenceById,
              `${section.id}-${blockIndex}`,
              compactExplanations
            )
          )
        ]
      },
      section.id
    )) })
  ] });
}

// source/web/features/report/components/NoticeStack.tsx
import { jsx as jsx9, jsxs as jsxs9 } from "react/jsx-runtime";
function NoticeStack({ notices }) {
  if (notices.length === 0) return null;
  return /* @__PURE__ */ jsx9("section", { className: "notice-stack", "aria-label": "\u62A5\u544A\u63D0\u9192", children: notices.map((notice, index) => /* @__PURE__ */ jsxs9(
    "aside",
    {
      className: `notice notice--${notice.kind}`,
      role: notice.kind === "boundary" ? "note" : "alert",
      children: [
        /* @__PURE__ */ jsx9("strong", { children: notice.title }),
        /* @__PURE__ */ jsx9("p", { children: notice.text })
      ]
    },
    `${notice.kind}-${index}`
  )) });
}

// source/web/features/report/components/QualityGate.tsx
import { jsx as jsx10, jsxs as jsxs10 } from "react/jsx-runtime";
var STATUS_LABELS = {
  sufficient: "\u53EF\u7528\u4E8E\u672C\u6B21\u6D1E\u5BDF",
  limited: "\u6837\u672C\u6709\u9650",
  insufficient: "\u4EC5\u9650\u91C7\u96C6\u8BCA\u65AD"
};
function QualityGate({ quality }) {
  return /* @__PURE__ */ jsxs10(
    "section",
    {
      className: `quality-gate quality-gate--${quality.status}`,
      "aria-labelledby": "quality-gate-title",
      children: [
        /* @__PURE__ */ jsxs10("div", { className: "quality-gate__heading", children: [
          /* @__PURE__ */ jsx10("p", { className: "eyebrow", children: "Data readiness" }),
          /* @__PURE__ */ jsx10("span", { className: "quality-gate__status", children: STATUS_LABELS[quality.status] })
        ] }),
        /* @__PURE__ */ jsx10("h2", { id: "quality-gate-title", children: quality.title }),
        /* @__PURE__ */ jsx10("p", { children: quality.summary }),
        /* @__PURE__ */ jsx10("ul", { children: quality.reasons.map((reason) => /* @__PURE__ */ jsx10("li", { children: reason }, reason)) })
      ]
    }
  );
}

// source/web/features/report/components/ReportBoundary.tsx
import { jsx as jsx11, jsxs as jsxs11 } from "react/jsx-runtime";
function ReportBoundary({ report }) {
  const warning = report.status.degraded || report.status.review_status === "unavailable";
  return /* @__PURE__ */ jsxs11("aside", { className: "report-boundary", "aria-label": "\u6837\u672C\u4E0E\u6838\u67E5\u8FB9\u754C", children: [
    report.status.statistics_only && /* @__PURE__ */ jsxs11("p", { children: [
      /* @__PURE__ */ jsx11("strong", { children: "\u7EDF\u8BA1\u7248\u62A5\u544A \xB7 \u81EA\u52A8\u89E3\u8BFB\u672A\u5B8C\u6210" }),
      "\u3002\u5F53\u524D\u4EC5\u5C55\u793A\u6A21\u578B\u5206\u7C7B\u8BA1\u6570\u4E0E\u539F\u8BC4\u8BBA\u6837\u4F8B\uFF0C\u5C1A\u672A\u5B8C\u6210\u6A21\u578B\u8BED\u4E49\u590D\u6838\u3002"
    ] }),
    /* @__PURE__ */ jsxs11("p", { children: [
      /* @__PURE__ */ jsx11("strong", { children: report.status.statistics_only ? "\u7EDF\u8BA1\u8303\u56F4" : warning ? "\u6A21\u578B\u8BED\u4E49\u590D\u6838\u672A\u5B8C\u6210" : report.quality.title }),
      report.status.partial ? " \xB7 \u90E8\u5206\u7ED3\u679C" : "",
      " \xB7 ",
      report.coverage.relevant_comments,
      " \u6761\u76F8\u5173\u8BC4\u8BBA\uFF1B\u539F\u6587\u5E93\u5C55\u793A ",
      report.evidence.length,
      " \u6761\u6837\u4F8B",
      report.quality.status === "insufficient" ? "\uFF0C\u4EC5\u9650\u91C7\u96C6\u8BCA\u65AD" : report.quality.status === "limited" ? "\uFF0C\u6837\u672C\u6709\u9650" : "",
      "\u3002\u7ED3\u8BBA\u4EC5\u9002\u7528\u4E8E\u672C\u6B21\u6837\u672C\u3002"
    ] }),
    /* @__PURE__ */ jsx11("p", { children: "\u5206\u7C7B\u6765\u81EA\u6A21\u578B\uFF0C\u7EDF\u8BA1\u7531\u7A0B\u5E8F\u8BA1\u7B97\uFF1B\u6B63\u6587\u53EF\u80FD\u662F\u4E8B\u5B9E\u8349\u7A3F\u6216 Agent \u64B0\u5199\u7684\u5206\u6790\u3002\u8BF7\u4EE5\u9875\u9762\u590D\u6838\u72B6\u6001\u4E3A\u51C6\uFF0C\u62A5\u544A\u4E0D\u4EE3\u8868\u4EBA\u5DE5\u786E\u8BA4\uFF0C\u8BF7\u7ED3\u5408\u5B8C\u6574\u539F\u6587\u5224\u65AD\u3002" }),
    report.status.review_status === "external_reviewed" && report.status.review_source === "codex-agent" && /* @__PURE__ */ jsx11("p", { children: "\u5BA1\u6838\u6765\u6E90\uFF1ACodex Agent\uFF08\u81EA\u52A8\u5BA1\u8BFB\uFF0C\u975E\u4EBA\u5DE5\u590D\u6838\uFF09\u3002\u5BA1\u8BFB\u8986\u76D6\u62A5\u544A\u6B63\u6587\u53CA\u5176\u5F15\u7528\u4F9D\u636E\uFF1B\u6807\u7B7E\u7EDF\u8BA1\u4ECD\u6765\u81EA\u5DF2\u6709\u81EA\u52A8\u6807\u6CE8\uFF0C\u672A\u91CD\u65B0\u6838\u9A8C\u5168\u90E8\u8BC4\u8BBA\u3002" }),
    report.status.partial && /* @__PURE__ */ jsx11("p", { children: "\u90E8\u5206\u7ED3\u679C\u57FA\u4E8E\u5DF2\u5B8C\u6210\u6807\u6CE8\u7684\u8BC4\u8BBA\uFF1B\u672A\u5B8C\u6210\u90E8\u5206\u672A\u8FDB\u5165\u5206\u7C7B\u7EDF\u8BA1\u3002" }),
    /* @__PURE__ */ jsxs11("details", { children: [
      /* @__PURE__ */ jsx11("summary", { children: "\u67E5\u770B\u91C7\u96C6\u5DEE\u989D\u3001\u62BD\u6837\u65B9\u5F0F\u4E0E\u6838\u67E5\u8BE6\u60C5" }),
      /* @__PURE__ */ jsx11(NoticeStack, { notices: report.notices }),
      /* @__PURE__ */ jsx11(QualityGate, { quality: report.quality })
    ] })
  ] });
}

// source/web/features/report/components/PlatformComparison.tsx
import { jsx as jsx12, jsxs as jsxs12 } from "react/jsx-runtime";
function PlatformComparison({ platforms }) {
  if (platforms.length < 2) return null;
  const maxRelevant = Math.max(...platforms.map((item) => item.relevant_comments), 1);
  return /* @__PURE__ */ jsxs12("section", { className: "platform-section", id: "platforms", children: [
    /* @__PURE__ */ jsxs12("header", { className: "section-heading section-heading--split", children: [
      /* @__PURE__ */ jsxs12("div", { children: [
        /* @__PURE__ */ jsx12("p", { className: "eyebrow", children: "Cross-platform comparison" }),
        /* @__PURE__ */ jsx12("h2", { children: "\u5E73\u53F0\u5DEE\u5F02" })
      ] }),
      /* @__PURE__ */ jsxs12("p", { className: "display-count", children: [
        "\u5171 ",
        /* @__PURE__ */ jsx12("strong", { children: formatInteger(platforms.length) }),
        " \u4E2A\u5E73\u53F0"
      ] })
    ] }),
    /* @__PURE__ */ jsx12("p", { className: "truncation-note", role: "note", children: "\u5404\u5E73\u53F0\u7684\u6837\u672C\u91CF\u7531\u8BE5\u5E73\u53F0\u5B9E\u9645\u91C7\u96C6\u5230\u7684\u53EF\u89C1\u8BC4\u8BBA\u51B3\u5B9A\uFF0C\u5F7C\u6B64\u4E0D\u53EF\u76F4\u63A5\u5F53\u4F5C\u7B49\u6743\u91CD \u5BF9\u6BD4\uFF1B\u4E0B\u8868\u7684\u767E\u5206\u6BD4\u662F\u5404\u5E73\u53F0\u5185\u90E8\u7684\u5360\u6BD4\u3002" }),
    /* @__PURE__ */ jsx12(
      "div",
      {
        className: "table-wrap",
        tabIndex: 0,
        "aria-label": "\u5E73\u53F0\u5DEE\u5F02\u5BF9\u6BD4\u8868\uFF0C\u53EF\u6A2A\u5411\u6EDA\u52A8",
        children: /* @__PURE__ */ jsxs12("table", { children: [
          /* @__PURE__ */ jsx12("caption", { className: "sr-only", children: "\u5404\u5E73\u53F0\u7684\u5185\u5BB9\u6570\u3001\u8BC4\u8BBA\u6570\u4E0E\u60C5\u7EEA\u5206\u5E03\u5BF9\u6BD4" }),
          /* @__PURE__ */ jsx12("thead", { children: /* @__PURE__ */ jsxs12("tr", { children: [
            /* @__PURE__ */ jsx12("th", { scope: "col", children: "\u5E73\u53F0" }),
            /* @__PURE__ */ jsx12("th", { scope: "col", children: "\u5185\u5BB9" }),
            /* @__PURE__ */ jsx12("th", { scope: "col", children: "\u5FEB\u7167\u8BC4\u8BBA" }),
            /* @__PURE__ */ jsx12("th", { scope: "col", children: "\u76F8\u5173" }),
            /* @__PURE__ */ jsx12("th", { scope: "col", children: "\u6B63\u9762" }),
            /* @__PURE__ */ jsx12("th", { scope: "col", children: "\u8D1F\u9762" }),
            /* @__PURE__ */ jsx12("th", { scope: "col", children: "\u5E73\u5747\u60C5\u7EEA" })
          ] }) }),
          /* @__PURE__ */ jsx12("tbody", { children: platforms.map((item) => /* @__PURE__ */ jsxs12("tr", { children: [
            /* @__PURE__ */ jsx12("th", { scope: "row", children: item.label }),
            /* @__PURE__ */ jsx12("td", { children: formatInteger(item.topics) }),
            /* @__PURE__ */ jsx12("td", { children: formatInteger(item.snapshot_comments) }),
            /* @__PURE__ */ jsx12("td", { children: /* @__PURE__ */ jsxs12("span", { className: "contro-cell", children: [
              /* @__PURE__ */ jsx12("span", { className: "contro-bar", "aria-hidden": "true", children: /* @__PURE__ */ jsx12(
                "span",
                {
                  style: {
                    width: `${item.relevant_comments / maxRelevant * 100}%`
                  }
                }
              ) }),
              formatInteger(item.relevant_comments)
            ] }) }),
            /* @__PURE__ */ jsx12("td", { className: "cell-pos", children: formatPercent(item.positive_pct) }),
            /* @__PURE__ */ jsx12("td", { className: "cell-neg", children: formatPercent(item.negative_pct) }),
            /* @__PURE__ */ jsx12("td", { children: item.avg_sentiment_score.toFixed(2) })
          ] }, item.platform)) })
        ] })
      }
    )
  ] });
}

// source/web/features/report/components/RankingGrid.tsx
import { jsx as jsx13, jsxs as jsxs13 } from "react/jsx-runtime";
var emotionLabels = {
  curiosity: "\u597D\u5947",
  amusement: "\u89C9\u5F97\u6709\u8DA3",
  approval: "\u8BA4\u53EF",
  enthusiasm: "\u70ED\u60C5",
  frustration: "\u53D7\u632B",
  skepticism: "\u6000\u7591",
  disappointment: "\u5931\u671B",
  anger: "\u6124\u6012",
  confusion: "\u56F0\u60D1",
  gratitude: "\u611F\u8C22",
  admiration: "\u8D5E\u8D4F",
  surprise: "\u60CA\u8BB6",
  excitement: "\u5174\u594B",
  sarcasm: "\u8BBD\u523A",
  concern: "\u62C5\u5FE7"
};
function RankingGrid({ groups }) {
  if (groups.length === 0) return null;
  return /* @__PURE__ */ jsxs13("section", { className: "ranking-section", id: "signals", children: [
    /* @__PURE__ */ jsxs13("header", { className: "section-heading section-heading--split", children: [
      /* @__PURE__ */ jsxs13("div", { children: [
        /* @__PURE__ */ jsx13("p", { className: "eyebrow", children: "Conversation signals" }),
        /* @__PURE__ */ jsx13("h2", { children: "\u8BA8\u8BBA\u7126\u70B9\u4E0E\u60C5\u7EEA\u4FE1\u53F7" })
      ] }),
      /* @__PURE__ */ jsx13("p", { className: "display-count", children: "\u6A21\u578B\u6807\u7B7E\u547D\u4E2D\u6B21\u6570\uFF1B\u540C\u4E00\u8BC4\u8BBA\u53EF\u6709\u591A\u4E2A\u6807\u7B7E" })
    ] }),
    /* @__PURE__ */ jsx13("div", { className: "ranking-grid", children: groups.map((group) => {
      const labels = group.items.map((item) => group.id === "emotion" ? emotionLabels[item.key] ?? item.label : item.label);
      const repeatedLabels = new Set(labels.filter((label, index) => labels.indexOf(label) !== index));
      return /* @__PURE__ */ jsxs13("article", { className: "ranking-panel", children: [
        /* @__PURE__ */ jsxs13("header", { children: [
          /* @__PURE__ */ jsx13("p", { className: "eyebrow", children: group.id }),
          /* @__PURE__ */ jsx13("h3", { children: group.title }),
          /* @__PURE__ */ jsx13("small", { children: group.note }),
          group.id === "emotion" && repeatedLabels.size > 0 && /* @__PURE__ */ jsx13("p", { className: "table-note", children: "\u539F\u59CB\u60C5\u7EEA\u6807\u7B7E\u542B\u4E0D\u540C\u8BED\u8A00\u7684\u540C\u4E49\u5199\u6CD5\uFF0C\u6682\u672A\u5F52\u5E76\uFF1B\u62EC\u53F7\u4FDD\u7559\u539F\u6807\u7B7E\uFF0C\u5404\u884C\u4E0D\u80FD\u76F8\u52A0\u5F53\u4F5C\u4EBA\u6570\u3002" })
        ] }),
        /* @__PURE__ */ jsx13("ol", { children: group.items.map((item, index) => /* @__PURE__ */ jsxs13("li", { children: [
          /* @__PURE__ */ jsxs13("div", { className: "ranking-panel__label", children: [
            /* @__PURE__ */ jsxs13("span", { children: [
              labels[index],
              repeatedLabels.has(labels[index]) && item.key !== labels[index] ? `\uFF08${item.key}\uFF09` : ""
            ] }),
            /* @__PURE__ */ jsx13("strong", { children: formatInteger(item.count) })
          ] }),
          /* @__PURE__ */ jsx13("div", { className: "ranking-panel__track", "aria-hidden": "true", children: /* @__PURE__ */ jsx13("span", { style: { width: `${Math.min(100, item.pct_of_relevant)}%` } }) }),
          /* @__PURE__ */ jsxs13("small", { children: [
            "\u547D\u4E2D\u6B21\u6570 / \u76F8\u5173\u8BC4\u8BBA\u6570\uFF1A",
            formatPercent(item.pct_of_relevant),
            item.pct_of_relevant > 100 ? "\uFF08\u6761\u5F62\u4E0A\u9650\u4E3A 100%\uFF09" : ""
          ] })
        ] }, item.key)) })
      ] }, group.id);
    }) })
  ] });
}

// source/web/features/report/components/ReportFooter.tsx
import { jsx as jsx14, jsxs as jsxs14 } from "react/jsx-runtime";
function ReportFooter({ note }) {
  return /* @__PURE__ */ jsxs14("footer", { className: "report-footer", children: [
    /* @__PURE__ */ jsx14("span", { children: "VoxAgent" }),
    /* @__PURE__ */ jsx14("p", { children: note })
  ] });
}

// source/web/features/report/components/ReportHeader.tsx
import { jsx as jsx15, jsxs as jsxs15 } from "react/jsx-runtime";
function statusLabel(status) {
  if (status.statistics_only) return "\u7EDF\u8BA1\u7248 \xB7 \u6A21\u578B\u672A\u590D\u6838";
  const prefix = status.partial ? "\u90E8\u5206\u7ED3\u679C \xB7 " : "";
  if (status.degraded || status.review_status === "unavailable") return `${prefix}\u6A21\u578B\u590D\u6838\u672A\u5B8C\u6210`;
  if (status.review_status === "external_reviewed" && status.review_source === "codex-agent") return `${prefix}Codex Agent\u590D\u6838\u901A\u8FC7`;
  if (status.review_status === "revised") return `${prefix}\u6A21\u578B\u4FEE\u8BA2\u540E\u590D\u6838\u901A\u8FC7`;
  if (status.review_status === "accepted") return `${prefix}\u6A21\u578B\u81EA\u52A8\u590D\u6838\u901A\u8FC7`;
  if (status.review_status === "not_required") return `${prefix}\u4EC5\u91C7\u96C6\u8BCA\u65AD`;
  return `${prefix}\u590D\u6838\u72B6\u6001\u5F85\u786E\u8BA4`;
}
function ReportHeader({ identity, status }) {
  const longQuestion = (identity.research_question?.length ?? 0) > 48;
  const externalReviewed = status.review_status === "external_reviewed" && status.review_source === "codex-agent";
  const state = status.degraded || !externalReviewed && !["accepted", "revised", "not_required"].includes(status.review_status) ? "warning" : status.partial ? "partial" : "accepted";
  return /* @__PURE__ */ jsxs15("header", { className: "report-header", children: [
    /* @__PURE__ */ jsxs15("div", { className: "topbar", children: [
      /* @__PURE__ */ jsxs15("div", { className: "topbar__meta", children: [
        /* @__PURE__ */ jsx15("span", { className: "brand-mark", "aria-hidden": "true" }),
        /* @__PURE__ */ jsx15("span", { className: "topbar__brand", children: "VoxAgent" }),
        /* @__PURE__ */ jsx15("span", { className: "mode-chip", children: formatMode(identity.mode) })
      ] }),
      /* @__PURE__ */ jsxs15("div", { className: "topbar__side", children: [
        /* @__PURE__ */ jsx15(
          "span",
          {
            className: `seal-badge${identity.sealed ? "" : " seal-badge--open"}`,
            children: identity.sealed ? "\u6837\u672C\u5DF2\u5C01\u5B58" : "\u6837\u672C\u672A\u5C01\u5B58"
          }
        ),
        /* @__PURE__ */ jsx15("time", { dateTime: identity.generated_at, children: formatGeneratedAt(identity.generated_at) }),
        /* @__PURE__ */ jsxs15("div", { className: `review-state review-state--${state}`, children: [
          /* @__PURE__ */ jsx15("span", { className: "review-state__mark", "aria-hidden": "true" }),
          /* @__PURE__ */ jsx15("span", { children: statusLabel(status) })
        ] })
      ] })
    ] }),
    /* @__PURE__ */ jsxs15("div", { className: "report-header__main", children: [
      /* @__PURE__ */ jsxs15("div", { children: [
        /* @__PURE__ */ jsx15("h1", { className: "report-title", children: longQuestion ? `${identity.subject} \xB7 \u8BC4\u8BBA\u7814\u7A76` : identity.research_question || identity.subject }),
        longQuestion ? /* @__PURE__ */ jsxs15("p", { className: "report-question", children: [
          /* @__PURE__ */ jsx15("span", { children: "\u7814\u7A76\u95EE\u9898" }),
          identity.research_question
        ] }) : identity.research_question && /* @__PURE__ */ jsxs15("p", { className: "report-subject", children: [
          "\u7814\u7A76\u5BF9\u8C61 \xB7 ",
          identity.subject
        ] })
      ] }),
      /* @__PURE__ */ jsxs15("div", { className: "report-header__aside", children: [
        /* @__PURE__ */ jsxs15("p", { className: "report-dek", children: [
          status.statistics_only ? "\u8BC4\u8BBA\u7EDF\u8BA1\u62A5\u544A" : "\u8BC4\u8BBA\u6D1E\u5BDF\u62A5\u544A",
          /* @__PURE__ */ jsx15("span", { "aria-hidden": "true", children: " / " }),
          "\u57FA\u4E8E\u672C\u6B21\u5B9E\u9645\u91C7\u96C6\u7684\u8BC4\u8BBA\u6837\u672C"
        ] }),
        /* @__PURE__ */ jsxs15("details", { className: "report-provenance", children: [
          /* @__PURE__ */ jsx15("summary", { children: "\u67E5\u770B\u7814\u7A76\u6807\u8BC6\u4E0E\u6838\u67E5\u4FE1\u606F" }),
          /* @__PURE__ */ jsxs15("dl", { className: "identity-list", "aria-label": "\u62A5\u544A\u8EAB\u4EFD", children: [
            /* @__PURE__ */ jsxs15("div", { children: [
              /* @__PURE__ */ jsx15("dt", { children: "Dataset" }),
              /* @__PURE__ */ jsx15("dd", { children: identity.dataset_public_id })
            ] }),
            /* @__PURE__ */ jsxs15("div", { children: [
              /* @__PURE__ */ jsx15("dt", { children: "Run" }),
              /* @__PURE__ */ jsx15("dd", { children: identity.run_id })
            ] }),
            /* @__PURE__ */ jsxs15("div", { children: [
              /* @__PURE__ */ jsx15("dt", { children: "Fingerprint" }),
              /* @__PURE__ */ jsxs15("dd", { title: identity.fingerprint, children: [
                identity.fingerprint.slice(0, 16),
                "\u2026"
              ] })
            ] })
          ] })
        ] })
      ] })
    ] })
  ] });
}

// source/web/features/report/components/SectionNav.tsx
import { jsx as jsx16, jsxs as jsxs16 } from "react/jsx-runtime";
function SectionNav({
  showAnalysis,
  showCrossAnalysis,
  showComparisons,
  showDistributions,
  showPlatforms,
  showSignals,
  showTimeline
}) {
  const navigationItems = [
    ["#overview", "\u6570\u636E\u6982\u89C8"],
    ...showAnalysis ? [["#analysis", "\u89C2\u70B9\u4E0E\u539F\u6587"]] : [],
    ...showCrossAnalysis ? [["#cross-analysis", "\u591A\u7EF4\u4EA4\u53C9"]] : [],
    ["#evidence", "\u539F\u6587\u6837\u672C\u5E93"],
    ...showDistributions ? [["#distributions", "\u603B\u4F53\u5206\u5E03"]] : [],
    ...showSignals ? [["#signals", "\u8BA8\u8BBA\u7126\u70B9"]] : [],
    ...showPlatforms ? [["#platforms", "\u5E73\u53F0\u5DEE\u5F02"]] : [],
    ...showComparisons ? [["#comparisons", "\u6BD4\u8F83\u6807\u7B7E"]] : [],
    ...showTimeline ? [["#timeline", "\u65E5\u671F\u5207\u7247"]] : [],
    ["#topics", "\u4F5C\u54C1\u660E\u7EC6"]
  ];
  return /* @__PURE__ */ jsxs16("nav", { className: "section-nav", "aria-label": "\u62A5\u544A\u7AE0\u8282\u5FEB\u901F\u5BFC\u822A", children: [
    /* @__PURE__ */ jsx16("span", { className: "section-nav__label", children: "\u5FEB\u901F\u5BFC\u822A" }),
    navigationItems.map(([href, label]) => /* @__PURE__ */ jsx16("a", { href, children: label }, href))
  ] });
}

// source/web/features/report/components/TopicTable.tsx
import { jsx as jsx17, jsxs as jsxs17 } from "react/jsx-runtime";
function TopicTable({ display, topics }) {
  return /* @__PURE__ */ jsxs17("section", { className: "topic-section", id: "topics", children: [
    /* @__PURE__ */ jsxs17("header", { className: "section-heading section-heading--split", children: [
      /* @__PURE__ */ jsxs17("div", { children: [
        /* @__PURE__ */ jsx17("p", { className: "eyebrow", children: "Topic-level detail" }),
        /* @__PURE__ */ jsx17("h2", { children: "\u4F5C\u54C1\u7EA7\u660E\u7EC6" })
      ] }),
      /* @__PURE__ */ jsxs17("p", { className: "display-count", children: [
        "\u5C55\u793A ",
        /* @__PURE__ */ jsx17("strong", { children: formatInteger(display.displayed) }),
        /* @__PURE__ */ jsx17("span", { "aria-hidden": "true", children: " / " }),
        "\u5171 ",
        formatInteger(display.total)
      ] })
    ] }),
    display.truncated ? /* @__PURE__ */ jsxs17("p", { className: "truncation-note", role: "note", children: [
      "\u5F53\u524D\u62A5\u544A\u53EA\u5C55\u793A\u6392\u5E8F\u540E\u7684\u524D ",
      formatInteger(display.displayed),
      " \u4E2A\u4F5C\u54C1\uFF0C\u5171",
      " ",
      formatInteger(display.total),
      " \u4E2A\uFF1B\u5B8C\u6574\u7EDF\u8BA1\u4ECD\u4FDD\u7559\u5728\u6570\u636E\u4EA7\u7269\u4E2D\u3002"
    ] }) : null,
    topics.length === 0 ? /* @__PURE__ */ jsxs17("div", { className: "empty-state", children: [
      /* @__PURE__ */ jsx17("strong", { children: "\u5F53\u524D\u6CA1\u6709\u53EF\u5C55\u793A\u7684\u4F5C\u54C1\u660E\u7EC6" }),
      /* @__PURE__ */ jsx17("p", { children: "\u62A5\u544A\u4ECD\u53EF\u67E5\u770B\u603B\u4F53\u5206\u5E03\u3001\u65B9\u6CD5\u8FB9\u754C\u4E0E\u8BC1\u636E\u3002" })
    ] }) : /* @__PURE__ */ jsx17(
      "div",
      {
        className: "table-wrap",
        tabIndex: 0,
        "aria-label": "\u4F5C\u54C1\u7EA7\u660E\u7EC6\u8868\uFF0C\u53EF\u6A2A\u5411\u6EDA\u52A8",
        children: /* @__PURE__ */ jsxs17("table", { children: [
          /* @__PURE__ */ jsx17("caption", { className: "sr-only", children: "\u4F5C\u54C1\u7EA7\u8BC4\u8BBA\u3001\u76F8\u5173\u6027\u3001\u60C5\u7EEA\u4E0E\u6B63\u8D1F\u60C5\u7EEA\u5747\u8861\u660E\u7EC6" }),
          /* @__PURE__ */ jsx17("thead", { children: /* @__PURE__ */ jsxs17("tr", { children: [
            /* @__PURE__ */ jsx17("th", { scope: "col", children: "\u4F5C\u54C1" }),
            /* @__PURE__ */ jsx17("th", { scope: "col", children: "\u5FEB\u7167\u8BC4\u8BBA" }),
            /* @__PURE__ */ jsx17("th", { scope: "col", children: "\u76F8\u5173" }),
            /* @__PURE__ */ jsx17("th", { scope: "col", children: "\u6B63\u9762" }),
            /* @__PURE__ */ jsx17("th", { scope: "col", children: "\u8D1F\u9762" }),
            /* @__PURE__ */ jsx17("th", { scope: "col", children: "\u6B63\u8D1F\u60C5\u7EEA\u5747\u8861" })
          ] }) }),
          /* @__PURE__ */ jsx17("tbody", { children: topics.map((topic) => {
            const url = safeExternalUrl(topic.url);
            return /* @__PURE__ */ jsxs17("tr", { children: [
              /* @__PURE__ */ jsx17("th", { scope: "row", children: url ? /* @__PURE__ */ jsx17(
                "a",
                {
                  href: url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  children: topic.title
                }
              ) : topic.title }),
              /* @__PURE__ */ jsx17("td", { children: formatInteger(topic.snapshot_comments) }),
              /* @__PURE__ */ jsx17("td", { children: formatInteger(topic.labeled_relevant) }),
              /* @__PURE__ */ jsx17("td", { className: "cell-pos", children: formatPercent(topic.positive_pct) }),
              /* @__PURE__ */ jsx17("td", { className: "cell-neg", children: formatPercent(topic.negative_pct) }),
              /* @__PURE__ */ jsx17("td", { children: /* @__PURE__ */ jsxs17("span", { className: "contro-cell", children: [
                /* @__PURE__ */ jsx17("span", { className: "contro-bar", "aria-hidden": "true", children: /* @__PURE__ */ jsx17(
                  "span",
                  {
                    style: {
                      width: `${Math.max(0, Math.min(100, topic.controversy_score))}%`
                    }
                  }
                ) }),
                topic.controversy_score.toFixed(1)
              ] }) })
            ] }, topic.topic_id);
          }) })
        ] })
      }
    ),
    /* @__PURE__ */ jsx17("p", { className: "table-note", children: "\u6B63\u9762\u3001\u8D1F\u9762\u7684\u5206\u6BCD\u4E3A\u5404\u4F5C\u54C1\u7684\u76F8\u5173\u8BC4\u8BBA\u3002\u6B63\u8D1F\u60C5\u7EEA\u5747\u8861 = 200 \xD7 min(\u6B63\u9762\u6570, \u8D1F\u9762\u6570) / (\u6B63\u9762\u6570 + \u8D1F\u9762\u6570)\uFF0C\u65E0\u6B63\u8D1F\u8BC4\u8BBA\u65F6\u4E3A 0\uFF1B\u4E0D\u542B\u4E2D\u6027\u8BC4\u8BBA\uFF0C\u4E0D\u8868\u793A\u4E89\u8BAE\u4EBA\u6570\u5360\u6BD4\u6216\u4E89\u8BAE\u5F3A\u5EA6\u3002" })
  ] });
}

// source/web/features/report/components/TimelineTable.tsx
import { jsx as jsx18, jsxs as jsxs18 } from "react/jsx-runtime";
function TimelineTable({ points }) {
  if (points.length < 2) return null;
  return /* @__PURE__ */ jsxs18("section", { className: "timeline-section", id: "timeline", children: [
    /* @__PURE__ */ jsxs18("header", { className: "section-heading section-heading--split", children: [
      /* @__PURE__ */ jsxs18("div", { children: [
        /* @__PURE__ */ jsx18("p", { className: "eyebrow", children: "Dated slices" }),
        /* @__PURE__ */ jsx18("h2", { children: "\u8BC4\u8BBA\u65E5\u671F\u5207\u7247" })
      ] }),
      /* @__PURE__ */ jsxs18("p", { className: "display-count", children: [
        "\u5C55\u793A ",
        formatInteger(points.length),
        " \u4E2A\u65E5\u671F\u5207\u7247"
      ] })
    ] }),
    /* @__PURE__ */ jsx18("p", { className: "timeline-boundary", children: "\u65E5\u671F\u6765\u81EA\u5F53\u524D\u5FEB\u7167\u4E2D\u7684\u8BC4\u8BBA\u65F6\u95F4\uFF1B\u4E0D\u80FD\u4EC5\u51ED\u8FD9\u4E9B\u5207\u7247\u5224\u65AD\u589E\u957F\u3001\u4E0B\u964D\u6216\u6301\u7EED\u6027\u3002" }),
    /* @__PURE__ */ jsx18("div", { className: "table-wrap", children: /* @__PURE__ */ jsxs18("table", { children: [
      /* @__PURE__ */ jsx18("thead", { children: /* @__PURE__ */ jsxs18("tr", { children: [
        /* @__PURE__ */ jsx18("th", { scope: "col", children: "\u65E5\u671F" }),
        /* @__PURE__ */ jsx18("th", { scope: "col", children: "\u5DF2\u6807\u6CE8" }),
        /* @__PURE__ */ jsx18("th", { scope: "col", children: "\u76F8\u5173" }),
        /* @__PURE__ */ jsx18("th", { scope: "col", children: "\u6B63\u9762" }),
        /* @__PURE__ */ jsx18("th", { scope: "col", children: "\u8D1F\u9762" }),
        /* @__PURE__ */ jsx18("th", { scope: "col", children: "\u4E2D\u6027" }),
        /* @__PURE__ */ jsx18("th", { scope: "col", children: "\u6DF7\u5408" })
      ] }) }),
      /* @__PURE__ */ jsx18("tbody", { children: points.map((point) => /* @__PURE__ */ jsxs18("tr", { children: [
        /* @__PURE__ */ jsx18("th", { scope: "row", children: point.date }),
        /* @__PURE__ */ jsx18("td", { children: formatInteger(point.labeled_comments) }),
        /* @__PURE__ */ jsx18("td", { children: formatInteger(point.relevant_comments) }),
        /* @__PURE__ */ jsx18("td", { children: formatInteger(point.positive) }),
        /* @__PURE__ */ jsx18("td", { children: formatInteger(point.negative) }),
        /* @__PURE__ */ jsx18("td", { children: formatInteger(point.neutral) }),
        /* @__PURE__ */ jsx18("td", { children: formatInteger(point.mixed) })
      ] }, point.date)) })
    ] }) })
  ] });
}

// source/web/features/report/ReportPage.tsx
import { Fragment as Fragment3, jsx as jsx19, jsxs as jsxs19 } from "react/jsx-runtime";
function ReportPage({ report, interactive = false }) {
  const statisticsOnly = report.status.statistics_only === true;
  const hostFacts = report.statistical_narrative === "host-facts-v1";
  const distributions = report.distributions.filter((group) => group.items.some((item) => item.count > 0));
  const hasAnalysis = Boolean(report.analysis?.groups.some((group) => group.rows.length));
  const relationCount = report.comparison_relations?.length ?? 0;
  const hasComparisons = report.comparisons.length > 0 || relationCount > 0;
  const aspectLabels2 = Object.fromEntries([
    ...report.rankings.find((group) => group.id === "aspects")?.items.map((item) => [item.key, item.label]) ?? [],
    ...report.analysis?.groups.find((group) => group.id === "aspect")?.rows.map((row) => [row.key, row.label]) ?? []
  ]);
  return /* @__PURE__ */ jsxs19(Fragment3, { children: [
    /* @__PURE__ */ jsx19("a", { className: "skip-link", href: statisticsOnly ? "#evidence" : "#analysis", children: statisticsOnly ? "\u8DF3\u5230\u539F\u6587\u6837\u672C" : "\u8DF3\u5230\u5206\u6790\u7ED3\u8BBA" }),
    /* @__PURE__ */ jsxs19("main", { className: `report-shell${interactive ? " report-shell--interactive" : ""}`, children: [
      /* @__PURE__ */ jsx19(ReportHeader, { identity: report.identity, status: report.status }),
      /* @__PURE__ */ jsx19(KpiStrip, { coverage: report.coverage }),
      /* @__PURE__ */ jsx19(ReportBoundary, { report }),
      /* @__PURE__ */ jsx19(SectionNav, { showAnalysis: !statisticsOnly, showCrossAnalysis: hasAnalysis, showComparisons: hasComparisons, showDistributions: distributions.length > 0, showPlatforms: report.platforms.length >= 2, showSignals: report.rankings.length > 0, showTimeline: report.timeline.length >= 2 }),
      !statisticsOnly && /* @__PURE__ */ jsxs19(Fragment3, { children: [
        /* @__PURE__ */ jsxs19("p", { className: "interpretation-note", children: [
          "\u4EE5\u4E0B\u4E3A\u6807\u7B7E\u4E0E\u539F\u6587\u8BC1\u636E\u7684\u6574\u7406",
          report.status.degraded ? "\uFF0C\u5C1A\u672A\u5B8C\u6210\u6A21\u578B\u8BED\u4E49\u590D\u6838" : "",
          "\u3002\u5148\u8BFB\u539F\u6587\uFF0C\u518D\u5224\u65AD\u89E3\u91CA\uFF1B\u5355\u6761\u6837\u4F8B\u4E0D\u4EE3\u8868\u4E3B\u9898\u9891\u7387\u3002"
        ] }),
        /* @__PURE__ */ jsx19(Narrative, { sections: report.sections.filter((section) => section.id === "subject-insights"), evidence: report.evidence, title: "\u5177\u4F53\u89C2\u70B9\u4E0E\u8BC4\u8BBA\u539F\u6587", compactExplanations: true })
      ] }),
      hasAnalysis && report.analysis && /* @__PURE__ */ jsx19(CrossAnalysis, { analysis: report.analysis, relevantCount: report.coverage.relevant_comments, interactive }),
      /* @__PURE__ */ jsx19(EvidenceGrid, { evidence: report.evidence, relevantCount: report.coverage.relevant_comments, interactive, aspectLabels: aspectLabels2 }),
      /* @__PURE__ */ jsxs19("div", { className: "report-detail-heading", children: [
        /* @__PURE__ */ jsx19("h2", { children: "\u6838\u5BF9\u7EDF\u8BA1\u4E0E\u6765\u6E90" }),
        /* @__PURE__ */ jsx19("p", { children: "\u9700\u8981\u5224\u65AD\u5360\u6BD4\u3001\u8DE8\u4F5C\u54C1\u5DEE\u5F02\u6216\u91C7\u6837\u8303\u56F4\u65F6\uFF0C\u5C55\u5F00\u4EE5\u4E0B\u660E\u7EC6\u3002" })
      ] }),
      distributions.length > 0 && /* @__PURE__ */ jsxs19("details", { className: "report-detail", children: [
        /* @__PURE__ */ jsxs19("summary", { children: [
          /* @__PURE__ */ jsx19("span", { children: "\u603B\u4F53\u5206\u5E03" }),
          /* @__PURE__ */ jsx19("small", { children: "\u60C5\u7EEA\u3001\u7ACB\u573A\u3001\u8BC4\u8BBA\u610F\u56FE\u4E0E\u8BC4\u4EF7\u5BF9\u8C61" })
        ] }),
        /* @__PURE__ */ jsx19(DistributionGrid, { groups: distributions, relevantCount: report.coverage.relevant_comments })
      ] }),
      report.rankings.length > 0 && /* @__PURE__ */ jsxs19("details", { className: "report-detail", children: [
        /* @__PURE__ */ jsxs19("summary", { children: [
          /* @__PURE__ */ jsx19("span", { children: "\u8BA8\u8BBA\u7126\u70B9\u4E0E\u60C5\u7EEA\u4FE1\u53F7" }),
          /* @__PURE__ */ jsx19("small", { children: "\u65B9\u9762\u3001\u60C5\u7EEA\u4E0E\u63D0\u53CA\u5BF9\u8C61\u7684\u6807\u7B7E\u9891\u7387" })
        ] }),
        /* @__PURE__ */ jsx19(RankingGrid, { groups: report.rankings })
      ] }),
      report.platforms.length >= 2 && /* @__PURE__ */ jsxs19("details", { className: "report-detail", children: [
        /* @__PURE__ */ jsxs19("summary", { children: [
          /* @__PURE__ */ jsx19("span", { children: "\u5E73\u53F0\u5DEE\u5F02" }),
          /* @__PURE__ */ jsxs19("small", { children: [
            report.platforms.length,
            " \u4E2A\u5E73\u53F0\u7684\u6837\u672C\u4E0E\u60C5\u7EEA"
          ] })
        ] }),
        /* @__PURE__ */ jsx19(PlatformComparison, { platforms: report.platforms })
      ] }),
      hasComparisons && /* @__PURE__ */ jsx19(ComparisonDisclosure, { rows: report.comparisons, relations: report.comparison_relations }),
      report.timeline.length >= 2 && /* @__PURE__ */ jsxs19("details", { className: "report-detail", children: [
        /* @__PURE__ */ jsxs19("summary", { children: [
          /* @__PURE__ */ jsx19("span", { children: "\u8BC4\u8BBA\u65E5\u671F\u5207\u7247" }),
          /* @__PURE__ */ jsxs19("small", { children: [
            report.timeline.length,
            " \u4E2A\u65E5\u671F\u7684\u6837\u672C\u5206\u5E03"
          ] })
        ] }),
        /* @__PURE__ */ jsx19(TimelineTable, { points: report.timeline })
      ] }),
      /* @__PURE__ */ jsxs19("details", { className: "report-detail", children: [
        /* @__PURE__ */ jsxs19("summary", { children: [
          /* @__PURE__ */ jsx19("span", { children: "\u4F5C\u54C1\u7EA7\u660E\u7EC6" }),
          /* @__PURE__ */ jsxs19("small", { children: [
            report.topic_display.total,
            " \u4E2A\u4F5C\u54C1\u7684\u8BC4\u8BBA\u91CF\u3001\u76F8\u5173\u6027\u4E0E\u60C5\u7EEA"
          ] })
        ] }),
        /* @__PURE__ */ jsx19(TopicTable, { display: report.topic_display, topics: report.topics })
      ] }),
      !statisticsOnly && /* @__PURE__ */ jsxs19("details", { className: "report-appendix", children: [
        /* @__PURE__ */ jsx19("summary", { children: hostFacts ? "\u4E8B\u5B9E\u9009\u6458\u4E0E\u884C\u52A8\u5EFA\u8BAE" : "\u539F\u59CB\u6A21\u578B\u6458\u8981\u3001\u7EDF\u8BA1\u89E3\u8BFB\u4E0E\u5EFA\u8BAE" }),
        /* @__PURE__ */ jsx19("p", { className: "table-note", children: hostFacts ? "\u7EDF\u8BA1\u7531\u6A21\u578B\u9009\u53D6\u4E8B\u5B9E\u7F16\u53F7\uFF0C\u7A0B\u5E8F\u6309\u539F\u53E3\u5F84\u76F4\u63A5\u5448\u73B0\uFF1B\u884C\u52A8\u5EFA\u8BAE\u7531\u6A21\u578B\u63D0\u51FA\u3002\u5206\u7C7B\u6807\u7B7E\u548C\u5EFA\u8BAE\u4ECD\u9700\u7ED3\u5408\u539F\u6587\u6838\u67E5\u3002" : "\u4FDD\u7559\u751F\u6210\u65F6\u7684\u539F\u59CB\u5185\u5BB9\u4F9B\u6838\u67E5\uFF1B\u4E0D\u5C06\u5206\u7C7B\u6807\u7B7E\u76F4\u63A5\u89C6\u4E3A\u5DF2\u8BC1\u5B9E\u7684\u7ED3\u8BBA\u3002" }),
        /* @__PURE__ */ jsx19(Narrative, { sections: report.sections.filter((section) => !["subject-insights", "method"].includes(section.id)), evidence: report.evidence, id: "takeaways", title: hostFacts ? "\u4E8B\u5B9E\u9009\u6458\u4E0E\u5F85\u6838\u52A8\u4F5C" : "\u539F\u59CB\u89E3\u8BFB" })
      ] }),
      /* @__PURE__ */ jsxs19("details", { className: "report-appendix", id: "method", children: [
        /* @__PURE__ */ jsx19("summary", { children: "\u6837\u672C\u4E0E\u7814\u7A76\u65B9\u6CD5" }),
        /* @__PURE__ */ jsxs19("p", { className: "table-note", children: [
          "\u5E73\u5747\u60C5\u7EEA\u5206 ",
          report.coverage.avg_sentiment_score.toFixed(3),
          "\uFF0C\u4E3A\u76F8\u5173\u8BC4\u8BBA\u7684\u6A21\u578B\u8BC4\u5206\u5747\u503C\uFF0C\u8303\u56F4 \u22121 \u81F3 +1\uFF0C\u4E0D\u662F\u6EE1\u610F\u5EA6\u3002"
        ] }),
        /* @__PURE__ */ jsx19(Narrative, { sections: report.sections.filter((section) => section.id === "method"), evidence: report.evidence, id: "method-content", title: "\u6837\u672C\u4E0E\u65B9\u6CD5" })
      ] }),
      /* @__PURE__ */ jsx19(ReportFooter, { note: report.footer_note })
    ] })
  ] });
}

// source/styles.css
var styles_default = ':root{--lightningcss-light:initial;--lightningcss-dark: ;color-scheme:light;--text-xs:.75rem;--text-sm:.8125rem;--text-base:.9375rem;--text-lg:1.125rem;--text-xl:clamp(1.5rem, 2.2vw, 2rem);--text-display:clamp(2.4rem, 5vw, 3.875rem);--text-kpi:clamp(1.9rem, 3vw, 2.5rem);--space-1:.25rem;--space-2:.5rem;--space-3:.75rem;--space-4:1rem;--space-5:1.25rem;--space-6:1.5rem;--space-8:2rem;--space-10:2.5rem;--space-12:3rem;--space-16:4rem;--content-width:77.5rem;--reading-width:72ch;--motion-fast:.18s;--ease-out:cubic-bezier(.16, 1, .3, 1);--layer-sticky:20}:is([data-theme=modernist],[data-theme=organic]:has(.theme-switch:checked)){--bg:#f3f2f2;--ink:#201e1d;--ink-soft:#444141;--ink-mute:#605d5d;--ink-faint:#8a8585;--accent:#ec3013;--accent-deep:#ae1800;--seg-positive:#ec3013;--seg-negative:#2d2b2b;--seg-neutral:#bab6b6;--seg-mixed:#ffc4b8;--seg-primary:#ec3013;--hairline:#d7d3d3;--track:#eae7e7;--hover:#ffe0d9;--tone-pos-bg:#ec3013;--tone-pos-fg:#fff;--tone-neg-bg:#2d2b2b;--tone-neg-fg:#fff;--font-sans:Archivo, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;--font-disp:var(--font-sans);--font-mono:ui-monospace, "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace;--disp-weight:800;--panel-bg:transparent;--panel-radius:0;--panel-pad:var(--space-8) 0 var(--space-6);--panel-pad-sm:var(--space-5) 0;--panel-radius-sm:0;--panel-shadow:none;--section-rule:2px solid var(--ink);--footer-border:2px solid var(--ink);--radius-sm:0;--radius-md:0;--radius-pill:0;--brand-size:.875rem;--brand-radius:0;--seal-bg:transparent;--seal-fg:var(--ink);--seal-border:2px solid var(--ink);--seal-radius:0;--mchip-border:2px solid var(--ink);--mchip-bg:transparent;--mchip-fg:var(--ink-soft);--mchip-radius:0;--aside-border-top:2px solid var(--ink);--aside-bg:transparent;--aside-radius:0;--aside-pad:var(--space-4) 0 0;--idchip-bg:transparent;--idchip-radius:0;--idchip-pad:0;--notice-bg:transparent;--notice-warn-bg:transparent;--notice-border-top:1px solid var(--hairline);--notice-radius:0;--notice-px:0;--bar-h:3.25rem;--bar-radius:0;--nav-bg:var(--bg);--nav-border:2px solid var(--ink);--nav-radius:0;--kpi-gap:0;--kpi-bg:transparent;--kpi-radius:0;--kpi-shadow:none;--kpi-rule:2px solid var(--ink);--kpi-hover:var(--hover);--legend-border-top:1px solid var(--hairline);--legend-bg:transparent;--legend-radius:0;--legend-pad:var(--space-3) 0 0;--legend-align:baseline;--contro-fill:var(--ink);--cell-pos-fg:var(--accent-deep);--cell-neg-fg:var(--ink);--thead-border:2px solid var(--ink);--tn-border-left:2px solid var(--accent-deep);--tn-radius:0;--quote-bg:transparent;--quote-border-block:1px solid var(--hairline);--quote-radius:0;--quote-px:0;--ref-border:1px solid var(--ink);--ref-bg:transparent;--ref-fg:var(--ink);--ev-grid-gap:2px;--ev-grid-bg:var(--ink);--ev-grid-border:2px solid var(--ink);--ev-card-bg:var(--bg);--chip-border:1px solid var(--ink);--chip-bg:transparent;--chip-fg:var(--ink);--evid-border:2px solid var(--ink);--evid-bg:transparent;--evid-fg:var(--ink);--review-ok-bg:transparent;--review-ok-fg:var(--ink);--review-ok-border:2px solid var(--ink);--review-warn-bg:transparent;--review-warn-fg:var(--accent-deep);--review-warn-border:2px solid var(--accent-deep);--print-panel-border:0 solid transparent;--toggle-bg:var(--ink);--toggle-fg:var(--bg);--toggle-border:0 solid transparent;--toggle-radius:0;--toggle-shadow:none}:is([data-theme=organic],[data-theme=modernist]:has(.theme-switch:checked)){--bg:#f5ead8;--card:#ebddc5;--inset:#f9f4ed;--sage-bg:#e1eecc;--sage-fg:#56633f;--ink:#201e1d;--ink-soft:#474238;--ink-mute:#645c50;--ink-faint:#8a8073;--accent:#c67139;--accent-deep:#8c491a;--seg-positive:#8fa073;--seg-negative:#b2622d;--seg-neutral:#c0b6a5;--seg-mixed:#ffc6a5;--seg-primary:#c67139;--hairline:#dcd3c4;--track:#f9f4ed;--hover:#f4e8d2;--tone-pos-bg:#e1eecc;--tone-pos-fg:#56633f;--tone-neg-bg:#ffe1d0;--tone-neg-fg:#8c491a;--font-sans:Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;--font-disp:Caprasimo, Georgia, "Times New Roman", "Songti SC", "STSong", "SimSun", serif;--font-mono:ui-monospace, "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace;--disp-weight:700;--panel-bg:var(--card);--panel-radius:1.75rem;--panel-pad:var(--space-8);--panel-pad-sm:var(--space-5);--panel-radius-sm:1.25rem;--panel-shadow:none;--section-rule:0 solid transparent;--footer-border:1px solid var(--hairline);--radius-sm:.5rem;--radius-md:1rem;--radius-pill:999px;--brand-size:1.375rem;--brand-radius:50%;--seal-bg:var(--sage-bg);--seal-fg:var(--sage-fg);--seal-border:0 solid transparent;--seal-radius:999px;--mchip-border:0 solid transparent;--mchip-bg:var(--inset);--mchip-fg:var(--ink-soft);--mchip-radius:999px;--aside-border-top:0 solid transparent;--aside-bg:var(--inset);--aside-radius:1rem;--aside-pad:var(--space-5);--idchip-bg:var(--card);--idchip-radius:999px;--idchip-pad:.25rem .75rem;--notice-bg:var(--inset);--notice-warn-bg:var(--tone-neg-bg);--notice-border-top:0 solid transparent;--notice-radius:1rem;--notice-px:var(--space-4);--bar-h:2.75rem;--bar-radius:999px;--nav-bg:var(--card);--nav-border:0 solid transparent;--nav-radius:999px;--kpi-gap:var(--space-4);--kpi-bg:var(--card);--kpi-radius:1.75rem;--kpi-shadow:0 1px 2px #2e2b2524;--kpi-rule:0 solid transparent;--kpi-hover:var(--hover);--legend-border-top:0 solid transparent;--legend-bg:var(--inset);--legend-radius:999px;--legend-pad:var(--space-2) var(--space-4);--legend-align:center;--contro-fill:var(--seg-positive);--cell-pos-fg:var(--accent-deep);--cell-neg-fg:#b2622d;--thead-border:1px solid var(--hairline);--tn-border-left:0 solid transparent;--tn-radius:1rem;--quote-bg:var(--inset);--quote-border-block:0 solid transparent;--quote-radius:1rem;--quote-px:var(--space-5);--ref-border:0 solid transparent;--ref-bg:var(--sage-bg);--ref-fg:var(--sage-fg);--ev-grid-gap:var(--space-4);--ev-grid-bg:transparent;--ev-grid-border:0 solid transparent;--ev-card-bg:var(--inset);--chip-border:0 solid transparent;--chip-bg:var(--card);--chip-fg:var(--ink-soft);--evid-border:0 solid transparent;--evid-bg:var(--sage-bg);--evid-fg:var(--sage-fg);--review-ok-bg:var(--sage-bg);--review-ok-fg:var(--sage-fg);--review-ok-border:0 solid transparent;--review-warn-bg:var(--tone-neg-bg);--review-warn-fg:var(--tone-neg-fg);--review-warn-border:0 solid transparent;--print-panel-border:1px solid var(--hairline);--toggle-bg:var(--card);--toggle-fg:var(--ink);--toggle-border:0 solid transparent;--toggle-radius:999px;--toggle-shadow:0 1px 2px #2e2b2524}*,:before,:after{box-sizing:border-box}html{background:var(--bg);scroll-behavior:smooth;-webkit-text-size-adjust:100%;-moz-text-size-adjust:100%;text-size-adjust:100%}body{background:var(--bg);min-width:20rem;color:var(--ink);font-family:var(--font-sans);font-size:var(--text-base);text-rendering:optimizelegibility;margin:0;line-height:1.6}a{color:var(--accent);text-underline-offset:.2em;transition:color var(--motion-fast) var(--ease-out), background-color var(--motion-fast) var(--ease-out);text-decoration-thickness:1px}a:hover{color:var(--accent-deep)}a:focus-visible,[tabindex]:focus-visible{outline:3px solid var(--accent);outline-offset:3px}h1,h2,h3,p,blockquote,dl,dd{margin:0}h1,h2,h3{color:var(--ink);font-family:var(--font-disp);font-weight:var(--disp-weight)}button,input,textarea,select{font:inherit}code{background:var(--track);font-family:var(--font-mono);padding:.12em .35em;font-size:.88em}section[id],article[id]{scroll-margin-top:6rem}.skip-link{top:var(--space-3);left:var(--space-3);z-index:calc(var(--layer-sticky) + 1);background:var(--ink);color:var(--bg);padding:var(--space-3) var(--space-4);font-weight:700;text-decoration:none;position:fixed;translate:0 -180%}.skip-link:focus{translate:0}.sr-only{clip:rect(0, 0, 0, 0);clip-path:inset(50%);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}.eyebrow{color:var(--accent-deep);font-size:var(--text-xs);letter-spacing:.12em;text-transform:uppercase;font-weight:800}.text-link{align-items:center;min-height:2.75rem;font-weight:700;display:inline-flex}@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,:before,:after{scroll-behavior:auto!important;transition-duration:.01ms!important}}.report-shell{width:min(var(--content-width), calc(100% - 2rem));margin:0 auto}.report-header{padding:var(--space-6) 0 var(--space-8)}.topbar{justify-content:space-between;align-items:center;gap:var(--space-3);flex-wrap:wrap;display:flex}.topbar__meta{align-items:center;gap:var(--space-3);display:flex}.brand-mark{width:var(--brand-size);height:var(--brand-size);border-radius:var(--brand-radius);background:var(--accent);flex:none}.topbar__brand{letter-spacing:.04em;font-weight:800}.mode-chip{border:var(--mchip-border);border-radius:var(--mchip-radius);background:var(--mchip-bg);color:var(--mchip-fg);font-size:var(--text-xs);padding:.15rem .6rem;font-weight:700}.topbar__side{align-items:center;gap:var(--space-3);flex-wrap:wrap;display:flex}.topbar__side time{color:var(--ink-mute);font-size:var(--text-sm);font-variant-numeric:tabular-nums}.seal-badge{border:var(--seal-border);border-radius:var(--seal-radius);background:var(--seal-bg);color:var(--seal-fg);letter-spacing:.1em;padding:.3rem .7rem;font-size:.68rem;font-weight:800}.seal-badge--open{border-color:var(--accent-deep);background:var(--tone-neg-bg);color:var(--tone-neg-fg)}.review-state{align-items:center;gap:var(--space-2);border-radius:var(--seal-radius);font-size:var(--text-xs);padding:.3rem .7rem;font-weight:700;display:inline-flex}.review-state__mark{border-radius:var(--brand-radius);background:currentColor;flex:none;width:.5rem;height:.5rem}.review-state--accepted{border:var(--review-ok-border);background:var(--review-ok-bg);color:var(--review-ok-fg)}.review-state--accepted .review-state__mark{background:var(--accent)}.review-state--warning,.review-state--partial{border:var(--review-warn-border);background:var(--review-warn-bg);color:var(--review-warn-fg)}.report-header__main{align-items:end;gap:var(--space-8);margin-top:var(--space-8);grid-template-columns:minmax(0,3fr) minmax(0,2fr);display:grid}.report-title{font-size:var(--text-display);letter-spacing:-.02em;line-height:1.05}.report-header__aside{gap:var(--space-4);border-top:var(--aside-border-top);border-radius:var(--aside-radius);background:var(--aside-bg);padding:var(--aside-pad);display:grid}.report-dek{color:var(--ink-soft);font-size:var(--text-base);line-height:1.55}.identity-list{gap:var(--space-2) var(--space-5);flex-wrap:wrap;display:flex}.identity-list>div{align-items:baseline;gap:var(--space-2);border-radius:var(--idchip-radius);background:var(--idchip-bg);min-width:0;padding:var(--idchip-pad);display:flex}.identity-list dt{color:var(--ink-mute);font-size:var(--text-xs);flex:none}.identity-list dd{overflow-wrap:anywhere;color:var(--ink-soft);font-family:var(--font-mono);font-size:var(--text-xs);font-weight:600}.notice-stack{gap:var(--space-2);margin:var(--space-4) 0;display:grid}.notice{align-items:baseline;gap:var(--space-3);border-top:var(--notice-border-top);border-radius:var(--notice-radius);background:var(--notice-bg);padding:var(--space-3) var(--notice-px);font-size:var(--text-sm);display:flex}.notice strong{font-size:var(--text-sm);flex:none}.notice p{color:var(--ink-soft)}.notice--boundary strong{color:var(--accent-deep)}.notice--warning,.notice--partial,.notice--review{background:var(--notice-warn-bg)}.notice--warning strong,.notice--partial strong,.notice--review strong{color:var(--accent-deep)}.section-nav{top:var(--space-3);z-index:var(--layer-sticky);align-items:center;gap:var(--space-1);margin:var(--space-4) 0 var(--space-6);border:var(--nav-border);border-radius:var(--nav-radius);background:var(--nav-bg);overscroll-behavior-inline:contain;padding:var(--space-1);scrollbar-width:thin;white-space:nowrap;display:flex;position:sticky;overflow-x:auto}.section-nav__label{color:var(--ink-mute);padding:0 var(--space-2) 0 var(--space-3);letter-spacing:.1em;text-transform:uppercase;font-size:.68rem;font-weight:800}.section-nav a{border-radius:var(--radius-pill);min-height:2.25rem;color:var(--ink-soft);font-size:var(--text-sm);align-items:center;padding:.35rem .85rem;font-weight:700;text-decoration:none;display:inline-flex}.section-nav a:hover{background:var(--hover);color:var(--ink)}.distribution-panel,.narrative,.topic-section,.platform-section,.evidence-section{border-radius:var(--panel-radius);background:var(--panel-bg);box-shadow:var(--panel-shadow)}.narrative,.topic-section,.platform-section,.evidence-section{border-top:var(--section-rule)}.report-footer{justify-content:space-between;align-items:baseline;gap:var(--space-6);margin-top:var(--space-8);border-top:var(--footer-border);padding:var(--space-4) 0 var(--space-12);color:var(--ink-mute);font-size:var(--text-xs);display:flex}.report-footer span{color:var(--ink);font-weight:800}.theme-switch{right:var(--space-4);bottom:var(--space-4);opacity:0;pointer-events:none;position:fixed}.theme-toggle{right:var(--space-4);bottom:var(--space-4);z-index:calc(var(--layer-sticky) + 1);align-items:center;gap:var(--space-2);border:var(--toggle-border);border-radius:var(--toggle-radius);background:var(--toggle-bg);box-shadow:var(--toggle-shadow);color:var(--toggle-fg);cursor:pointer;font-size:var(--text-xs);letter-spacing:.06em;padding:.55rem .9rem;font-weight:800;display:inline-flex;position:fixed}.theme-toggle__swatch{border-radius:var(--brand-radius);background:linear-gradient(135deg,#ec3013 50%,#c67139 50%);flex:none;width:.75rem;height:.75rem}.theme-switch:focus-visible+.theme-toggle{outline:3px solid var(--accent);outline-offset:2px}.preview-error{align-content:center;justify-items:start;width:min(62rem,100% - 2rem);min-height:100dvh;margin:0 auto;padding:clamp(2rem,8vw,6rem) 0;display:grid}.preview-error h1{max-width:18ch;margin:var(--space-3) 0 var(--space-5);font-size:var(--text-xl)}.preview-error>p:last-child{max-width:62ch;color:var(--ink-soft)}.report-subject{font-family:var(--font-sans);font-size:var(--text-sm);color:var(--ink-mute);margin-top:1rem;line-height:1.8}.report-question{max-width:64em;font-family:var(--font-sans);font-size:var(--text-base);color:var(--ink-soft);margin-top:1rem;line-height:1.8}.report-question>span{color:var(--ink-mute);font-size:var(--text-xs);margin-bottom:.25rem;display:block}.report-provenance summary{cursor:pointer;color:var(--ink-mute);font-size:var(--text-xs)}.report-provenance[open] .identity-list{margin-top:var(--space-3)}@media print{.report-provenance>.identity-list{display:flex}}.kpi-strip{margin:var(--space-4) 0 var(--space-6);border-left:var(--kpi-rule);gap:var(--kpi-gap);grid-template-columns:repeat(4,minmax(0,1fr));display:grid}.kpi{border-right:var(--kpi-rule);border-radius:var(--kpi-radius);background:var(--kpi-bg);min-width:0;box-shadow:var(--kpi-shadow);padding:var(--space-5) var(--space-5);transition:background-color var(--motion-fast) var(--ease-out)}.kpi:hover{background:var(--kpi-hover)}.kpi__label,.kpi__detail{color:var(--ink-mute);font-size:var(--text-xs);display:block}.kpi__label{font-weight:700}.kpi__value{margin:var(--space-2) 0 var(--space-1);font-family:var(--font-disp);font-size:var(--text-kpi);font-variant-numeric:tabular-nums;font-weight:var(--disp-weight);line-height:1.1;display:block}.kpi__value--positive{color:var(--cell-pos-fg)}.kpi__value--negative{color:var(--cell-neg-fg)}.distribution-grid{margin:var(--space-4) 0 var(--space-6);gap:var(--space-6);grid-template-columns:minmax(0,1fr) minmax(0,1fr);display:grid}.distribution-panel{padding:var(--panel-pad)}.distribution-panel h2{margin-top:var(--space-1);font-size:var(--text-xl)}.stacked-bar{height:var(--bar-h);margin-top:var(--space-6);border-radius:var(--bar-radius);background:var(--track);display:flex;overflow:hidden}.stacked-bar__seg{height:100%;display:block}.stacked-bar__seg--positive{background:var(--seg-positive)}.stacked-bar__seg--negative{background:var(--seg-negative)}.stacked-bar__seg--neutral{background:var(--seg-neutral)}.stacked-bar__seg--mixed{background:var(--seg-mixed)}.stacked-bar__seg--primary{background:var(--seg-primary)}.distribution-legend{margin:var(--space-5) 0 0;gap:var(--space-3) var(--space-6);grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr));padding:0;list-style:none;display:grid}.distribution-legend li{align-items:var(--legend-align);gap:var(--space-2);border-top:var(--legend-border-top);border-radius:var(--legend-radius);background:var(--legend-bg);min-width:0;padding:var(--legend-pad);display:flex}.legend-dot{border-radius:var(--brand-radius);flex:none;align-self:center;width:.625rem;height:.625rem}.legend-dot--positive{background:var(--seg-positive)}.legend-dot--negative{background:var(--seg-negative)}.legend-dot--neutral{background:var(--seg-neutral)}.legend-dot--mixed{background:var(--seg-mixed)}.legend-dot--primary{background:var(--seg-primary)}.legend-label{color:var(--ink-soft);font-weight:700}.distribution-legend strong{white-space:nowrap;font-family:var(--font-disp);font-size:var(--text-lg);font-variant-numeric:tabular-nums;font-weight:var(--disp-weight);margin-left:auto}.distribution-legend--bars li{grid-template-columns:minmax(0,1fr) auto auto;align-items:baseline;row-gap:.5rem;display:grid}.distribution-meter{background:var(--track);-webkit-print-color-adjust:exact;print-color-adjust:exact;border-radius:2px;grid-column:1/-1;height:4px;overflow:hidden}.distribution-meter>span{background:var(--seg-neutral);height:100%;display:block}.distribution-legend small{color:var(--ink-mute);font-size:var(--text-xs);font-variant-numeric:tabular-nums;white-space:nowrap}.quality-gate,.ranking-section,.comparison-section,.timeline-section{margin:var(--space-6) 0;padding:var(--panel-pad)}.quality-gate{border:1px solid var(--hairline);border-left:.45rem solid var(--accent);background:var(--panel-bg);box-shadow:var(--panel-shadow)}.quality-gate--insufficient{border-left-color:var(--seg-negative);background:var(--notice-warn-bg)}.quality-gate--limited{border-left-color:var(--seg-mixed)}.quality-gate__heading{justify-content:space-between;align-items:center;gap:var(--space-4);display:flex}.quality-gate__status{color:var(--ink-soft);font-size:var(--text-xs);border:1px solid;border-radius:999px;padding:.15rem .65rem;font-weight:800}.quality-gate h2{margin:var(--space-3) 0 var(--space-2);font-size:var(--text-xl)}.quality-gate p{max-width:var(--reading-width);color:var(--ink-soft)}.quality-gate ul{margin-bottom:0;padding-left:1.25rem}.ranking-grid{gap:var(--space-4);grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr));display:grid}.ranking-panel{border:1px solid var(--hairline);background:var(--inset);padding:var(--space-5)}.ranking-panel h3{margin:var(--space-1) 0}.ranking-panel header small,.ranking-panel li>small,.table-note,.timeline-boundary{color:var(--ink-mute);font-size:var(--text-xs)}.ranking-panel ol{margin:var(--space-5) 0 0;gap:var(--space-4);padding:0;list-style:none;display:grid}.ranking-panel__label{justify-content:space-between;gap:var(--space-3);display:flex}.ranking-panel__label strong{font-variant-numeric:tabular-nums}.ranking-panel__track{height:.35rem;margin:var(--space-2) 0;background:var(--track);display:block;overflow:hidden}.ranking-panel__track span{background:var(--accent);height:100%;display:block}.comparison-section table,.timeline-section table{min-width:42rem}.comparison-section td,.timeline-section td{font-variant-numeric:tabular-nums}.timeline-boundary{margin:calc(var(--space-3) * -1) 0 var(--space-5);border-left:2px solid var(--accent);padding-left:var(--space-3)}.table-note{margin-bottom:0}.section-heading{margin-bottom:var(--space-6)}.section-heading h2{margin-top:var(--space-1);font-size:var(--text-xl)}.section-heading--split{justify-content:space-between;align-items:flex-end;gap:var(--space-6);display:flex}.display-count{color:var(--ink-mute);font-size:var(--text-sm);font-variant-numeric:tabular-nums;flex:none}.display-count strong{color:var(--ink)}.narrative{margin:var(--space-6) 0;padding:var(--panel-pad);grid-template-columns:minmax(11rem,.32fr) minmax(0,1fr);display:grid}.narrative>.section-heading{padding-right:var(--space-8);align-self:start;position:sticky;top:6rem}.narrative__body{border-left:1px solid var(--hairline);padding-left:clamp(1.5rem,4vw,3rem)}.narrative-section{max-width:var(--reading-width);padding:0 0 var(--space-10)}.narrative-section+.narrative-section{border-top:1px solid var(--hairline);padding-top:var(--space-8)}.narrative-section:last-child{padding-bottom:0}.narrative-section h3{margin-bottom:var(--space-4);font-size:var(--text-lg)}.narrative-paragraph{color:var(--ink-soft)}.narrative-paragraph>*+*{margin-left:.28em}.fact-list,.action-list{margin:var(--space-4) 0 0;gap:var(--space-3);padding-left:1.3rem;display:grid}.fact-list li,.action-list li{color:var(--ink-soft);padding-left:var(--space-2)}.fact-list li::marker{color:var(--accent);font-weight:800}.action-list li::marker{color:var(--accent);font-weight:800}.action-list li::marker{font-family:var(--font-mono)}.evidence-ref,.narrative-evidence footer a{border:var(--ref-border);border-radius:var(--radius-sm);background:var(--ref-bg);color:var(--ref-fg);font-family:var(--font-mono);padding:.08em .28em;font-size:.86em;font-weight:700;text-decoration:none}.narrative-evidence{margin:var(--space-5) 0 0;border-block:var(--quote-border-block);border-radius:var(--quote-radius);background:var(--quote-bg);padding:var(--space-4) var(--quote-px)}.narrative-evidence p{color:var(--ink);font-family:var(--font-disp);font-size:var(--text-lg);font-weight:600;line-height:1.4}.narrative-evidence footer{align-items:center;gap:var(--space-2);margin-top:var(--space-3);color:var(--ink-mute);font-family:var(--font-mono);font-size:var(--text-xs);flex-wrap:wrap;display:flex}.topic-section,.platform-section,.evidence-section{margin:var(--space-6) 0;padding:var(--panel-pad)}.truncation-note{margin:calc(var(--space-4) * -1) 0 var(--space-6);border-left:var(--tn-border-left);border-radius:var(--tn-radius);background:var(--notice-warn-bg);color:var(--ink-soft);padding:var(--space-3) var(--space-4);font-size:var(--text-sm)}.table-wrap{overscroll-behavior-inline:contain;scrollbar-gutter:stable;max-width:100%;overflow:auto}table{border-collapse:collapse;width:100%;min-width:48rem;font-size:var(--text-sm)}th,td{border-bottom:1px solid var(--hairline);text-align:left;padding:.8rem .75rem}thead th{border-bottom:var(--thead-border);color:var(--ink-mute);font-size:var(--text-xs);white-space:nowrap;font-weight:700}tbody th{min-width:16rem;color:var(--ink-soft);font-weight:550}tbody td{font-variant-numeric:tabular-nums;white-space:nowrap}tbody tr{transition:background-color var(--motion-fast) var(--ease-out)}tbody tr:hover{background:var(--hover)}.cell-pos{color:var(--cell-pos-fg);font-weight:700}.cell-neg{color:var(--cell-neg-fg);font-weight:700}.contro-cell{align-items:center;gap:var(--space-2);display:inline-flex}.contro-bar{border-radius:var(--radius-pill);background:var(--track);width:4.75rem;height:.5rem;display:inline-block;overflow:hidden}.contro-bar>span{background:var(--contro-fill);height:100%;display:block}.evidence-section{margin-bottom:var(--space-12)}.evidence-grid{border:var(--ev-grid-border);background:var(--ev-grid-bg);gap:var(--ev-grid-gap);grid-template-columns:repeat(2,minmax(0,1fr));display:grid}.evidence-card{border-radius:var(--radius-md);background:var(--ev-card-bg);min-width:0;padding:var(--space-5);scroll-margin-top:6rem}.evidence-card__meta{align-items:center;gap:var(--space-2);flex-wrap:wrap;display:flex}.evidence-card__meta>*{border:var(--chip-border);border-radius:var(--radius-pill);background:var(--chip-bg);color:var(--chip-fg);padding:.2rem .55rem;font-size:.68rem;font-weight:700;line-height:1.5;text-decoration:none}.evidence-card__meta>.evidence-card__id{border:var(--evid-border);background:var(--evid-bg);color:var(--evid-fg);font-family:var(--font-mono);font-weight:800}.evidence-card__meta>.chip-tone--positive{border-color:var(--tone-pos-bg);background:var(--tone-pos-bg);color:var(--tone-pos-fg)}.evidence-card__meta>.chip-tone--negative{border-color:var(--tone-neg-bg);background:var(--tone-neg-bg);color:var(--tone-neg-fg)}.evidence-card blockquote{overflow-wrap:anywhere;margin:var(--space-4) 0;color:var(--ink);font-family:var(--font-disp);font-size:var(--text-lg);font-weight:600;line-height:1.4}.evidence-card footer{justify-content:space-between;align-items:flex-end;gap:var(--space-5);border-top:1px solid var(--hairline);padding-top:var(--space-3);color:var(--ink-mute);font-size:var(--text-xs);display:flex}.evidence-card footer>div{overflow-wrap:anywhere;min-width:0;display:grid}.evidence-card footer>a{white-space:nowrap;flex:none}.evidence-card footer small{color:var(--ink-mute)}.evidence-card__source-label{color:var(--ink-faint);letter-spacing:.08em;text-transform:uppercase;font-size:.65rem;font-weight:800}.source-unavailable{color:var(--ink-mute);flex:none}.empty-state{border-block:1px solid var(--hairline);color:var(--ink-soft);padding:var(--space-8) 0}.empty-state p{margin-top:var(--space-2);color:var(--ink-mute)}.report-boundary{border-left:3px solid var(--accent);background:var(--notice-bg);margin:16px 0 28px;padding:14px 18px;font-size:13px;line-height:1.8}.report-boundary>p{margin:0 0 6px}.report-boundary summary,.report-appendix>summary,.evidence-full-text summary{cursor:pointer;color:var(--ink-soft)}.report-boundary .quality-gate{margin-bottom:0}.readout-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;margin-top:22px;display:grid}.readout-item{border-top:2px solid var(--hairline);min-width:0;padding-top:16px}.readout-label,.readout-counts{color:var(--ink-mute);font-size:12px}.readout-item h3{flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:8px;margin:10px 0;font-size:17px;display:flex}.readout-item h3 strong{font-family:var(--font-sans);font-variant-numeric:tabular-nums;font-size:28px;font-weight:550}.readout-item h3 small{color:var(--ink-mute);font-size:12px;font-weight:400}.readout-item blockquote{margin:20px 0 12px;font-size:14px;line-height:1.85}.readout-item>a{color:var(--accent-deep);font-size:12px}.interpretation-note{color:var(--ink-soft);border-bottom:1px solid var(--hairline);padding:10px 0;font-size:13px}.report-appendix{border-top:1px solid var(--hairline);padding:20px 0}.report-appendix>summary{font-weight:600}.evidence-full-text{margin-bottom:16px;font-size:13px}.evidence-full-text p{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px 0;line-height:1.9}.evidence-source{min-width:0}.evidence-source summary{cursor:pointer;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.evidence-source p{line-height:1.8}.model-explanation{color:var(--ink-soft);margin:6px 0 12px;font-size:12px}.model-explanation summary{cursor:pointer}.evidence-card:focus,.evidence-ref:focus-visible,.readout-item a:focus-visible{outline:2px solid var(--accent);outline-offset:4px}@media (width<=700px){.readout-grid{grid-template-columns:1fr;gap:20px}}@media print{.readout-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.readout-item{break-inside:avoid}.report-boundary details::details-content{content-visibility:visible;display:block}.evidence-full-text::details-content{content-visibility:visible;display:block}.evidence-source::details-content{content-visibility:visible;display:block}#method::details-content{content-visibility:visible;display:block}.report-boundary details>:not(summary),.evidence-full-text>:not(summary),.evidence-source>:not(summary),#method>:not(summary){display:block!important}.model-explanation:not([open]),.report-appendix:not([open]):not(#method),.evidence-source summary{display:none}}.evidence-section{border-top:2px solid var(--ink);padding-top:24px}.evidence-scope{max-width:76ch;color:var(--ink-soft);margin:-8px 0 20px;font-size:13px;line-height:1.8}.evidence-explorer{background:var(--track);border-radius:8px;margin:0 0 24px;padding:20px}.evidence-explorer label{gap:7px;min-width:0;display:grid}.evidence-explorer label>span{color:var(--ink-soft);font-size:12px;font-weight:600}.evidence-explorer input,.evidence-explorer select{border:1px solid var(--hairline);background:var(--bg);width:100%;min-width:0;min-height:42px;color:var(--ink);border-radius:5px;padding:8px 11px;font-size:13px}.evidence-explorer input::placeholder{color:var(--ink-mute)}.evidence-search-row{grid-template-columns:minmax(0,1fr) 170px;gap:14px;display:grid}.evidence-filters{grid-template-columns:1fr 1fr 2fr;gap:14px;margin-top:14px;display:grid}.evidence-filters:has(label:nth-child(4)){grid-template-columns:1fr 1fr 2fr 1.2fr}.evidence-filter-status{color:var(--ink-soft);flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:8px;margin-top:15px;font-size:12px;display:flex}.evidence-filter-status button{color:var(--accent-deep);text-underline-offset:3px;cursor:pointer;background:0 0;border:0;font-size:12px;text-decoration:underline}.evidence-grid{background:0 0;border:0;align-items:start;gap:20px}.evidence-card{border:1px solid var(--hairline);background:var(--bg);padding:22px}.evidence-card[hidden]{display:none}.evidence-card:target{outline:2px solid var(--accent);outline-offset:3px}.evidence-card__meta>*{border:0;font-weight:500}.evidence-card__meta>.evidence-likes{background:0 0;margin-left:auto;padding-inline:0}.evidence-card blockquote{font-family:var(--font-sans);font-size:16px;font-weight:500;line-height:1.85}.evidence-classification{color:var(--ink-mute);flex-wrap:wrap;gap:5px 14px;margin-bottom:16px;font-size:11px;line-height:1.8;display:flex}.evidence-review-note{color:var(--accent-deep)}.evidence-more{color:var(--ink-mute);flex-wrap:wrap;justify-content:center;align-items:center;gap:12px;margin-top:24px;font-size:12px;display:flex}.evidence-more button,.evidence-section .empty-state button{border:1px solid var(--hairline);background:var(--bg);min-height:40px;color:var(--ink);cursor:pointer;border-radius:5px;padding:8px 16px}.evidence-more button:hover,.analysis-tabs button:hover{border-color:var(--accent);background:var(--hover)}.evidence-explorer :is(input,select,button):focus-visible,.analysis-tabs button:focus-visible,.evidence-more button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.cross-analysis{margin:30px 0 40px}.cross-analysis>.section-heading{margin-bottom:20px}.analysis-tabs{border-bottom:1px solid var(--hairline);gap:6px;padding-bottom:12px;display:flex}.analysis-tabs button{min-height:40px;color:var(--ink-soft);cursor:pointer;background:0 0;border:1px solid #0000;border-radius:5px;padding:8px 15px;font-size:13px;transition:background-color .16s}.analysis-tabs button[aria-pressed=true]{background:var(--ink);color:var(--bg)}.analysis-group{border-bottom:1px solid var(--hairline);padding:16px 0}.analysis-group[hidden]{display:none}.analysis-group>summary{cursor:pointer;font-size:15px;font-weight:600}.analysis-group>summary span{float:right;color:var(--ink-mute);font-size:12px;font-weight:400}.analysis-group>.table-note{margin:12px 0}.report-shell--interactive .analysis-group>summary{display:none}.cross-table{min-width:720px}.cross-table th,.cross-table td{padding:14px 10px}.cross-table tbody th{min-width:140px}.cross-table td strong{font-size:15px}.cross-table td>small{color:var(--ink-mute);font-size:11px;display:block}.cross-sentiment{gap:8px;font-size:11px;display:flex}.cross-bar{background:var(--track);border-radius:2px;width:100%;height:5px;margin-top:7px;display:flex;overflow:hidden}.cross-followups>span{font-size:11px;display:block}.cross-evidence{flex-wrap:wrap;gap:5px;max-width:150px;display:flex}.cross-evidence a{font-family:var(--font-mono);border:1px solid var(--hairline);white-space:nowrap;border-radius:3px;padding:4px 5px;font-size:11px}.sample-diagnostics{background:var(--track);border-radius:6px;margin-top:18px;padding:16px 20px;font-size:13px}.sample-diagnostics summary{cursor:pointer;font-weight:550}.sample-diagnostics dl{grid-template-columns:repeat(4,1fr);gap:20px;margin:18px 0;display:grid}.sample-diagnostics dt{color:var(--ink-soft);font-size:12px}.sample-diagnostics dd{font-variant-numeric:tabular-nums;font-size:24px}.sample-diagnostics small{color:var(--ink-mute);font-size:11px;display:block}.report-detail-heading{margin:40px 0 18px}.report-detail-heading h2{font-size:20px}.report-detail-heading p{color:var(--ink-mute);margin-top:7px;font-size:13px}.report-detail{border-top:1px solid var(--hairline);padding:18px 0}.report-detail>summary{cursor:pointer;color:var(--ink);font-size:14px;font-weight:600}.report-detail>summary small{color:var(--ink-mute);margin-left:16px;font-size:12px;font-weight:400}.report-detail[open]>summary{margin-bottom:12px}.report-detail .distribution-grid,.report-detail .ranking-section,.report-detail .topic-section,.report-detail .comparison-section,.report-detail .timeline-section{margin-top:8px}@media (width<=700px){.evidence-explorer{padding:14px}.evidence-search-row{grid-template-columns:minmax(0,1fr)}:is(.evidence-filters,.evidence-filters:has(label:nth-child(4))){grid-template-columns:repeat(2,minmax(0,1fr))}.evidence-filters>label:nth-child(3){grid-column:1/-1}.evidence-card{padding:18px}.evidence-card blockquote{font-size:15px}.sample-diagnostics dl{grid-template-columns:1fr 1fr;gap:16px}.analysis-tabs{flex-wrap:wrap}.analysis-tabs button{flex:1;padding-inline:8px}.report-detail>summary small{margin:6px 0 0 18px;display:block}}@media print{.evidence-explorer,.evidence-more,.analysis-tabs{display:none!important}.evidence-card[hidden],.analysis-group[hidden]{display:block!important}.analysis-group::details-content{content-visibility:visible;display:block}.report-detail::details-content{content-visibility:visible;display:block}.sample-diagnostics::details-content{content-visibility:visible;display:block}.analysis-group>:not(summary),.report-detail>:not(summary),.sample-diagnostics>:not(summary){display:block!important}.report-shell--interactive .analysis-group>summary{display:list-item}.evidence-card,.sample-diagnostics{break-inside:avoid}.cross-table{min-width:0;font-size:10px}.cross-table th,.cross-table td{padding:7px 5px}.cross-table tbody th{min-width:0}}.evidence-extra-filters{color:var(--ink-soft);margin-top:14px;font-size:12px}.evidence-extra-filters summary{cursor:pointer}.evidence-extra-filters .evidence-filters{grid-template-columns:repeat(2,minmax(0,1fr))}.evidence-filter-options{margin-top:15px}.evidence-filter-options>summary{color:var(--ink-soft);cursor:pointer;font-size:12px;font-weight:550}.evidence-filter-options>summary span{color:var(--ink-mute);margin-left:10px;font-weight:400}.comparison-sources{gap:10px;margin-top:18px;display:grid}.comparison-disclosure{scroll-margin-top:96px}.comparison-boundary{border-left:3px solid var(--hairline);background:var(--track);margin:12px 0;padding:12px 14px;line-height:1.8}.comparison-source{border:1px solid var(--hairline);overflow-wrap:anywhere;border-radius:10px;padding:14px 16px;scroll-margin-top:96px}.comparison-source>summary{cursor:pointer;font-weight:600}.comparison-source blockquote{border-left:3px solid var(--hairline);white-space:pre-wrap;margin:14px 0;padding-left:14px}.comparison-source__full{white-space:pre-wrap;overflow-wrap:anywhere}@media print{.comparison-boundary{break-after:avoid;display:block!important}.comparison-source,.comparison-source>details{display:block!important}.comparison-source::details-content{content-visibility:visible!important;display:block!important}.comparison-source details::details-content{content-visibility:visible!important;display:block!important}.comparison-source>:not(summary),.comparison-source details>:not(summary){display:block!important}}@media (width<=60rem){.kpi-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi:nth-child(n+3){border-top:var(--kpi-rule)}.narrative{grid-template-columns:1fr}.narrative>.section-heading{padding-right:0;position:static}.narrative__body{border-top:1px solid var(--hairline);padding-top:var(--space-8);border-left:0;padding-left:0}}@media (width<=47.9375rem){.report-shell{width:min(100% - 1.25rem,45rem)}.report-header{padding:var(--space-5) 0 var(--space-6)}.report-header__main{margin-top:var(--space-6);grid-template-columns:1fr;align-items:start}.notice{gap:var(--space-1);flex-direction:column}.section-nav{top:var(--space-2)}.section-nav__label{display:none}.kpi{padding:var(--space-4)}.distribution-grid,.evidence-grid{grid-template-columns:1fr}.distribution-panel,.narrative,.topic-section,.platform-section,.evidence-section{border-radius:var(--panel-radius-sm);padding:var(--panel-pad-sm)}.section-heading--split{align-items:flex-start;gap:var(--space-2);flex-direction:column}.evidence-card footer{align-items:flex-start;gap:var(--space-3);flex-direction:column}.report-footer{align-items:flex-start;gap:var(--space-2);flex-direction:column}}@media (width<=28rem){.kpi-strip,.distribution-legend{grid-template-columns:1fr}.kpi{border-top:var(--kpi-rule)}.kpi:first-child{border-top:0}.topbar__side{justify-content:flex-start;width:100%}}@media print{@page{size:A4;margin:14mm}html,body{font-size:10pt;background:#fff!important}[data-theme]{--bg:#fff;--card:#fff;--inset:#fff;--panel-bg:#fff;--panel-shadow:none;--kpi-shadow:none;--quote-bg:#fff;--notice-bg:#fff;--nav-bg:#fff;--track:#eee;--toggle-shadow:none}.skip-link,.section-nav,.theme-switch,.theme-toggle{display:none!important}.report-shell{width:100%}.report-header{padding-top:0}.report-header__aside,.notice,.kpi,.distribution-panel,.narrative,.topic-section,.platform-section,.evidence-section{break-inside:avoid}.distribution-panel,.narrative,.topic-section,.platform-section,.evidence-section,.kpi,.evidence-card,.notice{border:var(--print-panel-border)}.kpi-strip{grid-template-columns:repeat(4,minmax(0,1fr))}.stacked-bar,.contro-bar,.legend-dot,.brand-mark,.review-state__mark,.seal-badge,.review-state,.chip-tone--positive,.chip-tone--negative{-webkit-print-color-adjust:exact;print-color-adjust:exact}.narrative{display:block}.narrative,.narrative-section,.evidence-section{break-inside:auto}.narrative>.section-heading{position:static}.narrative__body{border-top:1px solid var(--hairline);padding-top:var(--space-6);border-left:0;padding-left:0}.evidence-card,tr{break-inside:avoid}.evidence-grid{background:0 0;border:0;display:block}.evidence-card{margin-bottom:var(--space-3)}.table-wrap{overflow:visible}table{min-width:0;font-size:8pt}th,td{padding:.45rem .35rem}a{color:inherit;text-decoration:none}.report-footer{padding-bottom:0}}\n';

// source/renderer/render-document.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { jsx as jsx20, jsxs as jsxs20 } from "react/jsx-runtime";
var REPORT_RENDERER_VERSION = "vox-report-react-static-v1";
var REPORT_THEMES = ["modernist", "organic"];
var DEFAULT_REPORT_THEME = "modernist";
function isReportTheme(value) {
  return REPORT_THEMES.includes(value);
}
function ReportDocument({
  report,
  theme
}) {
  const policy = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'"
  ].join("; ");
  return /* @__PURE__ */ jsxs20("html", { lang: "zh-CN", "data-theme": theme, children: [
    /* @__PURE__ */ jsxs20("head", { children: [
      /* @__PURE__ */ jsx20("meta", { charSet: "utf-8" }),
      /* @__PURE__ */ jsx20(
        "meta",
        {
          name: "viewport",
          content: "width=device-width,initial-scale=1"
        }
      ),
      /* @__PURE__ */ jsx20("meta", { httpEquiv: "Content-Security-Policy", content: policy }),
      /* @__PURE__ */ jsx20("meta", { name: "generator", content: REPORT_RENDERER_VERSION }),
      /* @__PURE__ */ jsx20("title", { children: report.identity.title }),
      /* @__PURE__ */ jsx20("style", { children: styles_default })
    ] }),
    /* @__PURE__ */ jsxs20("body", { children: [
      /* @__PURE__ */ jsx20(ReportPage, { report }),
      /* @__PURE__ */ jsx20(
        "input",
        {
          "aria-label": "\u5207\u6362 Modernist / Organic \u4E3B\u9898",
          className: "theme-switch",
          id: "theme-switch",
          type: "checkbox"
        }
      ),
      /* @__PURE__ */ jsxs20(
        "label",
        {
          className: "theme-toggle",
          htmlFor: "theme-switch",
          title: "\u5207\u6362 Modernist / Organic \u4E3B\u9898",
          children: [
            /* @__PURE__ */ jsx20("span", { className: "theme-toggle__swatch", "aria-hidden": "true" }),
            "\u4E3B\u9898"
          ]
        }
      )
    ] })
  ] });
}
function renderReportDocument(input, theme = DEFAULT_REPORT_THEME) {
  const report = parseReportView(input);
  return `<!doctype html>${renderToStaticMarkup(
    /* @__PURE__ */ jsx20(ReportDocument, { report, theme })
  )}`;
}

// source/renderer/cli.ts
function readArguments(args) {
  const valueAfter = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : void 0;
  };
  const input = valueAfter("--input");
  const output = valueAfter("--output");
  if (!input || !output) {
    throw new Error(
      "Usage: render:static -- --input <report-view.json> --output <report.html> [--theme modernist|organic]"
    );
  }
  const themeValue = valueAfter("--theme") ?? process.env.VOX_REPORT_THEME ?? "";
  const theme = isReportTheme(themeValue) ? themeValue : DEFAULT_REPORT_THEME;
  if (themeValue && !isReportTheme(themeValue)) {
    process.stderr.write(
      `Unknown report theme "${themeValue}", falling back to "${DEFAULT_REPORT_THEME}" (choices: ${REPORT_THEMES.join(", ")})
`
    );
  }
  const invocationDirectory = process.env.INIT_CWD ? path.resolve(process.env.INIT_CWD) : process.cwd();
  return {
    input: path.resolve(invocationDirectory, input),
    output: path.resolve(invocationDirectory, output),
    theme
  };
}
async function runCli() {
  const { input, output, theme } = readArguments(process.argv.slice(2));
  const raw = await readFile(input, "utf8");
  const html = renderReportDocument(JSON.parse(raw), theme);
  const temporary = `${output}.tmp-${process.pid}`;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(temporary, html, "utf8");
  await rename(temporary, output);
  process.stdout.write(
    `${JSON.stringify({
      schema_version: "vox-report-render-result-v1",
      renderer_version: REPORT_RENDERER_VERSION,
      theme,
      output,
      bytes: Buffer.byteLength(html),
      sha256: createHash("sha256").update(html).digest("hex")
    })}
`
  );
}
runCli().catch((error) => {
  process.stderr.write(
    `Static report render failed: ${error instanceof Error ? error.message : String(error)}
`
  );
  process.exitCode = 1;
});
