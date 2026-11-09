import { useCallback, useState } from 'react'
import { adminApi } from '../../api'
import { useToast } from '../../context/ToastContext'
import { useLoader } from '../../hooks'
import { useI18n } from '../../i18n/I18nContext'
import type { Settings } from '../../types'

/** Loaded settings + a local draft; `save()` PATCHes only the keys that changed. */
export function useSettings() {
  const { t } = useI18n()
  const { toast, onError } = useToast()
  const { data: saved, error, reload, setData: setSaved } = useLoader(adminApi.settings)
  const [draft, setDraft] = useState<Partial<Settings>>({})
  const [saving, setSaving] = useState(false)

  const value = <K extends keyof Settings>(key: K): Settings[K] | undefined =>
    key in draft ? (draft[key] as Settings[K]) : saved?.[key]

  const set = useCallback(<K extends keyof Settings>(key: K, v: Settings[K]) => setDraft((d) => ({ ...d, [key]: v })), [])

  const changes = Object.fromEntries(
    Object.entries(draft).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(saved?.[k as keyof Settings])),
  ) as Partial<Settings>
  const dirty = Object.keys(changes).length > 0

  const save = useCallback(async () => {
    if (!dirty) return
    setSaving(true)
    try {
      setSaved(await adminApi.updateSettings(changes))
      setDraft({})
      toast('success', t('common.saved'))
    } catch (err) {
      onError(err)
    } finally {
      setSaving(false)
    }
  }, [changes, dirty, onError, setSaved, t, toast])

  const discard = useCallback(() => setDraft({}), [])

  return { saved, error, reload, value, set, dirty, save, saving, discard }
}
