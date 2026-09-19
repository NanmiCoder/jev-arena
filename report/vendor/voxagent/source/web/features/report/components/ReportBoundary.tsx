import type { ReportView } from "../../../../contracts/index.ts";
import { NoticeStack } from "./NoticeStack";
import { QualityGate } from "./QualityGate";

export function ReportBoundary({ report }: { report: ReportView }) {
  const warning = report.status.degraded || report.status.review_status === "unavailable";
  return (
    <aside className="report-boundary" aria-label="样本与核查边界">
      {report.status.statistics_only && <p><strong>统计版报告 · 自动解读未完成</strong>。当前仅展示模型分类计数与原评论样例，尚未完成模型语义复核。</p>}
      <p><strong>{report.status.statistics_only ? "统计范围" : warning ? "模型语义复核未完成" : report.quality.title}</strong>
        {report.status.partial ? " · 部分结果" : ""} · {report.coverage.relevant_comments} 条相关评论；原文库展示 {report.evidence.length} 条样例{report.quality.status === "insufficient" ? "，仅限采集诊断" : report.quality.status === "limited" ? "，样本有限" : ""}。结论仅适用于本次样本。</p>
      <p>分类来自模型，统计由程序计算；正文可能是事实草稿或 Agent 撰写的分析。请以页面复核状态为准，报告不代表人工确认，请结合完整原文判断。</p>
      {report.status.review_status === "external_reviewed" && report.status.review_source === "codex-agent" && <p>审核来源：Codex Agent（自动审读，非人工复核）。审读覆盖报告正文及其引用依据；标签统计仍来自已有自动标注，未重新核验全部评论。</p>}
      {report.status.partial && <p>部分结果基于已完成标注的评论；未完成部分未进入分类统计。</p>}
      <details>
        <summary>查看采集差额、抽样方式与核查详情</summary>
        <NoticeStack notices={report.notices} />
        <QualityGate quality={report.quality} />
      </details>
    </aside>
  );
}
