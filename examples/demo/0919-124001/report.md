# Jev vs DeepSeek Flash 对比报告

- 运行：`0919-124001`（runs/0919-124001）
- 数据集：10000 条，本次运行 10000 条，指纹 `3c1e7621e3d78a4f`
- 平台分布（整个数据集）：bili=5783 dy=1691 xhs=1321 reddit=755 twitter=399 v2ex=51
- 开始：2026-09-19T04:40:01.577Z　结束：2026-09-19T04:53:45.152Z　总墙钟：823.575 秒
- 生成时间：2026-09-19T05:45:32.967Z

> 本报告的每个数字都从 `manifest.json`、`events.jsonl`、`labels.jev.jsonl`、`labels.deepseek.jsonl` 复算，无硬编码。

## 0. 覆盖度对账（先看分母，再看比例）

| 指标 | Jev | DeepSeek Flash |
|---|---:|---:|
| 成功打标 | 10000 | 10000 |
| 失败（已记账） | 0 | 0 |
| 未跑 | 0 | 0 |
| 本次运行条数（manifest.config.rows） | 10000 | 10000 |
| 成功率（分母 = 总条数） | 100% | 100% |

**配对集：10000 条**（两道都成功且 comment_id 相同；占总数 100%）。所有效果对比的分母都是这 10000 条，绝不拿两个不同分母的比例直接比。
> failureEvents 含二分重试后逐条记账的失败；repeatedFailureIds = 失败事件数 − 失败条数，是「重试后仍失败」的下界。

## 1. 时间

| 指标 | Jev | DeepSeek Flash |
|---|---:|---:|
| 墙钟时长（秒） | 203.207 | 823.486 |
| 开始时间戳 | 2026-09-19T04:40:01.577Z | 2026-09-19T04:40:01.594Z |
| 结束时间戳 | 2026-09-19T04:43:24.784Z | 2026-09-19T04:53:45.080Z |

**先跑完：Jev**；时长上 Jev 更快，快 **4.052×**。
> 每道的起止取 events.jsonl 中该道首/末事件的 t；两道并行跑，各自墙钟独立计时。

## 2. 金钱

| 指标 | Jev | DeepSeek Flash |
|---|---:|---:|
| 总费用（美元） | $0.838805 | $1.5004 |
| 总费用（人民币，按 1:7.1） | ¥5.96 | ¥10.65 |
| 单条均价（分母 = 成功条数） | $8.388e-5 / 10000 条 | $0.000150 / 10000 条 |
| 单条均价（人民币） | ¥0.000596 | ¥0.001065 |

**更便宜：Jev**，按单条均价算便宜 **1.789×**。

**计费口径（必须分清，否则数字没有意义）：**
- Jev：OpenRouter 响应里的 usage.cost（真实账单），逐条累加 label.meta.costUsd；不用单价表。
- DeepSeek Flash：接口不返回费用，按 pricing.mjs 的官方单价本地计算（cache hit/miss 分开计价），逐条累加 label.meta.costUsd。
- DeepSeek 命中档位（按运行开始时刻判定）：**off-peak（高峰价的一半）**；逐条记录到的档位：off-peak（高峰价的一半）×10000。
- 费用对账（events.jsonl 的 decision.costUsd 累加 vs labels 文件 meta.costUsd 累加）：Jev ✅ $0.838805 / $0.838805（差 $0）；DeepSeek Flash ✅ $1.5004 / $1.5004（差 $0）。
> 对比用单条均价，分母分别为两道各自成功条数；比率 = 贵的一方均价 ÷ 便宜的一方均价。

## 3. 速度

| 指标 | Jev | DeepSeek Flash |
|---|---:|---:|
| 吞吐（条/秒，分母 = 各自墙钟） | 49.211 | 12.143 |
| 单条平均延迟（毫秒，批次均摊） | 2139 | 9447 |
| P50 延迟（毫秒） | 1550 | 8859 |
| P95 延迟（毫秒） | 5610 | 14199 |
| 延迟样本数（分母） | 10000 | 10000 |
| 失败条数 | 0 | 0 |
| 重试后仍失败（下界） | 0 | 0 |

**吞吐更高：Jev**，高 **4.053×**。
> 延迟口径：label.meta.latencyMs 是「该条所在批次的往返耗时」，同一批内的条目共享同一个值；P50/P95 的分母是该道成功条数。重试次数未单独记账（二分会重发请求但不发事件），只能给出重试后仍失败条数。

## 4. 效果（一致率，分母 = 配对集 10000 条）

| 字段 | 一致条数 | 分母 | 一致率 |
|---|---:|---:|---:|
| 相关性 is_relevant | 8939 | 10000 | 89.39% |
| 情感 polarity | 7359 | 10000 | 73.59% |
| 意图 intent | 6785 | 10000 | 67.85% |
| 情感分数 ±0.25 | 7851 | 10000 | 78.51% |
| 情感分数 ±0.5（宽松） | 9580 | 10000 | 95.8% |

- 情感分数平均绝对差：**0.1613**（最大 1.41，分母 10000）。
- 上表字段都是「在同一受控词表里选一个」，机制同源，可以直接比较一致率。

### 4.1 仪器差异观察（**不是准确度，禁止当作效果指标引用**）

| 字段 | 平均 Jaccard | 完全一致 | 分母 | 为什么不能比 |
|---|---:|---:|---:|---|
| aspects | 0.347 | 1605 | 10000 | 两边列举机制不同（固定维度集合逐个判定 vs 自由列举），此数字是仪器差异而非准确度。 |
| emotion | 0.6235 | 5058 | 10000 | 两边列举机制不同（固定维度集合逐个判定 vs 自由列举），此数字是仪器差异而非准确度。 |

> ⚠️ **两边列举机制不同，此数字是仪器差异而非准确度**：一方在固定维度集合上逐个判定「是否提到」（可能一次命中多个、也可能为空），
> 另一方自由列举 1~2 个。报得多不代表报得准，Jaccard 低也不代表错。谁更准只能看独立盲评（`review.md`），
> 且盲评里 aspects 只作为附加观察轮，不计入胜负。

**条件一致率（只看双方都判 is_relevant=true 的 7846 条）**

| 字段 | 一致条数 | 分母 | 一致率 |
|---|---:|---:|---:|
| 情感 polarity | 6024 | 7846 | 76.78% |
| 意图 intent | 5598 | 7846 | 71.35% |
| 情感分数 ±0.25 | 6347 | 7846 | 80.89% |

**引文来源对账**（这一项不比对错，只防止把程序摘录当成模型输出）：

| | 有引文 | 逐字校验通过 | 总条数 | 来源标记 |
|---|---:|---:|---:|---|
| Jev | 10000 | 10000 | 10000 | host×10000 |
| DeepSeek Flash | 9841 | 9841 | 10000 | model×10000 |

> 所有 rate 的分母都是 paired；conditionalBothRelevant 的分母是其中双方都判 is_relevant=true 的条数。aspects/emotion 的 Jaccard 因两边产出机制不同源，标为 comparable:false，只作仪器差异展示，不是准确度指标。

## 5. 平台 × 情感交叉表（分母 = 各平台配对条数）

| 平台 | 配对数 | Jev 情感分布 | DeepSeek 情感分布 | 情感一致 |
|---|---:|---|---|---:|
| bili | 5783 | positive 1393 / negative 1467 / neutral 2625 / mixed 298 | positive 1108 / negative 1042 / neutral 3219 / mixed 414 | 4229/5783 = 73.13% |
| dy | 1691 | positive 458 / negative 502 / neutral 677 / mixed 54 | positive 382 / negative 295 / neutral 912 / mixed 102 | 1217/1691 = 71.97% |
| xhs | 1321 | positive 346 / negative 403 / neutral 522 / mixed 50 | positive 285 / negative 275 / neutral 684 / mixed 77 | 972/1321 = 73.58% |
| reddit | 755 | positive 242 / negative 176 / neutral 277 / mixed 60 | positive 227 / negative 137 / neutral 326 / mixed 65 | 591/755 = 78.28% |
| twitter | 399 | positive 195 / negative 54 / neutral 122 / mixed 28 | positive 196 / negative 29 / neutral 150 / mixed 24 | 308/399 = 77.19% |
| v2ex | 51 | positive 25 / negative 10 / neutral 10 / mixed 6 | positive 25 / negative 7 / neutral 11 / mixed 8 | 42/51 = 82.35% |

## 6. 分歧样本 Top 10（按分歧严重度排序，原始记录复算）

> 下面「分歧点」里的 aspects/emotion 的 Jaccard 只表示两套列举机制的差异，**不是准确度**：
> 两道的 aspects 产出机制不同源（固定维度集合逐个判定 vs 自由列举），报得多不等于报得对。

### 1. `6a6d8817000000000b038534`（xhs，分歧分 12）

> 豪完了...

分歧点：相关性判断相反（Jev false / DeepSeek true）；情感不同（negative vs positive）；意图不同（joke vs praise）；情感分差 1.075；维度 Jaccard 0；情绪 Jaccard 0

| 字段 | Jev | DeepSeek Flash |
|---|---|---|
| is_relevant | false | true |
| sentiment | negative (-0.575) | positive (0.5) |
| intent | joke | praise |
| aspects | — | other |
| emotion | 担忧、失望 | 认可 |
| evidence_quote（来源） | 豪完了...（host） | 豪完了...（model） |

### 2. `7669241511071122225`（dy，分歧分 11.55）

> [比心][比心][赞][赞][赞]

分歧点：相关性判断相反（Jev true / DeepSeek false）；情感不同（positive vs neutral）；意图不同（praise vs other）；情感分差 0.775；维度 Jaccard 0；情绪 Jaccard 0

| 字段 | Jev | DeepSeek Flash |
|---|---|---|
| is_relevant | true | false |
| sentiment | positive (0.775) | neutral (0) |
| intent | praise | other |
| aspects | capability、usability | — |
| emotion | 认可 | — |
| evidence_quote（来源） | [比心][比心][赞][赞][赞]（host） | [比心][比心][赞][赞][赞]（model） |

### 3. `308415045521`（bili，分歧分 11.5）

> 幻方没钱？别逗你梁叔叔笑了

分歧点：相关性判断相反（Jev false / DeepSeek true）；情感不同（negative vs positive）；意图不同（joke vs disagreement）；情感分差 1.09；维度 Jaccard 0；情绪 Jaccard 0.5

| 字段 | Jev | DeepSeek Flash |
|---|---|---|
| is_relevant | false | true |
| sentiment | negative (-0.69) | positive (0.4) |
| intent | joke | disagreement |
| aspects | — | trust |
| emotion | 调侃、质疑 | 调侃 |
| evidence_quote（来源） | 别逗你梁叔叔笑了（host） | 幻方没钱？别逗你梁叔叔笑了（model） |

### 4. `311892596080`（bili，分歧分 11.5）

> luna真区啊

分歧点：相关性判断相反（Jev false / DeepSeek true）；情感不同（positive vs negative）；意图不同（joke vs complaint）；情感分差 0.75；维度 Jaccard 0；情绪 Jaccard 0

| 字段 | Jev | DeepSeek Flash |
|---|---|---|
| is_relevant | false | true |
| sentiment | positive (0.15) | negative (-0.6) |
| intent | joke | complaint |
| aspects | — | capability |
| emotion | 调侃、认可 | 失望 |
| evidence_quote（来源） | luna真区啊（host） | luna真区啊（model） |

### 5. `6a6cbdaa000000002b028df2`（xhs，分歧分 11.5）

> 喷字儿像拉稀一样快

分歧点：相关性判断相反（Jev false / DeepSeek true）；情感不同（negative vs positive）；意图不同（joke vs praise）；情感分差 1.335；维度 Jaccard 0；情绪 Jaccard 0.5

| 字段 | Jev | DeepSeek Flash |
|---|---|---|
| is_relevant | false | true |
| sentiment | negative (-0.535) | positive (0.8) |
| intent | joke | praise |
| aspects | — | performance |
| emotion | 调侃 | 认可、调侃 |
| evidence_quote（来源） | 喷字儿像拉稀一样快（host） | 喷字儿像拉稀一样快（model） |

### 6. `6a6d848a0000000015008357`（xhs，分歧分 11.46）

> @程序猿方方

分歧点：相关性判断相反（Jev true / DeepSeek false）；情感不同（positive vs neutral）；意图不同（praise vs other）；情感分差 0.73；维度 Jaccard 0；情绪 Jaccard 0

| 字段 | Jev | DeepSeek Flash |
|---|---|---|
| is_relevant | true | false |
| sentiment | positive (0.73) | neutral (0) |
| intent | praise | other |
| aspects | performance、capability、service、content | other |
| emotion | 惊喜、认可 | — |
| evidence_quote（来源） | @程序猿方方（host） | —（model） |

### 7. `7668913256529986304`（dy，分歧分 11.3）

> [流泪]我好像确实落后于时代了 看评论区我都看不懂也没有使用的需求 只知道应该挺厉害的

分歧点：相关性判断相反（Jev false / DeepSeek true）；情感不同（negative vs neutral）；意图不同（complaint vs other）；情感分差 0.65；维度 Jaccard 0；情绪 Jaccard 0

| 字段 | Jev | DeepSeek Flash |
|---|---|---|
| is_relevant | false | true |
| sentiment | negative (-0.5) | neutral (0.15) |
| intent | complaint | other |
| aspects | — | other |
| emotion | — | 认可 |
| evidence_quote（来源） | [流泪]我好像确实落后于时代了   看评论区我都看不懂也没有使用的需求  只知道应该挺厉害的（host） | 只知道应该挺厉害的（model） |

### 8. `311829666176`（bili，分歧分 11.19）

> 哟西，这就是早起的鸟儿有虫吃吗？大家早上好呀[千恋万花表情包_丛雨Ciallo]

分歧点：相关性判断相反（Jev true / DeepSeek false）；情感不同（positive vs neutral）；意图不同（joke vs other）；情感分差 0.595；维度 Jaccard 0；情绪 Jaccard 0

| 字段 | Jev | DeepSeek Flash |
|---|---|---|
| is_relevant | true | false |
| sentiment | positive (0.595) | neutral (0) |
| intent | joke | other |
| aspects | — | other |
| emotion | 调侃 | — |
| evidence_quote（来源） | 大家早上好呀[千恋万花表情包_丛雨Ciallo]（host） | 大家早上好呀（model） |

### 9. `p0v323q`（reddit，分歧分 11.11）

> https://preview.redd.it/k7voh0ui7kgh1.jpeg?width=1073&format=pjpg&auto=webp&s=cff721322b76234f577fe73d3b4c281bf1dc9d34

分歧点：相关性判断相反（Jev true / DeepSeek false）；情感不同（positive vs neutral）；意图不同（information vs other）；情感分差 0.555；维度 Jaccard 0；情绪 Jaccard 0

| 字段 | Jev | DeepSeek Flash |
|---|---|---|
| is_relevant | true | false |
| sentiment | positive (0.555) | neutral (0) |
| intent | information | other |
| aspects | — | other |
| emotion | 惊喜 | — |
| evidence_quote（来源） | width=1073&format=pjpg&auto=webp&s=cff721322b76234f577fe73d3b4c281bf1dc9d34（host） | —（model） |

### 10. `2083465973190053948`（twitter，分歧分 11.1）

> @gmi_cloud wow

分歧点：相关性判断相反（Jev true / DeepSeek false）；情感不同（positive vs neutral）；意图不同（praise vs other）；情感分差 0.55；维度 Jaccard 0；情绪 Jaccard 0

| 字段 | Jev | DeepSeek Flash |
|---|---|---|
| is_relevant | true | false |
| sentiment | positive (0.55) | neutral (0) |
| intent | praise | other |
| aspects | price、comparison | other |
| emotion | 惊喜、认可 | — |
| evidence_quote（来源） | @gmi_cloud wow（host） | wow（model） |

## 7. 口径与局限

- **一致性 ≠ 正确性**：一致率只说明两道答案是否相同，不代表任何一方是对的。谁更准由独立盲评给出（`review.md`）。
- **aspects/emotion 不可直接比**：两道产出机制不同源（一边是固定维度集合逐个判定是否提到、一边是自由列举），
  Jaccard 主要反映输出长度与仪器差异；本报告把它放在 4.1 单独展示，不作为效果指标引用。
- **分母纪律**：效果类指标只在配对集（10000 条）上算；覆盖率、失败率的分母是总条数；单条均价的分母是各自成功条数。
- **延迟口径**：同一批内所有条目共享批次耗时，不是单条独立计时；批大小 10 条/次（两条道相同）。
- **费用口径**：Jev 是 OpenRouter 真实账单；DeepSeek 是本地按官方单价计算，可能因价格调整/缓存命中率而与真实账单有偏差。
- **重试不可见**：二分重试不会在 events.jsonl 留事件，报告只能给出「重试后仍失败」的下界。
- **引文口径**：Jev 的引文由宿主程序从原文机械摘取（evidenceSource=host），DeepSeek 的由模型自己给出（model）。
- **未跑完的 run**：若两道成功数不同或存在未跑条目，报告仍可生成，但比较结论只对配对集成立。
