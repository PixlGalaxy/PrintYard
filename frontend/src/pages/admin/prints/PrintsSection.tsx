// Admin → Prints: pending approvals (approve / reject with reason; handles "bed occupied"),
// history of all prints, and usage per user this month vs their limits.
import { Check, ClipboardList, FileCode2, Hourglass, Scale, ShieldAlert, TriangleAlert, Users, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { adminApi, api, ApiError } from '../../../api'
import GcodeFindings from '../../../components/GcodeFindings'
import Modal from '../../../components/Modal'
import { selectCls, tdCls, textareaCls, thCls } from '../../../components/styles'
import { Badge, Button, Callout, Empty, ErrorState, Loading, Meter } from '../../../components/ui'
import { useToast } from '../../../context/ToastContext'
import { timeAgo } from '../../../format'
import { formatDuration } from '../../../gcode/format'
import { useI18n } from '../../../i18n/I18nContext'
import { useRealtimeMessage } from '../../../realtime'
import type { AdminUser, DangerousGcodeDetails, PrintJob, PrintRequestState } from '../../../types'
import { PrintStateBadge } from '../../workspace/printer/PrintStateBadge'
import ReadOnlyHint from '../../../components/ReadOnlyHint'
import { useReadOnly } from '../../../readOnly'
import { Panel } from '../shared'

type ApproveOpts = { confirmBedClear?: boolean; force?: boolean; allowDangerous?: boolean }

export default function PrintsSection() {
  const { t, formatNumber, formatDate, errorMessage } = useI18n()
  const { toast, onError } = useToast()
  const [pending, setPending] = useState<PrintJob[] | null>(null)
  const [all, setAll] = useState<PrintJob[] | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [error, setError] = useState<unknown>(null)
  const [rejecting, setRejecting] = useState<PrintJob | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [bedBlock, setBedBlock] = useState<{ job: PrintJob; opts: ApproveOpts; fileName: string | null; endedAt: number | null } | null>(null)
  /** Approval stopped by a re-check the admin may override: limits now exceeded (force) or dangerous G-code (allowDangerous). */
  const [override, setOverride] = useState<
    { job: PrintJob; opts: ApproveOpts; kind: 'limit'; message: string } | { job: PrintJob; opts: ApproveOpts; kind: 'dangerous'; details: DangerousGcodeDetails } | null
  >(null)
  const [overrideAck, setOverrideAck] = useState(false)
  const [filter, setFilter] = useState<PrintRequestState | 'all'>('all')
  const readOnly = useReadOnly()
  const [monthStart] = useState(() => {
    const d = new Date()
    d.setDate(1)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  })

  const load = useCallback(async () => {
    try {
      const [p, a, u] = await Promise.all([adminApi.pendingPrints(), api.prints('all'), adminApi.users()])
      setPending(p)
      setAll(a)
      setUsers(u)
      setError(null)
    } catch (err) {
      setError(err)
    }
  }, [])
  useEffect(() => {
    Promise.all([adminApi.pendingPrints(), api.prints('all'), adminApi.users()]).then(([p, a, u]) => {
      setPending(p)
      setAll(a)
      setUsers(u)
    }, setError)
  }, [])

  useRealtimeMessage('approval.pending', (job) => {
    setPending((cur) => (cur && !cur.some((j) => j.id === job.id) ? [...cur, job] : cur))
    setAll((cur) => (cur && !cur.some((j) => j.id === job.id) ? [job, ...cur] : cur))
  })
  useRealtimeMessage('print.update', (job) => {
    setAll((cur) => cur?.map((j) => (j.id === job.id ? job : j)) ?? cur)
    if (job.state !== 'pending') setPending((cur) => cur?.filter((j) => j.id !== job.id) ?? cur)
  })

  async function approve(job: PrintJob, opts: ApproveOpts = {}) {
    setBusyId(job.id)
    try {
      const res = await adminApi.approvePrint(job.id, opts)
      toast('success', t('prints.approved', { name: job.username }))
      setPending((cur) => cur?.filter((j) => j.id !== job.id) ?? cur)
      setAll((cur) => cur?.map((j) => (j.id === res.id ? res : j)) ?? cur)
      setBedBlock(null)
      setOverride(null)
    } catch (err) {
      setBedBlock(null)
      setOverride(null)
      setOverrideAck(false)
      if (err instanceof ApiError && err.code === 'prints.bed_not_cleared') {
        const d = (err.details ?? {}) as { fileName?: string; endedAt?: number }
        setBedBlock({ job, opts, fileName: d.fileName ?? null, endedAt: d.endedAt ?? null })
      } else if (err instanceof ApiError && err.code.startsWith('prints.limit_') && !opts.force) {
        setOverride({ job, opts, kind: 'limit', message: errorMessage(err) })
      } else if (err instanceof ApiError && err.code === 'prints.dangerous_gcode' && !opts.allowDangerous) {
        setOverride({ job, opts, kind: 'dangerous', details: (err.details ?? { total: 0, findings: [] }) as DangerousGcodeDetails })
      } else {
        onError(err)
        if (err instanceof ApiError && err.code === 'prints.file_changed') void load()
      }
    } finally {
      setBusyId(null)
    }
  }

  // Usage this calendar month per user (done + printing), from the print history
  const usage = useMemo(() => {
    const map = new Map<number, { grams: number; prints: number }>()
    for (const p of all ?? []) {
      if (p.userId == null || p.createdAt < monthStart || (p.state !== 'done' && p.state !== 'printing')) continue
      const u = map.get(p.userId) ?? { grams: 0, prints: 0 }
      u.grams += p.grams ?? 0
      u.prints++
      map.set(p.userId, u)
    }
    return users.map((u) => ({ user: u, ...(map.get(u.id) ?? { grams: 0, prints: 0 }) })).sort((a, b) => b.grams - a.grams)
  }, [all, users, monthStart])

  if (error && !all) return <ErrorState error={error} onRetry={() => void load()} />
  if (!all || !pending) return <Loading />

  const history = all.filter((p) => filter === 'all' || p.state === filter)
  const g = (v: number | null) => (v == null ? '—' : `${formatNumber(v, { maximumFractionDigits: 1 })} g`)

  return (
    <div className="space-y-5">
      <Panel
        title={t('prints.admin.pending')}
        description={t('prints.admin.pendingDesc')}
        icon={<Hourglass size={18} />}
        actions={pending.length > 0 ? <Badge tone="amber">{pending.length}</Badge> : undefined}
        flush
      >
        {pending.length === 0 ? (
          <Empty icon={<Check size={20} />}>{t('prints.admin.noPending')}</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {pending.map((j) => {
              const u = users.find((x) => x.id === j.userId)
              const overMonth = u?.limits.maxGramsPerMonth != null && j.grams != null && (usage.find((x) => x.user.id === j.userId)?.grams ?? 0) + j.grams > u.limits.maxGramsPerMonth
              return (
                <li key={j.id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:px-5">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
                    <FileCode2 size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{j.fileName}</p>
                    <p className="text-xs text-muted">
                      <span className="font-medium text-fg/80">{j.username}</span> · {timeAgo(t, j.createdAt)} · {formatDuration(j.seconds)} · {g(j.grams)}
                      {j.costEstimate != null && ` · ${formatNumber(j.costEstimate, { maximumFractionDigits: 2 })}`}
                    </p>
                    {overMonth && (
                      <p className="mt-1 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                        <TriangleAlert size={12} /> {t('prints.admin.overMonth')}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="danger" icon={<X size={14} />} disabled={busyId === j.id} onClick={() => setRejecting(j)}>
                      {t('prints.admin.reject')}
                    </Button>
                    <ReadOnlyHint>
                      <Button size="sm" variant="primary" icon={<Check size={14} />} loading={busyId === j.id} disabled={readOnly} onClick={() => void approve(j)}>
                        {t('prints.admin.approve')}
                      </Button>
                    </ReadOnlyHint>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

      <Panel title={t('prints.admin.usage')} description={t('prints.admin.usageDesc')} icon={<Users size={18} />} flush>
        <div className="overflow-x-auto px-4 sm:px-5">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left">
              <tr>
                <th className={thCls}>{t('prints.admin.user')}</th>
                <th className={thCls}>{t('prints.admin.month')}</th>
                <th className={`${thCls} max-sm:hidden`}>{t('prints.admin.prints')}</th>
                <th className={`${thCls} max-md:hidden`}>{t('prints.admin.limits')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {usage.map(({ user, grams, prints }) => {
                const l = user.limits
                return (
                  <tr key={user.id}>
                    <td className={`${tdCls} font-medium`}>{user.username}</td>
                    <td className={`${tdCls} w-1/3 min-w-40`}>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs tabular-nums">
                          {g(grams)}
                          {l.enabled && l.maxGramsPerMonth != null && <span className="text-muted"> / {g(l.maxGramsPerMonth)}</span>}
                        </span>
                      </div>
                      {l.enabled && l.maxGramsPerMonth != null && (
                        <div className="mt-1">
                          <Meter value={(grams / l.maxGramsPerMonth) * 100} />
                        </div>
                      )}
                    </td>
                    <td className={`${tdCls} font-mono text-xs tabular-nums max-sm:hidden`}>{prints}</td>
                    <td className={`${tdCls} text-xs text-muted max-md:hidden`}>
                      {l.enabled ? (
                        <span className="flex flex-wrap gap-1">
                          {l.maxGramsPerPrint != null && <Badge tone="sky"><Scale size={10} /> {g(l.maxGramsPerPrint)}</Badge>}
                          {l.maxHoursPerPrint != null && <Badge tone="sky">{l.maxHoursPerPrint} h</Badge>}
                          {l.requiresApproval && <Badge tone="amber">{t('prints.needsApproval')}</Badge>}
                        </span>
                      ) : (
                        t('prints.admin.noLimits')
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title={t('prints.admin.history')}
        description={t('prints.admin.historyDesc')}
        icon={<ClipboardList size={18} />}
        flush
        actions={
          <select aria-label={t('prints.admin.filter')} value={filter} onChange={(e) => setFilter(e.target.value as PrintRequestState | 'all')} className={`${selectCls} h-8! w-auto! text-xs`}>
            {(['all', 'pending', 'printing', 'done', 'failed', 'cancelled', 'rejected'] as const).map((s) => (
              <option key={s} value={s}>
                {s === 'all' ? t('prints.admin.allStates') : t(`prints.state.${s}`)}
              </option>
            ))}
          </select>
        }
      >
        {history.length === 0 ? (
          <Empty>{t('prints.admin.noHistory')}</Empty>
        ) : (
          <div className="overflow-x-auto px-4 sm:px-5">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left">
                <tr>
                  <th className={thCls}>{t('prints.admin.file')}</th>
                  <th className={thCls}>{t('prints.admin.user')}</th>
                  <th className={thCls}>{t('prints.admin.state')}</th>
                  <th className={`${thCls} text-right`}>{t('prints.admin.grams')}</th>
                  <th className={`${thCls} max-md:hidden`}>{t('prints.admin.duration')}</th>
                  <th className={`${thCls} max-lg:hidden`}>{t('prints.admin.date')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {history.map((p) => (
                  <tr key={p.id}>
                    <td className={`${tdCls} max-w-64 truncate font-medium`} title={p.reason ? `${p.fileName} — ${p.reason === 'user_deleted' ? t('prints.reason.userDeleted') : p.reason}` : p.fileName}>
                      {p.fileName}
                      {p.reason && <span className="block truncate text-xs font-normal text-muted">{p.reason === 'user_deleted' ? t('prints.reason.userDeleted') : p.reason}</span>}
                    </td>
                    <td className={tdCls}>{p.username}</td>
                    <td className={tdCls}>
                      <PrintStateBadge state={p.state} />
                    </td>
                    <td className={`${tdCls} text-right font-mono text-xs tabular-nums`}>{g(p.grams)}</td>
                    <td className={`${tdCls} text-xs text-muted max-md:hidden`}>{formatDuration(p.seconds)}</td>
                    <td className={`${tdCls} text-xs text-muted max-lg:hidden`}>{formatDate(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {rejecting && <RejectModal job={rejecting} onClose={() => setRejecting(null)} onDone={(j) => {
        setPending((cur) => cur?.filter((x) => x.id !== j.id) ?? cur)
        setAll((cur) => cur?.map((x) => (x.id === j.id ? j : x)) ?? cur)
      }} />}

      {bedBlock && (
        <Modal
          size="sm"
          title={t('prints.admin.bedTitle')}
          icon={<TriangleAlert size={18} className="text-amber-500" />}
          onClose={() => setBedBlock(null)}
          footer={
            <>
              <Button onClick={() => setBedBlock(null)}>{t('common.cancel')}</Button>
              <Button variant="warning" loading={busyId === bedBlock.job.id} disabled={readOnly} onClick={() => void approve(bedBlock.job, { ...bedBlock.opts, confirmBedClear: true })}>
                {t('prints.admin.bedClearApprove')}
              </Button>
            </>
          }
        >
          <Callout tone="warning">
            {bedBlock.fileName ? t('prints.bedPrevious', { name: bedBlock.fileName, when: timeAgo(t, bedBlock.endedAt) }) : t('prints.bedHint')}
          </Callout>
          <p className="mt-3 text-sm text-muted">{t('prints.admin.bedDesc')}</p>
        </Modal>
      )}

      {override && (
        <Modal
          size={override.kind === 'dangerous' ? 'md' : 'sm'}
          title={t(override.kind === 'limit' ? 'prints.admin.limitTitle' : 'prints.admin.dangerTitle')}
          subtitle={`${override.job.fileName} · ${override.job.username}`}
          icon={override.kind === 'limit' ? <TriangleAlert size={18} className="text-amber-500" /> : <ShieldAlert size={18} className="text-red-500" />}
          onClose={() => setOverride(null)}
          footer={
            <>
              <Button onClick={() => setOverride(null)}>{t('common.cancel')}</Button>
              <Button
                variant={override.kind === 'limit' ? 'warning' : 'danger'}
                loading={busyId === override.job.id}
                disabled={readOnly || (override.kind === 'dangerous' && !overrideAck)}
                onClick={() =>
                  void approve(override.job, override.kind === 'limit' ? { ...override.opts, force: true } : { ...override.opts, allowDangerous: true })
                }
              >
                {t(override.kind === 'limit' ? 'prints.admin.forceApprove' : 'gcodeScan.printAnyway')}
              </Button>
            </>
          }
        >
          {override.kind === 'limit' ? (
            <>
              <Callout tone="warning">{override.message}</Callout>
              <p className="mt-3 text-sm text-muted">{t('prints.admin.limitDesc')}</p>
            </>
          ) : (
            <div className="space-y-3">
              <GcodeFindings details={override.details} />
              <p className="text-[13px] font-medium text-red-700 dark:text-red-300">{t('gcodeScan.overrideWarning')}</p>
              <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium">
                <input type="checkbox" className="size-4 accent-red-500" checked={overrideAck} onChange={(e) => setOverrideAck(e.target.checked)} />
                {t('gcodeScan.overrideConfirm')}
              </label>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}

function RejectModal({ job, onClose, onDone }: { job: PrintJob; onClose: () => void; onDone: (j: PrintJob) => void }) {
  const { t } = useI18n()
  const { toast, onError } = useToast()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      const j = await adminApi.rejectPrint(job.id, reason.trim())
      toast('success', t('prints.rejected', { name: job.username }))
      onDone(j)
      onClose()
    } catch (err) {
      onError(err)
      setBusy(false)
    }
  }
  return (
    <Modal
      size="sm"
      title={t('prints.admin.rejectTitle')}
      subtitle={`${job.fileName} · ${job.username}`}
      icon={<X size={18} className="text-red-500" />}
      onClose={onClose}
      dismissable={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void submit()}>
            {t('prints.admin.reject')}
          </Button>
        </>
      }
    >
      <label htmlFor="reject-reason" className="mb-1.5 block text-sm font-medium">
        {t('prints.admin.reason')} <span className="text-xs font-normal text-muted">({t('common.optional')})</span>
      </label>
      <textarea id="reject-reason" rows={3} maxLength={300} className={textareaCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('prints.admin.reasonPlaceholder')} />
    </Modal>
  )
}
