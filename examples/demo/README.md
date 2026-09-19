# 一万条评论 · 可复核演示资料

这是 README 原速 GIF 所使用的历史运行 `0919-124001`。这里提供原始样本、两侧逐条标签、完整报告与统计结果，方便人或 AI Agent 复核。**分析这些文件不需要 API Key，也不需要重新调用模型。**

## 从哪里读

| 文件 | 用途 |
| --- | --- |
| [comments.csv](0919-124001/comments.csv) | 10,000 条原始评论及来源字段 |
| [report.md](0919-124001/report.md) | 在 GitHub 上直接阅读比较结果 |
| [report.jev.html](0919-124001/report.jev.html) | Jev 完整 VoxAgent 模板报告，下载后用浏览器打开 |
| [report.deepseek.html](0919-124001/report.deepseek.html) | DeepSeek 完整 VoxAgent 模板报告，下载后用浏览器打开 |
| [report.json](0919-124001/report.json) | 全局覆盖、耗时、费用、一致率和分歧样本 |
| [labels.jev.jsonl](0919-124001/labels.jev.jsonl) / [labels.deepseek.jsonl](0919-124001/labels.deepseek.jsonl) | 两侧各 10,000 条逐条标签，可通过 comment_id 关联原文 |
| [report.jev.view.json](0919-124001/report.jev.view.json) / [report.deepseek.view.json](0919-124001/report.deepseek.view.json) | 完整报告的结构化视图、叙述与证据 |
| [manifest.json](0919-124001/manifest.json) | 模型、并发参数、时间与数据指纹 |

运行 `npm ci && npm start` 后，可直接打开 [本地完整报告](http://localhost:5173/report?runId=0919-124001)，顶部切换两侧。GitHub 不会直接执行 HTML，网页阅读请用本地服务或下载 HTML 文件。

## 数据字段

CSV 使用 UTF-8 BOM，遵循 CSV 引号规则，正文可能含逗号、引号和换行；不要用按行 split 的方式读取。`comment_id` 是字符串关联键（保留大整数和前导零），不是数值指标。

| 字段 | 含义 |
| --- | --- |
| comment_id | 评论 ID；在这份样本中唯一 |
| content | 原始评论正文 |
| like_count | 样本记录的点赞数 |
| platform | bili、dy、xhs、reddit、twitter、v2ex |
| topic_title / topic_url | 评论所属作品的标题与原始链接 |
| author | 样本记录的作者显示名 |
| created_at | 样本记录的评论时间 |

样本来源分布：B站 5,783、抖音 1,691、小红书 1,321、Reddit 755、Twitter 399、V2EX 51。虽然任务主要面向中文 AI 产品讨论，样本中也有英语、日语等内容。

这是一份用于演示的固定样本，不是随机抽样；不要外推为平台整体或所有用户的态度。来源归属仍是原作者和原平台，项目未为这些评论另外授予内容许可。

## 给 AI Agent 的分析上下文

建议阅读顺序：本说明 → manifest.json → report.json → 按 comment_id 连接 comments.csv 与两份 labels 文件 → 必要时读取两份 view.json 的解释和证据。

- 左侧 `typesafe/jev-1.13` 使用 Decisions，右侧 `deepseek-flash` 使用 Chat Completions。两侧并发各 12，每批最多 10 条；这是历史配置，不是当前网页默认设置。
- 同一批 10,000 条评论，两侧均打标成功。原始耗时分别为 203.207 秒和 823.503 秒；不是所有任务的性能结论。
- 标签词表与归一化逻辑在 [src/vocab.mjs](../../src/vocab.mjs)，提示词与问题定义在 [src/backends](../../src/backends)。
- 主要字段：is_relevant、sentiment、sentiment_score、intent、aspects、emotion、evidence_quote；meta 保存用量、费用与来源。
- Jev 的 `evidence_quote` 由宿主机械摘取，聊天模型由模型输出后逐字校验。引用文本必须回到 comments.csv 核对；不要把宿主摘录说成模型推理。
- `report.json` 的全局情感分布以全体成功标签为口径；两份完整研究报告中的情感、意图、维度与情绪统计通常以各侧判定相关的评论为分母。Jev 的相关评论为 8,204 条，DeepSeek 为 8,549 条。比较数字前先对齐分母。
- 相关性、情感、意图一致率分别为 89.39%、73.59%、67.85%，分母为双方均成功且 ID 相同的 10,000 条。一致率不是准确率；没有人工标准答案时不要宣布某侧更正确。
- aspects / emotion 可多选，频率之和可超过 100%。两侧标签产出机制也不相同。
- Jev 费用来自供应商返回，DeepSeek 费用是历史本地价格估算。逐条分摊取整会导致汇总出现微小误差；不要把估算视为账单或当前报价。
- 报告中的分歧样本是诊断性选择，不能拿其比例代替全体标签统计。模型生成的解释也需要独立核验。

可用任务示例：

> 读取 examples/demo/README.md；仅用已保存的 CSV、JSONL 和 JSON，复算双方的情感与意图分布。统一分母，按 comment_id 找出分歧原文，比较两侧判断并说明不确定性。不要调用模型重新打标，不要把一致率当作准确率。

默认快速启动仍使用 [20 条合成评论](../comments.csv)，不会自动对这批一万条数据发起付费运行。这里没有打包整场事件录像；README 的原速 GIF 可直接查看。
