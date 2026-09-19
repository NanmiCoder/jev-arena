/** Render a validated report view with the bundled, offline VoxAgent template. */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// External renderers remain an explicit development override only.
export const VOXAGENT_ROOT = process.env.VOXAGENT_ROOT
  ? path.resolve(process.env.VOXAGENT_ROOT)
  : null;
export const BUNDLED_RENDERER = fileURLToPath(new URL("./vendor/voxagent/render-static.js", import.meta.url));
const RENDERER_CLI = path.join("packages", "report-renderer", "dist", "render-static.js");

function runNode(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * @param {object} view      严格 vox-report-view-v1 对象
 * @param {string} outPath   HTML 输出路径（相对路径按当前 cwd 解析）
 * @param {{voxagentRoot?:string}} [options]
 * @returns {Promise<string>} 生成的 HTML 绝对路径
 */
export async function renderReport(view, outPath, options = {}) {
  const root = options.voxagentRoot ? path.resolve(options.voxagentRoot) : VOXAGENT_ROOT;
  const renderer = root ? path.join(root, RENDERER_CLI) : BUNDLED_RENDERER;
  if (!existsSync(renderer)) {
    throw new Error(
      `找不到报告渲染器：${renderer}\n`
      + `请确认仓库中的 report/vendor/voxagent/render-static.js 存在，并已执行 npm ci。`
      + (root ? `当前使用显式 VoxAgent 覆盖路径，请检查该项目的构建产物或移除覆盖设置。` : ""),
    );
  }
  const htmlPath = path.resolve(outPath);

  // view 先落临时文件：渲染器只接受文件路径，不读 stdin。
  // 放系统临时目录而不是输出目录，避免渲染失败时在 run 目录留下半成品。
  const staging = await mkdtemp(path.join(os.tmpdir(), "jev-arena-view-"));
  const viewPath = path.join(staging, "report-view.json");
  await writeFile(viewPath, JSON.stringify(view), "utf8");

  try {
    const { code, stdout, stderr } = await runNode(
      [renderer, "--input", viewPath, "--output", htmlPath],
      root || path.dirname(BUNDLED_RENDERER),
    );
    if (code !== 0) {
      // 渲染器的报错信息（zod 校验路径 / 堆栈）必须原样抛出：
      // 吞掉 stderr 只会留下「渲染失败」四个字，排查要重跑一遍。
      throw new Error(
        `报告渲染失败（exit ${code}）\n`
        + `命令：node ${renderer} --input <view.json> --output ${htmlPath}\n`
        + `--- renderer stderr ---\n${stderr.trim() || "(空)"}\n`
        + `--- renderer stdout ---\n${stdout.trim() || "(空)"}`,
      );
    }
    return htmlPath;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export default { renderReport, VOXAGENT_ROOT };
