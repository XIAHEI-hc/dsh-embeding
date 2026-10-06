const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-embed-smoke-'));
const project = path.join(data, 'project');
let dshPort;
let dshOrigin;
const secret = 'embed-smoke-secret-not-for-production-0001';
const initialPrompt = 'Draft only: inspect this workspace, but do not submit this message.';
let browser;
let child;
let exitPromise;
let processLog = '';
let workspaceId;
let grantCalls = 0;
let parentOrigin;
let smokePage;
let observedBrowserErrors = [];

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(body.length) });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function grant(body) {
  const response = await fetch(`${dshOrigin}/embed/control/grants`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function redeem(ticket, requestId, origin = parentOrigin) {
  const response = await fetch(`${dshOrigin}/embed/bootstrap/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: dshOrigin, 'x-request-id': requestId },
    body: JSON.stringify({
      protocol: 'dsh.embed', version: '1.0', channel_id: 'smoke-channel',
      request_id: requestId, parent_origin: origin, ticket,
    }),
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
}

function parentHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>DSH embed smoke parent</title></head>
<body><p id="status">loading</p><iframe id="frame" title="DSH AI workspace" style="width:1200px;height:760px"></iframe>
<script>
const origin=${JSON.stringify(dshOrigin)}, frame=document.getElementById('frame');
const channelId=crypto.randomUUID(); window.embedEvents=[]; window.grantRequests=0;
addEventListener('message', async event => {
  if(event.origin!==origin||event.source!==frame.contentWindow)return;
  const m=event.data; if(!m||m.protocol!=='dsh.embed'||m.version!=='1.0'||m.channel_id!==channelId)return;
  window.embedEvents.push(m);
  if(m.type==='ready'){
    frame.contentWindow.postMessage({protocol:'dsh.embed',version:'1.0',type:'init',channel_id:'wrong-channel',request_id:'wrong',payload:{ticket:'x'.repeat(32)}},origin);
    const response=await fetch('/api/ai/embed-grant',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspace_id:${JSON.stringify('__WORKSPACE_ID__')}})});
    window.grantRequests++; const issued=await response.json();
    if(!response.ok){document.getElementById('status').textContent='grant-error:'+response.status+':'+JSON.stringify(issued);return;}
    frame.contentWindow.postMessage({protocol:'dsh.embed',version:'1.0',type:'init',channel_id:channelId,request_id:'iframe-init-1',payload:{ticket:issued.ticket,initial_prompt:${JSON.stringify(initialPrompt)}}},origin);
  }
  if(m.type==='initialized')document.getElementById('status').textContent='initialized';
  if(m.type==='error')document.getElementById('status').textContent='error:'+m.payload.code;
});
frame.src=origin+'/embed?channel_id='+encodeURIComponent(channelId);
</script></body></html>`.replace('__WORKSPACE_ID__', workspaceId);
}

const parent = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      const body = Buffer.from(parentHtml());
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/ai/embed-grant') {
      grantCalls++;
      const body = await readJson(req);
      assert.equal(body.workspace_id, workspaceId);
      const issued = await grant({ subject: 'smoke-user', parent_origin: parentOrigin, workspace_id: workspaceId });
      json(res, issued.status, issued.body);
      return;
    }
    res.writeHead(404); res.end();
  } catch (error) { json(res, 500, { error: error.message }); }
});

(async () => {
  fs.mkdirSync(project, { recursive: true });
  const portProbe = http.createServer();
  await new Promise(resolve => portProbe.listen(0, 'localhost', resolve));
  dshPort = portProbe.address().port;
  dshOrigin = `http://localhost:${dshPort}`;
  await new Promise(resolve => portProbe.close(resolve));
  await new Promise(resolve => parent.listen(0, 'localhost', resolve));
  parentOrigin = `http://localhost:${parent.address().port}`;
  const workspaceConfig = path.join(data, 'workspaces.json');
  const embedConfig = path.join(data, 'embed.json');
  fs.writeFileSync(workspaceConfig, JSON.stringify({
    schema_version: 1, allowed_roots: [data], default_alias: 'project', auto_create_user_directories: false,
    workspaces: [{ alias: 'project', path: project, title: 'Embed smoke project', mode: 'read_write', write_probe: true }],
  }));
  fs.writeFileSync(embedConfig, JSON.stringify({
    schema_version: 1, public_origin: dshOrigin, allowed_parent_origins: [parentOrigin],
    ticket_ttl_seconds: 3, ticket_max_ttl_seconds: 3, ready_timeout_ms: 15000, init_timeout_ms: 30000,
    deployment_mode: 'trusted_shared_account', clients: [{ client_id: 'smoke-parent', secret_env: 'DSH_EMBED_SMOKE_SECRET',
      allowed_parent_origins: [parentOrigin], workspace_aliases: ['project'], mode: 'read_write' }],
  }));
  const env = {
    ...process.env,
    WORKBENCH_DATA_DIR: data,
    WORKBENCH_PUBLIC_URL: dshOrigin,
    WORKBENCH_WORKSPACE_CONFIG: workspaceConfig,
    WORKBENCH_EMBED_CONFIG: embedConfig,
    WORKBENCH_EMBED_ENABLED: 'true',
    DSH_EMBED_SMOKE_SECRET: secret,
    DSH_PERMISSION_MODE: 'danger-full-access',
    DEEPSEEK_API_KEY: 'embed-smoke-key-not-real',
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:9',
  };
  const repo = path.resolve(__dirname, '..');
  env.PYTHONPATH = [repo, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  delete env.DSH_WEB_PATCHES;
  child = spawn(process.env.PYTHON || 'python', ['-m', 'workbench.cli', 'web', '--port', String(dshPort)], {
    env, cwd: data,
  });
  exitPromise = new Promise(resolve => child.once('exit', resolve));
  child.stdout.on('data', chunk => { processLog += chunk; });
  child.stderr.on('data', chunk => { processLog += chunk; });
  let loginUrl;
  for (let i = 0; i < 900; i++) {
    loginUrl = processLog.match(/dsh web:\s+(http[^\s]+)/)?.[1];
    if (loginUrl && processLog.includes('完整官方 DSH Web 已启动')) break;
    assert.equal(child.exitCode, null, 'official service exited during startup');
    await delay(100);
  }
  assert(loginUrl, `startup timed out\n${processLog.slice(-4000)}`);

  assert(!processLog.includes('workbench-extensions ('), `extension activation failed\n${processLog}`);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await admin.goto(loginUrl);
  const workspaceList = await admin.evaluate(async () => {
    const response = await fetch('/embed/control/workspaces');
    return { status: response.status, body: await response.json() };
  });
  assert.equal(workspaceList.status, 200);
  assert.equal(workspaceList.body.items.length, 1);
  workspaceId = workspaceList.body.items[0].workspace_id;
  assert.equal(workspaceList.body.items[0].alias, 'project');
  await adminContext.close();

  const embedHeaders = await fetch(`${dshOrigin}/embed?channel_id=header-check`);
  assert.equal(embedHeaders.status, 200);
  assert.equal(embedHeaders.headers.get('x-frame-options'), null);
  assert.match(embedHeaders.headers.get('content-security-policy'), new RegExp(`frame-ancestors ${parentOrigin.replaceAll('.', '\\.')}`));

  const denied = await grant({ subject: 'smoke-user', parent_origin: 'http://localhost:9', workspace_id: workspaceId });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'EMBED_ORIGIN_DENIED');

  const replayGrant = await grant({ subject: 'smoke-user', parent_origin: parentOrigin, workspace_id: workspaceId });
  assert.equal(replayGrant.status, 201);
  const first = await redeem(replayGrant.body.ticket, 'replay-first');
  assert.equal(first.status, 200);
  assert.match(first.cookie, /HttpOnly/i);
  assert.match(first.cookie, /SameSite=Strict/i);
  assert.doesNotMatch(first.cookie, /; Secure/i);
  const replay = await redeem(replayGrant.body.ticket, 'replay-second');
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error.code, 'EMBED_TICKET_REPLAYED');

  const wrongOriginGrant = await grant({ subject: 'smoke-user', parent_origin: parentOrigin, workspace_id: workspaceId });
  const wrongOrigin = await redeem(wrongOriginGrant.body.ticket, 'wrong-origin', 'http://localhost:9');
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.body.error.code, 'EMBED_ORIGIN_DENIED');

  const revokedGrant = await grant({ subject: 'smoke-user', parent_origin: parentOrigin, workspace_id: workspaceId });
  const revokeResponse = await fetch(`${dshOrigin}/embed/control/grants/revoke`, {
    method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: revokedGrant.body.ticket }),
  });
  assert.equal(revokeResponse.status, 200);
  assert.equal((await revokeResponse.json()).revoked, true);
  assert.equal((await redeem(revokedGrant.body.ticket, 'revoked')).body.error.code, 'EMBED_TICKET_REVOKED');

  const expiredGrant = await grant({ subject: 'smoke-user', parent_origin: parentOrigin, workspace_id: workspaceId });
  await delay(3100);
  const expired = await redeem(expiredGrant.body.ticket, 'expired');
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error.code, 'EMBED_TICKET_EXPIRED');

  const embedContext = await browser.newContext();
  assert.equal((await embedContext.cookies(dshOrigin)).length, 0);
  const page = smokePage = await embedContext.newPage();
  const browserErrors = observedBrowserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && message.text().includes('embed-client')) browserErrors.push(message.text());
  });
  await page.goto(parentOrigin);
  await page.locator('#status').filter({ hasText: 'initialized' }).waitFor({ timeout: 30000 });
  assert.equal(grantCalls, 1, 'invalid channel/source handling must not request another grant');
  const events = await page.evaluate(() => window.embedEvents);
  assert(events.some(event => event.type === 'ready'));
  assert(events.some(event => event.type === 'initialized' && event.payload.workspace_id));
  assert(events.some(event => event.type === 'session.opened'));
  assert(events.some(event => event.type === 'connection.changed' && event.payload.state === 'connected'));
  const initialSessionId = events.findLast(event => event.type === 'session.opened')?.payload.session_id;
  assert.equal(typeof initialSessionId, 'string');
  const cookies = await embedContext.cookies(dshOrigin);
  assert(cookies.some(cookie => cookie.httpOnly && cookie.sameSite === 'Strict'));
  const iframe = page.frameLocator('#frame');
  const previewContinue = iframe.getByRole('button', { name: /^(继续|Continue)$/u });
  await previewContinue.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  if (await previewContinue.isVisible()) await previewContinue.click();
  const editor = iframe.locator('[contenteditable=true]').first();
  await editor.waitFor({ timeout: 30000 });
  assert.equal((await editor.innerText()).trim(), initialPrompt);
  assert.equal((await iframe.locator('body').innerText()).includes(initialPrompt.repeat(2)), false);
  await iframe.getByRole('button', { name: /^(发送消息|Send message)$/u }).click();
  await iframe.getByText(initialPrompt, { exact: true }).waitFor({ timeout: 30000 });
  if (process.env.DSH_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.DSH_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.DSH_SCREENSHOT_DIR, 'embed-ready.png'), fullPage: true });
  }
  const beforeReload = grantCalls;
  await iframe.locator('body').evaluate(() => location.reload());
  await editor.waitFor({ timeout: 30000 });
  assert.equal(grantCalls, beforeReload, 'iframe reload must not issue or redeem another ticket');
  await delay(3000);
  const eventsAfterReload = await page.evaluate(() => window.embedEvents);
  assert.equal(eventsAfterReload.some(event => event.type === 'error'), false, 'iframe reload must not emit an error');
  const restoredSessionId = eventsAfterReload.findLast(event => event.type === 'session.opened')?.payload.session_id;
  assert.equal(restoredSessionId, initialSessionId, 'iframe reload must restore the same non-blank session');
  assert.deepEqual(browserErrors, []);
  await embedContext.close();
  console.log('PASS embed: config, official workspace, one-use ticket, cookie, iframe protocol, connection, draft-only prompt, same-session reload');
})().catch(async error => {
  console.error(error.stack || error.message);
  if (smokePage && !smokePage.isClosed()) {
    try {
      console.error('PARENT', await smokePage.locator('body').innerText());
      console.error('EVENTS', JSON.stringify(await smokePage.evaluate(() => window.embedEvents)));
      console.error('BROWSER_ERRORS', JSON.stringify(observedBrowserErrors));
      for (const frame of smokePage.frames()) {
        console.error('FRAME', frame.url(), JSON.stringify((await frame.locator('body').innerText()).slice(0, 2000)));
      }
    } catch (diagnosticError) { console.error('BROWSER_DIAGNOSTIC_FAILED', diagnosticError.message); }
  }
  console.error(processLog.replace(/token=[^\s]+/g, 'token=[REDACTED]'));
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
  await new Promise(resolve => parent.close(resolve));
  for (let attempt = 0; attempt < 10; attempt++) {
    try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); break; }
    catch (error) { if (attempt === 9) throw error; await delay(200); }
  }
});
