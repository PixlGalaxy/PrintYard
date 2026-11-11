import { Bell, BellOff, BellRing, Monitor, Send, Share, Smartphone, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { notifyApi } from '../../../api'
import Card from '../../../components/Card'
import { Badge, Button, Callout, ErrorState, IconButton, Loading, Toggle } from '../../../components/ui'
import { useToast } from '../../../context/ToastContext'
import { useLoader } from '../../../hooks'
import { useI18n } from '../../../i18n/I18nContext'
import type { AccountNotifications, NotifyEvent, PushDevice } from '../../../types'
import { EVENT_GROUPS, eventLabel } from './events'
import { currentEndpoint, detectEnvironment, deviceLabel, disablePush, enablePush, hashEndpoint, type PushEnvironment } from './pushClient'

/** Account → Notifications: this device on/off, my devices, per-event toggles, test. */
export default function NotificationsCard() {
  const { t } = useI18n()
  const { data, error, reload, setData } = useLoader(notifyApi.mine)
  const [env, setEnv] = useState<PushEnvironment>(() => detectEnvironment())
  /** Hash of this browser's push endpoint (matches PushDevice.endpointHash), null when not subscribed */
  const [endpoint, setEndpoint] = useState<string | null>(null)

  const refreshEndpoint = useCallback(async () => {
    const raw = await currentEndpoint().catch(() => null)
    setEnv(detectEnvironment()) // permission may have changed
    setEndpoint(raw ? await hashEndpoint(raw) : null)
  }, [])
  useEffect(() => {
    let alive = true
    void currentEndpoint()
      .catch(() => null)
      .then((raw) => (raw ? hashEndpoint(raw) : null))
      .then((hash) => {
        if (alive) setEndpoint(hash)
      })
    return () => {
      alive = false
    }
  }, [])

  return (
    <Card title={t('account.notifications')} description={t('account.notificationsDesc')} icon={<Bell size={18} />}>
      {error && !data ? (
        <ErrorState error={error} onRetry={() => void reload()} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <ThisDevice
            env={env}
            data={data}
            endpoint={endpoint}
            onChanged={async () => {
              await refreshEndpoint()
              await reload()
            }}
          />
          <Devices data={data} endpoint={endpoint} onChanged={() => void reload()} />
          <EventToggles data={data} onSaved={setData} />
        </>
      )}
    </Card>
  )
}

function ThisDevice({
  env,
  data,
  endpoint,
  onChanged,
}: {
  env: PushEnvironment
  data: AccountNotifications
  endpoint: string | null
  onChanged: () => Promise<void>
}) {
  const { t } = useI18n()
  const { toast, onError } = useToast()
  const [busy, setBusy] = useState(false)
  const on = !!endpoint && data.devices.some((d) => d.endpointHash === endpoint)
  const denied = env.permission === 'denied'

  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true)
    try {
      await fn()
      toast('success', done)
    } catch (err) {
      onError(err)
    } finally {
      setBusy(false)
      await onChanged()
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${on ? 'bg-emerald-500/10 text-emerald-500' : 'bg-surface-2 text-muted'}`}>
            {on ? <BellRing size={18} /> : <BellOff size={18} />}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">{t('notify.thisDevice')}</div>
            <div className="text-xs text-muted">{t(on ? 'notify.onHere' : 'notify.offHere')}</div>
          </div>
        </div>
        {!env.blocker &&
          (on ? (
            <Button icon={<BellOff size={14} />} loading={busy} onClick={() => void run(disablePush, t('notify.disabledToast'))}>
              {t('notify.disable')}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<Bell size={14} />}
              loading={busy}
              disabled={denied}
              onClick={() => void run(() => enablePush(data.vapidPublicKey), t('notify.enabledToast'))}
            >
              {t('notify.enable')}
            </Button>
          ))}
      </div>

      {denied && !env.blocker && <Callout tone="warning">{t('notify.permissionDenied')}</Callout>}
      {env.blocker === 'insecure' && <Callout tone="warning">{t('notify.blocker.insecure')}</Callout>}
      {env.blocker === 'unsupported' && <Callout tone="info">{t('notify.blocker.unsupported')}</Callout>}
      {env.blocker === 'dev-no-sw' && <Callout tone="info">{t('notify.blocker.devNoSw')}</Callout>}
      {env.blocker === 'ios-version' && <Callout tone="warning">{t('notify.ios.version')}</Callout>}
      {env.ios && !env.standalone && env.blocker !== 'ios-version' && <IosGuide />}
    </div>
  )
}

function IosGuide() {
  const { t } = useI18n()
  return (
    <Callout tone="info" title={t('notify.ios.title')}>
      <ol className="list-decimal space-y-0.5 pl-4">
        <li>{t('notify.ios.step1')}</li>
        <li>
          <span className="inline-flex items-center gap-1">
            {t('notify.ios.step2')} <Share size={12} aria-hidden />
          </span>
        </li>
        <li>{t('notify.ios.step3')}</li>
      </ol>
      <p className="mt-1">{t('notify.ios.https')}</p>
    </Callout>
  )
}

function Devices({ data, endpoint, onChanged }: { data: AccountNotifications; endpoint: string | null; onChanged: () => void }) {
  const { t, formatDate } = useI18n()
  const { toast, onError } = useToast()
  const [testing, setTesting] = useState(false)
  const [removing, setRemoving] = useState<number | null>(null)

  async function test() {
    setTesting(true)
    try {
      const r = await notifyApi.sendTest()
      toast(r.failed ? 'error' : 'success', r.failed ? t('notify.testPartial', { sent: r.sent, failed: r.failed }) : t('notify.testSent', { sent: r.sent }))
      if (r.removed) onChanged()
    } catch (err) {
      onError(err)
    } finally {
      setTesting(false)
    }
  }

  async function remove(d: PushDevice) {
    setRemoving(d.id)
    try {
      await notifyApi.removeDevice(d.id)
      toast('success', t('notify.deviceRemoved'))
      onChanged()
    } catch (err) {
      onError(err)
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{t('notify.devices')}</h3>
        <Button size="xs" icon={<Send size={14} />} loading={testing} disabled={data.devices.length === 0} onClick={() => void test()}>
          {t('notify.sendTest')}
        </Button>
      </div>
      {data.devices.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-xs text-muted">{t('notify.devicesEmpty')}</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {data.devices.map((d) => {
            const label = deviceLabel(d.userAgent)
            const isCurrent = endpoint !== null && d.endpointHash === endpoint
            const Icon = label.mobile ? Smartphone : Monitor
            return (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2.5">
                <Icon size={18} className="shrink-0 text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className="truncate">
                      {label.browser} · {label.os}
                    </span>
                    {isCurrent && <Badge tone="sky">{t('notify.thisDevice')}</Badge>}
                    {d.failCount > 0 && <Badge tone="amber">{t('notify.failing', { count: d.failCount })}</Badge>}
                  </div>
                  <div className="truncate text-xs text-muted">
                    {t('notify.addedOn', { date: formatDate(d.createdAt) })}
                    {d.lastSuccessAt ? ` · ${t('notify.lastDelivery', { date: formatDate(d.lastSuccessAt) })}` : ''}
                  </div>
                </div>
                <IconButton label={t('notify.removeDevice')} tone="danger" disabled={removing === d.id} onClick={() => void remove(d)}>
                  <Trash2 size={16} />
                </IconButton>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function EventToggles({ data, onSaved }: { data: AccountNotifications; onSaved: (d: AccountNotifications) => void }) {
  const { t } = useI18n()
  const { onError } = useToast()
  const [saving, setSaving] = useState(false)
  const allowed = new Set(data.events)
  const on = new Set(data.prefs.events)

  async function toggle(e: NotifyEvent, value: boolean) {
    const next = data.events.filter((x) => (x === e ? value : on.has(x)))
    onSaved({ ...data, prefs: { events: next } }) // optimistic
    setSaving(true)
    try {
      onSaved(await notifyApi.setPrefs(next))
    } catch (err) {
      onSaved(data)
      onError(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">{t('notify.events')}</h3>
        <p className="text-xs text-muted">{t('notify.eventsDesc')}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {EVENT_GROUPS.map((g) => {
          const events = g.events.filter((e) => allowed.has(e))
          if (events.length === 0) return null
          return (
            <fieldset key={g.key} className="space-y-2">
              <legend className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">{t(g.label)}</legend>
              {events.map((e) => (
                <label key={e} className="flex items-center justify-between gap-3 text-sm">
                  <span>{eventLabel(t, e)}</span>
                  <Toggle checked={on.has(e)} disabled={saving} label={eventLabel(t, e)} onChange={(v) => void toggle(e, v)} />
                </label>
              ))}
            </fieldset>
          )
        })}
      </div>
    </div>
  )
}

