// Profiles tab → Filament: "Loaded now", the spools the printer reports right now (external holder and CFS slots,
// from PrinterStatus.cfs, no extra request to the printer). "Save as my filament" opens the create dialog with the
// matched system preset, the spool's colour and the printer's saved values for it (range, clamped temperatures,
// pressure advance), so the user keeps that exact spool as a profile.
import { Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../../api'
import { Button } from '../../../components/ui'
import { useLoader } from '../../../hooks'
import { useI18n } from '../../../i18n/I18nContext'
import { usePrinterStatus } from '../../../realtime'
import type { CfsSlot, FilamentPreset, PresetSummary, ProfileBundle } from '../../../types'
import { UNKNOWN_FILAMENT_COLOR } from '../../../workspace/filamentColor'
import { cfsName, loadedSpools, presetForSpool, printerOverrides, spoolFingerprint, spoolLabel, spoolName } from '../../../workspace/printerFilaments'
import { loadPreset, shortPresetName } from '../../../workspace/profiles'
import type { PresetDraft } from '../prepare/FilamentPresetDialog'
import Group from './ProfileGroup'

interface Loaded {
  spool: CfsSlot
  /** System preset the profile would be based on (a matched custom preset → its parent) */
  base: PresetSummary | undefined
  draft: PresetDraft | null
}

const sameValues = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k])
}

export default function LoadedNow({
  bundle,
  mine,
  onSave,
  onShow,
}: {
  bundle: ProfileBundle
  /** The user's own filaments (for "Saved as …") */
  mine: FilamentPreset[]
  onSave: (draft: PresetDraft) => void
  onShow: (presetId: string) => void
}) {
  const { t } = useI18n()
  const { data: printers } = useLoader(api.printers)
  const printerId = printers?.[0]?.id ?? null
  const status = usePrinterStatus(printerId)
  const spools = status?.online ? loadedSpools(status.cfs) : []
  const key = spools.map((c) => `${c.box}-${c.slot}=${spoolFingerprint(c)}`).join(';')
  const [rows, setRows] = useState<Loaded[]>([])

  useEffect(() => {
    let alive = true
    const allowed = new Set(bundle.filamentOptions.map((o) => o.key))
    const system = bundle.filament.filter((p) => !p.custom)
    void Promise.all(
      spools.map(async (spool): Promise<Loaded> => {
        const matched = presetForSpool(bundle.filament, spool)
        const base = matched?.custom ? system.find((p) => p.id === matched.inherits) : matched
        if (!base) return { spool, base, draft: null }
        let values: Record<string, string> = {}
        try {
          values = printerOverrides(spool, (await loadPreset(bundle.printerModel, 'filament', base.id)).values, allowed)
        } catch {
          // preset values unavailable: colour and name only
        }
        return {
          spool,
          base,
          draft: {
            basePresetId: base.id,
            name: `${spoolName(spool)} · ${cfsName(spool)}`,
            values,
            color: spool.color?.toUpperCase() ?? base.color ?? null,
            filamentType: spool.type || base.filamentType || null,
            vendor: spool.vendor || null,
            selectName: true,
          },
        }
      }),
    ).then((r) => alive && setRows(r))
    return () => {
      alive = false
    }
    // only when the printer's spools (or the preset list) change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, bundle])

  if (!printerId) return null
  const shown = spools.length ? rows.filter((r) => spools.some((s) => s.box === r.spool.box && s.slot === r.spool.slot)) : []
  const savedAs = (d: PresetDraft | null) =>
    d ? mine.find((p) => p.inherits === d.basePresetId && (p.color ?? '').toUpperCase() === (d.color ?? '').toUpperCase() && sameValues(p.values, d.values ?? {})) : undefined

  return (
    <Group title={t('loadedNow.group')} count={shown.length}>
      {!status?.online ? (
        <li className="px-3 py-2 text-[11px] text-muted">{t('loadedNow.offline')}</li>
      ) : !spools.length ? (
        <li className="px-3 py-2 text-[11px] text-muted">{t('loadedNow.empty')}</li>
      ) : (
        shown.map(({ spool, base, draft }) => {
          const saved = savedAs(draft)
          const range = spool.minTemp != null && spool.maxTemp != null ? `${spool.minTemp}–${spool.maxTemp} °C` : null
          const pa = spool.pressureAdvance != null ? t('loadedNow.pa', { pa: spool.pressureAdvance }) : null
          return (
            <li key={`${spool.box}-${spool.slot}`} className="flex items-start gap-2 px-3 py-2">
              <span className="mt-0.5 inline-flex h-5 w-8 shrink-0 items-center justify-center rounded bg-surface-2 font-mono text-[10px] font-semibold text-muted" title={spoolLabel(spool, t)}>
                {cfsName(spool)}
              </span>
              <div className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 shrink-0 rounded-full ring-1 ring-black/20 dark:ring-white/20" style={{ background: spool.color ?? UNKNOWN_FILAMENT_COLOR }} title={spool.color ?? undefined} />
                  <span className="truncate text-sm font-medium">{spoolName(spool)}</span>
                </span>
                <span className="block truncate text-[11px] text-muted">{[range, pa].filter(Boolean).join(' · ')}</span>
                <span className="block truncate text-[11px] text-muted">
                  {base ? t('loadedNow.preset', { name: shortPresetName(base.name) }) : t('loadedNow.noPreset')}
                </span>
                {saved && (
                  <button type="button" onClick={() => onShow(saved.presetId)} className="block max-w-full truncate text-left text-[11px] font-medium text-emerald-600 hover:underline dark:text-emerald-400">
                    {t('loadedNow.savedAs', { name: saved.name })}
                  </button>
                )}
              </div>
              <Button size="xs" icon={<Save size={13} />} disabled={!draft} onClick={() => draft && onSave(draft)}>
                {t('loadedNow.save')}
              </Button>
            </li>
          )
        })
      )}
    </Group>
  )
}
