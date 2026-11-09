import { ShieldAlert } from 'lucide-react'
import { useI18n } from '../i18n/I18nContext'
import type { DangerousGcodeDetails } from '../types'

/** The dangerous-command scan findings of `prints.dangerous_gcode` (first 20; the total may be higher). */
export default function GcodeFindings({ details }: { details: DangerousGcodeDetails }) {
  const { t, formatNumber } = useI18n()
  const findings = details.findings ?? []
  const more = Math.max(0, (details.total ?? findings.length) - findings.length)
  return (
    <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3.5">
      <p className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-300">
        <ShieldAlert size={16} />
        {t('gcodeScan.title')}
      </p>
      <p className="mt-1 text-[13px] text-red-700/90 dark:text-red-300/90">{t('gcodeScan.desc')}</p>
      <ul className="mt-2.5 max-h-56 space-y-1.5 overflow-y-auto pr-1 text-xs">
        {findings.map((f, i) => (
          <li key={`${f.line}-${i}`} className="rounded-lg bg-surface/70 px-2.5 py-1.5">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{t(`gcodeScan.reason.${f.reason}`)}</span>
              <span className="text-muted">{t('gcodeScan.line', { line: formatNumber(f.line) })}</span>
            </span>
            <code className="mt-0.5 block truncate font-mono text-[11px] text-muted" title={f.command}>
              {f.command}
              {f.detail && f.detail !== f.command && <span className="text-red-600 dark:text-red-400"> · {f.detail}</span>}
            </code>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="mt-2 text-xs text-muted">{t('gcodeScan.more', { count: formatNumber(more) })}</p>}
    </div>
  )
}
