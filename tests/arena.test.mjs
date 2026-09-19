import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import ExcelJS from 'exceljs';
import { datasetFromCsv, datasetFromFile } from '../src/dataset.mjs';
import { initialConfig, validateConfig } from '../src/config.mjs';

test('CSV 引号、换行、BOM、重复 ID 与空值', () => {
  const d = datasetFromCsv('\ufeffcomment_id,content\na,"你好,\n""模型"""\n');
  assert.equal(d.rows[0].content, '你好,\n"模型"');
  assert.throws(() => datasetFromCsv('comment_id,content\na,x\na,y'), /重复/);
  assert.throws(() => datasetFromCsv('comment_id,content\na,'), /为空/);
  assert.throws(() => datasetFromCsv('comment_id,content\na,"xx'), /未闭合/);
  assert.throws(() => datasetFromCsv('id,text\na,x'), /必需列/);
});
test('Excel 第一张表导入', async () => {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('评论');
  sheet.addRow(['comment_id', 'content']); sheet.addRow(['001', '有换行\n也有逗号,']);
  const d = await datasetFromFile(Buffer.from(await book.xlsx.writeBuffer()), 'test.xlsx');
  assert.equal(d.rows[0].comment_id, '001'); assert.equal(d.rows[0].content, '有换行\n也有逗号,');
});
test('更改 URL 不得泄露旧 Key', () => {
  const c = initialConfig({ LEFT_API_KEY: 'secret' });
  const next = c.map(x => ({ ...x, apiKey: '' })); next[0].baseUrl = 'http://localhost:1234';
  assert.equal(validateConfig(next, c)[0].apiKey, '');
});
test('20 条双侧运行、上传、费用、录像回放均使用本地模拟接口', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arena-test-'));
  let calls = 0;
  const mock = http.createServer(async (req, res) => {
    calls++;
    assert.equal(req.url, '/v1/chat/completions');
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.ok(['left-model', 'right-model'].includes(body.model));
    const input = body.messages[1].content;
    const { comments } = JSON.parse(input.slice(input.indexOf('{')));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify({ labels: comments.map(c => ({ comment_id: c.comment_id, is_relevant: true, sentiment: 'positive', sentiment_score: 0.5, confidence: 0.8, intent: '评价', aspects: [], emotion: [], evidence_quote: c.content })) }, null, 0) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 } }));
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const free = http.createServer(); await new Promise(r => free.listen(0, '127.0.0.1', r));
  const port = free.address().port; await new Promise(r => free.close(r));
  const child = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, DOTENV_CONFIG_PATH: path.join(root, 'missing-env'), PORT: String(port), RUNS_DIR: root, DATA_PATH: 'examples/comments.csv', LEFT_API_KEY: '', RIGHT_API_KEY: '', OPENROUTER_API_KEY: '', DEEPSEEK_API_KEY: '' }, stdio: 'pipe' });
  let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
  const base = `http://127.0.0.1:${port}`;
  async function api(route, body) { const res = await fetch(base + route, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); return { status: res.status, data: await res.json() }; }
  try {
    for (let i = 0; i < 100; i++) { try { await api('/api/state'); break; } catch { await new Promise(r => setTimeout(r, 50)); } }
    assert.equal((await api('/api/start', {})).status, 400, output);
    const lanes = initialConfig({}).map((c, i) => ({ ...c, protocol: 'openai', model: i ? 'right-model' : 'left-model', label: i ? '右模型' : '左模型', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'test-secret' }));
    const saved = await api('/api/config', { lanes });
    assert.equal(saved.status, 200); assert.ok(!JSON.stringify(saved).includes('test-secret'));
    const csv = await readFile('examples/comments.csv');
    assert.equal((await api('/api/dataset', { name: 'demo.csv', data: csv.toString('base64') })).status, 200);
    const invalid = await api('/api/dataset', { name: 'bad.csv', data: Buffer.from('x,y\na,b').toString('base64') });
    assert.equal(invalid.status, 400); assert.equal((await api('/api/state')).data.dataset.rows, 20);
    assert.equal((await api('/api/start', { limit: -1 })).status, 400);
    const bigCsv = 'comment_id,content\n' + Array.from({length:31}, (_,i) => `id-${i},测试评论`).join('\n');
    await api('/api/dataset', { name: 'large.csv', data: Buffer.from(bigCsv).toString('base64') });
    assert.equal((await api('/api/start', { limit: 31 })).status, 400);
    assert.equal(calls, 0);
    await api('/api/dataset', { name: 'demo.csv', data: csv.toString('base64') });
    const started = await api('/api/start', {}); assert.equal(started.status, 200); assert.equal(started.data.total, 20);
    for (let i = 0; i < 100; i++) { if (!(await api('/api/state')).data.running) break; await new Promise(r => setTimeout(r, 30)); }
    const state = (await api('/api/state')).data;
    assert.equal(state.running, false); assert.equal(state.lanes[0].done, 20); assert.equal(state.lanes[1].done, 20);
    assert.equal(state.lanes[0].failed, 0); assert.equal(state.lanes[0].model, 'left-model');
    const events = await readFile(path.join(root, started.data.runId, 'events.jsonl'), 'utf8');
    assert.ok(!events.includes('test-secret')); assert.ok(events.includes('left-model'));
    const callsBeforeReport = calls;
    const demo = await api('/api/report?runId=0919-124001');
    assert.equal(demo.status, 200);
    assert.equal(demo.data.analysis.paired, 10000);
    assert.deepEqual(demo.data.artifacts, { jev: true, deepseek: true });
    for (const lane of ['jev', 'deepseek']) {
      const saved = await fetch(base + '/api/report/artifact?runId=0919-124001&lane=' + lane);
      assert.equal(saved.status, 200);
      assert.match(saved.headers.get('content-type'), /text\/html/);
      assert.match(await saved.text(), /<!doctype html/i);
    }
    assert.equal(calls, callsBeforeReport);
    const reportResult = await api('/api/report?runId=' + started.data.runId);
    assert.equal(reportResult.status, 200);
    assert.equal(reportResult.data.analysis.paired, 20);
    assert.equal(reportResult.data.analysis.lanes[0].sentiment.positive, 20);
    assert.equal((await api('/api/report?runId=..%2F..')).status, 400);
    assert.equal((await api('/api/report?runId=0101-000000')).status, 404);
    await mkdir(path.join(root,'0101-000000'));
    await writeFile(path.join(root,'0101-000000','report.json'),JSON.stringify({runId:'0101-000000',lanes:[],marker:'specific-old-run'}));
    assert.equal((await api('/api/report?runId=0101-000000')).data.marker,'specific-old-run');
    const reportPage=await fetch(base+'/report?runId='+started.data.runId);
    assert.match(reportPage.headers.get('content-type'),/text\/html/);
    assert.match(await reportPage.text(),/report.js/);

    assert.equal((await api('/api/report/artifact?runId='+started.data.runId+'&lane=other')).status, 400);
    await writeFile(path.join(root,started.data.runId,'report.jev.html'), '<h1>Saved VoxAgent report</h1>');
    const artifact=await fetch(base+'/api/report/artifact?runId='+started.data.runId+'&lane=jev');
    assert.equal(artifact.status,200);assert.match(artifact.headers.get('content-type'),/text\/html/);
    assert.match(await artifact.text(),/Saved VoxAgent/);
    const callsBefore = calls; assert.equal(callsBefore, 4);
    assert.equal((await api('/api/replay', { runId: started.data.runId, speed: 1000 })).status, 200);
    for (let i = 0; i < 100; i++) { if (!(await api('/api/state')).data.replaying) break; await new Promise(r => setTimeout(r, 20)); }
    assert.equal(calls, callsBefore);
    assert.equal((await api('/api/state')).data.lanes[0].done, 20);
    assert.equal((await api('/api/start', { runId: '../bad' })).status, 400);
  } finally {
    const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited;
    await new Promise(r => mock.close(r)); await rm(root, { recursive: true, force: true });
  }
});

test('Jev 专用协议保留自定义 URL、模型和右侧标识', async () => {
  const { labelBatch } = await import('../src/backends/jev.mjs');
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, '/api/alpha/decisions');
    assert.equal(req.headers.authorization, 'Bearer local-key');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.model, 'custom-jev'); assert.equal(body.state.comments.length, 1);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([key, q]) => [key, q.type === 'noul' ? { noul: 0.8 } : q.type === 'score' ? { score: 3 } : { choice: Object.keys(q.criteria)[0], confidence: 0.9 }]));
    res.end(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 10, output_tokens: 10, cost: 0.002 } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const result = await labelBatch([{ comment_id: '001', content: '模型不错' }], { id: 'deepseek', apiKey: 'local-key', modelId: 'custom-jev', baseUrl: `http://127.0.0.1:${server.address().port}/api/alpha/decisions` });
    assert.equal(result.labels[0].meta.backend, 'deepseek');
    assert.equal(result.labels[0].meta.evidenceSource, 'host');
    assert.equal(result.usage.costUsd, 0.002);
  } finally { await new Promise(r => server.close(r)); }
});
