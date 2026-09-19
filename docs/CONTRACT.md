# jev-arena 接口契约（所有模块必须严格遵守）

> 这是并行开发的唯一事实源。改这里之前先确认没有别的模块依赖它。

## 0. 已验证的外部接口（2026-09-19 实跑通过，勿凭文档臆测）

### Jev（左道）
```
POST https://openrouter.ai/api/alpha/decisions      ← 注意：没有 /v1
Authorization: Bearer $OPENROUTER_API_KEY
Content-Type: application/json

{ "model": "typesafe/jev-1.13",
  "state": <string | object | array>,
  "questions": {
    "<id>": { "type": "noul",   "instructions": "...", "criteria": {"true":"...","false":"..."} },
    "<id>": { "type": "choice", "instructions": "...", "criteria": {"选项":"说明或 null"} },
    "<id>": { "type": "score",  "instructions": "...", "criteria": ["第0档","第1档",...] }
  } }
```
响应：
```json
{ "model": "typesafe/jev-1.13-20260917",
  "answers": { "<id>": {"type":"noul","noul":0.95},
               "<id>": {"type":"choice","choice":"mixed","probabilities":{...},"confidence":0.99},
               "<id>": {"type":"score","score":1.25,"legend":{...},"probabilities":{...},"confidence":0.79} },
  "usage": { "input_tokens": 509, "output_tokens": 78, "cost": 0.000021378 },
  "id": "gen-dec-...", "provider": "TypeSafe" }
```
- **`usage.cost` 是 OpenRouter 直接返回的真实费用（美元），不要自己算。**
- `score` 是**档位下标**（可落在两档之间），不是原始分值。
- `type` 用 `noul|choice|score`（原始命名）。**注意：Vercel AI SDK 那层用的是 `boolean`，别混淆。**
- 报错：`{"error":{"message":"...","code":400}}`。

### DeepSeek（右道）
```
POST https://api.deepseek.com/chat/completions
Authorization: Bearer $DEEPSEEK_API_KEY
{ "model": "deepseek-flash", "messages":[...], "temperature":0,
  "max_tokens": N, "response_format": {"type":"json_object"} }
```
响应是标准 OpenAI 形状，`usage: {prompt_tokens, completion_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens, completion_tokens_details:{reasoning_tokens}}`。
**不返回费用，必须本地按单价算。**

实测：单条评论 `completion_tokens=369`，其中 `reasoning_tokens=293` —— 它是推理模型，输出 token 是大头。

## 1. 统一的标签结构（两条道必须产出同一套字段，否则没法比）

```js
/** @typedef {Object} Label
 * @property {string} comment_id
 * @property {boolean} is_relevant
 * @property {"positive"|"negative"|"neutral"|"mixed"} sentiment
 * @property {number} sentiment_score      // -1..1
 * @property {number} confidence           // 0..1；Jev 来自答案，DeepSeek 无则 0
 * @property {string} intent               // 受控词表，见 vocab.mjs
 * @property {string[]} aspects            // 受控词表，最多 5
 * @property {string[]} emotion            // 受控词表，最多 3
 * @property {string} evidence_quote       // 必须是该评论原文的逐字子串
 * @property {Object} meta                 // {backend, costUsd, tokensIn, tokensOut, latencyMs, raw?}
 */
```

**硬规则**
1. `evidence_quote` 必须是原文逐字子串，校验不通过则置空并在 `meta.warnings` 记一笔。
   Jev 不产文本，引文由宿主从原文机械摘取，`meta.evidenceSource = "host"`；DeepSeek 的是 `"model"`。
   这个来源标记必须进报告 —— 绝不能让人以为 Jev 给出的引文是模型自己摘的。
2. 枚举值必须收敛到 `vocab.mjs` 的受控词表。模型写出词表外的值（实测 DeepSeek 会写 `intent:"观望"`）
   一律归一 + 记账，不要丢弃整条。
3. 所有金额单位为**美元**，保留 8 位小数。

## 2. 事件流（服务端 → 前端，SSE）

`GET /api/stream` 返回 `text/event-stream`，每行 `data: <json>\n\n`。

```js
{type:"run_start",  runId, total, lanes:[{id,label,model}], startedAt}
{type:"decision",   lane, index, commentId, ms, ok, costUsd, tokensIn, tokensOut,
                    label:Label|null, preview:string, error?:string}
{type:"lane_stats", lane, done, failed, elapsedMs, costUsd, tokensIn, tokensOut, cps}
{type:"run_end",    runId, lanes:LaneSummary[] }
{type:"error",      lane?, message}
```
- `lane` 取值固定为 `"jev"` / `"deepseek"`。
- `decision` 每完成一条就推一次，前端靠它做实时滚动。
- `lane_stats` 节流推送（≥200ms 一次），不要每条都推。
- 每个事件都带 `t` 字段：**epoch 毫秒**（`store.appendEvent` 里的 `Date.now()`），
  **不是相对运行起点的相对时间**（此前文档漏写，以实现为准）。回放按
  `(t - minT) / speed` 映射到墙钟重放。

## 3. HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 静态前端（全屏分屏页） |
| GET | `/api/state` | 当前运行状态 + 数据集信息（条数、平台分布） |
| POST | `/api/start` | `{limit?, concurrency?}` 启动对决；已在跑则 409 |
| POST | `/api/stop` | 停止当前运行 |
| GET | `/api/stream` | SSE 事件流 |
| GET | `/api/report` | 最近一次运行的报告 JSON |

## 4. 运行目录

```
runs/<runId>/
  manifest.json          配置、模型、数据集指纹、起止时间
  events.jsonl           全部事件（回放用）
  labels.jev.jsonl       左道逐条标签
  labels.deepseek.jsonl  右道逐条标签
  report.json            结构化对比结果
  report.md              给人看的报告
  review.md              Claude Code 独立评审
```

## 5. 单价表（`pricing.mjs`，DeepSeek 需本地算费）

deepseek-flash（美元 / 百万 token，来自官方 pricing 页）：
- 输入 cache miss：peak $0.30 / off-peak $0.15
- 输入 cache hit：peak $0.006 / off-peak $0.003
- 输出：peak $1.2 / off-peak $0.6
- peak = 周一至周五 01:00–04:00 与 06:00–10:00 UTC，其余为 off-peak

Jev：不要用单价表，直接用响应里的 `usage.cost`。

## 6. 本地开源版补充（优先于上方历史演示假设）

- `GET /api/config` 返回左右两侧公开配置与 `hasKey`，不返回 Key。
- `POST /api/config {lanes:[左侧,右侧]}`：支持 `jev` / `openai` 协议、`baseUrl`、`model`、`label`、`apiKey`、`jsonMode`、`inputPrice`、`outputPrice`。空 Key 保留旧值，但更换 URL 会清空旧 Key。
- `POST /api/dataset {name,data}`：`data` 为 base64 文件内容，支持 UTF-8 CSV / XLSX 第一张表；返回统计与三条预览。失败不替换当前数据。
- `POST /api/start` 缺省 `limit=20`；超过 30 条须 `confirmLargeRun:true`；并发限制为 1–10。网页/API 不允许续写已有运行。
- 配置、导入、启动、回放启动互斥；模型运行或回放期间不能改配置和数据。
- 运行结束状态在事件文件写完后返回，避免立即回放读到半截录像。
- 两侧 id 保留 `jev` / `deepseek` 以兼容历史录像，名称和模型由配置决定，不能再按 id 推断协议。
- 新的费用来源由 `meta.costSource` 标识：优先供应商返回；聊天接口可用用户单价估算，未配单价则 unknown。汇总 0 不等于免费。
- 默认载入 `examples/comments.csv` 的 20 条合成数据，原始评论与历史录像不纳入发布。
