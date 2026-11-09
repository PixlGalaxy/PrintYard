import type { TranslationKey } from '../i18n/translations'
import { BED_SURFACES, DEFAULT_BED_SURFACE, type BedSurface, type Printer } from '../types'

/** i18n label of each Creality bed surface */
export const BED_KEYS: Record<BedSurface, TranslationKey> = {
  'Epoxy Resin Plate': 'workspace.bed.epoxy',
  'Textured PEI Plate': 'workspace.bed.texturedPei',
  'High Temp Plate': 'workspace.bed.smoothPei',
  'Cool Plate': 'workspace.bed.cool',
  'Engineering Plate': 'workspace.bed.engineering',
  'Customized Plate': 'workspace.bed.custom',
}

export const isBedSurface = (v: unknown): v is BedSurface => BED_SURFACES.includes(v as BedSurface)

/** The surfaces the owner has for this printer (admin → Printers), default first-class; falls back to the profile default. */
export function ownedSurfaces(printer: Printer | null | undefined): { list: BedSurface[]; def: BedSurface } {
  const list = printer?.bedSurfaces?.filter(isBedSurface) ?? []
  const safe = list.length ? list : [DEFAULT_BED_SURFACE]
  const def = printer?.defaultBedSurface && safe.includes(printer.defaultBedSurface) ? printer.defaultBedSurface : safe[0]!
  return { list: safe, def }
}
