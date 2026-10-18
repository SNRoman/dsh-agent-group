import { expect, test } from 'vitest'
import { formatDeliveryClock } from '../packages/host/src/delivery-clock.ts'

test.each([
  ['2026-10-17T16:30:00.123Z', 'Asia/Shanghai', '2026-10-18T00:30:00.123+08:00'],
  ['2026-01-15T17:00:00.000Z', 'America/New_York', '2026-01-15T12:00:00.000-05:00'],
  ['2026-07-15T17:00:00.000Z', 'America/New_York', '2026-07-15T13:00:00.000-04:00'],
  ['2026-10-17T16:30:00.123Z', 'UTC', '2026-10-17T16:30:00.123Z'],
])('keeps UTC and the local clock at the same instant: %s in %s', (utc, timeZone, local) => {
  const clock = formatDeliveryClock(new Date(utc), timeZone)
  expect(clock).toEqual({ currentTimeUtc: utc, currentTimeLocal: { timeZone, dateTime: local } })
  expect(Date.parse(clock.currentTimeLocal.dateTime)).toBe(Date.parse(utc))
})
