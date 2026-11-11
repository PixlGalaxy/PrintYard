// Admin → Engine: slicer engine selection, installed / latest / previous versions, check now,
// update now (live progress over the realtime socket), rollback, auto-update settings.
import { CircleCheck, Cpu, Download, History, LoaderCircle, PackageCheck, RefreshCw, Undo2, Wrench } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { adminApi } from '../../api'
import { SettingRow } from '../../components/Card'
import ConfirmModal from '../../components/ConfirmModal'
import { inputCls } from '../../components/styles'
import { Badge, Button, Callout, ErrorState, Loading, RadioCard, Toggle } from '../../components/ui'
import { useToast } from '../../context/ToastContext'
import { timeAgo } from '../../format'
import { useI18n } from '../../i18n/I18nContext'
import { useRealtimeMessage } from '../../realtime'
import type { EngineInfo, EngineProgress } from '../../types'
import { formatBytes } from '../../validation'
import SaveBar from './SaveBar'
import { Panel } from './shared'
import { useSettings } from './useSettings'

const WORKING = ['downloading', 'extracting', 'testing'] as const

export default function EngineSection() {
  const { t, formatDate } = useI18n()
  const { toast, onError } = useToast()
  const s = useSettings()
  const [engine, setEngine] = useState<EngineInfo | null>(null)
  const [engineError, setEngineError] = useState<unknown>(null)
  const [live, setLive] = useState<EngineProgress | null>(null)
  const [checking, setChecking] = useState(false)
  const [rollback, setRollback] = useState(false)

  const load = useCallback(async () => {
    try {
      setEngine(await adminApi.engine())
      setEngineError(null)
    } catch (err) {
      setEngineError(err)
    }
  }, [])
  useEffect(() => {
    adminApi.engine().then(setEngine, setEngineError)
  }, [])

  useRealtimeMessage('engine.progress', (p) => {
    setLive(p)
    if (p.state === 'idle' || p.state === 'error') {
      void load()
      if (p.state === 'idle' && p.progress >= 100) toast('success', t('engineMgr.updated'))
      if (p.state === 'error') toast('error', p.message ?? t('engineMgr.failed'))
    }
  })

  if (s.error && !s.saved) return <ErrorState error={s.error} onRetry={() => void s.reload()} />
  if (!s.saved) return <Loading />

  const selected = s.value('engine.selected') ?? 'creality'
  const interval = s.value('engine.checkIntervalHours') ?? 24
  const intervalInvalid = !Number.isFinite(interval) || interval < 1 || interval > 720
  const state = live?.state && live.state !== 'idle' ? live.state : (engine?.state ?? 'idle')
  const working = (WORKING as readonly string[]).includes(state)
  const progress = live && live.state !== 'idle' ? live.progress : (engine?.progress ?? 0)
  const broken = !!engine?.broken
  const upToDate = !broken && !!engine?.installed && !!engine.latest && engine.installed.version === engine.latest.version

  async function check() {
    setChecking(true)
    try {
      const e = await adminApi.engineCheck()
      setEngine(e)
      toast('info', e.latest && e.installed?.version !== e.latest.version ? t('engineMgr.available', { v: e.latest.version }) : t('engineMgr.upToDate'))
    } catch (err) {
      onError(err)
    } finally {
      setChecking(false)
    }
  }

  async function update() {
    try {
      setLive({ state: 'downloading', progress: 0 })
      setEngine(await adminApi.engineUpdate())
    } catch (err) {
      setLive(null)
      onError(err)
    }
  }

  return (
    <div className="space-y-5">
      <Panel
        title={t('engineMgr.versionTitle')}
        description={t('engineMgr.versionDesc')}
        icon={<PackageCheck size={18} />}
        actions={
          <Button icon={<RefreshCw size={14} className={checking ? 'animate-spin' : ''} />} disabled={checking || working} onClick={() => void check()}>
            {t('engineMgr.check')}
          </Button>
        }
      >
        {engineError && !engine ? (
          <ErrorState error={engineError} onRetry={() => void load()} />
        ) : !engine ? (
          <Loading />
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-3">
              <VersionCard
                label={t('engineMgr.installed')}
                tone="sky"
                version={engine.installed?.version}
                sub={engine.installed ? t('engineMgr.installedAt', { when: formatDate(engine.installed.installedAt) }) : t('engineMgr.notInstalled')}
                badge={engine.installed ? broken ? <Badge tone="red">{t('engineMgr.broken')}</Badge> : upToDate ? <Badge tone="emerald"><CircleCheck size={12} /> {t('engineMgr.current')}</Badge> : <Badge tone="violet">{t('engineMgr.updateAvailable')}</Badge> : <Badge tone="amber">{t('engineMgr.missing')}</Badge>}
              />
              <VersionCard
                label={t('engineMgr.latest')}
                tone="violet"
                version={engine.latest?.version}
                sub={engine.latest ? `${formatDate(engine.latest.publishedAt)} · ${formatBytes(engine.latest.size)}` : t('engineMgr.neverChecked')}
              />
              <VersionCard
                label={t('engineMgr.previous')}
                tone="zinc"
                version={engine.previous?.version}
                sub={engine.previous ? t('engineMgr.keptForRollback') : t('engineMgr.noPrevious')}
              />
            </div>
            <p className="text-xs text-muted">
              {t('engineMgr.lastCheck', { when: engine.lastCheckAt ? timeAgo(t, engine.lastCheckAt) : t('common.never') })}
              {engine.installed && <> · <span className="font-mono">{engine.installed.path}</span></>}
            </p>

            {working && (
              <div className="rounded-xl border border-violet-500/30 bg-violet-500/[0.07] p-4" role="status" aria-live="polite">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <LoaderCircle size={16} className="animate-spin text-violet-500" />
                  {t(`engineMgr.state.${state as (typeof WORKING)[number]}`)}
                  <span className="ml-auto font-mono text-xs tabular-nums">{Math.round(progress)}%</span>
                </div>
                <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full bg-violet-500 transition-[width] duration-300" style={{ width: `${state === 'downloading' ? progress : 100}%` }} />
                </div>
                {live?.message && <p className="mt-1.5 text-xs text-muted">{live.message}</p>}
              </div>
            )}
            {broken && !working && (
              <Callout tone="error" title={t('engineMgr.brokenTitle')}>
                {t('engineMgr.brokenDesc')}
              </Callout>
            )}
            {state === 'error' && (
              <Callout tone="error" title={t('engineMgr.failed')}>
                {engine.error ?? live?.message}
              </Callout>
            )}

            <div className="flex flex-wrap gap-2">
              <Button variant="update" icon={<Download size={14} />} disabled={working || (!broken && (!engine.latest || upToDate))} onClick={() => void update()}>
                {broken ? t('engineMgr.reinstall') : engine.latest && !upToDate ? t('engineMgr.updateTo', { v: engine.latest.version }) : t('engineMgr.updateNow')}
              </Button>
              <Button icon={<Undo2 size={14} />} disabled={working || !engine.previous} onClick={() => setRollback(true)}>
                {engine.previous ? t('engineMgr.rollbackTo', { v: engine.previous.version }) : t('engineMgr.rollback')}
              </Button>
            </div>
          </>
        )}
      </Panel>

      <Panel title={t('engineAdmin.title')} description={t('engineAdmin.desc')} icon={<Cpu size={18} />}>
        <div role="radiogroup" aria-label={t('engineAdmin.selected')} className="grid gap-3 lg:grid-cols-2">
          <RadioCard
            name="engine"
            checked={selected === 'creality'}
            onChange={() => s.set('engine.selected', 'creality')}
            icon={<Cpu size={18} />}
            title={t('engine.creality')}
            badge={<Badge tone="emerald">{t('common.recommended')}</Badge>}
            description={t('engine.crealityDesc')}
          />
          <div aria-disabled className="pointer-events-none opacity-55">
            <RadioCard
              name="engine"
              checked={false}
              onChange={() => undefined}
              icon={<Wrench size={18} />}
              title={t('engine.orca')}
              badge={<Badge tone="sky">{t('common.comingSoon')}</Badge>}
              description={t('engineMgr.orcaSoon')}
            />
          </div>
        </div>
        <SettingRow label={t('engineAdmin.autoUpdate')} description={t('engineAdmin.autoUpdateHint')}>
          <Toggle checked={s.value('engine.autoUpdate') ?? true} onChange={(v) => s.set('engine.autoUpdate', v)} label={t('engineAdmin.autoUpdate')} />
        </SettingRow>
        <SettingRow label={t('engineAdmin.interval')} description={t('engineAdmin.intervalHint')}>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={720}
              aria-label={t('engineAdmin.interval')}
              aria-invalid={intervalInvalid}
              disabled={!(s.value('engine.autoUpdate') ?? true)}
              className={`${inputCls} w-24! tabular-nums`}
              value={Number.isFinite(interval) ? interval : ''}
              onChange={(e) => s.set('engine.checkIntervalHours', e.target.value === '' ? Number.NaN : Number(e.target.value))}
            />
            <span className="text-sm text-muted">{t('settings.hours')}</span>
          </div>
        </SettingRow>
      </Panel>

      <SaveBar dirty={s.dirty} saving={s.saving} invalid={intervalInvalid} onSave={() => void s.save()} onDiscard={s.discard} />

      {rollback && engine?.previous && (
        <ConfirmModal
          title={t('engineMgr.rollbackTitle')}
          confirmLabel={t('engineMgr.rollback')}
          onClose={() => setRollback(false)}
          onConfirm={async () => {
            try {
              setEngine(await adminApi.engineRollback())
              toast('success', t('engineMgr.rolledBack'))
            } catch (err) {
              onError(err)
              throw err
            }
          }}
        >
          {t('engineMgr.rollbackDesc', { from: engine.installed?.version ?? '—', to: engine.previous.version })}
        </ConfirmModal>
      )}
    </div>
  )
}

function VersionCard({ label, version, sub, badge, tone }: { label: string; version?: string; sub: string; badge?: ReactNode; tone: 'sky' | 'violet' | 'zinc' }) {
  const ring = { sky: 'bg-sky-500/10 text-sky-500', violet: 'bg-violet-500/10 text-violet-500', zinc: 'bg-zinc-500/10 text-zinc-500' }[tone]
  const Icon = tone === 'sky' ? PackageCheck : tone === 'violet' ? Download : History
  return (
    <div className="rounded-xl border border-line p-3.5">
      <div className="flex items-center gap-2">
        <span className={`flex size-7 items-center justify-center rounded-lg ${ring}`}>
          <Icon size={14} />
        </span>
        <span className="text-xs font-medium text-muted">{label}</span>
        <span className="ml-auto">{badge}</span>
      </div>
      <p className="mt-2 font-mono text-lg font-semibold">{version ?? '—'}</p>
      <p className="truncate text-xs text-muted">{sub}</p>
    </div>
  )
}

