interface SectionNavProps {
  showAnalysis: boolean;
  showCrossAnalysis?: boolean;
  /** 跨平台对比只在多平台研究里存在，导航项要跟着一起出现或消失。 */
  showPlatforms: boolean;
  showDistributions: boolean;
  showSignals: boolean;
  showComparisons: boolean;
  showTimeline: boolean;
}

export function SectionNav({
  showAnalysis,
  showCrossAnalysis,
  showComparisons,
  showDistributions,
  showPlatforms,
  showSignals,
  showTimeline,
}: SectionNavProps) {
  const navigationItems: Array<readonly [string, string]> = [
    ["#overview", "数据概览"],
    ...(showAnalysis ? ([["#analysis", "观点与原文"]] as const) : []),
    ...(showCrossAnalysis ? ([["#cross-analysis", "多维交叉"]] as const) : []),
    ["#evidence", "原文样本库"],
    ...(showDistributions ? ([["#distributions", "总体分布"]] as const) : []),
    ...(showSignals ? ([["#signals", "讨论焦点"]] as const) : []),
    ...(showPlatforms ? ([["#platforms", "平台差异"]] as const) : []),
    ...(showComparisons ? ([["#comparisons", "比较标签"]] as const) : []),
    ...(showTimeline ? ([["#timeline", "日期切片"]] as const) : []),
    ["#topics", "作品明细"],
  ];
  return (
    <nav className="section-nav" aria-label="报告章节快速导航">
      <span className="section-nav__label">快速导航</span>
      {navigationItems.map(([href, label]) => (
        <a href={href} key={href}>
          {label}
        </a>
      ))}
    </nav>
  );
}
