import { Gauge, KeyRound, UserPlus, UserRound } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { adminApi } from '../../api'
import Modal from '../../components/Modal'
import PasswordStrength from '../../components/PasswordStrength'
import { inputCls, selectCls } from '../../components/styles'
import { Button, Callout, Field, PasswordInput, Toggle } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { useI18n } from '../../i18n/I18nContext'
import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES } from '../../i18n/translations'
import type { AdminUser, Language, Role, UserLimits } from '../../types'
import { isEmail, isUsername, parseOptionalNumber, passwordProblem } from '../../validation'

// ---------- Create / edit ----------

export function UserFormModal({
  user,
  self,
  onClose,
  onSaved,
}: {
  /** undefined = create */
  user?: AdminUser
  self?: boolean
  onClose: () => void
  onSaved: (user: AdminUser) => void
}) {
  const { t, language } = useI18n()
  const { onError } = useToast()
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState(user?.email ?? '')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>(user?.role ?? 'user')
  const [isActive, setIsActive] = useState(user?.isActive ?? true)
  const [lang, setLang] = useState<Language>(user?.language ?? language)
  const [canPrintUploaded, setCanPrintUploaded] = useState(user?.canPrintUploadedGcode ?? false)
  const [canControl, setCanControl] = useState(user?.canControlPrinter ?? false)
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)

  const errors = {
    username: user ? null : !username.trim() ? 'validation.required' : !isUsername(username.trim()) ? 'validation.username' : null,
    email: email.trim() && !isEmail(email.trim()) ? 'validation.email' : null,
    password: user ? null : passwordProblem(password),
  } as const
  const invalid = Object.values(errors).some(Boolean)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (invalid) return
    setSaving(true)
    try {
      const saved = user
        ? await adminApi.updateUser(user.id, {
            email: email.trim() || null,
            language: lang,
            ...(self ? {} : { role, isActive }),
            ...(canPrintUploaded !== user.canPrintUploadedGcode && { canPrintUploadedGcode: canPrintUploaded }),
            ...(canControl !== (user.canControlPrinter ?? false) && { canControlPrinter: canControl }),
          })
        : await adminApi.createUser({
            username: username.trim(),
            ...(email.trim() ? { email: email.trim() } : {}),
            password,
            role,
            language: lang,
          })
      onSaved(saved)
      onClose()
    } catch (err) {
      onError(err)
      setSaving(false)
    }
  }

  const err = (k: keyof typeof errors) => (touched && errors[k] ? t(errors[k]!) : null)

  return (
    <Modal
      title={user ? t('users.editTitle', { name: user.username }) : t('users.createTitle')}
      icon={user ? <UserRound size={18} /> : <UserPlus size={18} />}
      onClose={onClose}
      dismissable={!saving}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="user-form" variant="primary" loading={saving}>
            {user ? t('common.saveChanges') : t('common.create')}
          </Button>
        </>
      }
    >
      <form id="user-form" onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
        {!user && (
          <Field label={t('users.username')} error={err('username')} hint={t('validation.username')}>
            {(p) => (
              <input
                {...p}
                className={inputCls}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={32}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            )}
          </Field>
        )}
        <Field label={t('users.email')} optional error={err('email')}>
          {(p) => <input {...p} type="email" className={inputCls} autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        {!user && (
          <div className="space-y-2 sm:col-span-2">
            <Field label={t('users.password')} error={err('password')}>
              {(p) => <PasswordInput {...p} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
            <PasswordStrength password={password} />
          </div>
        )}
        <Field label={t('users.role')}>
          {(p) => (
            <select {...p} className={selectCls} value={role} disabled={self} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="user">{t('role.user')}</option>
              <option value="admin">{t('role.admin')}</option>
            </select>
          )}
        </Field>
        <Field label={t('users.language')}>
          {(p) => (
            <select {...p} className={selectCls} value={lang} onChange={(e) => setLang(e.target.value as Language)}>
              {SUPPORTED_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {LANGUAGE_NAMES[l]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {user && (
          <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-surface-2/50 p-3.5 sm:col-span-2">
            <div>
              <p className="text-sm font-medium">{t('users.active')}</p>
              <p className="text-xs text-muted">{t('users.activeHint')}</p>
            </div>
            <Toggle checked={isActive} onChange={setIsActive} label={t('users.active')} disabled={self} />
          </div>
        )}
        {user && (
          <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-surface-2/50 p-3.5 sm:col-span-2">
            <div>
              <p className="text-sm font-medium">{t('users.canPrintUploaded')}</p>
              <p className="text-xs text-muted">{t(role === 'admin' ? 'users.canPrintUploadedAdmin' : 'users.canPrintUploadedHint')}</p>
            </div>
            <Toggle
              checked={role === 'admin' || canPrintUploaded}
              onChange={setCanPrintUploaded}
              label={t('users.canPrintUploaded')}
              disabled={role === 'admin'}
            />
          </div>
        )}
        {user && (
          <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-surface-2/50 p-3.5 sm:col-span-2">
            <div>
              <p className="text-sm font-medium">{t('users.canControlPrinter')}</p>
              <p className="text-xs text-muted">{t(role === 'admin' ? 'users.canControlPrinterAdmin' : 'users.canControlPrinterHint')}</p>
            </div>
            <Toggle
              checked={role === 'admin' || canControl}
              onChange={setCanControl}
              label={t('users.canControlPrinter')}
              disabled={role === 'admin'}
            />
          </div>
        )}
        {self && (
          <Callout tone="info" className="sm:col-span-2">
            {t('users.selfNote')}
          </Callout>
        )}
      </form>
    </Modal>
  )
}

// ---------- Limits ----------

const numStr = (n: number | null) => (n == null ? '' : String(n))

export function LimitsModal({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: (user: AdminUser) => void }) {
  const { t, formatNumber } = useI18n()
  const { onError } = useToast()
  const [enabled, setEnabled] = useState(user.limits.enabled)
  const [perPrint, setPerPrint] = useState(numStr(user.limits.maxGramsPerPrint))
  const [perMonth, setPerMonth] = useState(numStr(user.limits.maxGramsPerMonth))
  const [hours, setHours] = useState(numStr(user.limits.maxHoursPerPrint))
  const [approval, setApproval] = useState(user.limits.requiresApproval)
  const [saving, setSaving] = useState(false)
  const [cost, setCost] = useState<{ perKg: number; currency: string } | null>(null)

  // Filament price (optional) for a quick cost estimate
  useEffect(() => {
    adminApi.settings().then(
      (s) => {
        if (typeof s['limits.costPerKg'] === 'number' && s['limits.costPerKg'] > 0) {
          setCost({ perKg: s['limits.costPerKg'], currency: s['limits.currency'] || 'USD' })
        }
      },
      () => undefined,
    )
  }, [])

  const parsed = {
    maxGramsPerPrint: parseOptionalNumber(perPrint),
    maxGramsPerMonth: parseOptionalNumber(perMonth),
    maxHoursPerPrint: parseOptionalNumber(hours),
  }
  const bad = (v: number | null) => v !== null && Number.isNaN(v)
  const invalid = Object.values(parsed).some(bad)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (invalid) return
    setSaving(true)
    try {
      const limits: UserLimits = { enabled, ...parsed, requiresApproval: approval }
      onSaved(await adminApi.setLimits(user.id, limits))
      onClose()
    } catch (err) {
      onError(err)
      setSaving(false)
    }
  }

  const estimate =
    cost && parsed.maxGramsPerPrint && !Number.isNaN(parsed.maxGramsPerPrint)
      ? formatNumber((parsed.maxGramsPerPrint / 1000) * cost.perKg, { style: 'currency', currency: cost.currency })
      : null

  const numberField = (
    label: string,
    unit: string,
    value: string,
    set: (v: string) => void,
    hint?: ReactNode,
  ) => (
    <Field label={label} hint={hint ?? t('limits.emptyHint')} error={bad(parseOptionalNumber(value)) ? t('validation.number') : null}>
      {(p) => (
        <div className="relative">
          <input
            {...p}
            className={`${inputCls} pr-9! tabular-nums`}
            inputMode="decimal"
            placeholder={t('common.unlimited')}
            disabled={!enabled}
            value={value}
            onChange={(e) => set(e.target.value)}
          />
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted">{unit}</span>
        </div>
      )}
    </Field>
  )

  return (
    <Modal
      title={t('limits.title', { name: user.username })}
      subtitle={t('limits.desc')}
      icon={<Gauge size={18} />}
      onClose={onClose}
      dismissable={!saving}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="limits-form" variant="primary" loading={saving} disabled={invalid}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id="limits-form" onSubmit={submit} noValidate className="space-y-5">
        {/* Master switch */}
        <div
          className={`flex items-center justify-between gap-4 rounded-xl border p-4 transition-colors ${
            enabled ? 'border-sky-500/40 bg-sky-500/[0.06]' : 'border-line bg-surface-2/50'
          }`}
        >
          <div>
            <p className="text-sm font-semibold">{t('limits.enabled')}</p>
            <p className="text-xs text-muted">{t('limits.enabledHint')}</p>
          </div>
          <Toggle checked={enabled} onChange={setEnabled} label={t('limits.enabled')} />
        </div>

        <fieldset disabled={!enabled} className={`grid gap-4 transition-opacity sm:grid-cols-2 ${enabled ? '' : 'opacity-50'}`}>
          {numberField(
            t('limits.perPrint'),
            t('limits.grams'),
            perPrint,
            setPerPrint,
            estimate ? t('limits.costEstimate', { cost: estimate }) : undefined,
          )}
          {numberField(t('limits.perMonth'), t('limits.grams'), perMonth, setPerMonth, t('limits.perMonthHint'))}
          {numberField(t('limits.hoursPerPrint'), t('limits.hours'), hours, setHours)}
          <div className="flex items-center justify-between gap-4 rounded-xl border border-line p-3.5 sm:col-span-2">
            <div>
              <p className="text-sm font-medium">{t('limits.approval')}</p>
              <p className="text-xs text-muted">{t('limits.approvalHint')}</p>
            </div>
            <Toggle checked={approval} onChange={setApproval} label={t('limits.approval')} disabled={!enabled} />
          </div>
        </fieldset>
      </form>
    </Modal>
  )
}

// ---------- Reset password ----------

export function ResetPasswordModal({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n()
  const { onError } = useToast()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const problem = passwordProblem(password, confirm)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (problem) return
    setSaving(true)
    try {
      await adminApi.resetPassword(user.id, password)
      onSaved()
      onClose()
    } catch (err) {
      onError(err)
      setSaving(false)
    }
  }

  return (
    <Modal
      size="sm"
      title={t('users.resetTitle', { name: user.username })}
      icon={<KeyRound size={18} />}
      onClose={onClose}
      dismissable={!saving}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="reset-form" variant="warning" loading={saving}>
            {t('users.resetPassword')}
          </Button>
        </>
      }
    >
      <form id="reset-form" onSubmit={submit} noValidate className="space-y-4">
        <p className="text-sm text-muted">{t('users.resetText')}</p>
        <div className="space-y-2">
          <Field label={t('account.newPassword')} error={touched && problem && problem !== 'password.mismatch' ? t(problem) : null}>
            {(p) => <PasswordInput {...p} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <PasswordStrength password={password} />
        </div>
        <Field label={t('account.confirmPassword')} error={touched && problem === 'password.mismatch' ? t(problem) : null}>
          {(p) => <PasswordInput {...p} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
        </Field>
      </form>
    </Modal>
  )
}
