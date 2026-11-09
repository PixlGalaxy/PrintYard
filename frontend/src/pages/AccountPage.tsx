import { HardDrive, KeyRound, Palette, UserRound } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { ModePicker, SkinGrid } from '../components/AppearancePicker'
import Card, { SettingRow } from '../components/Card'
import LanguageSwitcher from '../components/LanguageSwitcher'
import PageHeader from '../components/PageHeader'
import PasswordStrength from '../components/PasswordStrength'
import StorageUsage from '../components/StorageUsage'
import { inputCls } from '../components/styles'
import { Badge, Button, Field, PasswordInput } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { useToast } from '../context/ToastContext'
import { useI18n } from '../i18n/I18nContext'
import type { User } from '../types'
import { isEmail, passwordProblem } from '../validation'
import AvatarEditor from './account/AvatarEditor'
import Nav3dCard from './account/Nav3dCard'
import FilamentPresetsCard from './account/FilamentPresetsCard'
import NotificationsCard from './account/notifications/NotificationsCard'

export default function AccountPage() {
  const { user } = useAuth()
  const { t } = useI18n()
  if (!user) return null
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title={t('account.title')} subtitle={t('account.subtitle')} />
      <ProfileCard user={user} />
      <div id="appearance" className="scroll-mt-24">
        <AppearanceCard />
      </div>
      <div id="nav3d" className="scroll-mt-24">
        <Nav3dCard />
      </div>
      <div id="filaments" className="scroll-mt-24">
        <FilamentPresetsCard />
      </div>
      <Card title={t('storage.title')} description={t('storage.desc')} icon={<HardDrive size={18} />}>
        <StorageUsage compact />
      </Card>
      <PasswordCard />
      <div id="notifications" className="scroll-mt-24">
        <NotificationsCard />
      </div>
    </div>
  )
}

function ProfileCard({ user }: { user: User }) {
  const { updateAccount } = useAuth()
  const { t, formatDate } = useI18n()
  const { toast, onError } = useToast()
  const [email, setEmail] = useState(user.email ?? '')
  const [saving, setSaving] = useState(false)
  const trimmed = email.trim()
  const invalid = trimmed !== '' && !isEmail(trimmed)
  const dirty = trimmed !== (user.email ?? '')

  async function save(e: FormEvent) {
    e.preventDefault()
    if (invalid || !dirty) return
    setSaving(true)
    try {
      await updateAccount({ email: trimmed || null })
      toast('success', t('common.saved'))
    } catch (err) {
      onError(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title={t('account.profile')} description={t('account.profileDesc')} icon={<UserRound size={18} />}>
      <AvatarEditor user={user}>
        <div className="min-w-0">
          <p className="truncate font-semibold">{user.username}</p>
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <Badge tone={user.role === 'admin' ? 'violet' : 'zinc'}>{t(user.role === 'admin' ? 'role.admin' : 'role.user')}</Badge>
            {t('account.memberSince')} {formatDate(user.createdAt)}
          </p>
        </div>
      </AvatarEditor>
      <form onSubmit={save} className="flex flex-col gap-3 sm:flex-row sm:items-start" noValidate>
        <Field
          className="flex-1"
          label={t('account.email')}
          hint={t('account.emailHint')}
          error={invalid ? t('validation.email') : null}
        >
          {(p) => (
            <input {...p} type="email" autoComplete="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} />
          )}
        </Field>
        <Button type="submit" variant="primary" size="md" className="sm:mt-6" loading={saving} disabled={!dirty || invalid}>
          {t('common.save')}
        </Button>
      </form>
    </Card>
  )
}

/** Language + theme mode + accent skin. Mode and skin can stay on "Use default" (follow the admin default). */
function AppearanceCard() {
  const { t } = useI18n()
  const { themeMode, skin, defaults, setAppearance } = useTheme()
  const { onError } = useToast()
  return (
    <Card title={t('appearance.title')} description={t('appearance.desc')} icon={<Palette size={18} />}>
      <SettingRow label={t('language.label')} description={t('account.languageDesc')}>
        <LanguageSwitcher />
      </SettingRow>
      <SettingRow label={t('appearance.mode')} description={t('appearance.modeDesc')}>
        <ModePicker
          value={themeMode ?? 'default'}
          defaultValue={defaults.defaultMode}
          onChange={(v) => setAppearance({ themeMode: v === 'default' ? null : v }).catch(onError)}
        />
      </SettingRow>
      <div className="space-y-3">
        <div>
          <div className="text-sm font-medium">{t('appearance.skin')}</div>
          <div className="text-xs text-muted">{t('appearance.skinDesc')}</div>
        </div>
        <SkinGrid
          value={skin ?? 'default'}
          defaultValue={defaults.defaultSkin}
          onChange={(v) => setAppearance({ skin: v === 'default' ? null : v }).catch(onError)}
        />
      </div>
    </Card>
  )
}

function PasswordCard() {
  const { t } = useI18n()
  const { toast, onError } = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const problem = passwordProblem(next, confirm)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (problem || !current) return
    setSaving(true)
    try {
      await api.changePassword(current, next)
      toast('success', t('account.passwordChanged'))
      setCurrent('')
      setNext('')
      setConfirm('')
      setTouched(false)
    } catch (err) {
      onError(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title={t('account.password')} description={t('account.passwordDesc')} icon={<KeyRound size={18} />}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        {/* Hidden username helps password managers pair the new password with the account */}
        <input type="text" autoComplete="username" hidden readOnly />
        <Field className="sm:col-span-2" label={t('account.currentPassword')} error={touched && !current ? t('validation.required') : null}>
          {(p) => <PasswordInput {...p} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
        </Field>
        <div className="space-y-2">
          <Field
            label={t('account.newPassword')}
            error={touched && problem && problem !== 'password.mismatch' ? t(problem) : null}
          >
            {(p) => <PasswordInput {...p} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
          </Field>
          <PasswordStrength password={next} />
        </div>
        <Field
          label={t('account.confirmPassword')}
          error={touched && problem === 'password.mismatch' ? t(problem) : null}
        >
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
        </Field>
        <div className="flex justify-end sm:col-span-2">
          <Button type="submit" variant="primary" size="md" loading={saving}>
            {t('account.changePassword')}
          </Button>
        </div>
      </form>
    </Card>
  )
}
