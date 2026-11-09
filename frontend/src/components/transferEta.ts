// Shared with <TransferStats/> callers (kept out of the component file for fast refresh).
/** Seconds left from bytes and a speed (null when unknown). */
export function etaOf(total: number, loaded: number, speed: number | undefined): number | null {
  if (!speed || speed <= 0) return null
  return Math.max(0, (total - loaded) / speed)
}
