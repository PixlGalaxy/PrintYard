// "Create filament" / "Save as new filament…" / filament details: name, base (system preset), material type,
// colour, vendor and private/shared (owner or admin). Values come from the caller (a slot's overrides, a preset to copy).
import { FlaskConical, Lock, Users } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../../../api'
import Modal from '../../../components/Modal'
import { inputCls, selectCls } from '../../../components/styles'
import { Button, Field, Segmented } from '../../../components/ui'
import { useAuth } from '../../../context/AuthContext'
import { useToast } from '../../../context/ToastContext'
import { useI18n } from '../../../i18n/I18nContext'
import type { FilamentPreset, FilamentPresetScope, PresetSummary, ProfileBundle } from '../../../types'
import { isCustomPresetId } from '../../../workspace/filamentPresets'
import { invalidateCustomFilaments, shortPresetName } from '../../../workspace/profiles'
import { UNKNOWN_FILAMENT_COLOR } from '../../../workspace/filamentColor'

/** Starting point for a new preset */
export interface PresetDraft {
  /** System preset id, or `custom:<n>` to start from another custom preset */
  basePresetId: string
  values?: Record<string, string>
  name?: string
  filamentType?: string | null
  color?: string | null
  vendor?: string | null
  /** Select the prefilled name when the dialog opens (the user is expected to tweak it) */
  selectName?: boolean
}

const BAD_NAME = /[;"\\]/

export default function FilamentPresetDialog({
  bundle,
  draft,
  preset,
  onClose,
  onSaved,
}: {
  bundle: ProfileBundle
  /** create mode */
  draft?: PresetDraft
  /** edit mode (details only; values are edited in the filament settings) */
  preset?: FilamentPreset
  onClose: () => void
  onSaved?: (p: FilamentPreset) => void
}) {
  const { t } = useI18n()
  const { user } = useAuth()
  const { toast, onError } = useToast()
  // Owner (any new preset is the user's own) or admin may share
  const canShare = !preset || preset.canEdit || user?.role === 'admin'
  const system = bundle.filament.filter((p) => !p.custom)
  const customs = bundle.filament.filter((p) => p.custom)
  const summaryOf = (id: string) => bundle.filament.find((p) => p.id === id)
  const startBase = preset?.inherits ?? draft?.basePresetId ?? (system.find((p) => p.isDefault) ?? system[0])?.id ?? ''
  const startSummary = summaryOf(startBase)
  const [base, setBase] = useState(startBase)
  const [name, setName] = useState(preset?.name ?? draft?.name ?? '')
  const [type, setType] = useState(preset?.filamentType ?? draft?.filamentType ?? startSummary?.filamentType ?? '')
  const [color, setColor] = useState((preset?.color ?? draft?.color ?? startSummary?.color ?? UNKNOWN_FILAMENT_COLOR).toUpperCase())
  const [vendor, setVendor] = useState(preset?.vendor ?? draft?.vendor ?? '')
  const [scope, setScope] = useState<FilamentPresetScope>(preset?.scope ?? 'private')
  const [busy, setBusy] = useState(false)
  const [touched, setTouched] = useState(false)

  const trimmed = name.trim()
  const nameError = !touched ? null : !trimmed ? t('filaments.nameRequired') : BAD_NAME.test(trimmed) ? t('filaments.nameInvalid') : null
  const types = [...new Set([...(bundle.filamentOptions.find((o) => o.key === 'filament_type')?.enumValues?.map((e) => e.value) ?? []), ...bundle.filament.map((p) => p.filamentType ?? '')])].filter(Boolean).sort()

  const pickBase = (id: string) => {
    setBase(id)
    // A new base brings its own type/colour unless the user changed them
    const s = summaryOf(id)
    if (!preset && s) {
      if (s.filamentType) setType(s.filamentType)
      if (s.color) setColor(s.color)
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (!trimmed || BAD_NAME.test(trimmed) || !base) return
    setBusy(true)
    try {
      let saved: FilamentPreset
      if (preset) {
        saved = await api.updateFilamentPreset(preset.id, {
          name: trimmed,
          inherits: base,
          filamentType: type.trim() || null,
          color,
          vendor: vendor.trim() || null,
        })
        if (canShare && scope !== preset.scope) saved = await api.shareFilamentPreset(preset.id, scope)
      } else {
        saved = await api.createFilamentPreset({
          printerModel: bundle.printerModel,
          basePresetId: base,
          name: trimmed,
          filamentType: type.trim() || null,
          color,
          vendor: vendor.trim() || null,
          values: draft?.values ?? {},
          scope,
        })
      }
      invalidateCustomFilaments()
      toast('success', t(preset ? 'filaments.updated' : 'filaments.created', { name: saved.name }))
      onSaved?.(saved)
      onClose()
    } catch (err) {
      onError(err)
      setBusy(false)
    }
  }

  const option = (p: PresetSummary) => (
    <option key={p.id} value={p.id}>
      {shortPresetName(p.name)}
    </option>
  )
  const byType = new Map<string, PresetSummary[]>()
  for (const p of system) byType.set(p.filamentType ?? '—', [...(byType.get(p.filamentType ?? '—') ?? []), p])
  const valueCount = Object.keys(preset?.values ?? draft?.values ?? {}).length

  return (
    <Modal
      size="sm"
      onClose={onClose}
      dismissable={!busy}
      icon={<FlaskConical size={18} />}
      title={preset ? t('filaments.editTitle') : t('filaments.createTitle')}
      subtitle={valueCount ? t('filaments.valueCount', { n: valueCount }) : t('filaments.noValues')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="filament-preset-form" loading={busy}>
            {preset ? t('common.save') : t('filaments.create')}
          </Button>
        </>
      }
    >
      <form id="filament-preset-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field label={t('filaments.name')} error={nameError}>
          {(p) => <input {...p} className={inputCls} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} placeholder={t('filaments.namePlaceholder')} onFocus={draft?.selectName ? (e) => e.currentTarget.select() : undefined} data-autofocus />}
        </Field>
        <Field label={t('filaments.base')} hint={isCustomPresetId(base) ? t('filaments.baseCustomHint') : t('filaments.baseHint')}>
          {(p) => (
            <select {...p} className={selectCls} value={base} onChange={(e) => pickBase(e.target.value)}>
              {[...byType].map(([ty, ps]) => (
                <optgroup key={ty} label={ty}>
                  {ps.map(option)}
                </optgroup>
              ))}
              {!preset && customs.length > 0 && <optgroup label={t('filaments.customGroup')}>{customs.map(option)}</optgroup>}
            </select>
          )}
        </Field>
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field label={t('filaments.type')}>
            {(p) => (
              <>
                <input {...p} className={inputCls} value={type} maxLength={32} list="filament-types" onChange={(e) => setType(e.target.value)} />
                <datalist id="filament-types">
                  {types.map((ty) => (
                    <option key={ty} value={ty} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <Field label={t('filaments.color')}>
            {(p) => (
              <label className="relative flex h-9 w-16 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-line font-mono text-[10px]" style={{ background: color }}>
                <input {...p} type="color" value={color} onChange={(e) => setColor(e.target.value.toUpperCase())} className="absolute inset-0 cursor-pointer opacity-0" />
              </label>
            )}
          </Field>
        </div>
        <Field label={t('filaments.vendor')} optional>
          {(p) => <input {...p} className={inputCls} value={vendor} maxLength={64} onChange={(e) => setVendor(e.target.value)} />}
        </Field>
        {canShare && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">{t('filaments.visibility')}</p>
            <Segmented<FilamentPresetScope>
              label={t('filaments.visibility')}
              value={scope}
              onChange={setScope}
              options={[
                { value: 'private', label: t('filaments.private'), icon: <Lock size={12} /> },
                { value: 'shared', label: t('filaments.shared'), icon: <Users size={12} /> },
              ]}
            />
            <p className="text-xs text-muted">{t(scope === 'shared' ? 'filaments.sharedHint' : 'filaments.privateHint')}</p>
          </div>
        )}
      </form>
    </Modal>
  )
}
