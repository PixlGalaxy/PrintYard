// Profiles tab → Filament: "Show printer filaments" (per-user, off by default) and, when on, the printer's own filament
// list as a read-only group. Each one maps to a PrintYard system preset; settings that differ get a "Differs" badge
// (details on click) and "Duplicate as my filament" opens the create dialog with the printer's values.
import { Copy, Printer, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import Modal from '../../../components/Modal'
import { Badge, Button, IconButton, Toggle } from '../../../components/ui'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { timeAgo } from '../../../format'
import { isTranslationKey } from '../../../i18n/translations'
import { useI18n } from '../../../i18n/I18nContext'
import type { PrinterMaterial, ProfileBundle } from '../../../types'
import { UNKNOWN_FILAMENT_COLOR } from '../../../workspace/filamentColor'
import { draftFromMaterial, usePrinterMaterials } from '../../../workspace/printerMaterials'
import { shortPresetName } from '../../../workspace/profiles'
import type { PresetDraft } from '../prepare/FilamentPresetDialog'
import Group from './ProfileGroup'

const temps = (m: PrinterMaterial) => (m.minTemp != null && m.maxTemp != null ? `${m.minTemp}–${m.maxTemp} °C` : null)

export default function PrinterFilaments({ bundle, onDuplicate }: { bundle: ProfileBundle; onDuplicate: (draft: PresetDraft) => void }) {
  const { t } = useI18n()
  const { updateAccount } = useAuth()
  const { onError } = useToast()
  const { enabled, view, materials, error, loading, refresh } = usePrinterMaterials()
  const [details, setDetails] = useState<PrinterMaterial | null>(null)
  const [saving, setSaving] = useState(false)

  const toggle = async (on: boolean) => {
    setSaving(true)
    try {
      await updateAccount({ showPrinterFilaments: on })
    } catch (err) {
      onError(err)
    } finally {
      setSaving(false)
    }
  }
  const duplicate = (m: PrinterMaterial) => {
    const draft = draftFromMaterial(m, t('printerFilaments.copyName', { name: m.name }))
    if (draft) onDuplicate(draft)
  }
  const errorKey = view?.error ? `errors.${view.error}` : null

  return (
    <>
      <div className="flex items-start gap-3 border-b border-line/70 px-3 py-2.5">
        <Printer size={15} className="mt-0.5 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">{t('printerFilaments.toggle')}</p>
          <p className="text-[11px] text-muted">{t('printerFilaments.toggleHint')}</p>
        </div>
        <Toggle checked={enabled} disabled={saving} onChange={(v) => void toggle(v)} label={t('printerFilaments.toggle')} />
      </div>
      {enabled && (
        <Group
          title={t('printerFilaments.group')}
          count={materials.length}
          action={
            <IconButton label={t('printerFilaments.refresh')} className="ml-auto size-6!" disabled={loading || !view?.online} onClick={() => void refresh()}>
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </IconButton>
          }
        >
          {(!view?.online || errorKey || error != null || (view && !materials.length)) && (
            <li className="px-3 py-2 text-[11px] text-muted">
              {error != null
                ? t('printerFilaments.noAnswer')
                : !view
                  ? t('common.loading')
                  : !view.online
                    ? t(view.fetchedAt ? 'printerFilaments.offlineCached' : 'printerFilaments.offline')
                    : errorKey && isTranslationKey(errorKey)
                      ? t(errorKey)
                      : !materials.length
                        ? t('printerFilaments.empty')
                        : null}
            </li>
          )}
          {materials.map((m) => (
            <li key={m.id} className="group/row relative flex items-start gap-2 px-3 py-2 transition-colors hover:bg-surface-2/60">
              <span className="w-3.5 shrink-0" />
              <button type="button" onClick={() => setDetails(m)} className="min-w-0 flex-1 text-left">
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 shrink-0 rounded-full ring-1 ring-black/20 dark:ring-white/20" style={{ background: m.color ?? UNKNOWN_FILAMENT_COLOR }} />
                  <span className="truncate text-sm font-medium">{m.name}</span>
                  {m.differs.length > 0 && <Badge tone="amber">{t('printerFilaments.differs')}</Badge>}
                  {!m.systemPresetId && <Badge>{t('printerFilaments.noMatch')}</Badge>}
                </span>
                <span className="block truncate text-[11px] text-muted">{[m.brand, m.type, temps(m)].filter(Boolean).join(' · ')}</span>
              </button>
              <IconButton label={t('printerFilaments.duplicate')} className="size-7!" disabled={!m.systemPresetId} onClick={() => duplicate(m)}>
                <Copy size={14} />
              </IconButton>
            </li>
          ))}
          {view?.fetchedAt != null && materials.length > 0 && <li className="px-3 py-1.5 text-[10px] text-muted">{t('printerFilaments.readAt', { when: timeAgo(t, view.fetchedAt) })}</li>}
        </Group>
      )}
      {details && <MaterialDialog material={details} bundle={bundle} onClose={() => setDetails(null)} onDuplicate={() => duplicate(details)} />}
    </>
  )
}

function MaterialDialog({ material: m, bundle, onClose, onDuplicate }: { material: PrinterMaterial; bundle: ProfileBundle; onClose: () => void; onDuplicate: () => void }) {
  const { t } = useI18n()
  const label = (key: string) => bundle.filamentOptions.find((o) => o.key === key)?.label ?? key
  return (
    <Modal
      size="md"
      onClose={onClose}
      icon={<span className="size-full rounded-[inherit] ring-1 ring-black/15 ring-inset" style={{ background: m.color ?? UNKNOWN_FILAMENT_COLOR }} />}
      title={t('printerFilaments.detailsTitle', { name: m.name })}
      subtitle={[m.brand, m.type, temps(m)].filter(Boolean).join(' · ')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button
            variant="primary"
            icon={<Copy size={14} />}
            disabled={!m.systemPresetId}
            onClick={() => {
              onDuplicate()
              onClose()
            }}
          >
            {t('printerFilaments.duplicate')}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-xs text-muted">{t('printerFilaments.readOnly')}</p>
        <p>
          {m.systemPresetId ? t('printerFilaments.mappedTo', { name: shortPresetName(m.systemPresetId) }) : t('printerFilaments.noMatch')}
        </p>
        {m.colors.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">{t('printerFilaments.colors')}</p>
            <div className="flex flex-wrap gap-1.5">
              {m.colors.map((c) => (
                <span key={c} title={c} className="size-5 rounded-full ring-1 ring-black/20 dark:ring-white/20" style={{ background: c }} />
              ))}
            </div>
          </div>
        )}
        {m.differs.length ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">{t('printerFilaments.differsHint', { n: m.differs.length })}</p>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-xs">
                <thead className="bg-surface-2 text-left text-muted">
                  <tr>
                    <th className="px-2.5 py-1.5 font-medium">{t('printerFilaments.diffSetting')}</th>
                    <th className="px-2.5 py-1.5 font-medium">{t('printerFilaments.diffPrinter')}</th>
                    <th className="px-2.5 py-1.5 font-medium">{t('printerFilaments.diffPrintYard')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/70">
                  {m.differs.map((d) => (
                    <tr key={d.key}>
                      <td className="px-2.5 py-1.5">
                        <span className="block">{label(d.key)}</span>
                        <span className="font-mono text-[10px] text-muted">{d.key}</span>
                        {!d.kept && <span className="block text-[10px] text-amber-600 dark:text-amber-400">{t('printerFilaments.notKept')}</span>}
                      </td>
                      <td className="px-2.5 py-1.5 font-mono break-all">{d.printer}</td>
                      <td className="px-2.5 py-1.5 font-mono break-all text-muted">{d.printyard ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          m.systemPresetId && <p className="text-xs text-emerald-600 dark:text-emerald-400">{t('printerFilaments.same')}</p>
        )}
      </div>
    </Modal>
  )
}
