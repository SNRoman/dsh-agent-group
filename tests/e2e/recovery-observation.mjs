/** Observe the recovered colleague reply before inspecting durable state. */
export async function waitForRecoveredReply(dialog, priorReplyCount, busyLabels, timeout) {
  await dialog.getByRole('main').getByText('MEMORY_OK Alice', { exact: true }).nth(priorReplyCount).waitFor({ timeout })
  await Promise.all(busyLabels.map(label => dialog.getByText(label, { exact: true }).waitFor({ state: 'hidden', timeout })))
}
