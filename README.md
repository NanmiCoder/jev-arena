<p align="center">
  <img src="assets/readme/hero-3d.png" width="100%" alt="Jev Arena：同一批评论进入绿蓝两条模型处理轨道的 3D 示意图">
</p>

# Jev Arena

**给两个模型同一批评论，直观看速度，逐条比结果。** 导入 CSV / Excel，填写两侧 Key，即可实时对比、保存回放，并离线生成两份研究报告。

[快速启动](#快速启动) · [模型配置](#模型配置) · [评论格式](#评论文件格式) · [生成报告](#生成两份报告) · [给 AI Agent 的指南](docs/report-generation.md)

![一万条评论对决的前 20 秒：通过回放按钮以 1 倍速录制，左侧 Jev 与右侧 DeepSeek 的实时处理进度](assets/readme/demo.gif)

**一万条评论历史运行的前 20 秒，1× 回放，无加速。** [演示来源](assets/readme/demo.md) · [静态关键帧](assets/readme/demo-still.png)

默认对比 **Jev（OpenRouter）与 DeepSeek**，两侧也可独立配置其他 OpenAI 兼容聊天模型。启动自带 **20 条合成评论**，点击「开始对决」才会调用模型。上图的速度差异仅代表该次运行。

## 演示数据与完整报告

[一万条评论与分析上下文](examples/demo/README.md) · [可直接阅读的比较报告](examples/demo/0919-124001/report.md) · [Jev 完整报告](examples/demo/0919-124001/report.jev.html) · [DeepSeek 完整报告](examples/demo/0919-124001/report.deepseek.html)

资料包含原始 CSV、两侧逐条 JSONL 标签、机器可读统计与完整报告视图，方便你或 AI Agent 复核。HTML 可下载后打开；启动项目后也能直接在报告页切换阅读，无需 Key、无需重跑。

## 快速启动

需要 **Node.js 22 或更高版本**，或使用下方 Docker 方式。

```bash
git clone https://github.com/NanmiCoder/jev-arena.git
cd jev-arena
npm ci
npm start
```

打开 [本地对决场](http://localhost:5173)，展开「模型设置与评论导入」：

1. 使用默认 Jev / DeepSeek 时，只需填入 **OpenRouter Key 和 DeepSeek Key**，点击「保存模型配置」。其他模型需同时修改协议、URL 和模型 ID。
2. 使用内置示例，或选择自己的 `.csv` / `.xlsx` 评论文件。
3. 保持「本次条数」为 **20**，点击「开始对决」。两侧处理相同的前 20 条评论。
4. 完成后按下方「生成两份报告」运行离线命令，再点击「查看双侧报告」，在页面顶部切换阅读。
5. 完成后在回放栏选择本次录像，播放或调整倍速。**回放不调用模型。**

网页配置保存在服务端内存，重启后需重新填写。API Key 不写入录像，也不保存在浏览器 localStorage。如需持久配置，把 [.env.example](.env.example) 复制为 `.env` 后填写，再重启服务。

<details>
<summary><strong>使用 Docker，无需本机安装 Node.js</strong></summary>


克隆后在项目目录执行（不需要本机安装 Node.js）：

```bash
docker run --name jev-arena --rm -it \
  -p 127.0.0.1:5173:5173 \
  -e HOST=0.0.0.0 \
  -v "$PWD:/app" \
  -v jev-arena-node-modules:/app/node_modules \
  -w /app node:22-bookworm-slim \
  sh -c "npm ci && npm start"
```

打开 [本地对决场](http://localhost:5173)，按上面的步骤配置。结果保留在项目的 `runs/` 中；按 Ctrl+C 停止，下次执行同一命令启动。容器内监听 `0.0.0.0`，宿主端口仅绑定本机。

</details>

想试 100 条？上传 [演示 CSV](examples/demo/0919-124001/comments.csv)，将「本次条数」设为 `100` 并确认。程序只处理前 100 条，不会自动运行整个文件。

## 模型配置

| 模式 | Base URL 示例 | 模型 ID |
| --- | --- | --- |
| Jev Decisions | `https://openrouter.ai/api` | `typesafe/jev-1.13`（以账号实际可用为准） |
| DeepSeek（默认右侧） | `https://api.deepseek.com` | `deepseek-flash`（以账号实际可用为准） |
| OpenRouter 聊天 | `https://openrouter.ai/api/v1` | 服务商提供的 `组织/模型` ID |
| 其他 OpenAI 兼容服务 | 提供商指定地址，通常以 `/v1` 结尾 | 服务商提供的模型 ID |

**Jev 的 Decisions 是独立协议，不是 Chat Completions。** 选择 `jev` 时调用 `/alpha/decisions`；选择 `openai` 时调用 `/chat/completions`。也接受这两个接口的完整 URL。

聊天模式要求支持非流式 `messages` 请求，并能够输出符合提示词的 JSON 标签。若服务不支持 `response_format`，取消勾选 JSON mode。接口格式兼容不代表所有模型参数或输出能力完全相同；本项目不支持 Responses API、工具调用协议或自动发现模型。

左右两侧可自由组合供应商与模型；界面和录像记录实际名称及模型 ID。

## 评论文件格式

下载 [CSV 示例](examples/comments.csv) 或 [Excel 示例](examples/comments.xlsx)。CSV 使用 UTF-8，可带 BOM；Excel 读取第一张工作表，首行为列名。

```csv
comment_id,content,platform,like_count,topic_title
001,回答速度挺快的,example,3,AI 模型体验
002,复杂问题还是会答错,example,1,AI 模型体验
```

| 列 | 要求 |
| --- | --- |
| `comment_id` | 必需，非空且唯一。Excel 中建议设为文本，保留前导零。 |
| `content` | 必需，非空评论正文。CSV 中的逗号、换行须按 CSV 规则加引号。 |
| `platform` | 可选，用于展示来源分布。 |
| `like_count` | 可选，数字。 |
| `topic_title` | 可选，传给模型的主题上下文。 |

网页上传最多 10 MB。旧版 `.xls` 请另存为 `.xlsx`；公式单元格请转换为值。导入只校验数据，不调用模型；文件错误会保留上一次有效数据。待运行的上传数据保存在内存；开始运行后，实际处理的评论会保存到该次运行的 `comments.csv`。重启服务会恢复 `DATA_PATH` 指定的输入文件。

当前标签与提示词面向 **AI 模型 / 产品评论**。用于其他领域时，需调整 [受控词表](src/vocab.mjs) 和两个 [模型适配器](src/backends)，否则「相关性」等标签的语义不适用。

## 生成两份报告

运行完成后，用实际运行 ID 替换下方占位符：

```bash
npm run report -- --run runs/<运行ID>
```

Docker 启动的用户可在另一个终端执行：

```bash
docker exec jev-arena npm run report -- --run runs/<运行ID>
```

无需 Key、无需安装 VoxAgent；读取本次保存的评论快照与两侧标签，生成相同模板的两份 HTML、事实清单及结构化视图。默认正文是明确标注的**事实草稿**。要让自己的 Agent 撰写研究分析，请让它阅读 [报告生成指南](docs/report-generation.md)，按事实和证据写入两侧 narrative JSON 后再次渲染。根目录 [AGENTS.md](AGENTS.md) 也提供操作入口。

生成后刷新「查看双侧报告」即可阅读；HTML 也可下载后直接打开。旧运行没有评论快照时，需要用 `--dataset` 指定原始 CSV。报告模板的来源与维护说明见 [vendor 说明](report/vendor/voxagent/README.md)。

## 运行、费用与回放

- 默认每侧 20 条；超过 30 条需要明确确认。停止会取消在途请求，但供应商已处理的请求可能仍收费。
- 两侧各自并发、按批处理。解析失败可能拆批重试，实际请求次数和费用可能增加。
- API 返回 `usage.cost` 时使用其值；否则使用设置中的输入 / 输出美元单价估算。**未配置单价的 $0 表示费用未知，不是免费。** 估算不包含供应商折扣、缓存分档或失败请求账单。
- 结果保存在 `runs/<runId>/`：`comments.csv`（本次实际处理的评论快照）、`manifest.json`（模型和运行信息）、`events.jsonl`（录像）、`labels.*.jsonl`（逐条结果）、`report.json`（比较报告）。
- 回放只读取事件文件，不需要 Key；重启服务后仍可从录像列表播放。原有录像格式保持兼容。
- 新网页流程每次新建运行，不续写旧任务，避免切换数据或模型后混用结果。

Jev 的引文由程序从原文机械摘取，聊天模型的引文由模型输出后逐字校验；每条结果通过 `meta.evidenceSource` 区分。两侧标签的一致率不是准确率，速度和费用也不能替代人工质量评估。

## 开发与验证

```bash
npm test
```

测试使用本地模拟接口，覆盖导入、配置、双侧运行、回放、离线 HTML 生成与密钥检查，不调用付费 API。

已完成独立 Docker 验证：仅配置两个 Key，100 条真实评论两侧均成功；随后在无密钥、断网容器中生成两份报告。该验证不保证其他供应商或模型的兼容性。

服务默认仅监听 `127.0.0.1`，适合个人本地使用，没有多用户认证。不要直接部署到公网。`.env`、`data/`、`runs/` 与上传目录已加入 [.gitignore](.gitignore)；一万条演示样本与报告单独整理在 `examples/demo/`；本地完整录像不随仓库上传。

`report/` 包含独立可用的报告流水线与内置模板；`src/review.mjs` 是历史复核脚本，不属于通用网页启动流程。

## 贡献与许可

欢迎通过 [Issues](https://github.com/NanmiCoder/jev-arena/issues) 反馈兼容性问题，注明协议、模型 ID 和脱敏报错；请勿粘贴 API Key 或私人评论。

仓库公开提供代码、演示样本和报告，**尚未指定开源许可证**。评论内容归原作者与原平台；模板来源及许可状态见 [模板说明](report/vendor/voxagent/README.md)。
