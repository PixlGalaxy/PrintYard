// Custom filament presets outside the workspace: Account → "My filaments" (scope mine) and Admin → Filaments
// (shared presets, or every user's). Edit values, details, duplicate, delete; admins can share.
import { Copy, FlaskConical, Lock, PencilLine, SlidersHorizontal, Trash2, Users } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../api'
import Card from '../../components/Card'
import ConfirmModal from '../../components/ConfirmModal'
import { Badge, Button, Empty, ErrorState, IconButton, Loading, Segmented } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { useI18n } from '../../i18n/I18nContext'
import type { FilamentPreset, PrinterModel } from '../../types'
import { copyName, useFilamentPresets } from '../../workspace/filamentPresets'
import { invalidateCustomFilaments, shortPresetName, useBundle } from '../../workspace/profiles'
import FilamentPresetDialog, { type PresetDraft } from '../workspace/prepare/FilamentPresetDialog'
import FilamentSettings from '../workspace/prepare/FilamentSettings'

const MODEL: PrinterModel = 'creality-k2se'

export default function FilamentPresetsCard({ admin = false }: { admin?: boolean }) {
  const { t, language, formatDate } = useI18n()
  const { onError, toast } = useToast()
  const [adminScope, setAdminScope] = useState<'shared' | 'everyone'>('shared')
  const scope = admin ? adminScope : 'mine'
  const { data, error, retry } = useFilamentPresets(scope)
  const { bundle } = useBundle(MODEL, language)
  const [values, setValues] = useState<FilamentPreset | null>(null)
  const [details, setDetails] = useState<FilamentPreset | null>(null)
  const [draft, setDraft] = useState<PresetDraft | null>(null)
  const [deleting, setDeleting] = useState<FilamentPreset | null>(null)

  const create = () => {
    const base = bundle?.filament.find((p) => p.isDefault && !p.custom) ?? bundle?.filament.find((p) => !p.custom)
    if (base) setDraft({ basePresetId: base.id, filamentType: base.filamentType ?? null, color: base.color ?? null })
  }
  const toggleShare = async (p: FilamentPreset) => {
    try {
      const saved = await api.shareFilamentPreset(p.id, p.scope === 'shared' ? 'private' : 'shared')
      invalidateCustomFilaments()
      toast('success', t(saved.scope === 'shared' ? 'filaments.nowShared' : 'filaments.nowPrivate', { name: saved.name }))
    } catch (err) {
      onError(err)
    }
  }

  return (
    <Card
      title={admin ? t('filaments.adminTitle') : t('filaments.myTitle')}
      description={admin ? t('filaments.adminDesc') : t('filaments.myDesc')}
      icon={<FlaskConical size={18} />}
      actions={
        <Button variant="primary" size="xs" icon={<FlaskConical size={13} />} disabled={!bundle} onClick={create}>
          {t('filaments.createFilament')}
        </Button>
      }
    >
      {admin && (
        <Segmented<'shared' | 'everyone'>
          label={t('filaments.adminScope')}
          value={adminScope}
          onChange={setAdminScope}
          options={[
            { value: 'shared', label: t('filaments.scopeShared') },
            { value: 'everyone', label: t('filaments.scopeEveryone') },
          ]}
        />
      )}
      {error && !data ? (
        <ErrorState error={error} onRetry={retry} />
      ) : !data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty icon={<FlaskConical size={20} />}>{admin && adminScope === 'shared' ? t('filaments.emptyShared') : t('filaments.empty')}</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {data.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <span className="size-6 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/15" style={{ background: p.color ?? 'transparent' }} />
              <div className="min-w-40 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                  <span className="truncate">{p.name}</span>
                  {p.filamentType && <Badge>{p.filamentType}</Badge>}
                  {p.scope === 'shared' ? (
                    <Badge tone="sky">
                      <Users size={11} /> {t('filaments.shared')}
                    </Badge>
                  ) : (
                    <Badge>
                      <Lock size={11} /> {t('filaments.private')}
                    </Badge>
                  )}
                  {!p.canEdit && <Badge tone="amber">{t('filaments.readOnly')}</Badge>}
                </p>
                {!p.canEdit && p.scope === 'shared' && <p className="text-xs text-muted">{t('filaments.sharedReadOnlyHint')}</p>}
                <p className="truncate text-xs text-muted">
                  {t('filaments.basedOn', { name: shortPresetName(p.inherits) })} · {t('filaments.valueCount', { n: Object.keys(p.values).length })}
                  {admin && ` · ${p.ownerName}`} · {formatDate(p.updatedAt)}
                </p>
              </div>
              <div className="flex items-center gap-0.5">
                {p.canEdit && (
                  <IconButton label={t('filaments.editValues')} title={t('filaments.editValues')} disabled={!bundle} onClick={() => setValues(p)}>
                    <SlidersHorizontal size={16} />
                  </IconButton>
                )}
                {p.canEdit && (
                  <IconButton label={t('filaments.details')} title={t('filaments.details')} disabled={!bundle} onClick={() => setDetails(p)}>
                    <PencilLine size={16} />
                  </IconButton>
                )}
                <IconButton
                  label={t(p.canEdit ? 'filaments.duplicate' : 'filaments.duplicateToEdit')}
                  title={t(p.canEdit ? 'filaments.duplicate' : 'filaments.duplicateToEdit')}
                  disabled={!bundle}
                  onClick={() => setDraft({ basePresetId: p.presetId, name: copyName(p.name, t('filaments.copySuffix')) })}
                >
                  <Copy size={16} />
                </IconButton>
                {admin && (
                  <IconButton label={t(p.scope === 'shared' ? 'filaments.unshare' : 'filaments.share')} title={t(p.scope === 'shared' ? 'filaments.unshare' : 'filaments.share')} onClick={() => toggleShare(p)}>
                    {p.scope === 'shared' ? <Lock size={16} /> : <Users size={16} />}
                  </IconButton>
                )}
                {p.canEdit && (
                  <IconButton label={t('common.delete')} title={t('common.delete')} tone="danger" onClick={() => setDeleting(p)}>
                    <Trash2 size={16} />
                  </IconButton>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {values && bundle && <FilamentSettings bundle={bundle} preset={values} onClose={() => setValues(null)} />}
      {details && bundle && <FilamentPresetDialog bundle={bundle} preset={details} onClose={() => setDetails(null)} />}
      {draft && bundle && <FilamentPresetDialog bundle={bundle} draft={draft} onClose={() => setDraft(null)} />}
      {deleting && (
        <ConfirmModal
          title={t('filaments.deleteTitle')}
          confirmLabel={t('common.delete')}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await api.deleteFilamentPreset(deleting.id)
              invalidateCustomFilaments()
            } catch (err) {
              onError(err)
              throw err
            }
          }}
        >
          {t('filaments.deleteBody', { name: deleting.name })}
        </ConfirmModal>
      )}
    </Card>
  )
}
