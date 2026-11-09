import type { UsageSummary } from '../../../types'

/** Checks the user's limits locally so problems show before sending (the server re-checks). */
export function limitProblems(usage: UsageSummary | null, grams: number | null, seconds: number | null) {
  const out: { key: 'perPrint' | 'month' | 'hours'; limit: number }[] = []
  const l = usage?.limits
  if (!l?.enabled) return out
  if (l.maxGramsPerPrint != null && grams != null && grams > l.maxGramsPerPrint) out.push({ key: 'perPrint', limit: l.maxGramsPerPrint })
  if (l.maxGramsPerMonth != null && grams != null && usage!.monthGrams + grams > l.maxGramsPerMonth) out.push({ key: 'month', limit: l.maxGramsPerMonth })
  if (l.maxHoursPerPrint != null && seconds != null && seconds / 3600 > l.maxHoursPerPrint) out.push({ key: 'hours', limit: l.maxHoursPerPrint })
  return out
}
