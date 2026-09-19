const root = document.querySelector('#report');
const params = new URLSearchParams(location.search);
const runId = params.get('runId') || params.get('replay');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
if (runId) document.querySelector('#back').href = `/?replay=${encodeURIComponent(runId)}&speed=1`;

function render(report) {
  const lanes = (Array.isArray(report.lanes) ? report.lanes : Object.values(report.lanes || {})).slice(0,2);
  const available = lanes.filter(lane => report.artifacts?.[lane.id]);
  const id = report.runId || runId;
  root.innerHTML = `<div class="reader-controls"><div class="artifact-tabs" aria-label="选择模型报告">${lanes.map((lane,index)=>`<button type="button" data-lane="${esc(lane.id)}" class="lane-${index}" aria-pressed="false" ${report.artifacts?.[lane.id] ? '' : 'disabled'}>${esc(lane.label || lane.id)}${report.artifacts?.[lane.id] ? ' 完整报告' : ' · 暂无报告'}</button>`).join('')}</div><span class="run-id">运行 ${esc(id)}</span></div>${available.length ? '<iframe class="artifact-frame" id="artifact-frame" title="完整研究报告" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>' : `<div class="state" role="status"><h1>这次运行尚未生成完整报告</h1><p>在项目目录执行以下离线命令，然后刷新本页：</p><pre>npm run report -- --run runs/${esc(id)}</pre><p>默认生成事实草稿；需要研究正文时，请让 Agent 阅读 docs/report-generation.md。</p><a href="/">返回对决</a></div>`}`;
  if (!available.length) return;
  function select(lane) {
    const url = `/api/report/artifact?runId=${encodeURIComponent(id)}&lane=${encodeURIComponent(lane.id)}`;
    const frame = document.querySelector('#artifact-frame');
    frame.src = url;
    frame.title = `${lane.label || lane.id} 完整研究报告`;
    const link = document.querySelector('#artifact-link');
    link.href = url; link.hidden = false;
    root.querySelectorAll('button[data-lane]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.lane === lane.id)));
    const locationUrl = new URL(location.href);
    locationUrl.searchParams.set('runId',id); locationUrl.searchParams.set('lane',lane.id); locationUrl.hash='';
    history.replaceState(null,'',locationUrl);
    document.title = `${lane.label || lane.id} 完整报告 · Jev Arena`;
  }
  root.querySelectorAll('button[data-lane]').forEach(button => button.addEventListener('click',()=>select(available.find(lane=>lane.id === button.dataset.lane))));
  select(available.find(lane=>lane.id === params.get('lane')) || available[0]);
}
try {
  const response = await fetch(`/api/report${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`);
  if (!response.ok) throw new Error(response.status === 404 ? '这次运行还没有报告，请返回对决页选择已完成的录像。' : `报告暂时无法读取（HTTP ${response.status}）。`);
  render(await response.json());
} catch(error) {
  root.innerHTML = `<div class="state" role="alert"><h1>暂时无法查看报告</h1><p>${esc(error.message)}</p><button id="retry" type="button">重新加载</button></div>`;
  document.querySelector('#retry').addEventListener('click',()=>location.reload());
}
