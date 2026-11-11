// G-code provenance (sliced by SliceDock vs uploaded), scan result and "declared vs measured" grams.
import { BadgeCheck, FileUp, ShieldAlert } from 'lucide-react'
import { Badge } from '../../components/ui'
import { useI18n } from '../../i18n/I18nContext'
import type { LibraryFile } from '../../types'

const sum = (a: number[] | undefined) => (a ?? []).reduce((x, y) => x + (Number(y) || 0), 0)

/** Declared (file comments) and computed (server, from the moves) grams when they differ noticeably, else null. */
function gramsMismatch(f: LibraryFile): { declared: number; computed: number } | null {
  const g = f.meta.gcode
  if (!g || f.meta.trusted || g.estimateSource !== 'computed' || !g.declared) return null
  const declared = sum(g.declared.filamentGrams)
  const computed = sum(g.filamentGrams)
  if (declared <= 0 && computed <= 0) return null
  return Math.abs(declared - computed) > Math.max(1, 0.05 * Math.max(declared, computed)) ? { declared, computed } : null
}

export function GcodeBadges({ file }: { file: LibraryFile }) {
  const { t, formatNumber } = useI18n()
  if (file.kind !== 'gcode') return null
  const trusted = file.meta.trusted === true
  const scan = file.meta.gcode?.scan
  const mismatch = gramsMismatch(file)
  const g = (v: number) => `${formatNumber(v, { maximumFractionDigits: 1 })} g`
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span title={t(trusted ? 'library.gcode.slicedHint' : 'library.gcode.uploadedHint')}>
        <Badge tone={trusted ? 'emerald' : 'zinc'}>
          {trusted ? <BadgeCheck size={12} /> : <FileUp size={12} />}
          {t(trusted ? 'library.gcode.sliced' : 'library.gcode.uploaded')}
        </Badge>
      </span>
      {!trusted && scan && !scan.ok && (
        <span title={t('library.gcode.blockedHint', { n: formatNumber(scan.total) })}>
          <Badge tone="red">
            <ShieldAlert size={12} />
            {t('library.gcode.blocked')}
          </Badge>
        </span>
      )}
      {mismatch && (
        <span title={t('library.gcode.declaredHint')}>
          <Badge tone="amber">{t('library.gcode.declared', { declared: g(mismatch.declared), computed: g(mismatch.computed) })}</Badge>
        </span>
      )}
    </span>
  )
}
