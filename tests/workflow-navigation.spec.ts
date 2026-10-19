import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { openWorkflowSettings } from './e2e/workflow-browser.mjs'

it('opens the workflow settings through the current Chinese work tab', async () => {
  const browser = await chromium.launch({ timeout: 10_000 })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(5_000)
    await page.setContent('<div role="dialog" aria-label="智能体组织"><button onclick="document.querySelector(\'details\').hidden=false">工作</button><details class="dsh-agent-group-work-settings" hidden><summary>工作流设置</summary><p>当前草稿</p></details></div>')
    const dialog = page.getByRole('dialog', { name: '智能体组织', exact: true })
    await openWorkflowSettings(dialog)
    expect(await dialog.locator('details').getAttribute('open')).toBe('')
    expect(await dialog.getByText('当前草稿', { exact: true }).isVisible()).toBe(true)
  } finally {
    await browser.close()
  }
}, 20_000)
