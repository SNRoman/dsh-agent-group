import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_UI_CSS } from '../packages/web/src/client/styles.ts'

let browser: Browser | undefined
beforeAll(async () => { browser = await chromium.launch() })
afterAll(async () => { await browser?.close() })

// Owned layout fixtures exercise the shipped stylesheet without a Host, model or network listener.
const content = (mode: string): string => `<style>
body { margin: 0; font: 14px system-ui; --dsw-alias-bg-layer-1: rgb(255,255,255); --dsw-alias-label-primary: rgb(20,20,20); --dsw-alias-label-primary-inverted: white; --dsw-alias-label-secondary: rgb(95,95,95); --dsw-alias-border-l2: #ddd; --dsw-alias-border-l4: #bbb; --dsw-alias-button-elevated-fill: white; --dsw-alias-state-business-primary: #4d6bfe; --dsw-alias-interactive-bg-hover: #f5f5f5; }
${WORKSPACE_UI_CSS}</style>
<div class="dsh-agent-group-overlay-root"><section class="dsh-agent-group-workbench">
<header class="dsh-agent-group-topbar"><nav class="dsh-agent-group-tabs"><button class="dsh-agent-group-tab">Conversations</button><button class="dsh-agent-group-tab">Colleagues</button><button class="dsh-agent-group-tab">Tasks</button><button class="dsh-agent-group-tab">Memory</button></nav></header>
<div class="dsh-agent-group-body" data-mode="${mode}"><aside class="dsh-agent-group-panel"><div class="dsh-agent-group-section-head">Selection</div><div class="dsh-agent-group-scroll"><button class="dsh-agent-group-list-button">Existing colleague or room</button></div></aside>
<main class="dsh-agent-group-panel"><section class="dsh-agent-group-workflow"><h3>Workflow</h3><details open><summary>Draft</summary><div class="dsh-agent-group-form">${Array.from({ length: 7 }, (_, i) => `<label class="dsh-agent-group-field"><span>Instructions ${i}</span><textarea class="dsh-agent-group-textarea">Long multiline brief</textarea></label>`).join('')}<button class="dsh-agent-group-button">Confirm</button></div></details></section><div class="dsh-agent-group-section-head">Results</div><div class="dsh-agent-group-scroll">Result</div></main></div>
</section></div>`

describe('organization workbench real Chromium layout', () => {
  it('keeps a long colleague name and both member actions inside the narrow member card', async () => {
    const context = await browser!.newContext({ viewport: { width: 1200, height: 860 } })
    try {
      const page = await context.newPage()
      const style = content('conversations').split('</style>')[0] + '</style>'
      await page.setContent(`${style}<aside style="width:240px"><div class="dsh-agent-group-member-card"><button class="dsh-agent-group-member-identity"><span class="dsh-agent-group-avatar">林</span><span>负责Java后端与跨部门系统集成的小林同事</span></button><div class="dsh-agent-group-member-actions"><button class="dsh-agent-group-button">发起私聊</button><button class="dsh-agent-group-button">移出群聊</button></div></div></aside>`)
      for (const button of await page.locator('button').all()) {
        const bounds = await button.boundingBox()
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(240)
      }
      expect(await page.locator('.dsh-agent-group-member-card').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
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
