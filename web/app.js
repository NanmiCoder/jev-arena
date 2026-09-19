/* ============================================================
 * jev-arena · 实时对决仪表盘（原生 ES module，无框架 / 无 CDN / 离线可跑）
 *
 * 严格按 docs/CONTRACT.md §2 / §3 消费接口：
 *   GET  /api/stream   SSE，data: {type:"run_start"|"decision"|"lane_stats"|"run_end"|"error"}
 *   GET  /api/state    当前状态 + 数据集信息
 *   POST /api/start    {limit?, concurrency?}
 *   POST /api/stop
 *   GET  /api/report   报告 JSON
 *
 * 对 /api/state 的形状做了宽容读取（服务端尚未定稿）：同时接受
 *   { running, runId, total, lanes:[{id,label,model,done,failed,elapsedMs,costUsd,cps,...}] }
 *   { state:{...}, data:{...} }、lanes 为对象映射、dataset.platforms 为数组或对象，
 * 字段名接受 camelCase / snake_case 两种写法。缺失的字段一律降级显示，不抛错。
 *
 * 所有金额单位美元，展示精度对齐 src/pricing.mjs：< $1 保留 6 位，≥ $1 保留 4 位。
 * ============================================================ */

/* ── 常量 ─────────────────────────────────────────────────── */

const MAX_ROWS = 200;        // 实时流 DOM 上限，超出丢弃最旧的（1 万条不能全塞 DOM）
const PREVIEW_CHARS = 40;    // 评论正文展示字数
const RECONNECT_MS = 3000;   // SSE 被彻底关闭后的手动重连间隔
const STALE_MS = 20000;      // 运行中多久收不到事件算「数据延迟」
const TICK_MS = 100;         // 本地计时器刷新间隔
const STATE_POLL_MS = 8000;  // SSE 断线时的兜底轮询

const LANE_DEFS = [
  { id: 'jev',      name: 'Jev',            model: 'typesafe/jev-1.13' },
  { id: 'deepseek', name: 'DeepSeek Flash', model: 'deepseek-flash' },
];

const STATUS_TEXT = { idle: '未开始', running: '运行中', done: '已完成', stopped: '已停止' };

const SENTIMENT_TEXT = { positive: '正面', negative: '负面', neutral: '中性', mixed: '混合' };
const SENTIMENT_CLASS = { positive: 'positive', negative: 'negative', neutral: 'neutral', mixed: 'mixed' };
const INTENT_TEXT = {
  praise: '称赞', complaint: '抱怨', question: '提问', suggestion: '建议', correction: '纠错',
  agreement: '赞同', disagreement: '反对', joke: '玩梗', information: '信息', other: '其他',
};

/* ── 工具 ─────────────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

function firstNum(...vals) {
  for (const v of vals) if (Number.isFinite(Number(v)) && v !== null && v !== undefined && v !== '') return Number(v);
  return undefined;
}
function firstStr(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

const pad2 = (n) => String(n).padStart(2, '0');

function fmtInt(n) {
  return Math.round(num(n)).toLocaleString('en-US');
}

/** 金额：绝不四舍五入成 $0.00（总额可能只有几美分）。 */
function fmtUsd(v) {
  const n = num(v);
  if (!(n > 0)) return '$0.000000';
  if (n >= 1) return '$' + n.toFixed(4);
  if (n >= 0.0001) return '$' + n.toFixed(6);
  return '$' + n.toFixed(7);
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.round(num(ms) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}
const fmtSeconds = (ms) => (num(ms) / 1000).toFixed(1);

function fmtCps(v) {
  const n = num(v);
  return n >= 100 ? n.toFixed(0) : n.toFixed(1);
}

function fmtTokens(v) {
  const n = num(v);
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

/** 截断到 n 个「字」（按码点，中文算 1 个），压缩空白。 */
function clip(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const arr = Array.from(s);
  return arr.length > n ? arr.slice(0, n).join('') + '…' : s;
}

/* ── 全局运行状态 ─────────────────────────────────────────── */

const run = {
  running: false,
  stoppedByUser: false,
  runId: null,
  startedAt: null,
  lastEventAt: 0,
  backendDown: false,
};

/** laneId -> lane 状态对象 */
const lanes = new Map();

/* ── 回放（录屏）────────────────────────────────────────────
 * 回放事件来自服务端只读的 events.jsonl，SSE 上每条都带 replay:true 标记，
 * 事件形状与真跑完全一致，因此下面所有渲染逻辑一行都不用改。
 * URL 参数：?replay=<runId>&speed=20&autoplay=1&embed=1
 *   autoplay=1 打开页面自动开播（录屏省事）；embed=1 隐藏控件只留画面。 */

const urlParams = new URLSearchParams(location.search);
const REPLAY_PARAM = (urlParams.get('replay') || '').trim();
const AUTOPLAY = urlParams.get('autoplay') === '1';
const EMBED = urlParams.get('embed') === '1';
const paramSpeed = Number(urlParams.get('speed'));
const SPEEDS = [1, 5, 10, 20, 50, 100];

const replayState = {
  active: false,        // 正在回放
  finished: false,      // 已自然放完（停在最终状态）
  started: false,       // 本页是否发起过回放（用于忽略服务端残留的旧回放状态）
  runId: REPLAY_PARAM || null,
  speed: SPEEDS.includes(paramSpeed) ? paramSpeed : (Number.isFinite(paramSpeed) && paramSpeed > 0 ? paramSpeed : 1),
  virtualMs: 0,
  totalMs: 0,
  emitted: 0,
  total: 0,
};

// 页面带着回放参数打开 → 禁用「开始对决」，从根上杜绝录屏时误触真跑花钱
let replayIntent = Boolean(REPLAY_PARAM);

/* ── DOM 引用 ─────────────────────────────────────────────── */

const el = {
  startBtn: $('#startBtn'),
  dsTotal: $('#dsTotal'),
  dsSource: $('#dsSource'),
  dsPlatforms: $('#dsPlatforms'),
  conn: $('#conn'),
  connText: $('#connText'),
  runId: $('#runId'),
  banner: $('#banner'),
  bannerJevName: $('#bannerJevName'),
  bannerJevVal: $('#bannerJevVal'),
  bannerDsName: $('#bannerDsName'),
  bannerDsVal: $('#bannerDsVal'),
  bannerSub: $('#bannerSub'),
  bannerLink: $('#bannerLink'),
  bannerClose: $('#bannerClose'),
  toast: $('#toast'),
  arena: $('.arena'),
  replayBar: $('#replayBar'),
  replayRun: $('#replayRun'),
  replayBtn: $('#replayBtn'),
  replaySpeed: $('#replaySpeed'),
  replayStatus: $('#replayStatus'),
  replayBadge: $('#replayBadge'),
  replayBadgeText: $('#replayBadgeText'),
  replayBadgeSpeed: $('#replayBadgeSpeed'),
};

/* ── 泳道：构建 ───────────────────────────────────────────── */

const laneTemplate = $('#laneTemplate');

/** host 传 .metric 单元格，字号分档挂在里面的 .metric-value 上（CSS 按 data-w 取值）。 */
function makeMetric(cell) {
  const host = cell.classList.contains('metric-value') ? cell : $('.metric-value', cell);
  return { host, num: $('.num', host), suffixEl: null, main: null, suffix: null };
}

function metricSet(m, main, suffix) {
  if (m.main !== main) {
    m.num.textContent = main;
    m.main = main;
  }
  const suf = suffix || null;
  if (m.suffix !== suf) {
    if (!suf) {
      if (m.suffixEl) { m.suffixEl.remove(); m.suffixEl = null; }
    } else {
      if (!m.suffixEl) {
        m.suffixEl = document.createElement('span');
        m.suffixEl.className = 'suffix';
        m.host.appendChild(m.suffixEl);
      }
      m.suffixEl.textContent = suf;
    }
    m.suffix = suf;
  }
  // 按「视觉宽度」分档缩字号，保证任何数字都不撑破格子
  const width = Array.from(main).length + (suf ? Math.round(Array.from(suf).length * 0.42) : 0);
  const bucket = String(Math.max(4, Math.min(12, width)));
  if (m.host.dataset.w !== bucket) m.host.dataset.w = bucket;
}

function createLane(def) {
  // index.html 里已经放好了两侧的 <section class="lane">（中间夹着分隔线），
  // 模板只承载泳道内部结构，整块替换进去，保证左右完全对称。
  let node = $(`.lane[data-lane="${def.id}"]`);
  if (!node) {
    node = document.createElement('section');
    node.className = 'lane';
    node.dataset.lane = def.id;
    el.arena.appendChild(node);
  }
  node.replaceChildren(laneTemplate.content.cloneNode(true));
  node.dataset.status = 'idle';

  const lane = {
    id: def.id,
    name: def.name,
    model: def.model,
    status: 'idle',
    // 服务端权威值（lane_stats / run_end 写入）
    stats: { done: 0, failed: 0, elapsedMs: 0, costUsd: 0, cps: 0, tokensIn: 0, tokensOut: 0 },
    statsAt: 0,          // performance.now()，用于本地插值计时
    // 本地从 decision 事件累加的「桥接」值，配合 stats 做平滑
    live: { done: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 },
    liveAtStats: { done: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 },
    retries: 0,
    normalized: 0,
    lastError: '',
    el: {
      node,
      dot: $('.status-dot', node),
      name: $('.lane-name', node),
      model: $('.lane-model', node),
      state: $('.lane-state', node),
      done: makeMetric($('.metric--done', node)),
      time: makeMetric($('.metric--time', node)),
      cost: makeMetric($('.metric--cost', node)),
      cps: makeMetric($('.metric--cps', node)),
      fill: $('.progress-fill', node),
      pct: $('.progress-pct', node),
      feed: $('.feed', node),
      footErr: $('.foot-stat--err', node),
      footRetry: $('.foot-stat--retry', node),
      footNorm: $('.foot-stat--norm', node),
      footTokens: $('.foot-stat--tokens', node),
      footMsg: $('.foot-msg', node),
    },
    pending: [],
    rendered: { done: null, time: null, cost: null, cps: null, pct: null, status: null, foot: null },
  };

  lane.el.name.textContent = def.name;
  lane.el.model.textContent = def.model;
  lane.el.state.textContent = STATUS_TEXT.idle;

  lanes.set(def.id, lane);
  return lane;
}

/* ── 泳道：渲染 ───────────────────────────────────────────── */

const bridge = (lane, key) =>
  lane.status === 'running'
    ? lane.stats[key] + (lane.live[key] - lane.liveAtStats[key])
    : (lane.stats[key] || lane.live[key]);

function laneView(lane) {
  const done = Math.max(0, bridge(lane, 'done'));
  // 服务端 elapsedMs 每 ≥200ms 才推一次，两次之间用本地时钟插值，秒数才是连续走的
  const elapsedMs = lane.status === 'running' && lane.statsAt
    ? lane.stats.elapsedMs + (performance.now() - lane.statsAt)
    : lane.stats.elapsedMs;
  const cpsFresh = performance.now() - lane.statsAt < 2000;
  const cps = lane.status === 'running' && !cpsFresh && elapsedMs > 500
    ? done / (elapsedMs / 1000)
    : lane.stats.cps;
  return {
    done,
    elapsedMs,
    costUsd: Math.max(0, bridge(lane, 'costUsd')),
    cps: Math.max(0, cps),
    total: lane.total || 0,
  };
}

function renderLane(lane) {
  const v = laneView(lane);
  const r = lane.rendered;

  if (r.status !== lane.status) {
    r.status = lane.status;
    lane.el.node.dataset.status = lane.status;
    lane.el.state.textContent = STATUS_TEXT[lane.status] || lane.status;
  }

  const doneText = fmtInt(v.done);
  const pct = v.total > 0 ? Math.min(100, (v.done / v.total) * 100) : 0;
  metricSet(lane.el.done, doneText, v.total > 0 ? '/' + fmtInt(v.total) : '');

  const timeText = fmtDuration(v.elapsedMs);
  metricSet(lane.el.time, timeText);
  metricSet(lane.el.cost, fmtUsd(v.costUsd));
  metricSet(lane.el.cps, fmtCps(v.cps));

  const pctText = pct.toFixed(1) + '%';
  if (r.pct !== pctText) {
    r.pct = pctText;
    lane.el.pct.textContent = pctText;
    lane.el.fill.style.transform = `scaleX(${(pct / 100).toFixed(4)})`;
  }

  const failed = Math.max(0, lane.stats.failed || 0);
  const foot = `失败 ${failed}|重试 ${lane.retries}|归一 ${lane.normalized}|` +
    `tokens ${fmtTokens(bridge(lane, 'tokensIn'))} / ${fmtTokens(bridge(lane, 'tokensOut'))}`;
  if (r.foot !== foot) {
    r.foot = foot;
    lane.el.footErr.textContent = `失败 ${failed}`;
    lane.el.footErr.classList.toggle('has-err', failed > 0);
    lane.el.footRetry.textContent = `重试 ${lane.retries}`;
    lane.el.footNorm.textContent = `归一 ${lane.normalized}`;
    lane.el.footTokens.textContent =
      `tokens ${fmtTokens(bridge(lane, 'tokensIn'))} / ${fmtTokens(bridge(lane, 'tokensOut'))}`;
  }
  if (lane.el.footMsg.textContent !== lane.lastError) {
    lane.el.footMsg.textContent = lane.lastError;
  }
}

/* ── 实时流：行 ───────────────────────────────────────────── */

function buildRow(lane, ev) {
  const row = document.createElement('div');
  row.className = 'row' + (ev.ok === false ? ' row--fail' : '');

  const idx = document.createElement('span');
  idx.className = 'row-idx';
  idx.textContent = Number.isFinite(Number(ev.index)) ? '#' + (Number(ev.index) + 1) : '';

  const text = document.createElement('span');
  text.className = 'row-text';
  text.textContent = clip(ev.preview, PREVIEW_CHARS) || '(无正文)';

  const tags = document.createElement('span');
  tags.className = 'row-tags';

  const label = ev.label;
  if (ev.ok === false) {
    const t = document.createElement('span');
    t.className = 'tag tag--fail';
    t.textContent = '错误';
    tags.appendChild(t);
  } else if (label) {
    const rel = document.createElement('span');
    rel.className = 'tag ' + (label.is_relevant ? 'tag--rel' : 'tag--irrel');
    rel.textContent = label.is_relevant ? '相关' : '无关';
    tags.appendChild(rel);

    const sent = document.createElement('span');
    sent.className = 'tag tag--' + (SENTIMENT_CLASS[label.sentiment] || 'neutral');
    sent.textContent = SENTIMENT_TEXT[label.sentiment] || label.sentiment || '—';
    tags.appendChild(sent);

    const intent = document.createElement('span');
    intent.className = 'tag';
    intent.textContent = INTENT_TEXT[label.intent] || label.intent || '—';
    tags.appendChild(intent);

    // 词表外的值被归一过：值得在视频里留个痕
    const norm = label.meta && Array.isArray(label.meta.normalized) ? label.meta.normalized : null;
    if (norm && norm.length) {
      lane.normalized += 1;
      const t = document.createElement('span');
      t.className = 'tag tag--norm';
      t.textContent = '归一';
      t.title = norm.map((c) => `${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`).join('\n');
      tags.appendChild(t);
    }
  } else {
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = '—';
    tags.appendChild(t);
  }

  const ms = document.createElement('span');
  ms.className = 'row-ms';
  ms.textContent = Number.isFinite(Number(ev.ms)) ? Math.round(Number(ev.ms)) + 'ms' : '';

  row.append(idx, text, tags, ms);
  row.title = [clip(ev.preview, 200), ev.error ? '错误：' + ev.error : ''].filter(Boolean).join('\n');
  return row;
}

function prependRows(lane, nodes) {
  const feed = lane.el.feed;
  const nearTop = feed.scrollTop <= 8;
  const beforeH = feed.scrollHeight;

  const frag = document.createDocumentFragment();
  for (let i = nodes.length - 1; i >= 0; i--) frag.appendChild(nodes[i]); // 最新一条在最上面
  feed.prepend(frag);

  let excess = feed.childElementCount - MAX_ROWS;
  while (excess-- > 0) {
    const last = feed.lastElementChild;
    if (!last) break;
    last.remove();
  }

  if (nearTop) feed.scrollTop = 0;
  else feed.scrollTop += Math.max(0, feed.scrollHeight - beforeH);
}

let rafId = 0;
function flushRows() {
  rafId = 0;
  for (const lane of lanes.values()) {
    if (!lane.pending.length) continue;
    const nodes = lane.pending;
    lane.pending = [];
    prependRows(lane, nodes);
  }
}
function queueRow(lane, ev) {
  lane.pending.push(buildRow(lane, ev));
  if (lane.pending.length > 400) lane.pending.splice(0, lane.pending.length - 400);
  if (!rafId) rafId = requestAnimationFrame(flushRows);
}

/* ── 事件处理（契约 §2）───────────────────────────────────── */

function resetLane(lane) {
  lane.status = 'running';
  lane.stats = { done: 0, failed: 0, elapsedMs: 0, costUsd: 0, cps: 0, tokensIn: 0, tokensOut: 0 };
  lane.statsAt = performance.now();
  lane.live = { done: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 };
  lane.liveAtStats = { done: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 };
  lane.retries = 0;
  lane.normalized = 0;
  lane.lastError = '';
  lane.rendered = { done: null, time: null, cost: null, cps: null, pct: null, status: null, foot: null };
  lane.pending = [];
  lane.el.feed.replaceChildren();
}

function onRunStart(ev) {
  run.running = true;
  run.stoppedByUser = false;
  run.runId = ev.runId || null;
  const started = Number(ev.startedAt);
  run.startedAt = Number.isFinite(started) && started > 0
    ? started
    : (Date.parse(ev.startedAt) || Date.now());
  el.runId.textContent = run.runId ? 'run ' + run.runId : 'run —';
  hideBanner();

  const total = num(ev.total, 0);
  const defs = Array.isArray(ev.lanes) && ev.lanes.length ? ev.lanes : LANE_DEFS;

  for (const lane of lanes.values()) resetLane(lane);

  for (const def of defs) {
    const id = def.id || def.lane;
    let lane = lanes.get(id);
    if (!lane) lane = createLane({ id, name: def.label || def.name || id, model: def.model || '' });
    if (def.label || def.name) {
      lane.name = def.label || def.name;
      lane.el.name.textContent = lane.name;
    }
    if (def.model) {
      lane.model = def.model;
      lane.el.model.textContent = def.model;
    }
  }
  for (const lane of lanes.values()) {
    lane.total = total;
    if (run.running && lane.status === 'idle') lane.status = 'running';
    renderLane(lane);
  }
  updateStartBtn();
}

function onDecision(ev) {
  const lane = lanes.get(ev.lane);
  if (!lane) return;
  if (lane.status !== 'running') lane.status = 'running';

  const ok = ev.ok !== false;
  lane.live.done += 1;
  lane.live.costUsd += num(ev.costUsd, 0);
  lane.live.tokensIn += num(ev.tokensIn, 0);
  lane.live.tokensOut += num(ev.tokensOut, 0);
  if (!ok) {
    lane.stats.failed = Math.max(lane.stats.failed, 0) + 1; // 本地先记，lane_stats 到达后以服务端为准
    lane.lastError = clip(ev.error || '调用失败', 60);
  }
  if (Number(ev.attempt) > 1) lane.retries += 1;

  queueRow(lane, ev);
  renderLane(lane);
}

function onLaneStats(ev) {
  const lane = lanes.get(ev.lane);
  if (!lane) return;
  lane.stats.done = num(ev.done, lane.stats.done);
  if (ev.failed !== undefined) lane.stats.failed = num(ev.failed, lane.stats.failed);
  lane.stats.elapsedMs = num(ev.elapsedMs, lane.stats.elapsedMs);
  lane.stats.costUsd = num(ev.costUsd, lane.stats.costUsd);
  lane.stats.cps = num(ev.cps, lane.stats.cps);
  lane.stats.tokensIn = num(ev.tokensIn, lane.stats.tokensIn);
  lane.stats.tokensOut = num(ev.tokensOut, lane.stats.tokensOut);
  lane.statsAt = performance.now();
  lane.liveAtStats = { ...lane.live };
  renderLane(lane);
}

function readSummary(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    id: entry.id ?? entry.lane ?? entry.laneId,
    label: entry.label ?? entry.name,
    model: entry.model,
    total: entry.total,
    elapsedMs: firstNum(entry.elapsedMs, entry.elapsed_ms, entry.elapsed, entry.durationMs, entry.ms),
    costUsd: firstNum(entry.costUsd, entry.cost_usd, entry.cost),
    done: firstNum(entry.done, entry.processed, entry.count),
    failed: firstNum(entry.failed, entry.errors, entry.errorCount),
    cps: firstNum(entry.cps, entry.rate),
    tokensIn: firstNum(entry.tokensIn, entry.tokens_in, entry.promptTokens),
    tokensOut: firstNum(entry.tokensOut, entry.tokens_out, entry.completionTokens),
  };
}

function onRunEnd(ev) {
  run.running = false;
  const stopped = run.stoppedByUser;
  const summaries = Array.isArray(ev.lanes) ? ev.lanes : [];
  const byId = new Map();
  for (const s of summaries) {
    const r = readSummary(s);
    if (r && r.id) byId.set(r.id, r);
  }
  for (const lane of lanes.values()) {
    const s = byId.get(lane.id);
    if (s) {
      if (s.model) { lane.model = s.model; lane.el.model.textContent = s.model; }
    if (s.total) lane.total = s.total;
    if (s.elapsedMs !== undefined) lane.stats.elapsedMs = s.elapsedMs;
      if (s.costUsd !== undefined) lane.stats.costUsd = s.costUsd;
      if (s.done !== undefined) { lane.stats.done = s.done; lane.liveAtStats = { ...lane.live }; }
      if (s.failed !== undefined) lane.stats.failed = s.failed;
      if (s.cps !== undefined) lane.stats.cps = s.cps;
      if (s.tokensIn !== undefined) lane.stats.tokensIn = s.tokensIn;
      if (s.tokensOut !== undefined) lane.stats.tokensOut = s.tokensOut;
      if (s.label) { lane.name = s.label; lane.el.name.textContent = s.label; }
    } else {
      // 没有汇总：把本地观察值冻结成最终值
      lane.stats.done = Math.max(lane.stats.done, lane.live.done);
      lane.stats.costUsd = lane.stats.costUsd || lane.live.costUsd;
      lane.liveAtStats = { ...lane.live };
    }
    if (!lane.stats.elapsedMs && run.startedAt) {
      lane.stats.elapsedMs = Math.max(0, Date.now() - run.startedAt);
    }
    lane.status = stopped ? 'stopped' : 'done';
    lane.statsAt = 0;
    renderLane(lane);
  }
  flushRows();
  updateStartBtn();
  showBanner(stopped);
}

function onErrorEvent(ev) {
  const msg = ev && ev.message ? String(ev.message) : '未知错误';
  toast(msg);
  if (ev && ev.lane) {
    const lane = lanes.get(ev.lane);
    if (lane) {
      lane.lastError = clip(msg, 60);
      renderLane(lane);
    }
  }
}

/** 带 replay:true 的事件 → 维护角标状态（渲染逻辑完全复用真跑那套）。
 *  decision 有 2 万条，不做任何额外 DOM 操作；lane_stats 本身就是节流的，
 *  用它带的 elapsedMs（原 run 的真实耗时）推进进度文字，粒度 250ms 虚拟时间。 */
function trackReplayEvent(ev) {
  if (ev.type === 'lane_stats') {
    const v = Number(ev.elapsedMs);
    if (Number.isFinite(v) && v - replayState.virtualMs >= 250) {
      replayState.virtualMs = v;
      updateReplayUI();
    }
    return;
  }
  if (ev.type === 'run_start') {
    replayState.active = true;
    replayState.finished = false;
    replayState.started = true;
    if (ev.runId) replayState.runId = ev.runId;
    updateReplayUI();
  } else if (ev.type === 'run_end') {
    replayState.active = false;
    replayState.finished = true;
    replayState.emitted = replayState.total || replayState.emitted;
    replayState.virtualMs = replayState.totalMs || replayState.virtualMs;
    updateReplayUI();
  }
}

function handleEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  run.lastEventAt = Date.now();
  if (ev.replay === true) trackReplayEvent(ev);
  switch (ev.type) {
    case 'run_start':  onRunStart(ev); return;
    case 'decision':   onDecision(ev); return;
    case 'lane_stats': onLaneStats(ev); return;
    case 'run_end':    onRunEnd(ev); return;
    case 'error':      onErrorEvent(ev); return;
    default: return; // 未知类型静默忽略（向后兼容）
  }
}

/* ── /api/state ───────────────────────────────────────────── */

function pickFrom(sources, keys) {
  for (const src of sources) {
    for (const k of keys) {
      const v = src[k];
      if (v !== undefined && v !== null) return v;
    }
  }
  return undefined;
}

function applyState(raw) {
  if (!raw || typeof raw !== 'object') return;
  const sources = [raw, raw.state, raw.data].filter((o) => o && typeof o === 'object' && !Array.isArray(o));
  const get = (...keys) => pickFrom(sources, keys);

  const runId = firstStr(get('runId', 'run_id'));
  if (runId) {
    run.runId = runId;
    el.runId.textContent = 'run ' + runId;
  }

  const statusRaw = String(get('status', 'state') ?? '').toLowerCase();
  const runningRaw = get('running', 'isRunning', 'active');
  const running = runningRaw !== undefined
    ? Boolean(runningRaw)
    : statusRaw === 'running' || statusRaw === 'started';
  run.running = running;

  // 数据集（契约：条数 + 平台分布）
  const ds = get('dataset', 'dataSet') || {};
  const total = firstNum(ds.rows, ds.total, ds.count, ds.size, get('total', 'totalCount', 'datasetSize'));
  const runTotal = firstNum(get('total'), total);
  if (total !== undefined) {
    el.dsTotal.textContent = fmtInt(total);
    for (const lane of lanes.values()) lane.total = runTotal || total;
  }
  const srcLabel = firstStr(ds.path, ds.file, ds.source, ds.name, get('datasetPath', 'datasetFile'));
  el.dsSource.textContent = srcLabel
    ? clip(srcLabel.replace(/^.*[/\\]/, ''), 40)
    : (total !== undefined ? '数据集已载入' : '数据集未知');

  const platforms = get('platforms', 'platformCounts', 'byPlatform', 'platformDistribution') ?? ds.platforms ?? ds.byPlatform;
  renderPlatforms(platforms);

  // 页面带着回放参数、但本页还没开播时，/api/state 里的 lanes 可能是上一场回放
  // 的残留终值：先不采纳，免得录屏开头闪一下终局数字和完成横幅。
  const pendingReplay = replayIntent && !replayState.started;

  // 泳道实时状态
  const lanesRaw = pendingReplay ? null : get('lanes', 'laneStats', 'stats', 'summary', 'laneSummary', 'results');
  applyLaneState(lanesRaw, running);

  if (!running && runId && !run.stoppedByUser && !pendingReplay) {
    // 刷新后仍是「已结束」：如果拿得到两侧耗时就直接把横幅恢复出来
    const both = [...lanes.values()].every((l) => l.stats.elapsedMs > 0) && lanes.size > 0;
    if (both) {
      for (const lane of lanes.values()) {
        lane.status = statusRaw === 'stopped' ? 'stopped' : 'done';
        renderLane(lane);
      }
      showBanner(statusRaw === 'stopped');
    }
  }
  if (!running && !runId) {
    for (const lane of lanes.values()) {
      if (lane.status === 'running') lane.status = 'idle';
      renderLane(lane);
    }
  }
  applyReplayState(raw); // raw.replay：刷新页面/多标签时同步回放角标与进度
  updateStartBtn();
}

function applyLaneState(lanesRaw, running) {
  if (!lanesRaw) return;
  const entries = [];
  if (Array.isArray(lanesRaw)) {
    for (const item of lanesRaw) entries.push(readSummary(item));
  } else if (typeof lanesRaw === 'object') {
    for (const [key, val] of Object.entries(lanesRaw)) {
      const r = readSummary(val);
      if (r) entries.push({ ...r, id: r.id || key });
    }
  }
  for (const s of entries) {
    if (!s || !s.id) continue;
    let lane = lanes.get(s.id);
    if (!lane) lane = createLane({ id: s.id, name: s.label || s.id, model: '' });
    if (s.label) { lane.name = s.label; lane.el.name.textContent = s.label; }
    if (s.model) { lane.model = s.model; lane.el.model.textContent = s.model; }
    if (s.total) lane.total = s.total;
    if (s.elapsedMs !== undefined) lane.stats.elapsedMs = s.elapsedMs;
    if (s.costUsd !== undefined) lane.stats.costUsd = s.costUsd;
    if (s.done !== undefined) lane.stats.done = s.done;
    if (s.failed !== undefined) lane.stats.failed = s.failed;
    if (s.cps !== undefined) lane.stats.cps = s.cps;
    if (s.tokensIn !== undefined) lane.stats.tokensIn = s.tokensIn;
    if (s.tokensOut !== undefined) lane.stats.tokensOut = s.tokensOut;
    if (running) {
      if (lane.status === 'idle') lane.status = 'running';
      lane.statsAt = performance.now();      // 重置插值基准，否则 elapsed 会跳
    } else if (lane.status === 'running') {
      lane.status = 'done';
      lane.statsAt = 0;
    }
    // 快照式状态：桥接基准对齐，避免与本地累加值双重计数
    lane.liveAtStats = { ...lane.live };
    renderLane(lane);
  }
}

function renderPlatforms(platforms) {
  const host = el.dsPlatforms;
  if (!platforms) { host.replaceChildren(); return; }
  let pairs = [];
  if (Array.isArray(platforms)) {
    pairs = platforms.map((p) => (Array.isArray(p)
      ? [String(p[0]), num(p[1])]
      : [String(p.platform ?? p.name ?? p.key ?? '?'), num(p.count ?? p.total ?? p.value)]));
  } else if (typeof platforms === 'object') {
    pairs = Object.entries(platforms).map(([k, v]) => [k, num(v)]);
  }
  pairs = pairs.filter(([k]) => k && k !== 'undefined').sort((a, b) => b[1] - a[1]);
  if (!pairs.length) { host.replaceChildren(); return; }

  const frag = document.createDocumentFragment();
  for (const [name, count] of pairs.slice(0, 6)) {
    const span = document.createElement('span');
    span.className = 'plat';
    span.textContent = name;
    const b = document.createElement('b');
    b.textContent = fmtInt(count);
    span.appendChild(b);
    frag.appendChild(span);
  }
  if (pairs.length > 6) {
    const span = document.createElement('span');
    span.className = 'plat';
    span.textContent = `+${pairs.length - 6}`;
    frag.appendChild(span);
  }
  host.replaceChildren(frag);
}

async function refreshState() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    applyState(await res.json());
    run.backendDown = false;
    if (!sseOpen && !sseFailed) setConn('connecting', '连接中…');
  } catch {
    run.backendDown = true;
    if (!sseOpen) { sseFailed = true; setConn('down', '后端未响应'); }
  }
}

/* ── 顶栏 UI ──────────────────────────────────────────────── */

function updateStartBtn() {
  const btn = el.startBtn;
  // 回放模式（手动进过回放，或 URL 带回放参数）下锁死真跑按钮：
  // 录屏时手滑点到「开始对决」是会真花钱的。
  const locked = replayIntent || replayState.active;
  btn.classList.toggle('is-running', run.running);
  btn.classList.toggle('is-done', !run.running && [...lanes.values()].some((l) => l.status === 'done'));
  btn.textContent = run.running
    ? '停止'
    : (locked ? '回放模式' : ([...lanes.values()].some((l) => l.status === 'done') ? '重新对决' : '开始对决'));
  btn.disabled = locked;
  btn.title = locked ? '回放模式下已禁用实时对决；刷新页面可恢复' : '';
}

function setConn(state, text) {
  el.conn.dataset.state = state;
  if (text) el.connText.textContent = text;
  else el.connText.textContent = {
    open: '实时连接', connecting: '连接中…', down: '连接断开 · 重连中', stale: '数据延迟…',
  }[state] || state;
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('is-on'), 8000);
}

function showBanner(stopped) {
  const j = lanes.get('jev');
  const d = lanes.get('deepseek');
  if (!j || !d) return;

  el.bannerJevName.textContent = j.name;
  el.bannerDsName.textContent = d.name;
  el.bannerJevVal.textContent = `${fmtSeconds(j.stats.elapsedMs)} 秒 / ${fmtUsd(j.stats.costUsd)}`;
  el.bannerDsVal.textContent = `${fmtSeconds(d.stats.elapsedMs)} 秒 / ${fmtUsd(d.stats.costUsd)}`;

  const jm = j.stats.elapsedMs;
  const dm = d.stats.elapsedMs;
  const jc = j.stats.costUsd;
  const dc = d.stats.costUsd;
  const parts = [];
  if (jm > 0 && dm > 0) {
    const diffS = Math.abs(jm - dm) / 1000;
    if (diffS >= 0.1) parts.push(`${jm <= dm ? j.name : d.name} 快 ${diffS.toFixed(1)} 秒`);
  }
  if (jc > 0 || dc > 0) {
    const diffC = Math.abs(jc - dc);
    if (diffC > 0) parts.push(`${jc <= dc ? j.name : d.name} 便宜 ${fmtUsd(diffC)}`);
  }
  if (stopped) parts.unshift('已手动停止');
  el.bannerSub.textContent = parts.join(' · ');
  el.bannerLink.href = '/api/report';
  el.banner.classList.add('is-on');
}

function hideBanner() {
  el.banner.classList.remove('is-on');
}

/* ── SSE（契约 §2）────────────────────────────────────────── */

let es = null;
let sseOpen = false;
let sseFailed = false;
let reconnectTimer = 0;

const SSE_TYPES = ['run_start', 'decision', 'lane_stats', 'run_end', 'error'];

function onMessage(ev) {
  let payload;
  try {
    payload = JSON.parse(ev.data);
  } catch {
    return; // 非 JSON 的心跳/注释行直接忽略
  }
  handleEvent(payload);
}

function connectSSE() {
  if (es) { es.close(); es = null; }
  clearTimeout(reconnectTimer);
  // 出过故障就一直显示「断开」，别用「连接中」把问题糊过去
  setConn(sseFailed ? 'down' : 'connecting');

  es = new EventSource('/api/stream');
  es.onopen = () => {
    sseOpen = true;
    sseFailed = false;
    run.lastEventAt = Date.now();
    setConn('open');
  };
  es.onmessage = onMessage;
  for (const type of SSE_TYPES) es.addEventListener(type, onMessage);

  // 注意：服务端若发 `event: error`，也会走到这里；用 data 区分「服务端错误事件」与「连接故障」
  es.onerror = (ev) => {
    if (ev && typeof ev.data === 'string') return; // 服务端 error 事件
    sseOpen = false;
    sseFailed = true;
    setConn('down');
    if (es && es.readyState === EventSource.CLOSED) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectSSE, RECONNECT_MS);
    }
  };
}

/* ── 交互 ─────────────────────────────────────────────────── */

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => null);
}

async function onStartStop() {
  const btn = el.startBtn;
  if (replayIntent || replayState.active) {
    toast('回放模式下已禁用实时对决');
    return;
  }
  btn.disabled = true;
  try {
    if (run.running) {
      await postJSON('/api/stop');
      run.stoppedByUser = true;
      run.running = false;
      for (const lane of lanes.values()) {
        lane.status = 'stopped';
        lane.statsAt = 0;
        renderLane(lane);
      }
      flushRows();
      updateStartBtn();
      showBanner(true);
    } else {
      hideBanner();
      run.stoppedByUser = false;
      const limit = Number(document.querySelector('#runLimit').value);
      if (!Number.isInteger(limit) || limit < 1) throw new Error('请输入正整数条数');
      const confirmLargeRun = limit > 30 && window.confirm(`本次每侧最多处理 ${limit} 条评论，将调用模型并产生费用。确认继续？`);
      if (limit > 30 && !confirmLargeRun) return;
      await postJSON('/api/start', { limit, confirmLargeRun });
    }
  } catch (e) {
    if (e.status === 409) {
      toast('已在运行中');
      await refreshState();
    } else if (e.status === 404) {
      toast('接口不存在（' + e.message + '）—— 后端还没起来？');
    } else {
      toast((run.running ? '停止失败：' : '启动失败：') + e.message);
    }
  } finally {
    updateStartBtn(); // 由它统一决定 disabled（回放模式下保持锁死）
  }
}

/* ── 回放：控制与状态 ─────────────────────────────────────── */

function updateReplayUI() {
  el.replayBtn.textContent = replayState.active ? '停止' : '播放';
  el.replayBtn.classList.toggle('is-running', replayState.active);
  el.replayRun.disabled = replayState.active;
  // URL 里给了非预设倍速（如 speed=7）时补一个临时 option，别让下拉框空着
  const speedStr = String(replayState.speed);
  if (![...el.replaySpeed.options].some((o) => o.value === speedStr)) {
    const o = document.createElement('option');
    o.value = speedStr;
    o.textContent = speedStr + '×';
    el.replaySpeed.appendChild(o);
  }
  el.replaySpeed.value = speedStr;

  if (replayState.active) {
    const pct = replayState.totalMs > 0 ? (replayState.virtualMs / replayState.totalMs) * 100 : 0;
    el.replayBadge.hidden = false;
    el.replayBadge.classList.remove('is-done');
    el.replayBadgeText.textContent = '回放';
    el.replayBadgeSpeed.textContent = '×' + replayState.speed;
    el.replayStatus.textContent =
      `回放中 ×${replayState.speed} · ${fmtDuration(replayState.virtualMs)} / ${fmtDuration(replayState.totalMs)}` +
      ` (${pct.toFixed(0)}%) · 事件 ${fmtInt(replayState.emitted)}/${fmtInt(replayState.total)}`;
  } else if (replayState.finished) {
    el.replayBadge.hidden = false;
    el.replayBadge.classList.add('is-done');
    el.replayBadgeText.textContent = '回放结束';
    el.replayBadgeSpeed.textContent = '';
    el.replayStatus.textContent = `回放结束 · 共 ${fmtInt(replayState.total)} 条事件 · 停在最终状态`;
  } else {
    el.replayBadge.hidden = true;
    el.replayStatus.textContent = replayIntent ? '选好录像后点「播放」' : '';
  }
  updateStartBtn();
}

function applyReplayState(raw) {
  const rp = raw?.replay;
  if (!rp || typeof rp !== 'object') return;
  const numOr = (v, cur) => (Number.isFinite(Number(v)) ? Number(v) : cur);

  if (rp.replaying === true) {
    // 服务端确实有一场回放在跑：以它为准（刷新页面/多标签也能看到角标）
    if (rp.runId) replayState.runId = rp.runId;
    replayState.speed = numOr(rp.speed, replayState.speed);
    replayState.virtualMs = numOr(rp.virtualMs, replayState.virtualMs);
    replayState.totalMs = numOr(rp.totalMs, replayState.totalMs);
    replayState.emitted = numOr(rp.emitted, replayState.emitted);
    replayState.total = numOr(rp.total, replayState.total);
    replayState.active = true;
    replayState.finished = false;
    updateReplayUI();
    return;
  }

  // 服务端实例还在、但既没在放也不算放完：说明是被别处停止的，本页同步解冻
  if (replayState.active && rp.replaying !== true && rp.finished !== true) {
    replayState.active = false;
    replayState.finished = false;
    updateReplayUI();
    return;
  }

  // 已结束的实例：只有本页确实参与过（自己在放，或自己发过 start）才认，
  // 否则会把「上一次回放的残留终态」误当成自己的结果，甚至覆盖 URL 指定的倍速。
  if (rp.finished === true && (replayState.active || replayState.started)) {
    replayState.virtualMs = numOr(rp.virtualMs, replayState.virtualMs);
    replayState.totalMs = numOr(rp.totalMs, replayState.totalMs);
    replayState.emitted = numOr(rp.emitted, replayState.emitted);
    replayState.total = numOr(rp.total, replayState.total);
    replayState.active = false;
    replayState.finished = true;
    updateReplayUI();
  }
}

/** 从 /api/runs 拉录像列表，摘要直接写进 option，选录像时能看到两边成绩。 */
async function loadRuns() {
  try {
    const res = await fetch('/api/runs', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const runs = Array.isArray(data?.runs) ? data.runs : [];
    const prev = el.replayRun.value;
    el.replayRun.replaceChildren();
    if (!runs.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '暂无录像（runs/ 下没有 events.jsonl）';
      el.replayRun.appendChild(o);
      return;
    }
    for (const r of runs) {
      const o = document.createElement('option');
      o.value = r.runId;
      const lanesTxt = (r.lanes || [])
        .map((l) => `${l.label || l.id} ${fmtInt(l.done)}条/${fmtSeconds(l.elapsedMs)}s/${fmtUsd(l.costUsd)}`)
        .join(' · ');
      o.textContent = `${r.runId} · ${lanesTxt}`;
      el.replayRun.appendChild(o);
    }
    const want = REPLAY_PARAM || prev;
    if (want && runs.some((r) => r.runId === want)) el.replayRun.value = want;
  } catch {
    toast('录像列表加载失败');
  }
}

async function startReplay() {
  const runId = el.replayRun.value || REPLAY_PARAM;
  if (!runId) { toast('请先选择要回放的录像'); return; }
  replayIntent = true;      // 一旦进过回放，本页就锁死真跑按钮
  replayState.started = true;
  el.replayBtn.disabled = true;
  try {
    const res = await postJSON('/api/replay', { runId, speed: replayState.speed });
    replayState.active = true;
    replayState.finished = false;
    replayState.runId = res?.runId ?? runId;
    replayState.totalMs = num(res?.totalMs, replayState.totalMs);
    replayState.total = num(res?.total, replayState.total);
    replayState.emitted = 0;
    replayState.virtualMs = 0;
    updateReplayUI();
  } catch (e) {
    if (e.status === 409) { toast('已有对决或回放正在进行'); await refreshState(); }
    else if (e.status === 404) toast('该录像没有 events.jsonl，不能回放');
    else toast('回放启动失败：' + e.message);
  } finally {
    el.replayBtn.disabled = false;
  }
}

/** 手动停止：冻结当前画面（不会清空、不会跳转）。 */
async function stopReplay() {
  el.replayBtn.disabled = true;
  try {
    await postJSON('/api/replay/stop');
    replayState.active = false;
    replayState.finished = false;
    run.running = false; // 服务端不会再推 run_end，本地运行态要自己收掉
    for (const lane of lanes.values()) {
      if (lane.status === 'running') { lane.status = 'stopped'; lane.statsAt = 0; renderLane(lane); }
    }
    flushRows();
    showBanner(true);
    updateReplayUI();
  } catch (e) {
    toast('停止回放失败：' + e.message);
  } finally {
    el.replayBtn.disabled = false;
  }
}

/** 中途变速：立刻生效，服务端从当前虚拟位置继续，不丢不重。 */
async function onReplaySpeedChange() {
  replayState.speed = num(el.replaySpeed.value, 1);
  updateReplayUI();
  if (!replayState.active) return; // 还没开播：只记下，开播时带上
  try {
    await postJSON('/api/replay/speed', { speed: replayState.speed });
  } catch (e) {
    toast('变速失败：' + e.message);
  }
}

/** 等 SSE 连上再开播，否则会错过 run_start（前端就不知道 lane 初始状态）。 */
function waitSseOpen(timeoutMs) {
  if (sseOpen) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (sseOpen || Date.now() - t0 > timeoutMs) { clearInterval(timer); resolve(sseOpen); }
    }, 50);
  });
}

/* ── 计时 / 心跳 ──────────────────────────────────────────── */

function tick() {
  const now = Date.now();
  for (const lane of lanes.values()) {
    if (lane.status === 'running') renderLane(lane);
  }
  if (sseOpen && run.running && run.lastEventAt && now - run.lastEventAt > STALE_MS) {
    setConn('stale');
  } else if (sseOpen && el.conn.dataset.state === 'stale') {
    setConn('open');
  }
}

/* ── 启动 ─────────────────────────────────────────────────── */

for (const def of LANE_DEFS) createLane(def);
for (const lane of lanes.values()) renderLane(lane);

el.startBtn.addEventListener('click', onStartStop);
el.bannerClose.addEventListener('click', hideBanner);

// 暴露给调试台（服务端同学可直接 window.__arena.handleEvent({...}) 灌假事件）
window.__arena = { run, lanes, handleEvent, applyState, refreshState, replayState };

/* ── 回放初始化 ───────────────────────────────────────────── */
if (EMBED) document.body.classList.add('embed'); // 录屏模式：隐藏所有控件
el.replaySpeed.value = String(replayState.speed);
el.replayBtn.addEventListener('click', () => (replayState.active ? stopReplay() : startReplay()));
el.replaySpeed.addEventListener('change', onReplaySpeedChange);
updateReplayUI();

loadRuns().then(async () => {
  if (!AUTOPLAY) return;
  if (!(REPLAY_PARAM || el.replayRun.value)) return; // 没有任何可回放的录像
  // 必须等 SSE 连上再开播：SSE 是事件唯一来源，晚连会丢 run_start
  await waitSseOpen(2500);
  await startReplay();
});

// 回放进度：SSE 不带总量/进度字段，回放中低频轮询 /api/state 刷新进度文字
setInterval(() => { if (replayState.active) refreshState(); }, 1500);

connectSSE();
refreshState();
setInterval(tick, TICK_MS);
setInterval(() => { if (!sseOpen) refreshState(); }, STATE_POLL_MS);
