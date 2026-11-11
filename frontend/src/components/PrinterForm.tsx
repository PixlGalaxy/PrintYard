import { CircleCheck, CircleX, PlugZap, Wifi, WifiOff } from 'lucide-react'
import { useState } from 'react'
import { useI18n } from '../i18n/I18nContext'
import { isTranslationKey } from '../i18n/translations'
import type { PrinterModelInfo, ProbeRequest, ProbeResult } from '../types'
import { normalizeMac, type PrinterDraft, type PrinterErrors } from '../validation'
import { inputCls, selectCls } from './styles'
import { Badge, Button, Callout, Chip, Field, Toggle } from './ui'

interface Props {
  value: PrinterDraft
  onChange: (next: PrinterDraft) => void
  models: PrinterModelInfo[]
  errors: PrinterErrors
  /** From /api/setup/status; undefined = unknown */
  hostNetworkLikely?: boolean
  onTest: (body: ProbeRequest) => Promise<ProbeResult>
  /** Notified after each test (the wizard uses it to know a test happened) */
  onTested?: (result: ProbeResult) => void
}

type TestState = { state: 'idle' } | { state: 'testing' } | { state: 'done'; result: ProbeResult; macFilled: boolean }

/** Model / name / IP + static toggle / MAC + "Test connection". Shared by the setup wizard and Admin → Printers. */
export default function PrinterForm({ value, onChange, models, errors, hostNetworkLikely, onTest, onTested }: Props) {
  const { t, errorMessage } = useI18n()
  const [test, setTest] = useState<TestState>({ state: 'idle' })
  const set = (patch: Partial<PrinterDraft>) => onChange({ ...value, ...patch })
  const modelOptions = models.length ? models : [{ id: 'creality-k2se' as const, name: 'Creality K2 SE', vendor: 'Creality', bed: { x: 220, y: 215, z: 245 } }]

  async function runTest() {
    setTest({ state: 'testing' })
    let result: ProbeResult
    try {
      result = await onTest({
        model: value.model,
        host: value.host.trim(),
        staticIp: value.staticIp,
        ...(value.mac.trim() ? { mac: normalizeMac(value.mac) } : {}),
      })
    } catch (err) {
      result = { ok: false, error: errorMessage(err) }
    }
    let macFilled = false
    if (result.ok && result.mac) {
      const mac = normalizeMac(result.mac)
      if (mac !== normalizeMac(value.mac)) {
        onChange({ ...value, mac })
        macFilled = true
      }
    }
    setTest({ state: 'done', result, macFilled })
    onTested?.(result)
  }

  const probeError = (code: string | undefined) => {
    if (!code) return t('errors.printers.unreachable')
    const key = `errors.${code}`
    return isTranslationKey(key) ? t(key) : code
  }

  const canTest = !!value.host.trim() && !errors.host

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('printer.model')}>
          {(p) => (
            <select {...p} className={selectCls} value={value.model} onChange={(e) => set({ model: e.target.value as PrinterDraft['model'] })}>
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('printer.name')} error={errors.name ? t(errors.name) : null}>
          {(p) => <input {...p} className={inputCls} maxLength={64} value={value.name} onChange={(e) => set({ name: e.target.value })} />}
        </Field>
      </div>

      <Field label={t('printer.host')} hint={t('printer.hostHint')} error={errors.host ? t(errors.host) : null}>
        {(p) => (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              {...p}
              className={`${inputCls} font-mono sm:flex-1`}
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              placeholder="192.168.1.50"
              value={value.host}
              onChange={(e) => set({ host: e.target.value })}
            />
            {/* Static IP toggle sits right beside the IP field */}
            <div className="flex h-9 shrink-0 items-center gap-2.5 rounded-lg border border-line bg-surface-2/60 px-3" title={t('printer.staticIpHint')}>
              <Toggle checked={value.staticIp} onChange={(v) => set({ staticIp: v })} label={t('printer.staticIp')} />
              <span className="text-sm font-medium">{t('printer.staticIp')}</span>
            </div>
          </div>
        )}
      </Field>

      {!value.staticIp && (
        <div className="space-y-4 animate-[fade-in_.2s_ease-out]">
          <Callout tone="warning" title={t('printer.dynamicWarningTitle')}>
            <p>{t('printer.dynamicWarning')}</p>
            {hostNetworkLikely !== undefined && (
              <p className={`mt-2 flex items-center gap-1.5 font-medium ${hostNetworkLikely ? 'text-emerald-700 dark:text-emerald-300' : ''}`}>
                {hostNetworkLikely ? <Wifi size={14} /> : <WifiOff size={14} />}
                {t(hostNetworkLikely ? 'printer.hostNetworkYes' : 'printer.hostNetworkNo')}
              </p>
            )}
          </Callout>
          <Field label={t('printer.mac')} hint={t('printer.macHint')} error={errors.mac ? t(errors.mac) : null}>
            {(p) => (
              <input
                {...p}
                className={`${inputCls} font-mono uppercase`}
                autoComplete="off"
                spellCheck={false}
                placeholder="AA:BB:CC:DD:EE:FF"
                value={value.mac}
                onChange={(e) => set({ mac: e.target.value })}
              />
            )}
          </Field>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button icon={<PlugZap size={14} />} loading={test.state === 'testing'} disabled={!canTest} onClick={runTest}>
          {test.state === 'testing' ? t('printer.testing') : t('printer.test')}
        </Button>
      </div>

      {test.state === 'done' && (
        <div
          aria-live="polite"
          className={`rounded-xl border p-4 animate-[pop-in_.18s_ease-out] ${
            test.result.ok ? 'border-emerald-500/30 bg-emerald-500/[0.06]' : 'border-red-500/30 bg-red-500/[0.06]'
          }`}
        >
          <div className="flex items-center gap-2 text-sm font-semibold">
            {test.result.ok ? <CircleCheck size={18} className="text-emerald-500" /> : <CircleX size={18} className="text-red-500" />}
            {t(test.result.ok ? 'printer.testOk' : 'printer.testFail')}
          </div>
          {test.result.ok ? (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              {test.result.model && <ResultRow label={t('printer.resultModel')} value={test.result.model} />}
              {test.result.firmware && <ResultRow label={t('printer.resultFirmware')} value={test.result.firmware} mono />}
              {test.result.mac && <ResultRow label={t('printer.resultMac')} value={normalizeMac(test.result.mac)} mono />}
              {test.result.hostname && <ResultRow label={t('printer.resultHostname')} value={test.result.hostname} mono />}
              {test.result.resolvedHost && <ResultRow label={t('printer.resultResolved')} value={test.result.resolvedHost} mono />}
              {(test.result.creality || test.result.moonraker) && (
                <>
                  <dt className="text-muted">{t('printer.resultApis')}</dt>
                  <dd className="flex flex-wrap gap-1.5">
                    {test.result.creality && <Badge tone="sky">Creality</Badge>}
                    {test.result.moonraker && <Badge tone="violet">Moonraker</Badge>}
                  </dd>
                </>
              )}
            </dl>
          ) : (
            <p className="mt-1.5 text-sm text-muted">{probeError(test.result.error)}</p>
          )}
          {test.macFilled && <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-300">{t('printer.macFilled')}</p>}
        </div>
      )}
    </div>
  )
}

function ResultRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 truncate">{mono ? <Chip className="text-fg">{value}</Chip> : value}</dd>
    </>
  )
}
