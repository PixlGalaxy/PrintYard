// What an import did: profiles created, keys left out (and why), parents replaced, names changed, files skipped.
import { ArrowRight, CircleCheck, CircleSlash, FileWarning, PencilLine, Shuffle } from 'lucide-react'
import type { ReactNode } from 'react'
import Modal from '../../../components/Modal'
import { Badge, Button } from '../../../components/ui'
import { useI18n } from '../../../i18n/I18nContext'
import type { TranslationKey } from '../../../i18n/translations'
import type { ProfileImportReport } from '../../../types'
import { shortPresetName } from '../../../workspace/profiles'

const REASONS: Record<string, TranslationKey> = {
  unsafe: 'profiles.reason.unsafe',
  unsupported: 'profiles.reason.unsupported',
  invalid_value: 'profiles.reason.invalidValue',
  too_many: 'profiles.reason.tooMany',
  printer_preset: 'profiles.reason.printerPreset',
  unsafe_path: 'profiles.reason.unsafePath',
  not_json: 'profiles.reason.notJson',
  invalid_json: 'profiles.reason.invalidJson',
  not_a_preset: 'profiles.reason.notPreset',
  unknown_kind: 'profiles.reason.unknownKind',
  too_large: 'profiles.reason.tooLarge',
  name_taken: 'profiles.reason.nameTaken',
}

export default function ImportReportDialog({ fileName, report, onClose }: { fileName: string; report: ProfileImportReport; onClose: () => void }) {
  const { t } = useI18n()
  const reason = (r: string) => {
    if (REASONS[r]) return t(REASONS[r])
    const range = /^range (-?[\d.e+]+)\.\.(-?[\d.e+]+)(%?)$/.exec(r)
    if (range) return t('profiles.reason.range', { min: `${range[1]}${range[3]}`, max: `${range[2]}${range[3]}` })
    if (r === 'number' || r === 'integer' || r === 'bool' || r === 'enum' || r === 'color' || r === 'text') return t('profiles.reason.invalidValue')
    return r
  }
  const total = report.created.length
  return (
    <Modal
      size="md"
      onClose={onClose}
      icon={total ? <CircleCheck size={18} /> : <FileWarning size={18} />}
      title={t('profiles.import.title')}
      subtitle={fileName}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="space-y-4 text-sm">
        <Section icon={<CircleCheck size={14} className="text-emerald-500" />} title={t('profiles.import.created', { n: total })}>
          {total === 0 ? (
            <p className="text-xs text-muted">{t('profiles.import.none')}</p>
          ) : (
            <ul className="space-y-1">
              {report.created.map((c) => (
                <li key={`${c.kind}-${c.id}`} className="flex flex-wrap items-center gap-1.5 text-xs">
                  <Badge tone={c.kind === 'process' ? 'violet' : 'sky'}>{t(c.kind === 'process' ? 'profiles.kind.process' : 'profiles.kind.filament')}</Badge>
                  <span className="font-medium">{c.name}</span>
                  <span className="text-muted">
                    {t('profiles.basedOn', { name: shortPresetName(c.inherits) })} · {t('profiles.changedCount', { n: c.keys })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        {report.remapped.length > 0 && (
          <Section icon={<Shuffle size={14} className="text-amber-500" />} title={t('profiles.import.remapped', { n: report.remapped.length })} hint={t('profiles.import.remappedHint')}>
            <ul className="space-y-1 text-xs">
              {report.remapped.map((r, i) => (
                <li key={i} className="flex flex-wrap items-center gap-1">
                  <span className="font-medium">{r.profile}</span>:<span className="text-muted">{r.from || t('profiles.import.noParent')}</span>
                  <ArrowRight size={12} className="text-muted" />
                  <span>{shortPresetName(r.to)}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {report.dropped.length > 0 && (
          <Section icon={<CircleSlash size={14} className="text-red-500" />} title={t('profiles.import.dropped', { n: report.dropped.length })} hint={t('profiles.import.droppedHint')}>
            <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs">
              {report.dropped.map((d, i) => (
                <li key={i} className="flex flex-wrap gap-x-1.5">
                  <span className="font-mono">{d.key}</span>
                  <span className="text-muted">
                    · {reason(d.reason)} · {d.profile}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {report.renamed.length > 0 && (
          <Section icon={<PencilLine size={14} className="text-sky-500" />} title={t('profiles.import.renamed', { n: report.renamed.length })}>
            <ul className="space-y-1 text-xs">
              {report.renamed.map((r, i) => (
                <li key={i} className="flex flex-wrap items-center gap-1">
                  <span className="text-muted">{r.from}</span>
                  <ArrowRight size={12} className="text-muted" />
                  <span className="font-medium">{r.to}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {report.skipped.length > 0 && (
          <Section icon={<FileWarning size={14} className="text-muted" />} title={t('profiles.import.skipped', { n: report.skipped.length })}>
            <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs">
              {report.skipped.map((s, i) => (
                <li key={i} className="flex flex-wrap gap-x-1.5">
                  <span className="font-mono break-all">{s.entry}</span>
                  <span className="text-muted">· {reason(s.reason)}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </Modal>
  )
}

function Section({ icon, title, hint, children }: { icon: ReactNode; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold">
        {icon}
        {title}
      </h3>
      {hint && <p className="text-xs text-muted">{hint}</p>}
      {children}
    </section>
  )
}
