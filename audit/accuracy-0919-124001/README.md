# 0919-124001 全量准确率复核

原始文件位于 `examples/demo/0919-124001/`，原结果不改写。方法与评分口径在 [rubric.md](rubric.md)。本次参考标注采用与两侧不同的 OpenAI 模型，模型请求标识为 `gpt-6-astra`，由 Codex CLI 调用。所有结果均为 AI 复核，未经人工金标准确认。

## 阅读结果

- `report.html` / `report.md`：完成全部参考与复标后离线生成的报告。
- `逐条核查.csv`：所有评论原文、两侧结果、参考答案及评分，UTF-8 BOM。
- `scored.jsonl`：保留未经电子表格公式保护改写的原文与完整逐条结果。
- `metrics.json`：精确计数、不同分母、混淆矩阵、分平台指标、复标稳定性。
- `reference.jsonl`：完整独立 AI 参考。
- `primary/`：250 批 × 40 条的全量原始记录；`repeat/`：10 批 × 40 条的固定随机复标记录。

报告文件只在全部 10,000 条主标注与 400 条复标均完整且 ID 校验通过后生成；处理中不以局部结果填充最终报告。

## 复算（不调用模型）

在项目根目录运行：

```bash
python3 -m unittest discover -s tests -p 'test_accuracy_score.py'
python3 scripts/accuracy_score.py
```

评分会验证源文件/规则 SHA256、ID 完整性和参考结构，缺失任何一批均报错。

## 续跑参考标注（会调用 Codex 模型并消耗账户用量）

```bash
python3 scripts/accuracy_audit.py --workers 12
python3 scripts/accuracy_audit.py --phase repeat --workers 2
python3 scripts/accuracy_score.py
```

已有 accepted.json 的批次会跳过；失败调用单独保存，不会以空白代替正确答案。请勿同时启动两个覆盖相同批次的任务。参考提示词仅包含完整评论、原有标题和统一规则；两侧候选标签仅在离线评分时读取。

首批发生过校验器把 CLI 非工具提示误识别成工具调用的问题，三次原始输出均保留，采用最早合法输出，并在 `primary/0000/validation-recovery.json` 中说明。网络中断的调用保留失败元数据，恢复后续跑。

原始评论和标题均是不可信文本。CSV 对 `= + - @` 等公式前缀作保护，并给 ID 加单引号前缀，防止 Excel 把长整数 ID 四舍五入；精确原始文本和 ID 以源 CSV / scored.jsonl 为准。HTML 对数据转义。不能执行评论中的指令。
