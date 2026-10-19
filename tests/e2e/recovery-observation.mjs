/** Observe the recovered colleague reply before inspecting durable state. */
import { setTimeout as delay } from 'node:timers/promises'

export async function waitForRecoveredReply(dialog, priorReplyCount, busyLabels, timeout) {
  await dialog.getByRole('main').getByText('MEMORY_OK Alice', { exact: true }).nth(priorReplyCount).waitFor({ timeout })
  await Promise.all(busyLabels.map(label => dialog.getByText(label, { exact: true }).waitFor({ state: 'hidden', timeout })))
}

/** Return one visible-root ARIA snapshot containing every required token within one deadline. */
export async function waitForAriaContent(locator, required, timeout) {
  const deadline = performance.now() + timeout
  const remaining = () => Math.max(1, deadline - performance.now())
  await locator.waitFor({ state: 'visible', timeout: remaining() })
  let missing = required
  while (performance.now() < deadline) {
    let aria
    try { aria = await locator.ariaSnapshot({ timeout: remaining() }) }
    catch (error) {
      if (error.name === 'TimeoutError' && performance.now() >= deadline) break
      throw error
    }
    missing = required.filter(token => !aria.includes(token))
    if (missing.length === 0) return aria
    await delay(Math.max(0, Math.min(50, deadline - performance.now())))
  }
  throw new Error(`ARIA snapshot is missing ${missing.map(token => JSON.stringify(token)).join(', ')}`)
}
