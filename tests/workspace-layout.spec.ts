import { chromium, type Browser } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_UI_CSS } from '../packages/web/src/client/styles.ts'

const BROWSER_TEST_TIMEOUT_MS = 15_000
const BROWSER_LAUNCH_TIMEOUT_MS = 10_000
const BROWSER_HOOK_TIMEOUT_MS = 15_000

let browser: Browser | undefined
beforeAll(async () => { browser = await chromium.launch({ timeout: BROWSER_LAUNCH_TIMEOUT_MS }) }, BROWSER_HOOK_TIMEOUT_MS)
afterEach(async () => { await Promise.all(browser?.contexts().map(context => context.close()) ?? []) }, BROWSER_HOOK_TIMEOUT_MS)
afterAll(async () => { await browser?.close(); browser = undefined }, BROWSER_HOOK_TIMEOUT_MS)

// Owned layout fixtures exercise the shipped stylesheet without a Host, model or network listener.
const content = (mode: string): string => `<style>
body { margin: 0; font: 14px system-ui; --dsw-alias-bg-layer-1: rgb(255,255,255); --dsw-alias-label-primary: rgb(20,20,20); --dsw-alias-label-primary-inverted: white; --dsw-alias-label-secondary: rgb(95,95,95); --dsw-alias-border-l2: #ddd; --dsw-alias-border-l4: #bbb; --dsw-alias-button-elevated-fill: white; --dsw-alias-state-business-primary: #4d6bfe; --dsw-alias-interactive-bg-hover: #f5f5f5; }
${WORKSPACE_UI_CSS}</style>
<div class="dsh-agent-group-overlay-root"><section class="dsh-agent-group-workbench">
<header class="dsh-agent-group-topbar"><nav class="dsh-agent-group-tabs"><button class="dsh-agent-group-tab">Conversations</button><button class="dsh-agent-group-tab">Colleagues</button><button class="dsh-agent-group-tab">Tasks</button><button class="dsh-agent-group-tab">Memory</button></nav></header>
<div class="dsh-agent-group-body" data-mode="${mode}"><aside class="dsh-agent-group-panel"><div class="dsh-agent-group-section-head">Selection</div><div class="dsh-agent-group-scroll"><button class="dsh-agent-group-list-button">Existing colleague or room</button></div></aside>
<main class="dsh-agent-group-panel"><section class="dsh-agent-group-workflow"><h3>Workflow</h3><details open><summary>Draft</summary><div class="dsh-agent-group-form">${Array.from({ length: 7 }, (_, i) => `<label class="dsh-agent-group-field"><span>Instructions ${i}</span><textarea class="dsh-agent-group-textarea">Long multiline brief</textarea></label>`).join('')}<button class="dsh-agent-group-button">Confirm</button></div></details></section><div class="dsh-agent-group-section-head">Results</div><div class="dsh-agent-group-scroll">Result</div></main></div>
</section></div>`

const toolbarContent = (withDrawer = false): string => `${content('conversations').split('</style>')[0]}</style>
<div class="dsh-agent-group-overlay-root dsh-agent-group-organizations"><div class="dsh-agent-group-organization-workspace"><section class="dsh-agent-group-workbench">
<header class="dsh-agent-group-topbar">
  <section class="dsh-agent-group-organization-directory">
    <div class="dsh-agent-group-organization-heading"><span class="dsh-agent-group-organization-name">Agent Organization</span><span class="dsh-agent-group-organization-counts">2 colleagues / 3 events</span></div>
    <label class="dsh-agent-group-field dsh-agent-group-organization-switcher"><span>Organization</span><select class="dsh-agent-group-select" aria-label="Organization"><option>Local organization</option></select></label>
    <details class="dsh-agent-group-organization-management"><summary>Manage organization</summary><div class="dsh-agent-group-form dsh-agent-group-management-form"><label class="dsh-agent-group-field"><span>Organization label</span><input class="dsh-agent-group-input" aria-label="Organization label" value="Local organization"></label><div class="dsh-agent-group-inline"><button class="dsh-agent-group-button">Create organization</button><button class="dsh-agent-group-button">Rename organization</button></div></div></details>
  </section>
  <nav class="dsh-agent-group-tabs" aria-label="Workspace views">${['Chat', 'Colleagues', 'Work', 'Memory'].map(name => `<button class="dsh-agent-group-tab">${name}</button>`).join('')}</nav>
  <span class="dsh-agent-group-spacer"></span>
  <div class="dsh-agent-group-shell-actions">
  <button class="dsh-agent-group-icon-button dsh-agent-group-activity-trigger" aria-label="Open activity"><span class="dsh-agent-group-status-indicator" data-status="responding" aria-hidden="true"></span><span class="dsh-agent-group-task-badge">Responding</span><span class="dsh-agent-group-task-badge">Using tool</span><span class="dsh-agent-group-activity-count">12</span></button>
  <button class="dsh-agent-group-icon-button" aria-label="Refresh">↻</button><button class="dsh-agent-group-icon-button" aria-label="Close">×</button>
  </div>
</header>
<div class="dsh-agent-group-body" data-mode="conversations" data-members-open="false"><aside class="dsh-agent-group-panel">Rooms</aside><main class="dsh-agent-group-chat">Messages</main><aside hidden class="dsh-agent-group-panel dsh-agent-group-member-panel">Members</aside></div>
${withDrawer ? '<aside class="dsh-agent-group-activity-drawer" role="dialog" aria-label="Activity"><div class="dsh-agent-group-section-head"><strong>Activity</strong><button class="dsh-agent-group-icon-button dsh-agent-group-right" aria-label="Close activity">×</button></div><div class="dsh-agent-group-activity-layout">Activity detail</div></aside>' : ''}
</section></div></div>`

describe('organization workbench real Chromium layout', { timeout: BROWSER_TEST_TIMEOUT_MS }, () => {
  it.each([{ foreground: '#141414', background: '#ffffff' }, { foreground: '#e5e7eb', background: '#16181d' }])('keeps small employment labels readable on $background', async theme => {
    const context = await browser!.newContext({ viewport: { width: 800, height: 600 } })
    try {
      const page = await context.newPage()
      const style = content('colleagues').split('</style>')[0] + '</style>'
      await page.setContent(`${style}<div class="dsh-agent-group-overlay-root" style="--dsw-alias-label-primary:${theme.foreground};--dsw-alias-state-success-primary:#22c55e;background:${theme.background}"><span class="dsh-agent-group-person-status" data-employment="employed">在职</span></div>`)
      const contrast = await page.locator('.dsh-agent-group-person-status').evaluate((element, background) => {
        const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
        const context = canvas.getContext('2d')!
        context.fillStyle = background; context.fillRect(0, 0, 1, 1)
        context.fillStyle = getComputedStyle(element).backgroundColor; context.fillRect(0, 0, 1, 1)
        const backdrop = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
        context.fillStyle = getComputedStyle(element).color; context.fillRect(0, 0, 1, 1)
        const foreground = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
        const luminance = (rgb: number[]): number => rgb.map(value => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0)
        const a = luminance(foreground), b = luminance(backdrop)
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
      }, theme.background)
      expect(contrast).toBeGreaterThanOrEqual(4.5)
    } finally { await context.close() }
  })
  it('keeps all navigation buttons reachable beside the complete active English toolbar at 768px', async () => {
    const context = await browser!.newContext({ viewport: { width: 768, height: 800 } })
    try {
      const page = await context.newPage()
      await page.setContent(toolbarContent())
      for (const button of await page.getByRole('navigation', { name: 'Workspace views' }).getByRole('button').all()) {
        expect(await button.evaluate(element => { const bounds = element.getBoundingClientRect(); return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('button') === element })).toBe(true)
      }
      expect(await page.getByRole('navigation', { name: 'Workspace views' }).evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    } finally { await context.close() }
  })

  it('keeps the narrow activity drawer Close button above the global toolbar', async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 800 } })
    try {
      const page = await context.newPage()
      await page.setContent(toolbarContent(true))
      const close = page.getByRole('button', { name: 'Close activity', exact: true })
      expect(await close.evaluate(element => { const bounds = element.getBoundingClientRect(); return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('button') === element })).toBe(true)
    } finally { await context.close() }
  })

  it('keeps the narrow organization selector reachable while colleagues are using tools', async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 800 } })
    try {
      const page = await context.newPage()
      await page.setContent(toolbarContent())
      const selector = page.getByRole('combobox', { name: 'Organization', exact: true })
      expect(await selector.evaluate(element => { const bounds = element.getBoundingClientRect(); return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === element })).toBe(true)
    } finally { await context.close() }
  })

  it.each([390, 768, 1280])('keeps organization management inside the %ipx unified frame with reachable controls', async width => {
    const context = await browser!.newContext({ viewport: { width, height: 800 } })
    try {
      const page = await context.newPage()
      await page.setContent(toolbarContent())
      await page.getByText('Manage organization', { exact: true }).click()
      const form = await page.locator('.dsh-agent-group-management-form').boundingBox()
      const trigger = await page.locator('.dsh-agent-group-organization-management > summary').boundingBox()
      expect(form!.x).toBeGreaterThanOrEqual(0)
      expect(form!.x + form!.width).toBeLessThanOrEqual(width)
      expect(form!.y + form!.height).toBeLessThanOrEqual(800)
      expect(form!.x).toBeLessThan(trigger!.x + trigger!.width)
      expect(form!.x + form!.width).toBeGreaterThan(trigger!.x)
      expect(form!.y - trigger!.y - trigger!.height).toBeGreaterThanOrEqual(4)
      expect(form!.y - trigger!.y - trigger!.height).toBeLessThanOrEqual(12)
      if (width >= 720) expect(Math.abs(form!.x - trigger!.x)).toBeLessThanOrEqual(1)
      const create = page.getByRole('button', { name: 'Create organization', exact: true })
      expect(await create.evaluate(element => { const bounds = element.getBoundingClientRect(); return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('button') === element })).toBe(true)
    } finally { await context.close() }
  })

  it.each([390, 1280])('keeps the unified %ipx organization header compact and its navigation reachable', async width => {
    const context = await browser!.newContext({ viewport: { width, height: 800 } })
    try {
      const page = await context.newPage()
      const style = content('conversations').split('</style>')[0] + '</style>'
      await page.setContent(`${style}<div class="dsh-agent-group-overlay-root dsh-agent-group-organizations"><div class="dsh-agent-group-organization-workspace"><section class="dsh-agent-group-workbench"><header class="dsh-agent-group-topbar"><section class="dsh-agent-group-organization-directory"><div class="dsh-agent-group-organization-heading"><span class="dsh-agent-group-organization-name">智能体组织</span></div><label class="dsh-agent-group-field dsh-agent-group-organization-switcher"><span>组织</span><select class="dsh-agent-group-select" aria-label="组织"><option>Local organization</option></select></label><details class="dsh-agent-group-organization-management"><summary>组织管理</summary></details></section><nav class="dsh-agent-group-tabs"><button class="dsh-agent-group-tab">聊天</button><button class="dsh-agent-group-tab">同事</button><button class="dsh-agent-group-tab">工作</button><button class="dsh-agent-group-tab">记忆</button></nav><span class="dsh-agent-group-spacer"></span><button class="dsh-agent-group-icon-button" aria-label="关闭">×</button></header></section></div></div>`)
      const header = await page.locator('.dsh-agent-group-topbar').boundingBox()
      expect(header!.height).toBeLessThanOrEqual(width > 700 ? 76 : 132)
      expect(await page.locator('.dsh-agent-group-workbench').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
      for (const button of await page.locator('.dsh-agent-group-tab').all()) {
        expect(await button.evaluate(el => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === el })).toBe(true)
      }
    } finally { await context.close() }
  })

  it('returns the closed desktop member column to the conversation instead of leaving an empty rail', async () => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    try {
      const page = await context.newPage()
      const style = content('conversations').split('</style>')[0] + '</style>'
      await page.setContent(`${style}<div class="dsh-agent-group-overlay-root"><section class="dsh-agent-group-workbench"><div class="dsh-agent-group-body" data-mode="conversations" data-members-open="false"><aside class="dsh-agent-group-panel">Rooms</aside><main class="dsh-agent-group-panel dsh-agent-group-chat">Messages</main><aside hidden class="dsh-agent-group-panel dsh-agent-group-member-panel">Members</aside></div></section></div>`)
      const body = await page.locator('.dsh-agent-group-body').boundingBox()
      const rooms = await page.locator('aside').first().boundingBox()
      const chat = await page.locator('main').boundingBox()
      expect(await page.locator('.dsh-agent-group-member-panel').isVisible()).toBe(false)
      expect(chat!.width).toBeGreaterThanOrEqual(body!.width - rooms!.width - 2)
    } finally { await context.close() }
  })

  it('keeps the narrow conversation editor visible below its compact room picker', async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 800 } })
    try {
      const page = await context.newPage()
      const style = content('conversations').split('</style>')[0] + '</style>'
      await page.setContent(`${style}<div class="dsh-agent-group-overlay-root"><section class="dsh-agent-group-workbench"><header class="dsh-agent-group-topbar"><nav class="dsh-agent-group-tabs"><button class="dsh-agent-group-tab">聊天</button></nav></header><div class="dsh-agent-group-body" data-mode="conversations" data-members-open="false"><aside class="dsh-agent-group-panel dsh-agent-group-room-sidebar"><div class="dsh-agent-group-section-head"><label class="dsh-agent-group-room-picker"><select class="dsh-agent-group-select" aria-label="会话"><option>测试群</option></select></label><button class="dsh-agent-group-icon-button">+</button></div><div class="dsh-agent-group-scroll dsh-agent-group-list dsh-agent-group-room-list">${'<button class="dsh-agent-group-list-button">会话</button>'.repeat(12)}</div></aside><main class="dsh-agent-group-chat"><div class="dsh-agent-group-section-head">测试群</div><div class="dsh-agent-group-messages">${'<p>历史消息</p>'.repeat(30)}</div><div class="dsh-agent-group-composer"><div class="dsh-agent-group-compose-row"><textarea class="dsh-agent-group-textarea"></textarea><div class="dsh-agent-group-compose-footer"><button class="dsh-agent-group-button dsh-agent-group-send">发送</button></div></div></div></main></div></section></div>`)
      const editor = await page.locator('.dsh-agent-group-composer').boundingBox()
      expect(editor!.y + editor!.height).toBeLessThanOrEqual(800)
      expect((await page.locator('.dsh-agent-group-messages').boundingBox())!.height).toBeGreaterThanOrEqual(150)
      expect(await page.getByRole('combobox', { name: '会话' }).isVisible()).toBe(true)
      expect(await page.locator('.dsh-agent-group-room-list').isVisible()).toBe(false)
    } finally { await context.close() }
  })
  it.each([390, 1200])('gives the %ipx colleague picker full-width readable choices and reachable actions', async width => {
    const context = await browser!.newContext({ viewport: { width, height: 700 } })
    try {
      const page = await context.newPage()
      const style = content('conversations').split('</style>')[0] + '</style>'
      await page.setContent(`${style}<div class="dsh-agent-group-modal dsh-agent-group-add-colleague-modal"><div class="dsh-agent-group-modal-card dsh-agent-group-add-colleague-dialog"><header><h2>添加同事</h2><p>加入后自动同步群聊历史</p></header><input type="search" class="dsh-agent-group-input" aria-label="搜索同事"> <div class="dsh-agent-group-add-colleague-list">${Array.from({ length: 18 }, (_, index) => `<label class="dsh-agent-group-add-colleague-option"><input type="radio" name="colleague"><span class="dsh-agent-group-avatar">林</span><span class="dsh-agent-group-person-label"><strong>负责Java后端和数据系统的小林同事${index}</strong><small>跨部门集成工程师</small></span></label>`).join('')}</div><footer class="dsh-agent-group-add-colleague-footer"><span>已选择小林</span><div class="dsh-agent-group-inline"><button class="dsh-agent-group-button">取消</button><button class="dsh-agent-group-button">加入群聊</button></div></footer></div></div>`)
      await page.locator('.dsh-agent-group-add-colleague-footer > span').evaluate(element => { element.textContent = 'Selected colleague: ' + 'ColleagueWithAnUnbrokenEnglishName'.repeat(4) })
      const card = await page.locator('.dsh-agent-group-add-colleague-dialog').boundingBox()
      const selected = await page.locator('.dsh-agent-group-add-colleague-footer > span').boundingBox()
      expect(selected!.x + selected!.width).toBeLessThanOrEqual(card!.x + card!.width)
      if (width > 600) expect(card!.width).toBeGreaterThanOrEqual(600)
      expect(card!.x).toBeGreaterThanOrEqual(0)
      expect(card!.x + card!.width).toBeLessThanOrEqual(width)
      expect(card!.y + card!.height).toBeLessThanOrEqual(700)
      const row = await page.locator('.dsh-agent-group-add-colleague-option').first().boundingBox()
      expect(row!.height).toBeGreaterThanOrEqual(56)
      expect(row!.width).toBeGreaterThanOrEqual(card!.width - 56)
      const reachable = await page.getByRole('button', { name: '加入群聊', exact: true }).evaluate(button => { const bounds = button.getBoundingClientRect(); return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('button') === button })
      expect(reachable).toBe(true)
      expect(await page.locator('.dsh-agent-group-add-colleague-list').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    } finally { await context.close() }
  })

  it.each([390, 1726])('keeps the %ipx chat composer compact and its send label on one line', async width => {
    const context = await browser!.newContext({ viewport: { width, height: 600 } })
    try {
      const page = await context.newPage()
      const style = content('conversations').split('</style>')[0] + '</style>'
      await page.setContent(`${style}<div class="dsh-agent-group-composer"><div class="dsh-agent-group-compose-row"><textarea class="dsh-agent-group-textarea" placeholder="输入消息"></textarea><div class="dsh-agent-group-compose-footer"><span class="dsh-agent-group-compose-hint">Ctrl/⌘ + Enter</span><button class="dsh-agent-group-button dsh-agent-group-send">发送</button></div></div></div>`)
      const textarea = await page.locator('textarea').boundingBox()
      expect(textarea!.height).toBeLessThanOrEqual(80)
      const send = await page.getByRole('button', { name: '发送', exact: true }).boundingBox()
      expect(send!.height).toBeGreaterThanOrEqual(32)
      expect(send!.height).toBeLessThanOrEqual(44)
      const lines = await page.getByRole('button', { name: '发送', exact: true }).evaluate(button => {
        const range = document.createRange(); range.selectNodeContents(button)
        return new Set(Array.from(range.getClientRects()).map(rect => rect.top)).size
      })
      expect(lines).toBe(1)
      expect(await page.locator('.dsh-agent-group-composer').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    } finally { await context.close() }
  })

  it('keeps a long chat draft scrollable without a manual resize handle', async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 600 } })
    try {
      const page = await context.newPage()
      const style = content('conversations').split('</style>')[0] + '</style>'
      await page.setContent(`${style}<div class="dsh-agent-group-composer"><div class="dsh-agent-group-compose-row"><textarea class="dsh-agent-group-textarea" style="height:500px">${'多行草稿\n'.repeat(30)}</textarea><div class="dsh-agent-group-compose-footer"><button class="dsh-agent-group-button dsh-agent-group-send">发送并交办</button></div></div></div>`)
      expect((await page.locator('textarea').boundingBox())!.height).toBeLessThanOrEqual(200)
      expect(await page.locator('textarea').evaluate(element => ({ resize: getComputedStyle(element).resize, overflowing: element.scrollHeight > element.clientHeight }))).toEqual({ resize: 'none', overflowing: true })
    } finally { await context.close() }
  })

  it('keeps Markdown sticky controls below the recall modal', async () => {
    const context = await browser!.newContext({ viewport: { width: 700, height: 600 } })
    try {
      const page = await context.newPage()
      const style = content('conversations').split('</style>')[0] + '</style>'
      await page.setContent(`${style}<div class="dsh-agent-group-message-body"><div style="position:fixed;inset:0;z-index:99">Code controls</div></div><div class="dsh-agent-group-modal"><div class="dsh-agent-group-modal-card">Recall</div></div>`)
      expect(await page.evaluate(() => Boolean(document.elementFromPoint(350, 300)?.closest('.dsh-agent-group-modal')))).toBe(true)
    } finally { await context.close() }
  })
  it('keeps the add-colleague submit control reachable in a narrow directory', async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 860 } })
    try {
      const page = await context.newPage()
      const style = content('colleagues').split('</style>')[0] + '</style>'
      await page.setContent(`${style}<div class="dsh-agent-group-overlay-root"><section class="dsh-agent-group-workbench"><header class="dsh-agent-group-topbar">Colleagues</header><div class="dsh-agent-group-people-body"><aside class="dsh-agent-group-panel"><div class="dsh-agent-group-section-head">Colleagues<button class="dsh-agent-group-button">Add colleague</button></div><label class="dsh-agent-group-field"><input class="dsh-agent-group-input" placeholder="Search"></label><form class="dsh-agent-group-form dsh-agent-group-card"><label class="dsh-agent-group-field"><span>Name</span><input class="dsh-agent-group-input"></label><label class="dsh-agent-group-field"><span>Role</span><select class="dsh-agent-group-select"><option>Engineer</option></select></label><button type="submit" class="dsh-agent-group-button">Confirm colleague</button></form><div class="dsh-agent-group-scroll dsh-agent-group-list">Existing colleagues</div></aside><main class="dsh-agent-group-panel dsh-agent-group-people-main">Profile</main></div></section></div>`)
      const reachable = await page.getByRole('button', { name: 'Confirm colleague' }).evaluate(el => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === el })
      expect(reachable).toBe(true)
    } finally { await context.close() }
  })

  it('keeps a long colleague name and both member actions inside the narrow member card', async () => {
    const context = await browser!.newContext({ viewport: { width: 1200, height: 860 } })
    try {
      const page = await context.newPage()
      const style = content('conversations').split('</style>')[0] + '</style>'
      const person = '<span class="dsh-agent-group-avatar">林</span><span class="dsh-agent-group-person-label"><strong>负责Java后端与跨部门系统集成的小林同事</strong><small>跨部门集成工程师</small></span><span class="dsh-agent-group-person-status" data-employment="employed">在职</span>'
      await page.setContent(`${style}<div class="dsh-agent-group-overlay-root" style="display:block"><aside style="width:240px"><button class="dsh-agent-group-list-button" aria-label="Directory colleague">${person}</button><div class="dsh-agent-group-member-card"><button class="dsh-agent-group-list-button dsh-agent-group-member-identity" aria-label="Group colleague">${person}</button><div class="dsh-agent-group-member-actions"><button class="dsh-agent-group-button">发起私聊</button><button class="dsh-agent-group-button">移出群聊</button></div></div></aside></div>`)
      const metrics = (element: Element) => {
        const css = getComputedStyle(element)
        return { padding: css.padding, font: css.font, borderRadius: css.borderRadius, textAlign: css.textAlign, gap: css.gap }
      }
      expect(await page.getByRole('button', { name: 'Group colleague', exact: true }).evaluate(metrics)).toEqual(await page.getByRole('button', { name: 'Directory colleague', exact: true }).evaluate(metrics))
      expect(await page.locator('.dsh-agent-group-member-card').evaluate(el => getComputedStyle(el).borderWidth)).toBe('0px')
      for (const button of await page.locator('button').all()) {
        const bounds = await button.boundingBox()
        const aside = await page.locator('aside').boundingBox()
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(aside!.x + aside!.width)
      }
      expect(await page.locator('.dsh-agent-group-member-card').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    } finally { await context.close() }
  })

  it.each([390, 1200])('keeps picker employment status beside the identity rather than an orphaned grid row at %ipx', async width => {
    const context = await browser!.newContext({ viewport: { width, height: 700 } })
    try {
      const page = await context.newPage()
      const style = content('conversations').split('</style>')[0] + '</style>'
      await page.setContent(`${style}<div class="dsh-agent-group-overlay-root"><div style="width:100%"><label class="dsh-agent-group-add-colleague-option"><input type="checkbox"><span class="dsh-agent-group-avatar">林</span><span class="dsh-agent-group-person-label"><strong>负责Java后端与跨部门系统集成的小林同事</strong><small>跨部门集成工程师</small></span><span class="dsh-agent-group-person-status" data-employment="employed">在职</span></label></div></div>`)
      const row = await page.locator('label').boundingBox()
      const identity = await page.locator('.dsh-agent-group-person-label').boundingBox()
      const status = await page.locator('.dsh-agent-group-person-status').boundingBox()
      expect(status!.x).toBeGreaterThanOrEqual(identity!.x + identity!.width)
      expect(status!.y).toBeLessThan(identity!.y + identity!.height)
      expect(status!.y + status!.height).toBeGreaterThan(identity!.y)
      expect(status!.x + status!.width).toBeLessThanOrEqual(row!.x + row!.width)
      expect(await page.locator('label').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    } finally { await context.close() }
  })

  it('aligns human bubbles right, keeps colleague bubbles left and wraps long text', async () => {
    const context = await browser!.newContext({ viewport: { width: 700, height: 600 } })
    try {
      const page = await context.newPage()
      const style = content('conversations').split('</style>')[0] + '</style>'
      await page.setContent(`${style}<div class="dsh-agent-group-messages"><article class="dsh-agent-group-message" data-author="agent"><span class="dsh-agent-group-avatar">林</span><div class="dsh-agent-group-message-body"><div class="dsh-agent-group-message-text">已收到</div></div></article><article class="dsh-agent-group-message" data-author="human"><span class="dsh-agent-group-avatar">我</span><div class="dsh-agent-group-message-body"><div class="dsh-agent-group-message-text">${'很长的消息'.repeat(80)}</div></div></article></div>`)
      const agent = await page.locator('[data-author="agent"]').boundingBox()
      const human = await page.locator('[data-author="human"]').boundingBox()
      expect(agent!.x).toBeLessThan(human!.x)
      expect(await page.locator('[data-author="human"] .dsh-agent-group-message-body').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
      const colors = await page.locator('.dsh-agent-group-message-body').evaluateAll(elements => elements.map(el => getComputedStyle(el).backgroundColor))
      expect(colors[0]).not.toBe(colors[1])
    } finally { await context.close() }
  })

  it('keeps empty-directory management and its Close control inside a narrow viewport', async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 700 } })
    try {
      const page = await context.newPage()
      const style = content('tasks').split('</style>')[0] + '</style>'
      await page.setContent(`${style}<div class="dsh-agent-group-overlay-root dsh-agent-group-organizations"><section class="dsh-agent-group-organization-directory"><div class="dsh-agent-group-organization-heading"><span class="dsh-agent-group-organization-name">Agent Organization</span></div><label class="dsh-agent-group-field"><span>Organization</span><select class="dsh-agent-group-select" disabled></select></label><details class="dsh-agent-group-organization-management" open><summary>Manage organization</summary><div class="dsh-agent-group-form dsh-agent-group-management-form"><label class="dsh-agent-group-field"><span>Organization label</span><input class="dsh-agent-group-input"></label><button class="dsh-agent-group-button">Create organization</button></div></details><button class="dsh-agent-group-button" data-variant="ghost">Close</button></section></div>`)
      const bounds = await page.locator('.dsh-agent-group-management-form').evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom } })
      expect(bounds.left).toBeGreaterThanOrEqual(0)
      expect(bounds.right).toBeLessThanOrEqual(390)
      expect(bounds.bottom).toBeLessThanOrEqual(700)
      const closeReachable = await page.getByRole('button', { name: 'Close', exact: true }).evaluate(el => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === el })
      expect(closeReachable).toBe(true)
    } finally { await context.close() }
  })

  it.each([390, 590])('uses the full %ipx narrow task area instead of an orphaned grid column', async width => {
    const context = await browser!.newContext({ viewport: { width, height: 860 } })
    try {
      const page = await context.newPage()
      await page.setContent(content('tasks'))
      const sizes = await page.evaluate(() => {
        const body = document.querySelector('.dsh-agent-group-body')!.getBoundingClientRect()
        const main = document.querySelector('main')!.getBoundingClientRect()
        return { body: body.width, main: main.width, overflow: document.documentElement.scrollWidth - innerWidth }
      })
      expect(sizes.main).toBeGreaterThanOrEqual(sizes.body - 2)
      expect(sizes.overflow).toBeLessThanOrEqual(1)
    } finally { await context.close() }
  })

  it('lets the task pane scroll the full brief without a second clipped workflow scrollbar', async () => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 860 } })
    try {
      const page = await context.newPage()
      await page.setContent(content('tasks'))
      const workflow = await page.locator('.dsh-agent-group-workflow').evaluate(el => ({ content: el.scrollHeight, visible: el.clientHeight }))
      expect(workflow.content).toBeLessThanOrEqual(workflow.visible + 1)
      const pane = await page.locator('main').evaluate(el => ({ content: el.scrollHeight, visible: el.clientHeight }))
      expect(pane.content).toBeGreaterThan(pane.visible)
    } finally { await context.close() }
  })

  it.each(['conversations', 'colleagues', 'memory'])('keeps %s selection reachable in a narrow window', async mode => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 860 } })
    try {
      const page = await context.newPage()
      await page.setContent(content(mode))
      expect(await page.getByRole('button', { name: 'Existing colleague or room' }).isVisible()).toBe(true)
    } finally { await context.close() }
  })

  it('shows a keyboard focus ring on the editor rather than removing the outline', async () => {
    const context = await browser!.newContext({ viewport: { width: 1440, height: 860 } })
    try {
      const page = await context.newPage()
      await page.setContent(content('tasks'))
      await page.getByRole('button', { name: 'Conversations', exact: true }).focus()
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')
      const ring = await page.evaluate(() => { const el = document.activeElement!; const css = getComputedStyle(el); return { tag: el.tagName, width: Number.parseFloat(css.outlineWidth), style: css.outlineStyle } })
      expect(ring.tag).toBe('TEXTAREA')
      expect(ring.width).toBeGreaterThan(0)
      expect(ring.style).not.toBe('none')
    } finally { await context.close() }
  })
})
