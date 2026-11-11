import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cloud,
  Cpu,
  Globe,
  House,
  Network,
  Pencil,
  Rocket,
  Server,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { api, ApiError } from '../../api'
import PasswordStrength from '../../components/PasswordStrength'
import PrinterForm from '../../components/PrinterForm'
import { useLoader } from '../../hooks'
import { PublicShell } from '../../components/RouteGuards'
import { inputCls } from '../../components/styles'
import { Badge, Button, Callout, ErrorState, Field, Loading, PasswordInput, RadioCard, Toggle } from '../../components/ui'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import { printerModelName } from '../../format'
import { useI18n } from '../../i18n/I18nContext'
import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES, type TranslationKey } from '../../i18n/translations'
import type { EngineId, ExposureMode, PrinterModelInfo, SetupStatus } from '../../types'
import {
  formatBytes,
  isEmail,
  isUrl,
  isUsername,
  passwordProblem,
  printerInput,
  validatePrinter,
  type PrinterDraft,
} from '../../validation'

const STEPS: { key: TranslationKey; icon: LucideIcon }[] = [
  { key: 'setup.step.welcome', icon: Sparkles },
  { key: 'setup.step.admin', icon: ShieldCheck },
  { key: 'setup.step.printer', icon: Cpu },
  { key: 'setup.step.exposure', icon: Globe },
  { key: 'setup.step.engine', icon: Wrench },
  { key: 'setup.step.summary', icon: Rocket },
]

const EXPOSURES: { mode: ExposureMode; icon: LucideIcon; title: TranslationKey; desc: TranslationKey }[] = [
  { mode: 'none', icon: House, title: 'exposure.none', desc: 'exposure.noneDesc' },
  { mode: 'cloudflare', icon: Cloud, title: 'exposure.cloudflare', desc: 'exposure.cloudflareDesc' },
  { mode: 'nginx', icon: Server, title: 'exposure.nginx', desc: 'exposure.nginxDesc' },
  { mode: 'other', icon: Network, title: 'exposure.other', desc: 'exposure.otherDesc' },
]

const loadSetup = async () => {
  const [status, models] = await Promise.all([api.setupStatus(), api.printerModels().catch((): PrinterModelInfo[] => [])])
  return { status, models }
}

interface AdminDraft {
  username: string
  email: string
  password: string
  confirm: string
}

export default function SetupPage() {
  const { t } = useI18n()
  const { data, error, reload: load } = useLoader(loadSetup)
  const status = data?.status ?? null
  const models = data?.models ?? []

  return (
    <PublicShell wide>
      <div className="w-full max-w-3xl space-y-4">
        {error ? (
          <div className="rounded-2xl border border-line bg-surface shadow-sm">
            <ErrorState error={error} onRetry={() => void load()} />
          </div>
        ) : !status ? (
          <Loading />
        ) : status.lanAllowed === false ? (
          <LanBlocked />
        ) : (
          <>
            {status.memoryOk === false && (
              <Callout tone="warning" title={t('setup.memoryWarningTitle')}>
                {t('setup.memoryWarning', { limit: formatBytes(status.memoryLimitBytes) })}
              </Callout>
            )}
            <Wizard status={status} models={models} />
          </>
        )}
      </div>
    </PublicShell>
  )
}

function LanBlocked() {
  const { t } = useI18n()
  return (
    <div className="rounded-2xl border border-line bg-surface p-6 shadow-xl shadow-black/5 animate-[pop-in_.25s_ease-out] sm:p-8">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-500">
        <ShieldX size={24} />
      </div>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">{t('setup.lan.title')}</h1>
      <p className="mt-2 text-sm leading-relaxed">{t('setup.lan.text')}</p>
      <p className="mt-3 text-sm leading-relaxed text-muted">{t('setup.lan.why')}</p>
      <Callout className="mt-5" tone="info">
        {t('setup.lan.howTo')}
      </Callout>
    </div>
  )
}

function Wizard({ status, models }: { status: SetupStatus; models: PrinterModelInfo[] }) {
  const { t, language, setLanguage } = useI18n()
  const { completeSetup, reload } = useAuth()
  const { toast, onError } = useToast()
  const navigate = useNavigate()
  const heading = useRef<HTMLHeadingElement>(null)

  const [step, setStep] = useState(0)
  const [showErrors, setShowErrors] = useState(false)
  const [admin, setAdmin] = useState<AdminDraft>({ username: '', email: '', password: '', confirm: '' })
  const [printer, setPrinter] = useState<PrinterDraft>({ name: 'K2 SE', model: 'creality-k2se', host: '', staticIp: true, mac: '' })
  const [tested, setTested] = useState(false)
  const [exposure, setExposure] = useState<{ mode: ExposureMode; publicUrl: string }>({ mode: 'none', publicUrl: '' })
  const [engine, setEngine] = useState<{ selected: EngineId; autoUpdate: boolean }>({ selected: 'creality', autoUpdate: true })
  const [finishing, setFinishing] = useState(false)

  // ---------- Validation per step ----------
  const adminErrors = {
    username: !admin.username.trim() ? 'validation.required' : !isUsername(admin.username.trim()) ? 'validation.username' : null,
    email: admin.email.trim() && !isEmail(admin.email.trim()) ? 'validation.email' : null,
    password: passwordProblem(admin.password) ?? null,
    confirm: admin.password && admin.confirm !== admin.password ? 'password.mismatch' : !admin.confirm ? 'validation.required' : null,
  } satisfies Record<string, TranslationKey | null>
  const printerErrors = validatePrinter(printer)
  const urlError = exposure.publicUrl.trim() && !isUrl(exposure.publicUrl.trim()) ? ('validation.url' as const) : null

  const stepValid = [
    true,
    Object.values(adminErrors).every((e) => !e),
    Object.keys(printerErrors).length === 0,
    !urlError,
    true,
    true,
  ]

  const goTo = (next: number) => {
    setStep(next)
    setShowErrors(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
    requestAnimationFrame(() => heading.current?.focus())
  }

  function next() {
    if (!stepValid[step]) {
      setShowErrors(true)
      return
    }
    goTo(step + 1)
  }

  async function finish() {
    setFinishing(true)
    try {
      const { user } = await api.setupComplete({
        language,
        admin: { username: admin.username.trim(), email: admin.email.trim(), password: admin.password },
        printer: printerInput(printer),
        exposure: { mode: exposure.mode, publicUrl: exposure.publicUrl.trim() || null },
        engine,
      })
      completeSetup(user)
      toast('success', t('setup.done'))
      navigate('/', { replace: true })
    } catch (err) {
      onError(err)
      setFinishing(false)
      if (err instanceof ApiError && (err.code === 'setup.already_complete' || err.code === 'setup.not_lan')) void reload()
    }
  }

  const err = (key: TranslationKey | null | undefined) => (showErrors && key ? t(key) : null)
  const current = STEPS[step]

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-xl shadow-black/5 animate-[pop-in_.25s_ease-out]">
      {/* Progress */}
      <div className="border-b border-line px-4 py-4 sm:px-6">
        <div className="mb-3 flex items-center justify-between text-xs text-muted">
          <span className="font-medium text-fg">{t('setup.title')}</span>
          <span>{t('setup.stepOf', { current: step + 1, total: STEPS.length })}</span>
        </div>
        <ol className="flex items-center gap-1.5 sm:gap-2" aria-label={t('setup.title')}>
          {STEPS.map((s, i) => {
            const done = i < step
            const active = i === step
            const Icon = s.icon
            return (
              <li key={s.key} className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2" aria-current={active ? 'step' : undefined}>
                <button
                  type="button"
                  disabled={i > step || finishing}
                  onClick={() => goTo(i)}
                  title={t(s.key)}
                  className={`flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-sky-500 ${
                    active
                      ? 'border-sky-500 bg-sky-500 text-white shadow-sm shadow-sky-500/30'
                      : done
                        ? 'border-sky-500/40 bg-sky-500/10 text-sky-600 hover:bg-sky-500/20 dark:text-sky-400'
                        : 'border-line bg-surface-2 text-muted'
                  }`}
                >
                  {done ? <Check size={14} /> : <Icon size={14} />}
                  <span className="sr-only">{t(s.key)}</span>
                </button>
                {active && <span className="hidden truncate text-xs font-medium text-fg sm:block">{t(s.key)}</span>}
                {i < STEPS.length - 1 && <span className={`h-px min-w-2 flex-1 ${done ? 'bg-sky-500/50' : 'bg-line'}`} aria-hidden />}
              </li>
            )
          })}
        </ol>
      </div>

      {/* Step body */}
      <form
        key={step}
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          if (step < STEPS.length - 1) next()
          else void finish()
        }}
      >
        <div className="space-y-5 px-4 py-6 animate-[slide-in_.2s_ease-out] sm:px-6">
          <h1 ref={heading} tabIndex={-1} className="sr-only">
            {t(current.key)}
          </h1>

          {step === 0 && (
            <StepIntro icon={<Sparkles size={20} />} title={t('setup.welcome.title')} text={t('setup.welcome.text')}>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t('setup.welcome.language')}</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {SUPPORTED_LANGUAGES.map((l) => (
                    <RadioCard
                      key={l}
                      name="language"
                      checked={language === l}
                      onChange={() => void setLanguage(l)}
                      icon={<span className="text-xs font-bold uppercase">{l}</span>}
                      title={LANGUAGE_NAMES[l]}
                      description={l === 'en' ? 'Use SliceDock in English' : 'Usar SliceDock en español'}
                    />
                  ))}
                </div>
                <p className="text-xs text-muted">{t('setup.welcome.languageHint')}</p>
              </fieldset>
            </StepIntro>
          )}

          {step === 1 && (
            <StepIntro icon={<ShieldCheck size={20} />} title={t('setup.admin.title')} text={t('setup.admin.text')}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('setup.admin.username')} error={err(adminErrors.username)} hint={t('validation.username')}>
                  {(p) => (
                    <input
                      {...p}
                      className={inputCls}
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={32}
                      value={admin.username}
                      onChange={(e) => setAdmin({ ...admin, username: e.target.value })}
                    />
                  )}
                </Field>
                <Field label={t('setup.admin.email')} optional error={err(adminErrors.email)} hint={t('setup.admin.emailHint')}>
                  {(p) => (
                    <input
                      {...p}
                      type="email"
                      className={inputCls}
                      autoComplete="email"
                      placeholder="you@example.com"
                      value={admin.email}
                      onChange={(e) => setAdmin({ ...admin, email: e.target.value })}
                    />
                  )}
                </Field>
                <div className="space-y-2">
                  <Field label={t('setup.admin.password')} error={err(adminErrors.password)}>
                    {(p) => (
                      <PasswordInput
                        {...p}
                        autoComplete="new-password"
                        value={admin.password}
                        onChange={(e) => setAdmin({ ...admin, password: e.target.value })}
                      />
                    )}
                  </Field>
                  <PasswordStrength password={admin.password} />
                </div>
                <Field label={t('setup.admin.confirm')} error={err(adminErrors.confirm)}>
                  {(p) => (
                    <PasswordInput
                      {...p}
                      autoComplete="new-password"
                      value={admin.confirm}
                      onChange={(e) => setAdmin({ ...admin, confirm: e.target.value })}
                    />
                  )}
                </Field>
              </div>
            </StepIntro>
          )}

          {step === 2 && (
            <StepIntro icon={<Cpu size={20} />} title={t('setup.printer.title')} text={t('setup.printer.text')}>
              <PrinterForm
                value={printer}
                onChange={setPrinter}
                models={models}
                errors={showErrors ? printerErrors : {}}
                hostNetworkLikely={status.hostNetworkLikely}
                onTest={api.setupTestPrinter}
                onTested={() => setTested(true)}
              />
            </StepIntro>
          )}

          {step === 3 && (
            <StepIntro icon={<Globe size={20} />} title={t('exposure.title')} text={t('exposure.text')}>
              <div role="radiogroup" aria-label={t('exposure.title')} className="grid gap-3 sm:grid-cols-2">
                {EXPOSURES.map((o) => (
                  <RadioCard
                    key={o.mode}
                    name="exposure"
                    checked={exposure.mode === o.mode}
                    onChange={() => setExposure({ ...exposure, mode: o.mode })}
                    icon={<o.icon size={18} />}
                    title={t(o.title)}
                    description={t(o.desc)}
                  />
                ))}
              </div>
              {exposure.mode !== 'none' && (
                <div className="space-y-3 animate-[fade-in_.2s_ease-out]">
                  <Field label={t('exposure.publicUrl')} optional hint={t('exposure.publicUrlHint')} error={err(urlError)}>
                    {(p) => (
                      <input
                        {...p}
                        type="url"
                        inputMode="url"
                        className={`${inputCls} font-mono`}
                        placeholder="https://print.example.com"
                        value={exposure.publicUrl}
                        onChange={(e) => setExposure({ ...exposure, publicUrl: e.target.value })}
                      />
                    )}
                  </Field>
                  <Callout tone="info">{t('exposure.httpsNote')}</Callout>
                </div>
              )}
            </StepIntro>
          )}

          {step === 4 && (
            <StepIntro icon={<Wrench size={20} />} title={t('engine.title')} text={t('engine.text')}>
              <div role="radiogroup" aria-label={t('engine.title')} className="grid gap-3 sm:grid-cols-2">
                <RadioCard
                  name="engine"
                  checked={engine.selected === 'creality'}
                  onChange={() => setEngine({ ...engine, selected: 'creality' })}
                  icon={<Cpu size={18} />}
                  title={t('engine.creality')}
                  badge={<Badge tone="emerald">{t('common.recommended')}</Badge>}
                  description={t('engine.crealityDesc')}
                />
                <RadioCard
                  name="engine"
                  checked={engine.selected === 'orca'}
                  onChange={() => setEngine({ ...engine, selected: 'orca' })}
                  icon={<Wrench size={18} />}
                  title={t('engine.orca')}
                  description={t('engine.orcaDesc')}
                />
              </div>
              <div className="flex items-start justify-between gap-4 rounded-xl border border-line bg-surface-2/50 p-4">
                <div>
                  <p className="text-sm font-medium">{t('engine.autoUpdate')}</p>
                  <p className="text-xs text-muted">{t('engine.autoUpdateHint')}</p>
                </div>
                <Toggle checked={engine.autoUpdate} onChange={(v) => setEngine({ ...engine, autoUpdate: v })} label={t('engine.autoUpdate')} />
              </div>
            </StepIntro>
          )}

          {step === 5 && (
            <StepIntro icon={<Rocket size={20} />} title={t('summary.title')} text={t('summary.text')}>
              <dl className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                <SummaryRow label={t('summary.language')} onEdit={() => goTo(0)}>
                  {LANGUAGE_NAMES[language]}
                </SummaryRow>
                <SummaryRow label={t('summary.admin')} onEdit={() => goTo(1)}>
                  <span className="font-medium">{admin.username}</span>
                  {admin.email && <span className="text-muted"> · {admin.email}</span>}
                </SummaryRow>
                <SummaryRow label={t('summary.printer')} onEdit={() => goTo(2)}>
                  <span className="font-medium">{printer.name}</span> <span className="text-muted">· {printerModelName(printer.model)}</span>
                  <br />
                  <span className="font-mono text-xs">{printer.host}</span>{' '}
                  <Badge tone={printer.staticIp ? 'sky' : 'violet'}>{t(printer.staticIp ? 'printer.static' : 'printer.dynamic')}</Badge>
                  {printer.mac && <span className="ml-1.5 font-mono text-xs text-muted">{printer.mac}</span>}
                </SummaryRow>
                <SummaryRow label={t('summary.exposure')} onEdit={() => goTo(3)}>
                  {t(EXPOSURES.find((e) => e.mode === exposure.mode)!.title)}
                  {exposure.publicUrl.trim() && <span className="block font-mono text-xs text-muted">{exposure.publicUrl.trim()}</span>}
                </SummaryRow>
                <SummaryRow label={t('summary.engine')} onEdit={() => goTo(4)}>
                  {t(engine.selected === 'creality' ? 'engine.creality' : 'engine.orca')}
                  <span className="text-muted">
                    {' '}
                    · {t('engine.autoUpdate')}: {t(engine.autoUpdate ? 'common.on' : 'common.off')}
                  </span>
                </SummaryRow>
              </dl>
              {!tested && <Callout tone="info">{t('setup.printer.notTested')}</Callout>}
            </StepIntro>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line bg-surface-2/50 px-4 py-3 sm:px-6">
          <Button size="md" variant="ghost" icon={<ArrowLeft size={16} />} disabled={step === 0 || finishing} onClick={() => goTo(step - 1)}>
            {t('common.back')}
          </Button>
          {step < STEPS.length - 1 ? (
            <Button type="submit" size="md" variant="primary">
              {t('common.next')}
              <ArrowRight size={16} />
            </Button>
          ) : (
            <Button type="submit" size="md" variant="primary" icon={<Rocket size={16} />} loading={finishing}>
              {finishing ? t('setup.finishing') : t('setup.finish')}
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}

function StepIntro({ icon, title, text, children }: { icon: ReactNode; title: string; text: string; children: ReactNode }) {
  return (
    <>
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-500">{icon}</div>
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <p className="text-sm text-muted">{text}</p>
        </div>
      </div>
      {children}
    </>
  )
}

function SummaryRow({ label, children, onEdit }: { label: string; children: ReactNode; onEdit: () => void }) {
  const { t } = useI18n()
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <dt className="w-28 shrink-0 pt-0.5 text-xs font-medium text-muted sm:w-36">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm break-words">{children}</dd>
      <Button size="xs" variant="ghost" icon={<Pencil size={12} />} onClick={onEdit} aria-label={`${t('summary.edit')}: ${label}`}>
        <span className="hidden sm:inline">{t('summary.edit')}</span>
      </Button>
    </div>
  )
}
