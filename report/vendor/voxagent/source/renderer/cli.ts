import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  DEFAULT_REPORT_THEME,
  REPORT_RENDERER_VERSION,
  REPORT_THEMES,
  isReportTheme,
  renderReportDocument,
  type ReportTheme,
} from "./render-document";

type RenderArguments = {
  input: string;
  output: string;
  theme: ReportTheme;
};

function readArguments(args: string[]): RenderArguments {
  const valueAfter = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const input = valueAfter("--input");
  const output = valueAfter("--output");
  if (!input || !output) {
    throw new Error(
      "Usage: render:static -- --input <report-view.json> --output <report.html> [--theme modernist|organic]",
    );
  }
  const themeValue =
    valueAfter("--theme") ?? process.env.VOX_REPORT_THEME ?? "";
  const theme = isReportTheme(themeValue)
    ? themeValue
    : DEFAULT_REPORT_THEME;
  if (themeValue && !isReportTheme(themeValue)) {
    process.stderr.write(
      `Unknown report theme "${themeValue}", falling back to "${DEFAULT_REPORT_THEME}" (choices: ${REPORT_THEMES.join(", ")})\n`,
    );
  }
  const invocationDirectory = process.env.INIT_CWD
    ? path.resolve(process.env.INIT_CWD)
    : process.cwd();
  return {
    input: path.resolve(invocationDirectory, input),
    output: path.resolve(invocationDirectory, output),
    theme,
  };
}

async function runCli(): Promise<void> {
  const { input, output, theme } = readArguments(process.argv.slice(2));
  const raw = await readFile(input, "utf8");
  const html = renderReportDocument(JSON.parse(raw) as unknown, theme);
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
      sha256: createHash("sha256").update(html).digest("hex"),
    })}\n`,
  );
}

runCli().catch((error: unknown) => {
  process.stderr.write(
    `Static report render failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
