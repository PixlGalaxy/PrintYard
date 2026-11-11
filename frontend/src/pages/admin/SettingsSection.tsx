import { Coins, Globe, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { adminApi } from '../../api'
import { SettingRow } from '../../components/Card'
import { inputCls, selectCls, textareaCls } from '../../components/styles'
import { Callout, ErrorState, Field, Loading } from '../../components/ui'
import { useI18n } from '../../i18n/I18nContext'
import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES } from '../../i18n/translations'
import { PREPARE_LEVELS, type ExposureMode, type Language, type PrepareLevel } from '../../types'
import { LEVEL_DESC, LEVEL_LABEL } from '../workspace/prepare/settings/levels'
import { isCidr, isEmail, isUrl, parseOptionalNumber } from '../../validation'
import AppearanceSettingsPanel from './AppearanceSettingsPanel'
import SaveBar from './SaveBar'
import { Panel } from './shared'
import { useSettings } from './useSettings'

const MODES: ExposureMode[] = ['none', 'cloudflare', 'nginx', 'other']
const MODE_LABEL = { none: 'exposure.none', cloudflare: 'exposure.cloudflare', nginx: 'exposure.nginx', other: 'exposure.other' } as const
const MODE_DESC = { none: 'exposure.noneDesc', cloudflare: 'exposure.cloudflareDesc', nginx: 'exposure.nginxDesc', other: 'exposure.otherDesc' } as const
const CURRENCIES = ['USD', 'EUR', 'GBP', 'MXN', 'ARS', 'CLP', 'COP', 'PEN', 'BRL', 'CAD', 'AUD', 'JPY', 'CNY']

export default function SettingsSection() {
  const { t } = useI18n()
  const s = useSettings()
  // Text inputs whose typed form differs from the stored value (lists, optional numbers)
  const [proxiesText, setProxiesText] = useState<string | null>(null)
  const [costText, setCostText] = useState<string | null>(null)
  const [proxySeen, setProxySeen] = useState(false)
  useEffect(() => {
    adminApi.system().then((sys) => setProxySeen(!!sys.proxyHeadersSeen), () => undefined)
  }, [])

  if (s.error && !s.saved) return <ErrorState error={s.error} onRetry={() => void s.reload()} />
  if (!s.saved) return <Loading />

  const mode = s.value('exposure.mode') ?? 'none'
  const publicUrl = s.value('exposure.publicUrl') ?? ''
  const proxies = proxiesText ?? (s.value('exposure.trustedProxies') ?? []).join('\n')
  const sessionHours = s.value('security.sessionHours') ?? 168
  const idleMinutes = s.value('security.idleMinutes') ?? 0
  const adminEmail = s.value('admin.email') ?? ''
  const cost = costText ?? (s.value('limits.costPerKg') == null ? '' : String(s.value('limits.costPerKg')))
  const currency = s.value('limits.currency') ?? 'USD'
  const defaultLevel = s.value('workspace.defaultLevel') ?? 'basic'

  const proxyList = proxies.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)
  const errors = {
    publicUrl: publicUrl && !isUrl(publicUrl) ? t('validation.url') : null,
    proxies: proxyList.some((p) => !isCidr(p)) ? t('validation.cidr') : null,
    sessionHours: !Number.isInteger(sessionHours) || sessionHours < 1 || sessionHours > 8760 ? t('validation.number') : null,
    idleMinutes: !Number.isInteger(idleMinutes) || idleMinutes < 0 ? t('validation.number') : null,
    adminEmail: adminEmail && !isEmail(adminEmail) ? t('validation.email') : null,
    cost: Number.isNaN(parseOptionalNumber(cost)) ? t('validation.number') : null,
  }
  const invalid = Object.values(errors).some(Boolean)
  const intOrNaN = (v: string) => (v.trim() === '' ? Number.NaN : Number(v))

  return (
    <div className="space-y-5">
      {proxySeen && mode === 'none' && (
        <Callout tone="warning" title={t('system.proxyTitle')}>
          {t('system.proxyDescSettings')}
        </Callout>
      )}
      <Panel title={t('settings.exposure')} description={t('settings.exposureDesc')} icon={<Globe size={18} />}>
        <Field label={t('settings.mode')} hint={t(MODE_DESC[mode])}>
          {(p) => (
            <select {...p} className={selectCls} value={mode} onChange={(e) => s.set('exposure.mode', e.target.value as ExposureMode)}>
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {t(MODE_LABEL[m])}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('exposure.publicUrl')} optional hint={t('exposure.publicUrlHint')} error={errors.publicUrl}>
          {(p) => (
            <input
              {...p}
              type="url"
              className={`${inputCls} font-mono`}
              placeholder="https://print.example.com"
              value={publicUrl}
              onChange={(e) => s.set('exposure.publicUrl', e.target.value.trim() || null)}
            />
          )}
        </Field>
        {mode === 'other' && (
          <Field label={t('exposure.trustedProxies')} hint={t('exposure.trustedProxiesHint')} error={errors.proxies}>
            {(p) => (
              <textarea
                {...p}
                rows={4}
                className={`${textareaCls} font-mono`}
                placeholder={'10.0.0.0/8\n172.16.0.0/12\n192.168.0.0/16'}
                value={proxies}
                onChange={(e) => {
                  setProxiesText(e.target.value)
                  s.set(
                    'exposure.trustedProxies',
                    e.target.value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
                  )
                }}
              />
            )}
          </Field>
        )}
        {mode !== 'none' && <Callout tone="info">{t('exposure.httpsNote')}</Callout>}
      </Panel>

      <Panel title={t('settings.security')} description={t('settings.securityDesc')} icon={<ShieldCheck size={18} />}>
        <SettingRow label={t('settings.sessionHours')} description={errors.sessionHours ?? t('settings.sessionHoursHint')}>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={8760}
              aria-label={t('settings.sessionHours')}
              aria-invalid={!!errors.sessionHours}
              className={`${inputCls} w-24! tabular-nums`}
              value={Number.isFinite(sessionHours) ? sessionHours : ''}
              onChange={(e) => s.set('security.sessionHours', intOrNaN(e.target.value))}
            />
            <span className="w-16 text-sm text-muted">{t('settings.hours')}</span>
          </div>
        </SettingRow>
        <SettingRow label={t('settings.idleMinutes')} description={errors.idleMinutes ?? t('settings.idleMinutesHint')}>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              aria-label={t('settings.idleMinutes')}
              aria-invalid={!!errors.idleMinutes}
              className={`${inputCls} w-24! tabular-nums`}
              value={Number.isFinite(idleMinutes) ? idleMinutes : ''}
              onChange={(e) => s.set('security.idleMinutes', intOrNaN(e.target.value))}
            />
            <span className="w-16 text-sm text-muted">{t('settings.minutes')}</span>
          </div>
        </SettingRow>
      </Panel>

      <Panel title={t('settings.general')} description={t('settings.generalDesc')} icon={<SlidersHorizontal size={18} />}>
        <SettingRow label={t('settings.defaultLanguage')} description={t('settings.defaultLanguageHint')}>
          <select
            aria-label={t('settings.defaultLanguage')}
            className={`${selectCls} w-44!`}
            value={s.value('app.defaultLanguage') ?? 'en'}
            onChange={(e) => s.set('app.defaultLanguage', e.target.value as Language)}
          >
            {SUPPORTED_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {LANGUAGE_NAMES[l]}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label={t('settings.defaultLevel')} description={`${t('settings.defaultLevelHint')} ${t(LEVEL_DESC[defaultLevel])}`}>
          <select
            aria-label={t('settings.defaultLevel')}
            className={`${selectCls} w-44!`}
            value={defaultLevel}
            onChange={(e) => s.set('workspace.defaultLevel', e.target.value as PrepareLevel)}
          >
            {PREPARE_LEVELS.map((l) => (
              <option key={l} value={l}>
                {t(LEVEL_LABEL[l])}
              </option>
            ))}
          </select>
        </SettingRow>
        <Field label={t('settings.adminEmail')} optional hint={t('settings.adminEmailHint')} error={errors.adminEmail}>
          {(p) => (
            <input
              {...p}
              type="email"
              className={inputCls}
              placeholder="you@example.com"
              value={adminEmail}
              onChange={(e) => s.set('admin.email', e.target.value.trim() || null)}
            />
          )}
        </Field>
      </Panel>

      <AppearanceSettingsPanel s={s} />

      <Panel title={t('settings.costs')} description={t('settings.costsDesc')} icon={<Coins size={18} />}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.costPerKg')} optional error={errors.cost}>
            {(p) => (
              <input
                {...p}
                inputMode="decimal"
                className={`${inputCls} tabular-nums`}
                placeholder="20.00"
                value={cost}
                onChange={(e) => {
                  setCostText(e.target.value)
                  const n = parseOptionalNumber(e.target.value)
                  if (n === null || !Number.isNaN(n)) s.set('limits.costPerKg', n)
                }}
              />
            )}
          </Field>
          <Field label={t('settings.currency')}>
            {(p) => (
              <select {...p} className={selectCls} value={currency} onChange={(e) => s.set('limits.currency', e.target.value)}>
                {(CURRENCIES.includes(currency) ? CURRENCIES : [currency, ...CURRENCIES]).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </Panel>

      <SaveBar
        dirty={s.dirty || (costText !== null && !!errors.cost)}
        saving={s.saving}
        invalid={invalid}
        onSave={() => void s.save().then(() => {
          setProxiesText(null)
          setCostText(null)
        })}
        onDiscard={() => {
          s.discard()
          setProxiesText(null)
          setCostText(null)
        }}
      />
    </div>
  )
}
