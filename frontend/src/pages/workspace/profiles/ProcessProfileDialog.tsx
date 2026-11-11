// New / duplicate / rename a process profile: name and (new) the system preset it is based on.
import { SlidersHorizontal } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../../../api'
import Modal from '../../../components/Modal'
import { inputCls, selectCls } from '../../../components/styles'
import { Button, Field } from '../../../components/ui'
import { useToast } from '../../../context/ToastContext'
import { useI18n } from '../../../i18n/I18nContext'
import type { ProcessProfile, ProfileBundle } from '../../../types'
import { invalidateCustomFilaments, shortPresetName } from '../../../workspace/profiles'

const BAD_NAME = /[;"\\/]/

export type ProcessDialogMode =
  | { mode: 'create'; basePresetId?: string; name?: string }
  /** copy of a profile (own or shared by another user) */
  | { mode: 'duplicate'; basePresetId: string; name: string }
  | { mode: 'rename'; profile: ProcessProfile }

export default function ProcessProfileDialog({
  bundle,
  state,
  onClose,
  onSaved,
}: {
  bundle: ProfileBundle
  state: ProcessDialogMode
  onClose: () => void
  onSaved: (p: ProcessProfile) => void
}) {
  const { t } = useI18n()
  const { toast, onError } = useToast()
  const system = bundle.process.filter((p) => !p.custom)
  const [name, setName] = useState(state.mode === 'rename' ? state.profile.name : (state.name ?? ''))
  const [base, setBase] = useState(state.mode === 'create' ? (state.basePresetId ?? (system.find((p) => p.isDefault) ?? system[0])?.id ?? '') : '')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const trimmed = name.trim()
  const nameError = !touched ? null : !trimmed ? t('filaments.nameRequired') : BAD_NAME.test(trimmed) ? t('profiles.nameInvalid') : null

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (!trimmed || BAD_NAME.test(trimmed)) return
    setBusy(true)
    try {
      const saved =
        state.mode === 'rename'
          ? await api.updateProcessProfile(state.profile.id, { name: trimmed })
          : await api.createProcessProfile({ printerModel: bundle.printerModel, basePresetId: state.mode === 'create' ? base : state.basePresetId, name: trimmed })
      invalidateCustomFilaments()
      toast('success', t(state.mode === 'rename' ? 'profiles.saved' : 'profiles.created', { name: saved.name }))
      onSaved(saved)
      onClose()
    } catch (err) {
      onError(err)
      setBusy(false)
    }
  }

  const title = state.mode === 'rename' ? t('profiles.renameTitle') : state.mode === 'duplicate' ? t('profiles.duplicateTitle') : t('profiles.newProcessTitle')
  return (
    <Modal
      size="sm"
      onClose={onClose}
      dismissable={!busy}
      icon={<SlidersHorizontal size={18} />}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="process-profile-form" loading={busy}>
            {state.mode === 'rename' ? t('common.save') : t('filaments.create')}
          </Button>
        </>
      }
    >
      <form id="process-profile-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field label={t('filaments.name')} error={nameError}>
          {(p) => <input {...p} className={inputCls} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} placeholder={t('profiles.namePlaceholder')} data-autofocus />}
        </Field>
        {state.mode === 'create' && (
          <Field label={t('profiles.parent')} hint={t('profiles.parentHint')}>
            {(p) => (
              <select {...p} className={selectCls} value={base} onChange={(e) => setBase(e.target.value)}>
                {system.map((s) => (
                  <option key={s.id} value={s.id}>
                    {shortPresetName(s.name)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
      </form>
    </Modal>
  )
}
