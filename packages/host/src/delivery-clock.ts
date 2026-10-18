/** Clock readings for the current delivery, independent of historical event dates. */

/** @param now One sampled instant. @param timeZone Local IANA time zone. @returns The same instant in UTC and local time, including its date-specific offset. */
export function formatDeliveryClock(now: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, calendar: 'iso8601', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  })
  const parts = formatter.formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(value => value.type === type)!.value
  const offset = part('timeZoneName').replace(/^GMT/u, '').replace(/^\+00:00$/u, '') || 'Z'
  const dateTime = `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}.${String(now.getUTCMilliseconds()).padStart(3, '0')}${offset}`
  return { currentTimeUtc: now.toISOString(), currentTimeLocal: { timeZone: formatter.resolvedOptions().timeZone, dateTime } }
}
