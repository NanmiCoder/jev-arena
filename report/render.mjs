/**
 * 渲染适配器：view JSON → 调 VoxAgent 的渲染器 → 自包含 HTML。
 *
 * 为什么是 spawn 而不是 import：渲染器（packages/report-renderer/dist/render-static.js）
 * 是 VoxAgent 仓库的产物，它内部依赖 React / zod / 它自己的 CSS。跨仓库 import 会把
 * jev-arena 的依赖树和 VoxAgent 的构建产物绑死；spawn 一条命令则是稳定的进程边界：
 * 渲染器怎么升级都不用改这边，接口只有「进去 JSON、出来 HTML」。
 *
 * 渲染器要求 cwd 在 VoxAgent 根目录（它按 INIT_CWD/cwd 解析相对路径），所以这里
 * cwd 固定为 VoxAgent 根，输入输出都传绝对路径，不受调用方 cwd 影响。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 默认指向同级目录下的 VoxAgent 检出；换机器用 VOXAGENT_ROOT 覆盖。 */
export const VOXAGENT_ROOT = process.env.VOXAGENT_ROOT
  ? path.resolve(process.env.VOXAGENT_ROOT)
  : path.resolve("/Users/nanmi/workspace/myself_code/VoxAgent");

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
  const renderer = path.join(root, RENDERER_CLI);
  if (!existsSync(renderer)) {
    throw new Error(
      `找不到 VoxAgent 渲染器：${renderer}\n`
      + `请确认 VoxAgent 检出存在（或用 VOXAGENT_ROOT / --voxagent 指定根目录），`
      + `并在该仓库执行过 npm run build --workspace @voxagent/report-renderer。`,
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
      root,
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
