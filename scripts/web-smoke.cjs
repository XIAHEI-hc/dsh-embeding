// Model fixture is test-only. Production starts the unmodified official DSH Web.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = http.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(error => error ? reject(error) : resolve(port));
  });
});
const proxy = process.argv.includes('--proxy');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-smoke-'));
let toolIssued = false;
let toolResultSeen = false;
const fixtureObservations = [];
let processLog = '';
let browser;
let page;
let child;
let exitPromise;
const errors = [];
const fixture = http.createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    assert(req.url.endsWith('/messages'), `Unexpected fixture endpoint ${req.url}`);
    const body = JSON.parse(raw);
    fixtureObservations.push({
      model: body.model,
      tools: Array.isArray(body.tools) ? body.tools.map(tool => tool?.name) : typeof body.tools,
      messageCount: Array.isArray(body.messages) ? body.messages.length : -1,
    });
    const shellTool = body.tools?.find(tool => tool.name === 'bash' || tool.name === 'pwsh');
    const agent = shellTool !== undefined;
    if (agent && toolIssued) {
      toolResultSeen ||= body.messages.some(message => Array.isArray(message.content) &&
        message.content.some(block => block.type === 'tool_result' && !block.is_error));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const event = (name, value) => res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
    event('message_start', { type: 'message_start', message: {
      id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 }
    }});
    let stop = 'end_turn';
    if (agent && !toolIssued) {
      toolIssued = true;
      stop = 'tool_use';
      event('content_block_start', { type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'tool_fixture', name: shellTool.name, input: {} }});
      const command = shellTool.name === 'pwsh'
        ? "New-Item -ItemType Directory -Force -Path output | Out-Null; [IO.File]::WriteAllText((Join-Path (Get-Location) 'output/report.md'), \"Verified report from official tool execution`n\", [Text.UTF8Encoding]::new($false))"
        : "mkdir -p output; printf 'Verified report from official tool execution\\n' > output/report.md";
      event('content_block_delta', { type: 'content_block_delta', index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify({
          description: 'Generate verification report in output directory',
          command,
        }) }});
    } else {
      event('content_block_start', { type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' }});
      const chunks = agent ? ['STREAM_BEGIN ', 'verified ', '[report](output/report.md) STREAM_END'] : ['Verification'];
      for (const text of chunks) {
        event('content_block_delta', { type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text } });
        if (agent) await delay(1000);
      }
    }
    event('content_block_stop', { type: 'content_block_stop', index: 0 });
    event('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 10 }});
    event('message_stop', { type: 'message_stop' });
    res.end();
  } catch (error) { errors.push(error.message); res.destroy(); }
});
(async () => {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const webPort = await freePort();
  const upstreamPort = await freePort();
  const repo = path.resolve(__dirname, '..');
  const env = { ...process.env, WORKBENCH_DATA_DIR: data, DSH_PERMISSION_MODE: 'danger-full-access' };
  env.DEEPSEEK_API_KEY = 'fixture-key-not-real';
  env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${fixture.address().port}`;
  env.PYTHONPATH = [repo, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  delete env.WORKBENCH_PUBLIC_URL;
  delete env.WORKBENCH_WEB_HOME;
  delete env.WORKBENCH_WEB_WORKSPACE;
  delete env.WORKBENCH_WORKSPACE_CONFIG;
  delete env.WORKBENCH_EMBED_CONFIG;
  delete env.WORKBENCH_EMBED_STATE;
  env.WORKBENCH_EMBED_ENABLED = 'false';
  delete env.DSH_WEB_PATCHES;
  child = spawn(process.env.PYTHON || 'python', ['-m', 'workbench.cli', 'web', '--port', String(webPort),
    '--upstream-port', String(upstreamPort), ...(proxy ? ['--host', '0.0.0.0'] : [])],
  { env, cwd: data });
  exitPromise = new Promise(resolve => child.once('exit', resolve));
  child.stdout.on('data', data => processLog += data);
  child.stderr.on('data', data => processLog += data);
  let url;
  for (let i = 0; i < 900; i++) {
    url = processLog.match(/dsh web:\s+(http[^\s]+)/)?.[1];
    if (url) break;
    assert(child.exitCode === null, 'Official service exited during startup');
    await delay(100);
  }
  assert(url, 'Startup timed out');
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  page = await browser.newPage({ locale: 'en-US', viewport: { width: 1500, height: 1000 } });
  let websocketFrames = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framereceived', () => websocketFrames++));
  await page.goto(url);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const configureLater = page.getByRole('button', { name: 'Configure later', exact: true });
  if (await configureLater.isVisible()) await configureLater.click();
  assert(!page.url().includes('token='), 'Login token should leave the address bar');
  assert((await page.context().cookies()).length, 'Official auth cookie missing');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  const apiKey = page.locator('input[aria-label="API key"]').first();
  if (!await apiKey.isVisible()) await page.getByText('Edit', { exact: true }).first().click();
  if (await apiKey.isDisabled()) {
    assert.match(await apiKey.getAttribute('placeholder'), /launch environment/i);
  } else {
    await apiKey.fill('fixture-key-not-real');
    await page.getByText('Customized settings', { exact: true }).first().click();
    await page.locator('input[aria-label="Base URL"]').first().fill(`http://127.0.0.1:${fixture.address().port}`);
    await page.getByRole('button', { name: 'Apply', exact: true }).first().click();
    await page.getByText('Saved DeepSeek (deepseek-official).', { exact: true }).waitFor();
  }
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('[contenteditable=true]').first().fill('Generate a report file and explain the result.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('STREAM_BEGIN', { exact: true }).waitFor({ timeout: 30000 });
  assert(!(await page.locator('body').innerText()).includes('STREAM_END'), 'Response was buffered instead of streamed');
  await page.getByRole('button', { name: 'report', exact: true }).waitFor({ timeout: 30000 });
  assert(toolResultSeen, 'Official model loop did not receive successful tool result');
  const report = path.join(data, 'web/workspace/deepseek-harness/default-workspace/output/report.md');
  assert.equal(fs.readFileSync(report, 'utf8'), 'Verified report from official tool execution\n');
  await page.getByRole('button', { name: 'report', exact: true }).click();
  await page.getByText('Verified report from official tool execution', { exact: true }).waitFor();
  assert(websocketFrames > 0, 'Official WebSocket did not deliver events');
  if (process.env.DSH_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.DSH_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.DSH_SCREENSHOT_DIR, proxy ? 'official-web-proxy.png' : 'official-web.png') });
  }
  await page.reload();
  await page.getByRole('button', { name: 'report', exact: true }).waitFor();
  assert.deepEqual(errors, [], 'Browser or fixture errors');
  console.log(`PASS ${proxy ? 'Nginx proxy' : 'native'}: official login, model configuration, incremental streaming, shell output, file preview, WebSocket, history reload`);
})().catch(async error => {
  console.error(error.message.replace(/token=[^\s]+/g, 'token=[REDACTED]'));
  if (page && !page.isClosed()) {
    console.error('PAGE_URL', page.url().replace(/token=[^&]+/g, 'token=[REDACTED]'));
    console.error('PAGE_TITLE', await page.title().catch(() => '<unavailable>'));
    console.error('PAGE_BODY', (await page.locator('body').innerText().catch(() => '<unavailable>')).slice(0, 4000));
  }
  console.error('FIXTURE_OBSERVATIONS', JSON.stringify(fixtureObservations));
  console.error(processLog.slice(-2000).replace(/token=[^\s]+/g, 'token=[REDACTED]'));
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    if (process.platform === 'win32') {
      await new Promise(resolve => {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        killer.once('exit', resolve);
        killer.once('error', resolve);
      });
    } else child.kill('SIGTERM');
    await exitPromise;
  }
  await new Promise(resolve => fixture.close(resolve));
  for (let attempt = 0; attempt < 10; attempt++) {
    try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); break; }
    catch (error) { if (attempt === 9) throw error; await delay(200); }
  }
});
