const assert = require('node:assert/strict')
const { mkdirSync } = require('node:fs')
const { resolve } = require('node:path')
const { chromium } = require('playwright')

const parentOrigin = process.env.PROBE_PARENT_ORIGIN
const dshOrigin = process.env.PROBE_DSH_ORIGIN
const siteProjectId = process.env.PROBE_SITE_PROJECT_ID
const probecardProjectId = process.env.PROBE_PROBECARD_PROJECT_ID
const toolSecret = process.env.PROBE_AI_TOOL_SECRET
const dshInstanceId = process.env.PROBE_AI_DSH_INSTANCE_ID
const screenshotDir = resolve(process.env.PROBE_SCREENSHOT_DIR || 'artifacts/probe-integration')

for (const [name, value] of Object.entries({
  PROBE_PARENT_ORIGIN: parentOrigin,
  PROBE_DSH_ORIGIN: dshOrigin,
  PROBE_SITE_PROJECT_ID: siteProjectId,
  PROBE_PROBECARD_PROJECT_ID: probecardProjectId,
  PROBE_AI_TOOL_SECRET: toolSecret,
  PROBE_AI_DSH_INSTANCE_ID: dshInstanceId,
})) {
  if (!value) throw new Error(`${name} is required`)
}

async function toolQuery(state, requestId) {
  const response = await fetch(`${parentOrigin}/api/ai/tool-query`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${toolSecret}`,
      'content-type': 'application/json',
      'x-dsh-instance-id': dshInstanceId,
    },
    body: JSON.stringify({
      request_id: requestId,
      context_id: state.context_id,
      session_id: state.session_id,
      tool: 'get_project_overview',
      arguments: {},
    }),
  })
  return { status: response.status, body: await response.json() }
}

async function browserRequest(page, path, options = {}) {
  return page.evaluate(async ({ requestPath, requestOptions }) => {
    const response = await fetch(requestPath, {
      credentials: 'include',
      ...requestOptions,
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }, { requestPath: path, requestOptions: options })
}

async function embeddedState(page) {
  await page.locator('iframe[title="DSH AI 工作台"]').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForFunction(
    origin => [...document.querySelectorAll('iframe')]
      .some(frame => frame.src.startsWith(origin) && frame.src.includes('channel_id=')),
    dshOrigin,
    { timeout: 30_000 },
  )
  const iframe = page.locator('iframe[title="DSH AI 工作台"]')
  const iframeSrc = await iframe.getAttribute('src')
  const channelId = new URL(iframeSrc).searchParams.get('channel_id')
  assert.ok(channelId, 'DSH iframe URL must carry a channel id')
  const handle = await iframe.elementHandle()
  const frame = await handle.contentFrame()
  const deadline = Date.now() + 45_000
  let ready = false
  while (!ready && Date.now() < deadline) {
    ready = await frame.evaluate((expectedChannelId) => {
      const raw = sessionStorage.getItem('dsh.embed.pending.v1')
      if (!raw) return false
      const state = JSON.parse(raw)
      return location.pathname === '/' && state.channel_id === expectedChannelId
        && typeof state.session_id === 'string'
        && state.session_id.length > 0 && typeof state.context_id === 'string'
    }, channelId).catch(() => false)
    if (!ready) await page.waitForTimeout(100)
  }
  assert.equal(ready, true, 'DSH iframe did not finish integration initialization')
  const state = await frame.evaluate(() => JSON.parse(sessionStorage.getItem('dsh.embed.pending.v1')))
  const box = await iframe.boundingBox()
  assert.ok(box && box.width >= 640 && box.height >= 480, 'official DSH iframe must occupy the work area')
  const renderDeadline = Date.now() + 15_000
  let bodyText = ''
  while (bodyText.length === 0 && Date.now() < renderDeadline) {
    bodyText = (await frame.locator('body').innerText()).trim()
    if (bodyText.length === 0) await page.waitForTimeout(100)
  }
  if (bodyText.length === 0) {
    const markup = await frame.locator('body').innerHTML()
    assert.fail(`official DSH UI must render content; body=${markup.slice(0, 500)}`)
  }
  await page.waitForTimeout(500)
  assert.equal(
    await page.getByText('AI 工作台暂不可用', { exact: true }).count(),
    0,
    'parent page must remain in the ready state after DSH initialization',
  )
  return state
}

async function openWorkbench(page, projectId, screenshotName) {
  await page.goto(`${parentOrigin}/projects/${encodeURIComponent(projectId)}/ai-workbench`, {
    waitUntil: 'domcontentloaded',
  })
  await page.getByText('AI 工作台', { exact: true }).first().waitFor({ timeout: 30_000 })
  const state = await embeddedState(page)
  await page.getByText('正在连接 AI 工作台...', { exact: true }).waitFor({
    state: 'hidden',
    timeout: 15_000,
  })
  await page.screenshot({ path: resolve(screenshotDir, screenshotName), fullPage: true })
  return state
}

async function main() {
  mkdirSync(screenshotDir, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  const failures = []
  page.on('pageerror', error => failures.push(`pageerror: ${error.message}`))
  page.on('response', response => {
    if (response.status() >= 500) failures.push(`${response.status()} ${response.url()}`)
  })
  try {
    await page.goto(`${parentOrigin}/api/auth/login?return_to=%2Fprojects`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForURL(url => url.origin === parentOrigin && url.pathname === '/projects', { timeout: 30_000 })

    const site = await openWorkbench(page, siteProjectId, 'site-ai-workbench.png')
    await page.reload({ waitUntil: 'domcontentloaded' })
    const siteAfterRefresh = await embeddedState(page)
    assert.equal(siteAfterRefresh.session_id, site.session_id, 'refresh must restore the exact Site session')
    assert.equal(siteAfterRefresh.context_id, site.context_id, 'refresh must restore the exact Site context')

    const probecard = await openWorkbench(page, probecardProjectId, 'probecard-ai-workbench.png')
    assert.notEqual(probecard.session_id, site.session_id, 'project modes must use different sessions')
    assert.notEqual(probecard.context_id, site.context_id, 'project modes must use different contexts')
    assert.equal(probecard.workspace_id, site.workspace_id, 'both modes must use the same configured workspace')

    const missingCsrf = await browserRequest(
      page,
      `/api/ai/projects/${encodeURIComponent(probecardProjectId)}/bootstrap`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ function_type: 'PROBECARD_DESIGN', request_id: 'smoke-missing-csrf' }),
      },
    )
    assert.equal(missingCsrf.status, 403, 'bootstrap without CSRF must be rejected')
    assert.equal(missingCsrf.body?.detail?.code, 'CSRF_INVALID')

    const csrf = await browserRequest(page, '/api/auth/csrf')
    assert.equal(csrf.status, 200, 'authenticated browser must receive a CSRF token')
    const logout = await browserRequest(page, '/api/auth/logout', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf.body.csrf_token },
    })
    assert.equal(logout.status, 204, 'logout must succeed with the real AuthSession and CSRF token')

    const revoked = await toolQuery(probecard, 'smoke-after-logout')
    assert.equal(revoked.status, 403, 'the old tool grant must be rejected immediately after logout')
    assert.equal(revoked.body?.error?.code, 'CONTEXT_REVOKED')

    const unauthenticated = await browserRequest(
      page,
      `/api/ai/projects/${encodeURIComponent(probecardProjectId)}/bootstrap`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ function_type: 'PROBECARD_DESIGN', request_id: 'smoke-after-logout' }),
      },
    )
    assert.equal(unauthenticated.status, 401, 'bootstrap without an AuthSession must be rejected')
    assert.equal(unauthenticated.body?.detail?.code, 'AUTH_REQUIRED')

    await page.goto(`${parentOrigin}/api/auth/login?return_to=%2Fprojects`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForURL(url => url.origin === parentOrigin && url.pathname === '/projects', { timeout: 30_000 })
    const restored = await openWorkbench(page, probecardProjectId, 'probecard-ai-workbench-relogin.png')
    assert.equal(restored.context_id, probecard.context_id, 'relogin must restore the same context')
    assert.equal(restored.session_id, probecard.session_id, 'relogin must restore the same DSH session')
    const restoredQuery = await toolQuery(restored, 'smoke-after-relogin')
    assert.equal(restoredQuery.status, 200, 'a new grant must authorize tools after relogin')
    assert.equal(restoredQuery.body?.ok, true)
    assert.deepEqual(failures, [])

    process.stdout.write(`${JSON.stringify({
      site: { project_id: siteProjectId, session_id: site.session_id, context_id: site.context_id },
      probecard: {
        project_id: probecardProjectId,
        session_id: probecard.session_id,
        context_id: probecard.context_id,
      },
      auth_lifecycle: {
        old_grant_after_logout: revoked.body?.error?.code,
        unauthenticated_bootstrap: unauthenticated.body?.detail?.code,
        restored_session_id: restored.session_id,
        restored_context_id: restored.context_id,
      },
      workspace_id: site.workspace_id,
      screenshots: screenshotDir,
    }, null, 2)}\n`)
  } finally {
    await context.close()
    await browser.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
