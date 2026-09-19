import {
  parseReportView,
  type ReportView,
} from "../contracts/index.ts";
import { ReportPage } from "../web/features/report/ReportPage.tsx";
import reportCss from "../styles.css";
import { renderToStaticMarkup } from "react-dom/server";

export const REPORT_RENDERER_VERSION = "vox-report-react-static-v1";

export const REPORT_THEMES = ["modernist", "organic"] as const;
export type ReportTheme = (typeof REPORT_THEMES)[number];
export const DEFAULT_REPORT_THEME: ReportTheme = "modernist";

export function isReportTheme(value: string): value is ReportTheme {
  return (REPORT_THEMES as readonly string[]).includes(value);
}

function ReportDocument({
  report,
  theme,
}: {
  report: ReportView;
  theme: ReportTheme;
}) {
  const policy = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");

  return (
    <html lang="zh-CN" data-theme={theme}>
      <head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width,initial-scale=1"
        />
        <meta httpEquiv="Content-Security-Policy" content={policy} />
        <meta name="generator" content={REPORT_RENDERER_VERSION} />
        <title>{report.identity.title}</title>
        <style>{reportCss}</style>
      </head>
      <body>
        <ReportPage report={report} />
        <input
          aria-label="切换 Modernist / Organic 主题"
          className="theme-switch"
          id="theme-switch"
          type="checkbox"
        />
        <label
          className="theme-toggle"
          htmlFor="theme-switch"
          title="切换 Modernist / Organic 主题"
        >
          <span className="theme-toggle__swatch" aria-hidden="true" />
          主题
        </label>
      </body>
    </html>
  );
}

export function renderReportDocument(
  input: unknown,
  theme: ReportTheme = DEFAULT_REPORT_THEME,
): string {
  const report = parseReportView(input);
  return `<!doctype html>${renderToStaticMarkup(
    <ReportDocument report={report} theme={theme} />,
  )}`;
}
