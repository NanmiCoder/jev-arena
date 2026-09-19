import type {
  InlineSpan,
  ReportBlock,
  ReportEvidence,
  ReportSection,
} from "../../../../contracts/index.ts";
import type { ReactNode } from "react";

interface NarrativeProps {
  sections: ReportSection[];
  evidence: ReportEvidence[];
  id?: string;
  title?: string;
  compactExplanations?: boolean;
}

function InlineContent({
  spans,
}: {
  spans: InlineSpan[];
}) {
  return spans.map((span, index) => {
    const key = `${span.type}-${index}`;
    switch (span.type) {
      case "text":
        return <span key={key}>{span.value}</span>;
      case "strong":
        return <strong key={key}>{span.value}</strong>;
      case "code":
        return <code key={key}>{span.value}</code>;
      case "evidence-ref":
        return (
          <a
            className="evidence-ref"
            href={`#evidence-${span.evidence_id}`}
            key={key}
          >
            [{span.evidence_id}]
          </a>
        );
    }
  });
}

function renderBlock(
  block: ReportBlock,
  evidenceById: ReadonlyMap<string, ReportEvidence>,
  key: string,
  compactExplanations = false,
): ReactNode {
  switch (block.type) {
    case "paragraph":
      if (compactExplanations && !block.spans.some((span) => span.type === "strong")) {
        return <details className="model-explanation" key={key}>
          <summary>查看模型解释</summary>
          <p className="narrative-paragraph"><InlineContent spans={block.spans} /></p>
        </details>;
      }
      return (
        <p className="narrative-paragraph" key={key}>
          <InlineContent spans={block.spans} />
        </p>
      );
    case "fact-list":
      return (
        <ul className="fact-list" key={key}>
          {block.items.map((item) => (
            <li data-fact-id={item.fact_id} key={item.fact_id}>
              {item.text}
            </li>
          ))}
        </ul>
      );
    case "action-list":
      return (
        <ol className="action-list" key={key}>
          {block.items.map((item, index) => (
            <li key={`${index}-${item.slice(0, 24)}`}>{item}</li>
          ))}
        </ol>
      );
    case "evidence-quote": {
      const item = evidenceById.get(block.evidence_id);
      if (!item) return null;
      return (
        <blockquote className="narrative-evidence" key={key}>
          <p>“{item.quote}”</p>
          <footer>
            <a href={`#evidence-${item.evidence_id}`}>
              [{item.evidence_id}]
            </a>
            <span>{item.sentiment_label}</span>
            <span>{item.stance_label}</span>
            <span>{item.intent_label}</span>
          </footer>
        </blockquote>
      );
    }
  }
}

export function Narrative({ sections, evidence, id = "analysis", title = "分析结论", compactExplanations = false }: NarrativeProps) {
  const evidenceById = new Map(
    evidence.map((item) => [item.evidence_id, item]),
  );

  return (
    <article className="narrative" id={id}>
      <header className="section-heading">
        <p className="eyebrow">Evidence-grounded narrative</p>
        <h2>{title}</h2>
      </header>
      <div className="narrative__body">
        {sections.map((section) => (
          <section
            className={`narrative-section narrative-section--${section.id}`}
            data-section-id={section.id}
            key={section.id}
          >
            {!compactExplanations && <h3>{section.title}</h3>}
            {section.blocks.map((block, blockIndex) =>
              renderBlock(
                block,
                evidenceById,
                `${section.id}-${blockIndex}`,
                compactExplanations,
              ),
            )}
          </section>
        ))}
      </div>
    </article>
  );
}
