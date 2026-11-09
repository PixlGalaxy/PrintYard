/** "3h 12m", "12m 5s", "45s" */
export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—'
  const s = Math.max(0, Math.round(sec))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s % 60}s`
  return `${s}s`
}

/** Grams from the slicer summary, or estimated from mm (PLA density) */
export function totalGrams(grams: number[], mm: number[], density = 1.24): number | null {
  if (grams.length) return grams.reduce((a, b) => a + b, 0)
  if (mm.length) return (mm.reduce((a, b) => a + b, 0) * Math.PI * 0.875 * 0.875 * density) / 1000
  return null
}
