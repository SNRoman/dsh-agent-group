import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { waitForRecoveredReply } from './e2e/recovery-observation.mjs'

let browser: Browser
beforeAll(async () => { browser = await chromium.launch() })
afterAll(async () => { await browser?.close() })

test('an imported reply cannot complete observation of the new recovery reply', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent('<div role="dialog"><main><p>MEMORY_OK Alice</p></main></div>')
    const dialog = page.getByRole('dialog')
    const before = await dialog.getByRole('main').getByText('MEMORY_OK Alice', { exact: true }).count()
    await expect(waitForRecoveredReply(dialog, before, ['Agents working…'], 100)).rejects.toThrow(/Timeout/u)
  } finally { await page.close() }
})

test.each(['Agents working…', '智能体处理中…'])('durable inspection waits for a new reply and hidden %s', async busyLabel => {
  const page = await browser.newPage()
  try {
    await page.setContent(`<div role="dialog"><main><p>MEMORY_OK Alice</p></main><div>${busyLabel}</div></div>`)
    const dialog = page.getByRole('dialog')
    const before = await dialog.getByRole('main').getByText('MEMORY_OK Alice', { exact: true }).count()
    await page.locator('main').evaluate(main => { const reply = document.createElement('p'); reply.textContent = 'MEMORY_OK Alice'; main.append(reply) })
    const inspected = async (timeout: number) => {
      await waitForRecoveredReply(dialog, before, [busyLabel], timeout)
      await page.locator('main').evaluate(main => { main.setAttribute('data-durable-inspected', 'true') })
    }
    await expect(inspected(100)).rejects.toThrow(busyLabel)
    expect(await page.locator('main').getAttribute('data-durable-inspected')).toBeNull()
    await dialog.getByText(busyLabel, { exact: true }).evaluate(element => { element.remove() })
    await inspected(30_000)
    expect(await page.locator('main').getAttribute('data-durable-inspected')).toBe('true')
  } finally { await page.close() }
})
