<p align="center">
  <img src="assets/readme/hero-3d.png" width="100%" alt="Jev Arena：同一批评论进入绿蓝两条模型处理轨道的 3D 示意图">
</p>

# Jev Arena

**同一批评论，对比两个模型的速度、费用和标注结果。** 支持 CSV / Excel 导入、实时对决、录像回放和离线报告，默认 Jev vs DeepSeek，也可配置其他 OpenAI 兼容聊天模型。

[Jev 模型原理](https://nanmicoder.github.io/jev-arena/) · [数据与报告](examples/demo/README.md) · [使用指南](docs/usage.md)

![一万条评论历史对决的前 20 秒，1× 回放，无加速](assets/readme/demo.gif)

[演示来源](assets/readme/demo.md) · [静态截图](assets/readme/demo-still.png)

## 一万条评论实测

使用 **GPT-6 Astra 对同一批 10,000 条评论全量复核**：只看原文和原标题独立标注，再对照两侧结果；另随机抽取 400 条复标。

| 指标 | Jev 1.13 | DeepSeek Flash |
| --- | ---: | ---: |
| 处理耗时 | 203.2 秒 | 823.5 秒 |
| 费用（美元） | $0.84 | $1.50（估算） |
| 相关性准确率 | 94.70% | 96.26% |
| 情感准确率 | 82.91% | 84.54% |
| 意图准确率 | 77.90% | 80.33% |
| **三项同时正确** | **62.69%** | **67.26%** |

准确率采用允许合理歧义的口径，三项指相关性、情感、意图；**这是 AI 参考下的复核结果，不是人工金标准**。严格只认首选答案时，三项全对率为 50.58% / 55.45%。速度、费用与准确率均仅代表本次数据和配置。

[完整准确率报告](audit/accuracy-0919-124001/report.md) · [逐条核查表](audit/accuracy-0919-124001/逐条核查.csv) · [原始数据与两侧标签](examples/demo/README.md)

## 快速启动

需要 **Node.js 22+**；也可使用 [Docker](docs/usage.md#使用-docker)。

```bash
git clone https://github.com/NanmiCoder/jev-arena.git
cd jev-arena
npm ci
npm start
```

打开 [localhost:5173](http://localhost:5173)，填入 **OpenRouter Key 和 DeepSeek Key**，保存后点击「开始对决」。默认使用 **20 条合成评论**；可上传自己的 [CSV](examples/comments.csv) / [Excel](examples/comments.xlsx)，超过 30 条需确认。

结果保存在 `runs/<运行ID>/`，可随时回放；**回放不调用模型**。配置、导入格式与费用口径见 [使用指南](docs/usage.md)。

## 生成报告

运行结束后，替换为实际运行 ID：

```bash
npm run report -- --run runs/<运行ID>
```

离线生成两侧 HTML 报告，无需 Key。默认正文为**事实草稿**；需要 Agent 撰写分析时，按 [报告生成指南](docs/report-generation.md) 操作。

---

[使用指南](docs/usage.md) · [标签契约](docs/CONTRACT.md) · [反馈问题](https://github.com/NanmiCoder/jev-arena/issues) · 测试：`npm test`

[MIT License](LICENSE)。演示评论归原作者与平台，不属于代码许可范围。
