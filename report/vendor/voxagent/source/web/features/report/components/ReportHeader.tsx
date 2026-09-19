import type {
  ReportIdentity,
  ReportStatus,
} from "../../../../contracts/index.ts";

import {
  formatGeneratedAt,
  formatMode,
} from "../../../lib/format";

interface ReportHeaderProps {
  identity: ReportIdentity;
  status: ReportStatus;
}

function statusLabel(status: ReportStatus): string {
  if (status.statistics_only) return "统计版 · 模型未复核";
  const prefix = status.partial ? "部分结果 · " : "";
  if (status.degraded || status.review_status === "unavailable") return `${prefix}模型复核未完成`;
  if (status.review_status === "external_reviewed" && status.review_source === "codex-agent") return `${prefix}Codex Agent复核通过`;
  if (status.review_status === "revised") return `${prefix}模型修订后复核通过`;
  if (status.review_status === "accepted") return `${prefix}模型自动复核通过`;
  if (status.review_status === "not_required") return `${prefix}仅采集诊断`;
  return `${prefix}复核状态待确认`;
}

export function ReportHeader({ identity, status }: ReportHeaderProps) {
  // A multi-part research brief remains readable copy instead of a wall of display type.
  const longQuestion = (identity.research_question?.length ?? 0) > 48;
  const externalReviewed = status.review_status === "external_reviewed" && status.review_source === "codex-agent";
  const state = status.degraded || (!externalReviewed && !["accepted", "revised", "not_required"].includes(status.review_status))
    ? "warning"
    : status.partial
      ? "partial"
      : "accepted";

  return (
    <header className="report-header">
      <div className="topbar">
        <div className="topbar__meta">
          <span className="brand-mark" aria-hidden="true" />
          <span className="topbar__brand">VoxAgent</span>
          <span className="mode-chip">{formatMode(identity.mode)}</span>
        </div>
        <div className="topbar__side">
          <span
            className={`seal-badge${identity.sealed ? "" : " seal-badge--open"}`}
          >
            {identity.sealed ? "样本已封存" : "样本未封存"}
          </span>
          <time dateTime={identity.generated_at}>
            {formatGeneratedAt(identity.generated_at)}
          </time>
          <div className={`review-state review-state--${state}`}>
            <span className="review-state__mark" aria-hidden="true" />
            <span>{statusLabel(status)}</span>
          </div>
        </div>
      </div>

      <div className="report-header__main">
        <div>
          <h1 className="report-title">{longQuestion ? `${identity.subject} · 评论研究` : identity.research_question || identity.subject}</h1>
          {longQuestion
            ? <p className="report-question"><span>研究问题</span>{identity.research_question}</p>
            : identity.research_question && <p className="report-subject">研究对象 · {identity.subject}</p>}
        </div>
        <div className="report-header__aside">
          <p className="report-dek">
            {status.statistics_only ? "评论统计报告" : "评论洞察报告"}
            <span aria-hidden="true"> / </span>
            基于本次实际采集的评论样本
          </p>
          <details className="report-provenance">
          <summary>查看研究标识与核查信息</summary>
          <dl className="identity-list" aria-label="报告身份">
            <div>
              <dt>Dataset</dt>
              <dd>{identity.dataset_public_id}</dd>
            </div>
            <div>
              <dt>Run</dt>
              <dd>{identity.run_id}</dd>
            </div>
            <div>
              <dt>Fingerprint</dt>
              <dd title={identity.fingerprint}>
                {identity.fingerprint.slice(0, 16)}…
              </dd>
            </div>
          </dl>
          </details>
        </div>
      </div>
    </header>
  );
}
