import type { ReportView } from "../../../contracts/index.ts";
import { DistributionGrid } from "./components/DistributionGrid";
import { ComparisonDisclosure } from "./components/ComparisonDisclosure";
import { CrossAnalysis } from "./components/CrossAnalysis";
import { EvidenceGrid } from "./components/EvidenceGrid";
import { KpiStrip } from "./components/KpiStrip";
import { Narrative } from "./components/Narrative";
import { ReportBoundary } from "./components/ReportBoundary";
import { PlatformComparison } from "./components/PlatformComparison";
import { RankingGrid } from "./components/RankingGrid";
import { ReportFooter } from "./components/ReportFooter";
import { ReportHeader } from "./components/ReportHeader";
import { SectionNav } from "./components/SectionNav";
import { TopicTable } from "./components/TopicTable";
import { TimelineTable } from "./components/TimelineTable";

interface ReportPageProps {
  report: ReportView;
  /** Static exports keep native disclosures and every excerpt, without inert controls. */
  interactive?: boolean;
}

export function ReportPage({ report, interactive = false }: ReportPageProps) {
  const statisticsOnly = report.status.statistics_only === true;
  const hostFacts = report.statistical_narrative === "host-facts-v1";
  const distributions = report.distributions.filter((group) => group.items.some((item) => item.count > 0));
  const hasAnalysis = Boolean(report.analysis?.groups.some((group) => group.rows.length));
  const relationCount = report.comparison_relations?.length ?? 0;
  const hasComparisons = report.comparisons.length > 0 || relationCount > 0;
  const aspectLabels = Object.fromEntries([
    ...(report.rankings.find((group) => group.id === "aspects")?.items.map((item) => [item.key, item.label]) ?? []),
    ...(report.analysis?.groups.find((group) => group.id === "aspect")?.rows.map((row) => [row.key, row.label]) ?? []),
  ]);
  return <>
    <a className="skip-link" href={statisticsOnly ? "#evidence" : "#analysis"}>{statisticsOnly ? "跳到原文样本" : "跳到分析结论"}</a>
    <main className={`report-shell${interactive ? " report-shell--interactive" : ""}`}>
      <ReportHeader identity={report.identity} status={report.status} />
      <KpiStrip coverage={report.coverage} />
      <ReportBoundary report={report} />
      <SectionNav showAnalysis={!statisticsOnly} showCrossAnalysis={hasAnalysis} showComparisons={hasComparisons} showDistributions={distributions.length > 0} showPlatforms={report.platforms.length >= 2} showSignals={report.rankings.length > 0} showTimeline={report.timeline.length >= 2} />
      {!statisticsOnly && <>
        <p className="interpretation-note">以下为标签与原文证据的整理{report.status.degraded ? "，尚未完成模型语义复核" : ""}。先读原文，再判断解释；单条样例不代表主题频率。</p>
        <Narrative sections={report.sections.filter((section) => section.id === "subject-insights")} evidence={report.evidence} title="具体观点与评论原文" compactExplanations />
      </>}
      {hasAnalysis && report.analysis && <CrossAnalysis analysis={report.analysis} relevantCount={report.coverage.relevant_comments} interactive={interactive} />}
      <EvidenceGrid evidence={report.evidence} relevantCount={report.coverage.relevant_comments} interactive={interactive} aspectLabels={aspectLabels} />
      <div className="report-detail-heading"><h2>核对统计与来源</h2><p>需要判断占比、跨作品差异或采样范围时，展开以下明细。</p></div>
      {distributions.length > 0 && <details className="report-detail"><summary><span>总体分布</span><small>情绪、立场、评论意图与评价对象</small></summary><DistributionGrid groups={distributions} relevantCount={report.coverage.relevant_comments} /></details>}
      {report.rankings.length > 0 && <details className="report-detail"><summary><span>讨论焦点与情绪信号</span><small>方面、情绪与提及对象的标签频率</small></summary><RankingGrid groups={report.rankings} /></details>}
      {report.platforms.length >= 2 && <details className="report-detail"><summary><span>平台差异</span><small>{report.platforms.length} 个平台的样本与情绪</small></summary><PlatformComparison platforms={report.platforms} /></details>}
      {hasComparisons && <ComparisonDisclosure rows={report.comparisons} relations={report.comparison_relations} />}
      {report.timeline.length >= 2 && <details className="report-detail"><summary><span>评论日期切片</span><small>{report.timeline.length} 个日期的样本分布</small></summary><TimelineTable points={report.timeline} /></details>}
      <details className="report-detail"><summary><span>作品级明细</span><small>{report.topic_display.total} 个作品的评论量、相关性与情绪</small></summary><TopicTable display={report.topic_display} topics={report.topics} /></details>
      {!statisticsOnly && <details className="report-appendix"><summary>{hostFacts ? "事实选摘与行动建议" : "原始模型摘要、统计解读与建议"}</summary><p className="table-note">{hostFacts ? "统计由模型选取事实编号，程序按原口径直接呈现；行动建议由模型提出。分类标签和建议仍需结合原文核查。" : "保留生成时的原始内容供核查；不将分类标签直接视为已证实的结论。"}</p><Narrative sections={report.sections.filter((section) => !["subject-insights", "method"].includes(section.id))} evidence={report.evidence} id="takeaways" title={hostFacts ? "事实选摘与待核动作" : "原始解读"} /></details>}
      <details className="report-appendix" id="method"><summary>样本与研究方法</summary><p className="table-note">平均情绪分 {report.coverage.avg_sentiment_score.toFixed(3)}，为相关评论的模型评分均值，范围 −1 至 +1，不是满意度。</p><Narrative sections={report.sections.filter((section) => section.id === "method")} evidence={report.evidence} id="method-content" title="样本与方法" /></details>
      <ReportFooter note={report.footer_note} />
    </main>
  </>;
}
