/* Decides every recipient's individual send time UP FRONT, the moment a campaign
   is scheduled — not later. Two rules shape the schedule:

     1. Pace  — one send every `intervalSeconds`, so a list trickles out instead
        of blasting all at once.
     2. Daily cap — no more than `dailyLimit` sends land on the same UTC day for
        an account; once a day fills up, the remainder rolls to the next day.

   Pure + deterministic (no I/O, no Date.now inside) so it's easy to unit-test:
   pass `startAt` in explicitly. */

const UNIT_SECONDS = {
  second: 1,
  seconds: 1,
  minute: 60,
  minutes: 60,
  hour: 3600,
  hours: 3600,
  day: 86400,
  days: 86400,
}

/* Turn a campaign `frequency` ({ count, every, unit }) into seconds between
   individual sends. "1 every 2 minutes" → 120s; "5 every 1 minute" → 12s.
   Falls back to one per minute. */
export function frequencyToIntervalSeconds(frequency = {}) {
  const count = Number(frequency.count) > 0 ? Number(frequency.count) : 1
  const every = Number(frequency.every) > 0 ? Number(frequency.every) : 1
  const unitSec = UNIT_SECONDS[String(frequency.unit || 'minutes').toLowerCase()] ?? 60
  return Math.max(1, Math.round((every * unitSec) / count))
}

function utcDayKey(date) {
  return date.toISOString().slice(0, 10) // YYYY-MM-DD
}

function nextUtcMidnight(date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0)
  )
}

/* Compute `count` send times. Returns an array of Date objects, ascending.
   Example: count=50, intervalSeconds=60, startAt=now
     → [now, now+1m, now+2m, …, now+49m]  (all on the same day if under the cap)

   `floors` (optional): a per-index earliest-allowed time, parallel to the
   recipient list — e.g. "this recipient's follow-up can't go out before their
   own initial send + 3 days". When given, the pacing cursor is nudged FORWARD
   (never back) to meet it before the day-cap check runs, so a later step gets
   the same pacing/day-cap behaviour as step zero, just not before its floor.
   Omitted entirely, this is 100% unchanged from the original single-step
   behaviour — every existing caller keeps working exactly as before. */
export function computeSendTimes(count, { startAt, intervalSeconds = 60, dailyLimit = 400, floors } = {}) {
  const times = []
  if (count <= 0) return times

  const start = startAt instanceof Date ? new Date(startAt.getTime()) : new Date(startAt)
  const step = Math.max(1, intervalSeconds) * 1000
  const cap = Number(dailyLimit) > 0 ? Number(dailyLimit) : Infinity

  let cursor = start
  let dayKey = utcDayKey(cursor)
  let dayCount = 0

  for (let i = 0; i < count; i++) {
    if (i > 0) cursor = new Date(cursor.getTime() + step)

    if (floors && floors[i] != null) {
      const floor = floors[i] instanceof Date ? floors[i] : new Date(floors[i])
      if (floor.getTime() > cursor.getTime()) cursor = new Date(floor.getTime())
    }

    // Natural rollover into a new calendar day resets the daily counter.
    const key = utcDayKey(cursor)
    if (key !== dayKey) {
      dayKey = key
      dayCount = 0
    }

    // Day is full → jump to the start of the next UTC day and continue pacing.
    if (dayCount >= cap) {
      cursor = nextUtcMidnight(cursor)
      dayKey = utcDayKey(cursor)
      dayCount = 0
    }

    times.push(new Date(cursor.getTime()))
    dayCount++
  }

  return times
}
