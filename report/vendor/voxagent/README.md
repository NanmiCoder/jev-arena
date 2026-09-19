# 内置 VoxAgent 静态报告模板

这个目录让 Jev Arena 单独克隆后即可生成完整、自包含 HTML，无需安装或定位另一个 VoxAgent 仓库。运行时只需要根目录 `npm ci` 安装的 React、React DOM、Zod；生成 HTML 不请求网络、不调用模型。模板通过 React 文本转义和 Zod 结构校验处理输入，HTML 内置 CSS 与限制性 CSP。

## 来源与修改

- 来源项目：项目所有者提供的 VoxAgent，`packages/report-renderer`、`packages/report-contracts` 和 `apps/web` 的报告视图。
- 提取日期：2026-09-19。提取时仓库 HEAD：`1c537996689310296acdd8aab9585b9d3d5d8ef1`。
- 原始构建文件 SHA-256：`f3c5d28c54d3622d5e443b2baf8498f4118d5f3a94dd598ef461d128b9cdafa9`。构建产物可能早于工作区 HEAD；这里以该构建文件及其 sourcemap 为准确模板版本，不宣称与 HEAD 源码完全相同。
- `render-static.js`：使用下述独立重建脚本从提取源码重新生成，并验证两侧历史 view 均可渲染。未内置第三方运行库。
- `source/`：从同一构建文件的 sourcemap 提取的最小 TS/TSX 源码；将 workspace 别名替换为本目录相对路径。`styles.css` 是同一构建中已合并的完整 CSS，因此保持演示报告的样式。
- 边界说明已适配本项目：区分模型标签、程序统计和正文草稿，不宣称已完成未执行的自动复核。
- 不包含 VoxAgent 应用服务、数据、密钥或其他无关代码。

## 修改模板

日常使用不需要构建。维护者修改 `source/` 后可以在仓库根执行：

```sh
node report/vendor/voxagent/rebuild.mjs
```

此命令通过 npm 临时下载固定版本 `esbuild@0.25.10`（需要联网），更新并提交 `render-static.js`。React / React DOM / Zod 仍由根 package-lock.json 锁定。重建实现等价渲染，不保证与原 Vite 构建字节一致。

## 许可说明

模板由本项目所有者授权从其 VoxAgent 项目纳入，并以本仓库的 [MIT License](../../../LICENSE) 发布。此说明适用于本仓库中的模板副本，不改变外部 VoxAgent 仓库的许可状态。React、React DOM、Zod 为独立 npm 依赖，其各自 LICENSE 随 npm 安装包保留。
