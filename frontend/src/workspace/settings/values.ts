// Value helpers shared by the process and filament settings panels.
import type { OptionDef } from '../../types'

/** Canonical form for comparisons: "15.0%" → "15%", "0.20" → "0.2", quotes stripped. */
export const norm = (v: string | undefined) => {
  if (v === undefined) return ''
  const s = v.trim().replace(/^"(.*)"$/, '$1')
  const n = Number(s.replace(/%$/, ''))
  return s !== '' && Number.isFinite(n) ? `${n}${s.endsWith('%') ? '%' : ''}` : s
}
export const same = (a: string | undefined, b: string | undefined) => norm(a) === norm(b)

/** Value shown to the user (enum label, quotes stripped). */
export function display(def: OptionDef, v: string | undefined) {
  if (v === undefined) return ''
  const s = v.replace(/^"(.*)"$/, '$1')
  return def.enumValues?.find((e) => e.value === s)?.label ?? s
}

/** Units worth showing next to a field (Creality's "[[mm,mm,mm/s]]" table hints are dropped). */
export const unitOf = (def: OptionDef) => (def.unit && !def.unit.startsWith('[') ? def.unit : undefined)

export const matches = (o: OptionDef, q: string) =>
  o.label.toLowerCase().includes(q) || o.key.includes(q.replace(/\s+/g, '_')) || (o.tooltip ?? '').toLowerCase().includes(q) || o.group.toLowerCase().includes(q)

/** Options grouped by page + group, in list order. */
export function groupOptions(options: OptionDef[]) {
  const groups = new Map<string, { page: string; group: string; opts: OptionDef[] }>()
  for (const o of options) {
    const k = `${o.page}\u0000${o.group}`
    let g = groups.get(k)
    if (!g) groups.set(k, (g = { page: o.page, group: o.group, opts: [] }))
    g.opts.push(o)
  }
  return [...groups.values()]
}
