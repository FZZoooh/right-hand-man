// End-to-end check of the separate tools provider for web_search / fetch_url:
//   1. Old settings.json gains toolsBaseUrl / toolsApiKey on first read (upgradeShape);
//   2. /api/settings saves and clears the tools fields without ever echoing the key;
//   3. /api/settings/test-tools probes /tools/search with per-field inheritance (draft wins,
//      stored tools key, then the main key);
//   4. /chat actually routes web_search to the resolved provider: no tools fields → main upstream
//      with the main key; each configured field overrides just that field.
//
// Approach like test-turn-abort.mjs: temporary HOME + data dir, two fake upstreams (main and
// tools), backend imported in-process, settings.json rewritten directly between chat rounds
// (the backend re-reads the file on every request, so no restart is needed).
//
// Run: node scripts/test-tools-provider.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createProbe } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'pageask-home-'));
const dataDir = mkdtempSync(join(tmpdir(), 'pageask-data-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const MAIN_KEY = 'sk-main-1234';
const TOOLS_KEY = 'sk-tools-5678';

// Ask the OS for a free port so a fixed one cannot already be taken
async function freePort() {
  const probe = createProbe();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** Fake upstream that records every /v1/tools/search Authorization header it sees. */
function makeUpstream() {
  const hits = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/v1/tools/search') {
        hits.push({ auth: req.headers.authorization ?? '', body: raw });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [{ title: 't', url: 'https://x.test', summary: 's' }] }));
        return;
      }
      if (req.url === '/v1/responses') {
        const body = JSON.parse(raw || '{}');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (Array.isArray(body.tools) && body.tools.length > 0) {
          const needsOutput = (body.input ?? []).some((i) => i?.type === 'function_call_output');
          if (needsOutput) {
            // the tool result is in: wrap up with a final message
            res.write(
              sse('response.completed', {
                response: {
                  id: `resp_final_${hits.length}`,
                  output: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }],
                },
              }),
            );
          } else {
            res.write(
              sse('response.completed', {
                response: {
                  id: `resp_call_${hits.length}`,
                  output: [
                    {
                      type: 'function_call',
                      call_id: `call_${hits.length}`,
                      name: 'web_search',
                      arguments: JSON.stringify({ query: 'test query' }),
                    },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              }),
            );
          }
        } else {
          // auto-title request (no tools): return a plain message so it completes quietly
          res.write(
            sse('response.completed', {
              response: {
                id: `resp_title_${hits.length}`,
                output: [{ type: 'message', content: [{ type: 'output_text', text: '标题' }] }],
              },
            }),
          );
        }
        res.end();
        return;
      }
      res.writeHead(404).end();
    });
  });
  return { server, hits };
}

const main = makeUpstream();
const tools = makeUpstream();
const mainPort = await freePort();
const toolsPort = await freePort();
await new Promise((resolve) => main.server.listen(mainPort, '127.0.0.1', resolve));
await new Promise((resolve) => tools.server.listen(toolsPort, '127.0.0.1', resolve));
const mainBase = `http://127.0.0.1:${mainPort}`;
const toolsBase = `http://127.0.0.1:${toolsPort}`;

const backendPort = await freePort();
const settingsPath = join(home, '.config', 'righthandman', 'settings.json');

/** Rewrite the whole settings.json; fields left out are simply gone from the file. */
function writeSettingsFile(extra = {}) {
  mkdirSync(join(home, '.config', 'righthandman'), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      baseUrl: mainBase,
      model: 'fake-model',
      apiKey: MAIN_KEY,
      state: 'off',
      port: backendPort,
      token: '',
      dataDir,
      ...extra,
    }),
  );
}

writeSettingsFile(); // old shape on purpose: no tools fields yet

// settings.mjs / db.mjs read the settings file above at module load time, so import afterwards
const { closeDb } = await import('../server/db.mjs');
await import('../server/index.mjs');

process.on('exit', () => {
  try {
    closeDb();
  } catch {}
  try {
    rmSync(home, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  } catch {}
});

const base = `http://127.0.0.1:${backendPort}`;
for (let i = 0; i < 50; i += 1) {
  try {
    const r = await fetch(`${base}/health`);
    if (r.ok) break;
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 100));
}

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${err.message}`);
  }
}

async function request(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    // the /api/settings* and /health gates accept same-origin (or a token; this server has none)
    headers: { Origin: base, ...(init.headers ?? {}) },
  });
  const raw = await res.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, raw };
}

function postJson(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** One full chat turn: the fake upstream calls web_search once, then answers. */
async function chatOnce(text) {
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page: { url: 'https://example.com/tools-page', title: '工具供应商', markdown: '正文' },
      text,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await res.text();
  const events = [];
  for (const chunk of raw.split('\n\n')) {
    let event = 'message';
    let data = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (data) events.push({ event, data: JSON.parse(data) });
  }
  return events;
}

try {
  // 1. upgradeShape: the first read back-fills the new fields into the old file
  check('old settings.json gains the tools fields on first read', () => {
    const onDisk = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(onDisk.toolsBaseUrl, '');
    assert.equal(onDisk.toolsApiKey, '');
  });

  // 2. /api/settings: saved / kept / cleared, and the key never comes back in plaintext
  const badToolsUrl = await postJson('/api/settings', { toolsBaseUrl: 'ftp://example.com' });
  check('an invalid toolsBaseUrl returns 400', () => assert.equal(badToolsUrl.status, 400));
  check('the invalid-toolsBaseUrl error code', () =>
    assert.equal(badToolsUrl.body?.code, 'settings.invalid_base_url'));

  const saved = await postJson('/api/settings', { toolsBaseUrl: toolsBase, toolsApiKey: TOOLS_KEY });
  check('tools fields are saved', () => {
    assert.equal(saved.body?.toolsBaseUrl, toolsBase);
    assert.equal(saved.body?.hasToolKey, true);
  });
  check('the tools key never comes back in plaintext', () =>
    assert.ok(!JSON.stringify(saved.body).includes(TOOLS_KEY)));
  check('the tools key is masked', () =>
    assert.ok(saved.body?.toolApiKeyMasked?.endsWith(TOOLS_KEY.slice(-4))));

  const keptKey = await postJson('/api/settings', { toolsApiKey: '' });
  check('an empty toolsApiKey keeps the stored key', () => assert.equal(keptKey.body?.hasToolKey, true));

  const clearedUrl = await postJson('/api/settings', { toolsBaseUrl: '' });
  check('an empty toolsBaseUrl clears back to inheritance', () => assert.equal(clearedUrl.body?.toolsBaseUrl, ''));

  const clearedKey = await postJson('/api/settings', { clearToolsApiKey: true });
  check('clearToolsApiKey clears the key', () => assert.equal(clearedKey.body?.hasToolKey, false));

  // 3. /health shows the resolved provider (inheritance applied)
  const health = await request('/health');
  check('/health resolves the tools baseUrl to the main one when unset', () => {
    assert.equal(health.body?.toolsBaseUrl, mainBase);
    assert.equal(health.body?.hasToolKey, true); // inherited from the main key
  });

  // 4. /api/settings/test-tools: draft wins, then stored tools key, then the main key
  await postJson('/api/settings', { toolsBaseUrl: toolsBase });
  main.hits.length = 0;
  tools.hits.length = 0;

  const probeInherit = await postJson('/api/settings/test-tools', {});
  check('test-tools without a tools key uses the main key', () => {
    assert.equal(probeInherit.body?.ok, true);
    assert.equal(tools.hits.length, 1);
    assert.equal(tools.hits[0].auth, `Bearer ${MAIN_KEY}`);
    assert.equal(main.hits.length, 0);
  });

  const probeDraft = await postJson('/api/settings/test-tools', { toolsApiKey: 'sk-draft-1' });
  check('test-tools prefers the draft key', () => {
    assert.equal(probeDraft.body?.ok, true);
    assert.equal(tools.hits[1].auth, 'Bearer sk-draft-1');
  });

  const probeUnreachable = await postJson('/api/settings/test-tools', { toolsBaseUrl: 'http://127.0.0.1:9' });
  check('an unreachable tools provider fails the test', () =>
    assert.equal(probeUnreachable.body?.code, 'settings.test_failed'));

  const probeBadUrl = await postJson('/api/settings/test-tools', { toolsBaseUrl: 'ftp://example.com' });
  check('an invalid draft toolsBaseUrl returns 400', () => assert.equal(probeBadUrl.status, 400));

  await postJson('/api/settings', { clearApiKey: true, clearToolsApiKey: true });
  const probeNoKey = await postJson('/api/settings/test-tools', {});
  check('no key anywhere yields an error code', () =>
    assert.equal(probeNoKey.body?.code, 'settings.missing_api_key'));

  // 5. Routing matrix: rewrite settings.json and watch where web_search actually lands.
  //    Clearing both keys above means the rounds below restore the keys they need.
  async function assertRouting(name, extra, expectedUpstream, expectedKey) {
    writeSettingsFile(extra);
    main.hits.length = 0;
    tools.hits.length = 0;
    const events = await chatOnce(`搜索 ${expectedUpstream}`);
    check(`${name}: the round completes`, () => {
      assert.ok(events.some((e) => e.event === 'tool'), 'missing a tool event');
      assert.ok(events.some((e) => e.event === 'done'), 'missing the done event');
    });
    check(`${name}: web_search hits ${expectedUpstream === 'main' ? 'the main' : 'the tools'} upstream with the ${expectedKey} key`, () => {
      const hitHost = expectedUpstream === 'main' ? main.hits : tools.hits;
      const otherHost = expectedUpstream === 'main' ? tools.hits : main.hits;
      assert.equal(hitHost.length, 1, `expected one hit, got ${hitHost.length}`);
      assert.equal(hitHost[0].auth, `Bearer ${expectedKey}`);
      assert.equal(otherHost.length, 0);
    });
  }

  await assertRouting('full inheritance', {}, 'main', MAIN_KEY);
  await assertRouting('toolsBaseUrl only', { toolsBaseUrl: toolsBase }, 'tools', MAIN_KEY);
  await assertRouting('toolsApiKey only', { toolsApiKey: TOOLS_KEY }, 'main', TOOLS_KEY);
  await assertRouting('both configured', { toolsBaseUrl: toolsBase, toolsApiKey: TOOLS_KEY }, 'tools', TOOLS_KEY);
} finally {
  main.server.closeAllConnections?.();
  await new Promise((resolve) => main.server.close(resolve));
  tools.server.closeAllConnections?.();
  await new Promise((resolve) => tools.server.close(resolve));
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nall good');
// the imported backend keeps the event loop alive; the temp cleanup ran via the exit hook
process.exit(0);
