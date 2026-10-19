import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { waitForAriaContent, waitForRecoveredReply } from './e2e/recovery-observation.mjs'

let browser: Browser
beforeAll(async () => { browser = await chromium.launch() })
afterAll(async () => { await browser?.close() })

test('ARIA capture waits until all required content occurs in the same real snapshot', async () => {
  const page = await browser.newPage()
  const releaseFirst = Promise.withResolvers<void>()
  const releaseSecond = Promise.withResolvers<void>()
  let pending: Promise<unknown> | undefined
  try {
    await page.setContent('<div role="dialog"><h2>Recovered organization</h2><main></main></div>')
    const dialog = page.getByRole('dialog')
    const first = Promise.withResolvers<string>()
    const second = Promise.withResolvers<string>()
    let count = 0
    const observed = {
      waitFor: (options: Parameters<typeof dialog.waitFor>[0]) => dialog.waitFor(options),
      ariaSnapshot: async (options: Parameters<typeof dialog.ariaSnapshot>[0]) => {
        const aria = await dialog.ariaSnapshot(options)
        count += 1
        if (count === 1) { first.resolve(aria); await releaseFirst.promise }
        if (count === 2) { second.resolve(aria); await releaseSecond.promise }
        return aria
      },
    }
    const captured = waitForAriaContent(observed, ['Recovered organization', 'MEMORY_OK Alice'], 5_000)
    const outcome = captured.then(snapshot => ({ snapshot }), error => ({ error }))
    pending = outcome
    expect(await first.promise).not.toContain('MEMORY_OK Alice')
    await dialog.evaluate(root => { root.querySelector('h2')!.remove(); root.querySelector('main')!.textContent = 'MEMORY_OK Alice' })
    releaseFirst.resolve()
    const middle = await Promise.race([second.promise, outcome.then(result => {
      if ('error' in result) throw result.error
      throw new Error('ARIA capture completed without simultaneous required content')
    })])
    expect(middle).toContain('MEMORY_OK Alice')
    expect(middle).not.toContain('Recovered organization')
    await dialog.evaluate(root => { const heading = document.createElement('h2'); heading.textContent = 'Recovered organization'; root.prepend(heading) })
    releaseSecond.resolve()
    const final = await captured
    expect(final).toContain('Recovered organization')
    expect(final).toContain('MEMORY_OK Alice')
    expect(final).toBe(await dialog.ariaSnapshot())
  } finally { releaseFirst.resolve(); releaseSecond.resolve(); await page.close(); await pending }
})

test('ARIA capture reports every still-missing token when its deadline expires', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent('<div role="dialog"><h2>Recovered organization</h2><p hidden>MEMORY_OK Alice</p></div>')
    await expect(waitForAriaContent(page.getByRole('dialog'), ['Recovered organization', 'MEMORY_OK Alice', 'never rendered'], 100)).rejects.toThrow('ARIA snapshot is missing "MEMORY_OK Alice", "never rendered"')
  } finally { await page.close() }
})

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
