const panel = document.createElement('details');
panel.className = 'setup';
panel.innerHTML = `<summary>模型设置与评论导入 <span>默认试跑 20 条 · 配置只保存在本次服务内存</span></summary>
<form id="setupForm"><div class="setup-lanes"></div><p>费用优先使用 API 返回值；否则按填写的美元 / 百万 token 单价估算。未填单价显示的 $0 不代表免费。</p>
<button class="btn" type="submit">保存模型配置</button> <output id="setupStatus" aria-live="polite"></output></form>
<div class="setup-import"><label>评论文件 <input id="commentFile" type="file" accept=".csv,.xlsx"></label>
<p>UTF-8 CSV 或 Excel .xlsx 第一张表；必需列 comment_id、content。ID 必须唯一，正文不能为空。最多 10 MB。</p><output id="importStatus" aria-live="polite"></output></div>`;
document.querySelector('.topbar').after(panel);
const form = panel.querySelector('form');
async function api(url, body) {
  const res = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}
function fields(config) {
  const target = panel.querySelector('.setup-lanes');
  target.replaceChildren();
  config.forEach((c, i) => {
    const fieldset = document.createElement('fieldset');
    fieldset.innerHTML = `<legend>${i ? '右侧' : '左侧'}</legend>
      <label>显示名称<input name="label" required></label>
      <label>接口协议<select name="protocol"><option value="jev">Jev Decisions</option><option value="openai">OpenAI Chat Completions</option></select></label>
      <label>API Base URL<input name="baseUrl" type="url" required></label>
      <label>模型 ID<input name="model" required></label>
      <label>API Key<input name="apiKey" type="password" autocomplete="off"></label>
      <label>输入单价 / 百万 token<input name="inputPrice" type="number" min="0" step="any"></label>
      <label>输出单价 / 百万 token<input name="outputPrice" type="number" min="0" step="any"></label>
      <label class="check"><input name="jsonMode" type="checkbox">发送 JSON mode（不支持时取消）</label>`;
    for (const name of ['label', 'protocol', 'baseUrl', 'model', 'inputPrice', 'outputPrice']) fieldset.querySelector(`[name=${name}]`).value = c[name];
    fieldset.querySelector('[name=jsonMode]').checked = c.jsonMode;
    fieldset.querySelector('[name=apiKey]').placeholder = c.hasKey ? '已配置；留空保留，更换 URL 需重新填写' : '填写 API Key';
    target.append(fieldset);
  });
}
api('/api/config').then(data => fields(data.lanes)).catch(e => { document.querySelector('#setupStatus').textContent = e.message; });
form.addEventListener('submit', async e => {
  e.preventDefault();
  const status = document.querySelector('#setupStatus');
  const lanes = [...form.querySelectorAll('fieldset')].map(f => Object.fromEntries([...f.querySelectorAll('[name]')].map(el => [el.name, el.type === 'checkbox' ? el.checked : el.value])));
  try { const data = await api('/api/config', { lanes }); fields(data.lanes); status.textContent = '配置已保存，Key 不会返回浏览器或写入录像。'; }
  catch (e) { status.textContent = e.message; }
});
panel.querySelector('#commentFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const status = document.querySelector('#importStatus');
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('文件超过 10 MB');
    status.textContent = '正在校验文件…';
    const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result.split(',')[1]); r.onerror = reject; r.readAsDataURL(file); });
    const result = await api('/api/dataset', { name: file.name, data });
    status.textContent = `已导入 ${result.stats.total} 条评论。预览：${result.preview.map(x => x.content.slice(0, 60)).join(' / ')}`;
    document.querySelector('#dsTotal').textContent = result.stats.total;
  } catch (e) { status.textContent = e.message; }
});
