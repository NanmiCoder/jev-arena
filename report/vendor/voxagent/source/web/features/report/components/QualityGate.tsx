import type { ReportQuality } from "../../../../contracts/index.ts";

interface QualityGateProps {
  quality: ReportQuality;
}

const STATUS_LABELS: Record<ReportQuality["status"], string> = {
  sufficient: "可用于本次洞察",
  limited: "样本有限",
  insufficient: "仅限采集诊断",
};

export function QualityGate({ quality }: QualityGateProps) {
  return (
    <section
      className={`quality-gate quality-gate--${quality.status}`}
      aria-labelledby="quality-gate-title"
    >
      <div className="quality-gate__heading">
        <p className="eyebrow">Data readiness</p>
        <span className="quality-gate__status">
          {STATUS_LABELS[quality.status]}
        </span>
      </div>
      <h2 id="quality-gate-title">{quality.title}</h2>
      <p>{quality.summary}</p>
      <ul>
        {quality.reasons.map((reason) => <li key={reason}>{reason}</li>)}
      </ul>
    </section>
  );
}
