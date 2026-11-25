// Trial-window arithmetic for DEMO accounts.
//
// `Account.trialStartsAt` / `trialEndsAt` are `@db.Date` — CALENDAR DAYS, not instants. Prisma
// hands a `@db.Date` back as a Date pinned to UTC MIDNIGHT of that civil day, so the stored day is
// read off the UTC parts and NEVER off the local ones (in UTC-5, `getDate()` on a UTC-midnight
// value is the PREVIOUS day: that is the off-by-one the column type exists to avoid).
//
// "Today", by contrast, is a civil day in the READER's own zone: at 02:00 in UTC+4 the user's today
// is already tomorrow in UTC. So the two sides are read differently ON PURPOSE — the stored value
// by its UTC parts, "now" by its local parts — and both are then projected onto UTC midnight, which
// is what makes the subtraction DST-proof: UTC days are all exactly 86400s, so no spring-forward
// day can shorten the difference.

/** A stored `@db.Date` value, normalized to UTC midnight of the civil day it denotes. */
export function toTrialDate(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The caller's own civil today, as the UTC-midnight value a `@db.Date` column stores. */
export function todayTrialDate(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

const DAY_MS = 86_400_000;

/**
 * Whole CALENDAR days from `today` to `trialEndsAt`: 0 on the last day of the trial, 1 the day
 * before, NEGATIVE once it has expired. `trialEndsAt` is read as a stored `@db.Date` (UTC parts),
 * `today` as a wall-clock instant in the reader's zone (local parts).
 */
export function trialDaysLeft(trialEndsAt: Date, today: Date = new Date()): number {
  return Math.round((toTrialDate(trialEndsAt).getTime() - todayTrialDate(today).getTime()) / DAY_MS);
}

/** The UI's default trial length, in days, as agreed with the owner. */
export const DEFAULT_TRIAL_DAYS = 90;
