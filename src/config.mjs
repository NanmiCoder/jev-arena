import * as jev from './backends/jev.mjs';
import * as chat from './backends/deepseek.mjs';

export function initialConfig(env = process.env) {
  return ['LEFT', 'RIGHT'].map((side, i) => ({
    id: i ? 'deepseek' : 'jev',
    label: env[`${side}_LABEL`] || (i ? 'DeepSeek' : 'Jev'),
    protocol: env[`${side}_PROTOCOL`] || (i ? 'openai' : 'jev'),
    baseUrl: env[`${side}_BASE_URL`] || (i ? env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com' : env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api'),
    apiKey: env[`${side}_API_KEY`] || (i ? env.DEEPSEEK_API_KEY : env.OPENROUTER_API_KEY) || '',
    model: env[`${side}_MODEL`] || (i ? 'deepseek-flash' : 'typesafe/jev-1.13'),
    jsonMode: true,
    inputPrice: 0, outputPrice: 0,
  }));
}
export function publicConfig(config) {
  return config.map(({ apiKey, ...rest }) => ({ ...rest, hasKey: Boolean(apiKey) }));
}
export function validateConfig(value, previous) {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('需要左右两侧配置');
  return value.map((v, i) => {
    const c = { ...previous[i] };
    for (const k of ['label', 'protocol', 'baseUrl', 'model']) {
      if (typeof v[k] !== 'string' || !v[k].trim()) throw new Error(`${k} 不能为空`);
      c[k] = v[k].trim();
    }
    if (!['jev', 'openai'].includes(c.protocol)) throw new Error('不支持的协议');
    const url = new URL(c.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入不含凭据和参数的 HTTP(S) API URL');
    c.baseUrl = c.baseUrl.replace(/\/+$/, '');
    if (v.apiKey) c.apiKey = String(v.apiKey).trim();
    else if (c.baseUrl !== previous[i].baseUrl) c.apiKey = ''; // 不向新地址复用旧密钥
    c.jsonMode = v.jsonMode !== false;
    for (const k of ['inputPrice', 'outputPrice']) {
      c[k] = Number(v[k] ?? 0);
      if (!Number.isFinite(c[k]) || c[k] < 0) throw new Error('单价必须为非负数字');
    }
    return c;
  });
}
export function configuredLanes(config) {
  return config.map(c => ({ id: c.id, label: c.label, model: c.model, backend: {
    maxBatchSize: 10,
    labelBatch: (rows, ctx) => (c.protocol === 'jev' ? jev : chat).labelBatch(rows, {
      ...ctx, ...c, modelId: c.model, configured: true,
    }),
  }}));
}
