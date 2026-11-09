import { BellRing, CircleCheck, CircleX, Gauge, MessageSquare, Save, Send, Smartphone, Webhook, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { ApiError, notifyApi } from '../../../api'
import { inputCls } from '../../../components/styles'
import { Button, Callout, ErrorState, Field, Loading, Toggle } from '../../../components/ui'
import { useToast } from '../../../context/ToastContext'
import { useLoader } from '../../../hooks'
import { useI18n } from '../../../i18n/I18nContext'
import type { TranslationKey } from '../../../i18n/translations'
import { NOTIFY_CHANNELS, type AdminNotifications, type NotifyChannel, type NotifyChannelStatus, type NotifyEvent } from '../../../types'
import { EVENT_GROUPS, eventLabel } from '../../account/notifications/events'
import { Panel } from '../shared'

const MASK = '********'

interface FieldDef {
  key: string
  label: TranslationKey
  hint: TranslationKey
  secret?: boolean
  placeholder?: string
}

const CHANNEL_META: Record<NotifyChannel, { icon: LucideIcon; title: TranslationKey; desc: TranslationKey; fields: FieldDef[] }> = {
  discord: {
    icon: MessageSquare,
    title: 'notify.channel.discord',
    desc: 'notify.channelDesc.discord',
    fields: [
      { key: 'webhookUrl', label: 'notify.field.webhookUrl', hint: 'notify.field.webhookUrlHint', secret: true, placeholder: 'https://discord.com/api/webhooks/…' },
      { key: 'mention', label: 'notify.field.mention', hint: 'notify.field.mentionHint', placeholder: '<@&123456789012345678>' },
    ],
  },
  telegram: {
    icon: Send,
    title: 'notify.channel.telegram',
    desc: 'notify.channelDesc.telegram',
    fields: [
      { key: 'botToken', label: 'notify.field.botToken', hint: 'notify.field.botTokenHint', secret: true, placeholder: '123456789:AA…' },
      { key: 'chatId', label: 'notify.field.chatId', hint: 'notify.field.chatIdHint', placeholder: '-1001234567890' },
    ],
  },
  ntfy: {
    icon: BellRing,
    title: 'notify.channel.ntfy',
    desc: 'notify.channelDesc.ntfy',
    fields: [
      { key: 'serverUrl', label: 'notify.field.serverUrl', hint: 'notify.field.serverUrlHint', placeholder: 'https://ntfy.sh' },
      { key: 'topic', label: 'notify.field.topic', hint: 'notify.field.topicHint', placeholder: 'slicedock-k2-7f3a' },
      { key: 'token', label: 'notify.field.token', hint: 'notify.field.tokenHint', secret: true, placeholder: 'tk_…' },
    ],
  },
  webhook: {
    icon: Webhook,
    title: 'notify.channel.webhook',
    desc: 'notify.channelDesc.webhook',
    fields: [
      { key: 'url', label: 'notify.field.url', hint: 'notify.field.urlHint', secret: true, placeholder: 'https://example.com/hooks/slicedock' },
      { key: 'secret', label: 'notify.field.secret', hint: 'notify.field.secretHint', secret: true },
    ],
  },
}

/** Admin → Notifications: Discord, Telegram, ntfy and webhook channels + Web Push facts. */
export default function NotificationsSection() {
  const { t } = useI18n()
  const [, setParams] = useSearchParams()
  const { data, error, reload, setData } = useLoader(notifyApi.admin)

  if (error && !data) return <ErrorState error={error} onRetry={() => void reload()} />
  if (!data) return <Loading />

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">{t('notify.adminDesc')}</p>
      {data.push.subjectFallback && (
        <Callout tone="warning" title={t('notify.subjectFallbackTitle')}>
          <p>{t('notify.subjectFallback')}</p>
          <Button size="xs" className="mt-2" onClick={() => setParams({ section: 'settings' }, { replace: true })}>
            {t('notify.goSettings')}
          </Button>
        </Callout>
      )}
      <div className="flex items-center gap-2 text-sm text-muted">
        <Smartphone size={16} aria-hidden />
        {t('notify.pushInfo', { count: data.push.devices })}
      </div>
      <RateLimitInfo data={data} />
      {NOTIFY_CHANNELS.map((c) => (
        <ChannelCard key={c} channel={c} data={data} onSaved={setData} reload={() => void reload()} />
      ))}
    </div>
  )
}

type Draft = Record<string, unknown>

function ChannelCard({
  channel,
  data,
  onSaved,
  reload,
}: {
  channel: NotifyChannel
  data: AdminNotifications
  onSaved: (d: AdminNotifications) => void
  reload: () => void
}) {
  const { t } = useI18n()
  const { toast, onError } = useToast()
  const meta = CHANNEL_META[channel]
  const saved = data.channels[channel] as unknown as Record<string, unknown>
  const [draft, setDraft] = useState<Draft>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const value = (k: string) => (k in draft ? draft[k] : saved[k])
  const dirty = Object.keys(draft).some((k) => JSON.stringify(draft[k]) !== JSON.stringify(saved[k]))
  const set = (k: string, v: unknown) => {
    setDraft((d) => ({ ...d, [k]: v }))
    setErrors((e) => {
      const { [k]: _drop, ...rest } = e
      return rest
    })
  }
  const unset = (k: string) =>
    setDraft((d) => {
      const { [k]: _drop, ...rest } = d
      return rest
    })

  const enabled = value('enabled') === true
  const events = (value('events') as NotifyEvent[] | undefined) ?? []

  async function save(): Promise<boolean> {
    if (!dirty) return true
    setSaving(true)
    try {
      onSaved(await notifyApi.updateChannel(channel, draft as never))
      setDraft({})
      setErrors({})
      toast('success', t('common.saved'))
      return true
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation.failed' && Array.isArray(err.details)) {
        setErrors(Object.fromEntries((err.details as { path: string; message: string }[]).map((d) => [d.path, d.message])))
      }
      onError(err)
      return false
    } finally {
      setSaving(false)
    }
  }

  async function test() {
    if (!(await save())) return
    setTesting(true)
    try {
      await notifyApi.testChannel(channel)
      toast('success', t('notify.testOk'))
    } catch (err) {
      onError(err)
    } finally {
      setTesting(false)
      reload()
    }
  }

  const Icon = meta.icon
  return (
    <Panel
      title={t(meta.title)}
      description={t(meta.desc)}
      icon={<Icon size={18} />}
      actions={<Toggle checked={enabled} label={t('notify.toggleChannel', { channel: t(meta.title) })} onChange={(v) => set('enabled', v)} />}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {meta.fields.map((f) => {
          const raw = value(f.key)
          const storedSecret = f.secret && saved[f.key] === MASK
          const cleared = f.secret && draft[f.key] === ''
          // Secrets: an untouched stored value shows as empty with a "saved" placeholder; typing replaces it
          const shown = f.secret ? (f.key in draft ? String(draft[f.key] ?? '') : '') : String(raw ?? '')
          return (
            <Field key={f.key} label={t(f.label)} hint={t(f.hint)} error={errors[f.key] ?? null} optional={f.key === 'mention' || f.key === 'token' || f.key === 'secret'}>
              {(p) => (
                <div className="flex gap-2">
                  <input
                    {...p}
                    type={f.secret ? 'password' : 'text'}
                    autoComplete="off"
                    spellCheck={false}
                    className={`${inputCls} font-mono`}
                    placeholder={storedSecret && !cleared ? t('notify.secretSaved') : f.placeholder}
                    value={shown}
                    onChange={(e) => {
                      const v = e.target.value
                      if (f.secret && v === '') unset(f.key)
                      else set(f.key, v)
                    }}
                  />
                  {storedSecret && !cleared && (
                    <Button size="md" onClick={() => set(f.key, '')}>
                      {t('notify.clearSecret')}
                    </Button>
                  )}
                </div>
              )}
            </Field>
          )
        })}
      </div>

      {channel === 'ntfy' && (
        <div className="flex items-start justify-between gap-4 rounded-lg border border-line p-3">
          <div>
            <div className="text-sm font-medium">{t('notify.field.localServer')}</div>
            <p className="text-xs text-muted">{t('notify.field.localServerHint')}</p>
          </div>
          <Toggle checked={value('localServer') === true} label={t('notify.field.localServer')} onChange={(v) => set('localServer', v)} />
        </div>
      )}

      <EventPicker value={events} onChange={(v) => set('events', v)} />

      <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
        <DeliveryStatus status={data.status[channel]} />
        <div className="flex shrink-0 gap-2">
          <Button icon={<Send size={14} />} loading={testing} disabled={saving} onClick={() => void test()}>
            {t('notify.test')}
          </Button>
          <Button variant="primary" icon={<Save size={14} />} loading={saving} disabled={!dirty} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Panel>
  )
}

/** Flood protection: what is rate-limited and who is being held back right now (review 3A #3). */
function RateLimitInfo({ data }: { data: AdminNotifications }) {
  const { t, formatDate } = useI18n()
  const rl = data.rateLimit
  if (!rl) return null
  return (
    <div className="rounded-lg border border-line p-3 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <Gauge size={16} aria-hidden />
        {t('notify.rateLimit.title')}
      </div>
      <p className="mt-1 text-xs text-muted">
        {t('notify.rateLimit.desc', { max: rl.maxPerWindow, minutes: rl.windowMinutes, events: rl.events.map((e) => eventLabel(t, e)).join(', ') })}
      </p>
      {rl.heldTotal > 0 && <p className="mt-1 text-xs text-muted">{t('notify.rateLimit.totals', { held: rl.heldTotal, digests: rl.digestsSent })}</p>}
      {rl.active.length > 0 && (
        <ul className="mt-2 space-y-1">
          {rl.active.map((a) => (
            <li key={`${a.userId}:${a.event}`} className="flex flex-wrap items-center gap-x-2 text-xs">
              <span className="font-medium">{a.username ?? `#${a.userId}`}</span>
              <span className="text-muted">{eventLabel(t, a.event)}</span>
              <span className="text-amber-600 dark:text-amber-400">
                {t('notify.rateLimit.held', { n: a.held })}
                {a.digestAt !== null && ` · ${t('notify.rateLimit.digestAt', { date: formatDate(a.digestAt) })}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function EventPicker({ value, onChange }: { value: NotifyEvent[]; onChange: (v: NotifyEvent[]) => void }) {
  const { t } = useI18n()
  const on = new Set(value)
  const all = EVENT_GROUPS.flatMap((g) => g.events)
  const toggle = (e: NotifyEvent) => onChange(all.filter((x) => (x === e ? !on.has(e) : on.has(x))))
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{t('notify.channelEvents')}</div>
        <div className="flex gap-1">
          <Button size="xs" variant="ghost" onClick={() => onChange(all)}>
            {t('notify.all')}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => onChange([])}>
            {t('notify.none')}
          </Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {EVENT_GROUPS.map((g) => (
          <fieldset key={g.key} className="space-y-1.5">
            <legend className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">{t(g.label)}</legend>
            <div className="flex flex-wrap gap-1.5">
              {g.events.map((e) => (
                <button
                  key={e}
                  type="button"
                  aria-pressed={on.has(e)}
                  onClick={() => toggle(e)}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent-500 ${
                    on.has(e) ? 'border-accent-500/40 bg-accent-500/10 text-accent-600 dark:text-accent-400' : 'border-line text-muted hover:text-fg'
                  }`}
                >
                  {eventLabel(t, e)}
                </button>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </div>
  )
}

function DeliveryStatus({ status }: { status: NotifyChannelStatus }) {
  const { t, formatDate } = useI18n()
  const failed = status.lastErrorAt !== null && (status.lastSuccessAt === null || status.lastErrorAt > status.lastSuccessAt)
  if (failed) {
    return (
      <div className="min-w-0 text-xs text-red-600 dark:text-red-400">
        <div className="flex items-center gap-1.5 font-medium">
          <CircleX size={14} aria-hidden />
          {t('notify.status.failed', { date: formatDate(status.lastErrorAt!) })}
        </div>
        {status.lastError && <p className="mt-0.5 font-mono break-all opacity-90">{status.lastError}</p>}
      </div>
    )
  }
  if (status.lastSuccessAt !== null) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
        <CircleCheck size={14} aria-hidden />
        {t('notify.status.ok', { date: formatDate(status.lastSuccessAt) })}
      </div>
    )
  }
  return <div className="text-xs text-muted">{t('notify.status.never')}</div>
}
