import { z } from "zod";
import { comparisonRelationKey, comparisonRelationSchema } from "./comparison-relations";

const boundedText = (minimum: number, maximum: number) =>
  z.string().trim().min(minimum).max(maximum);

const nonNegativeInteger = z.number().int().nonnegative();
const percentage = z.number().finite().min(0).max(100);
const httpUrl = z
  .url()
  .refine((value) => value.startsWith("https://") || value.startsWith("http://"), {
    message: "Only http and https source URLs are allowed",
  });

export const reportModeSchema = z.enum(["keyword", "post", "creator"]);

export const distributionToneSchema = z.enum([
  "positive",
  "negative",
  "neutral",
  "mixed",
  "primary",
]);

export const reportIdentitySchema = z
  .object({
    subject: boundedText(1, 240),
    research_question: z.string().max(1000).optional(),
    title: boundedText(1, 320),
    mode: reportModeSchema,
    generated_at: z.iso.datetime({ offset: true }),
    dataset_public_id: z.uuid(),
    run_id: z.number().int().positive(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    sealed: z.boolean(),
  })
  .strict();

export const reportStatusSchema = z
  .object({
    review_status: boundedText(1, 96),
    degraded: z.boolean(),
    partial: z.boolean(),
    statistics_only: z.boolean().optional(),
    review_source: z.literal("codex-agent").optional(),
  })
  .strict()
  .refine((value) => !value.statistics_only || (value.degraded && value.review_status === "unavailable"), {
    message: "statistics-only reports must disclose unavailable semantic review",
  })
  .refine((value) => value.review_status === "external_reviewed"
    ? value.review_source === "codex-agent" && !value.degraded
    : value.review_source === undefined, {
    message: "external review requires an explicit Codex Agent source and a non-degraded status",
  });

export const reportQualitySchema = z
  .object({
    status: z.enum(["sufficient", "limited", "insufficient"]),
    title: boundedText(1, 160),
    summary: boundedText(1, 1200),
    reasons: z.array(boundedText(1, 800)).min(1).max(8),
  })
  .strict();

export const reportCoverageSchema = z
  .object({
    topics: nonNegativeInteger,
    comments_in_snapshot: nonNegativeInteger,
    labeled_comments: nonNegativeInteger,
    relevant_comments: nonNegativeInteger,
    labeled_pct: percentage,
    relevant_pct: percentage,
    avg_sentiment_score: z.number().finite().min(-1).max(1),
  })
  .strict();

export const distributionItemSchema = z
  .object({
    key: boundedText(1, 64),
    label: boundedText(1, 64),
    count: nonNegativeInteger,
    pct: percentage,
    tone: distributionToneSchema,
  })
  .strict();

export const distributionGroupSchema = z
  .object({
    id: z.enum(["sentiment", "stance", "intent", "opinion_target"]),
    title: boundedText(1, 80),
    items: z.array(distributionItemSchema).min(1).max(12),
  })
  .strict();

export const rankingItemSchema = z
  .object({
    key: boundedText(1, 128),
    label: boundedText(1, 128),
    count: nonNegativeInteger,
    pct_of_relevant: z.number().finite().nonnegative(),
  })
  .strict();

export const rankingGroupSchema = z
  .object({
    id: z.enum(["aspects", "emotion", "competitors"]),
    title: boundedText(1, 120),
    note: boundedText(1, 400),
    items: z.array(rankingItemSchema).min(1).max(12),
  })
  .strict();

export const comparisonRowSchema = z
  .object({
    competitor: boundedText(1, 160),
    stronger: nonNegativeInteger,
    similar: nonNegativeInteger,
    weaker: nonNegativeInteger,
    total: z.number().int().positive(),
  })
  .strict()
  .refine(
    (value) => value.total === value.stronger + value.similar + value.weaker,
    { message: "Comparison total must equal verdict counts" },
  );

export const timelinePointSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    labeled_comments: nonNegativeInteger,
    relevant_comments: nonNegativeInteger,
    positive: nonNegativeInteger,
    negative: nonNegativeInteger,
    neutral: nonNegativeInteger,
    mixed: nonNegativeInteger,
  })
  .strict();

export const reportNoticeSchema = z
  .object({
    kind: z.enum(["boundary", "warning", "partial", "review"]),
    title: boundedText(1, 120),
    text: boundedText(1, 1200),
  })
  .strict();

export const inlineSpanSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      value: boundedText(1, 1600),
    })
    .strict(),
  z
    .object({
      type: z.literal("strong"),
      value: boundedText(1, 400),
    })
    .strict(),
  z
    .object({
      type: z.literal("code"),
      value: boundedText(1, 400),
    })
    .strict(),
  z
    .object({
      type: z.literal("evidence-ref"),
      evidence_id: z.string().regex(/^C[1-9]\d*$/u),
    })
    .strict(),
]);

export const reportBlockSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("paragraph"),
      spans: z.array(inlineSpanSchema).min(1).max(40),
    })
    .strict(),
  z
    .object({
      type: z.literal("fact-list"),
      items: z
        .array(
          z
            .object({
              fact_id: z.string().regex(/^NF\d{4}$/u),
              text: boundedText(1, 1200),
            })
            .strict(),
        )
        .min(1)
        .max(24),
    })
    .strict(),
  z
    .object({
      type: z.literal("evidence-quote"),
      evidence_id: z.string().regex(/^C[1-9]\d*$/u),
    })
    .strict(),
  z
    .object({
      type: z.literal("action-list"),
      items: z.array(boundedText(1, 1000)).min(1).max(12),
    })
    .strict(),
]);

export const reportSectionSchema = z
  .object({
    id: z.enum([
      "executive-summary",
      "method",
      "core-findings",
      "subject-insights",
      "risks",
      "actions",
    ]),
    title: boundedText(1, 120),
    blocks: z.array(reportBlockSchema).min(1).max(30),
  })
  .strict();

export const reportTopicSchema = z
  .object({
    topic_id: boundedText(1, 160),
    title: boundedText(1, 400),
    url: httpUrl.nullable(),
    snapshot_comments: nonNegativeInteger,
    labeled_relevant: nonNegativeInteger,
    positive_pct: percentage,
    negative_pct: percentage,
    controversy_score: percentage,
  })
  .strict();

export const reportTopicDisplaySchema = z
  .object({
    displayed: nonNegativeInteger,
    total: nonNegativeInteger,
    truncated: z.boolean(),
  })
  .strict()
  .refine((value) => value.displayed <= value.total, {
    message: "Displayed topic count cannot exceed the total",
  });

export const reportPlatformSchema = z
  .object({
    platform: z.enum(["bili", "xhs", "dy", "reddit"]),
    label: boundedText(1, 32),
    topics: nonNegativeInteger,
    snapshot_comments: nonNegativeInteger,
    labeled_comments: nonNegativeInteger,
    relevant_comments: nonNegativeInteger,
    positive_pct: percentage,
    negative_pct: percentage,
    neutral_pct: percentage,
    avg_sentiment_score: z.number().finite().min(-1).max(1),
  })
  .strict();

export const reportEvidenceSchema = z
  .object({
    evidence_id: z.string().regex(/^C[1-9]\d*$/u),
    sentiment: z.enum(["positive", "negative", "neutral", "mixed"]),
    sentiment_label: boundedText(1, 64),
    stance: z.enum(["support", "oppose", "neutral"]),
    stance_label: boundedText(1, 64),
    intent: z.enum([
      "praise",
      "complaint",
      "question",
      "suggestion",
      "correction",
      "agreement",
      "disagreement",
      "joke",
      "information",
      "other",
    ]),
    intent_label: boundedText(1, 64),
    opinion_target: z.enum([
      "target",
      "post",
      "creator",
      "content",
      "mentioned_entity",
      "other",
    ]),
    opinion_target_label: boundedText(1, 96),
    like_count: nonNegativeInteger,
    quote: boundedText(1, 4000),
    full_text: boundedText(1, 20000).optional(),
    source_url: httpUrl.nullable(),
    topic_title: boundedText(1, 400),
    source_label: boundedText(1, 400).nullable(),
    topic_id: boundedText(1, 160).optional(),
    aspects: z.array(boundedText(1, 128)).max(32).optional(),
    confidence: z.number().finite().min(0).max(1).optional(),
    reviewed: z.boolean().optional(),
    requires_context: z.boolean().optional(),
  })
  .strict();

export const analysisRowSchema = z.object({
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
  evidence_ids: z.array(z.string().regex(/^C[1-9]\d*$/u)).max(3),
}).strict().refine((row) => row.count === row.positive + row.negative + row.neutral + row.mixed, {
  message: "Cross-analysis sentiment counts must equal the group count",
});

export const reportAnalysisSchema = z.object({
  groups: z.array(z.object({
    id: z.enum(["aspect", "opinion_target", "intent"]),
    title: boundedText(1, 120),
    note: boundedText(1, 800),
    rows: z.array(analysisRowSchema).max(16),
  }).strict()).max(3),
  quality: z.object({
    top_topic_share_pct: percentage,
    top_three_topic_share_pct: percentage,
    low_confidence_count: nonNegativeInteger,
    low_confidence_threshold: z.number().finite().min(0).max(1),
    keyword_context_only_count: nonNegativeInteger,
    evidence_pool_count: nonNegativeInteger,
  }).strict(),
}).strict();

export const reportViewSchema = z
  .object({
    schema_version: z.literal("vox-report-view-v1"),
    statistical_narrative: z.literal("host-facts-v1").optional(),
    identity: reportIdentitySchema,
    status: reportStatusSchema,
    quality: reportQualitySchema,
    coverage: reportCoverageSchema,
    distributions: z.array(distributionGroupSchema).min(2).max(4),
    rankings: z.array(rankingGroupSchema).max(3),
    comparisons: z.array(comparisonRowSchema).max(16),
    comparison_relations: z.array(comparisonRelationSchema).max(16).optional(),
    timeline: z.array(timelinePointSchema).max(45),
    notices: z.array(reportNoticeSchema).max(16),
    sections: z.array(reportSectionSchema).min(1).max(6),
    topic_display: reportTopicDisplaySchema,
    topics: z.array(reportTopicSchema).max(100),
    platforms: z.array(reportPlatformSchema).max(8),
    evidence: z.array(reportEvidenceSchema).max(128),
    analysis: reportAnalysisSchema.optional(),
    footer_note: boundedText(1, 500),
  })
  .strict()
  .superRefine((report, context) => {
    const unique = (
      values: readonly string[],
      path: PropertyKey[],
      label: string,
    ) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: `${label} must be unique`,
          path,
        });
      }
    };

    unique(
      report.distributions.map((group) => group.id),
      ["distributions"],
      "distribution IDs",
    );
    unique(
      report.rankings.map((group) => group.id),
      ["rankings"],
      "ranking IDs",
    );
    unique(
      report.comparisons.map((item) => item.competitor.toLocaleLowerCase()),
      ["comparisons"],
      "comparison competitors",
    );
    unique((report.comparison_relations ?? []).map(comparisonRelationKey), ["comparison_relations"], "comparison relations");
    unique(
      report.timeline.map((item) => item.date),
      ["timeline"],
      "timeline dates",
    );
    unique(
      report.sections.map((section) => section.id),
      ["sections"],
      "section IDs",
    );
    unique(
      report.topics.map((topic) => topic.topic_id),
      ["topics"],
      "topic IDs",
    );
    unique(
      report.evidence.map((item) => item.evidence_id),
      ["evidence"],
      "evidence IDs",
    );
    unique(
      report.platforms.map((item) => item.platform),
      ["platforms"],
      "platform IDs",
    );

    // 各平台的快照评论数之和不能超过整体覆盖率里的快照总数，
    // 否则跨平台对比会和"样本与方法"里的数字互相矛盾。
    const platformComments = report.platforms.reduce(
      (total, item) => total + item.snapshot_comments,
      0,
    );
    if (platformComments > report.coverage.comments_in_snapshot) {
      context.addIssue({
        code: "custom",
        message:
          "Per-platform snapshot comments cannot exceed the dataset total",
        path: ["platforms"],
      });
    }

    const evidenceIds = new Set(
      report.evidence.map((item) => item.evidence_id),
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
        path: ["topic_display", "displayed"],
      });
    }
    if (
      report.topic_display.truncated !==
      (report.topic_display.total > report.topic_display.displayed)
    ) {
      context.addIssue({
        code: "custom",
        message: "Topic truncation flag must match displayed and total counts",
        path: ["topic_display", "truncated"],
      });
    }
    report.sections.forEach((section, sectionIndex) => {
      section.blocks.forEach((block, blockIndex) => {
        if (
          block.type === "evidence-quote" &&
          !evidenceIds.has(block.evidence_id)
        ) {
          context.addIssue({
            code: "custom",
            message: `Unknown evidence reference: ${block.evidence_id}`,
            path: ["sections", sectionIndex, "blocks", blockIndex, "evidence_id"],
          });
        }
        if (block.type === "paragraph") {
          block.spans.forEach((span, spanIndex) => {
            if (
              span.type === "evidence-ref" &&
              !evidenceIds.has(span.evidence_id)
            ) {
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
                  "evidence_id",
                ],
              });
            }
          });
        }
      });
    });
  });

export type ReportMode = z.infer<typeof reportModeSchema>;
export type DistributionTone = z.infer<typeof distributionToneSchema>;
export type ReportIdentity = z.infer<typeof reportIdentitySchema>;
export type ReportStatus = z.infer<typeof reportStatusSchema>;
export type ReportQuality = z.infer<typeof reportQualitySchema>;
export type ReportCoverage = z.infer<typeof reportCoverageSchema>;
export type DistributionItem = z.infer<typeof distributionItemSchema>;
export type DistributionGroup = z.infer<typeof distributionGroupSchema>;
export type RankingItem = z.infer<typeof rankingItemSchema>;
export type RankingGroup = z.infer<typeof rankingGroupSchema>;
export type ComparisonRow = z.infer<typeof comparisonRowSchema>;
export type TimelinePoint = z.infer<typeof timelinePointSchema>;
export type ReportNotice = z.infer<typeof reportNoticeSchema>;
export type InlineSpan = z.infer<typeof inlineSpanSchema>;
export type ReportBlock = z.infer<typeof reportBlockSchema>;
export type ReportSection = z.infer<typeof reportSectionSchema>;
export type ReportTopic = z.infer<typeof reportTopicSchema>;
export type ReportTopicDisplay = z.infer<typeof reportTopicDisplaySchema>;
export type ReportEvidence = z.infer<typeof reportEvidenceSchema>;
export type ReportAnalysis = z.infer<typeof reportAnalysisSchema>;
export type ReportPlatform = z.infer<typeof reportPlatformSchema>;
export type ReportView = z.infer<typeof reportViewSchema>;

export function parseReportView(input: unknown): ReportView {
  return reportViewSchema.parse(input);
}

export function safeParseReportView(input: unknown) {
  return reportViewSchema.safeParse(input);
}
