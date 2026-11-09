import { Bell, ClipboardList, Cpu, FlaskConical, FolderOpen, LayoutDashboard, ScrollText, Settings, ShieldCheck, Users, type LucideIcon } from 'lucide-react'
import { PrinterLayers } from '../../components/printerIcons'
import { useSearchParams } from 'react-router'
import PageHeader from '../../components/PageHeader'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'
import AuditSection from './AuditSection'
import DashboardSection from './DashboardSection'
import EngineSection from './EngineSection'
import FilesSection from './FilesSection'
import FilamentPresetsCard from '../account/FilamentPresetsCard'
import LogsSection from './LogsSection'
import NotificationsSection from './notifications/NotificationsSection'
import PrintersSection from './PrintersSection'
import PrintsSection from './prints/PrintsSection'
import { usePendingApprovals } from './prints/usePendingApprovals'
import SettingsSection from './SettingsSection'
import UsersSection from './UsersSection'

const SECTIONS = [
  { key: 'dashboard', label: 'admin.section.dashboard', icon: LayoutDashboard },
  { key: 'users', label: 'admin.section.users', icon: Users },
  { key: 'printers', label: 'admin.section.printers', icon: PrinterLayers },
  { key: 'prints', label: 'admin.section.prints', icon: ClipboardList },
  { key: 'files', label: 'admin.section.files', icon: FolderOpen },
  { key: 'filaments', label: 'admin.section.filaments', icon: FlaskConical },
  { key: 'engine', label: 'admin.section.engine', icon: Cpu },
  { key: 'notifications', label: 'admin.section.notifications', icon: Bell },
  { key: 'settings', label: 'admin.section.settings', icon: Settings },
  { key: 'logs', label: 'admin.section.logs', icon: ScrollText },
  { key: 'audit', label: 'admin.section.audit', icon: ShieldCheck },
] as const satisfies readonly { key: string; label: TranslationKey; icon: LucideIcon }[]

type Section = (typeof SECTIONS)[number]['key']

const isSection = (v: string | null): v is Section => SECTIONS.some((s) => s.key === v)

export default function AdminPage() {
  const { t } = useI18n()
  // The section lives in ?section= so a reload or a shared link opens the same view
  const [params, setParams] = useSearchParams()
  const requested = params.get('section')
  const active: Section = isSection(requested) ? requested : 'dashboard'

  const pending = usePendingApprovals(true).items.length
  const select = (key: Section) => setParams(key === 'dashboard' ? {} : { section: key }, { replace: true })

  return (
    <div className="space-y-5">
      <PageHeader title={t('admin.title')} subtitle={t('admin.subtitle')} />

      <div className="flex flex-col gap-5 md:flex-row md:items-start">
        <nav
          aria-label={t('admin.title')}
          className="grid shrink-0 grid-cols-2 gap-1 sm:grid-cols-4 md:sticky md:top-20 md:flex md:w-56 md:flex-col"
        >
          {SECTIONS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => select(key)}
              aria-current={active === key ? 'page' : undefined}
              className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-sky-500 ${
                active === key
                  ? 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400'
                  : 'border-transparent text-muted hover:bg-surface hover:text-fg'
              }`}
            >
              <Icon size={17} aria-hidden />
              <span className="truncate">{t(label)}</span>
              {key === 'prints' && pending > 0 && (
                <span className="ml-auto rounded-full bg-amber-500 px-1.5 text-[11px] leading-5 font-semibold text-white">{pending}</span>
              )}
            </button>
          ))}
        </nav>

        <div key={active} className="min-w-0 flex-1 animate-[fade-in_.2s_ease-out]">
          {active === 'dashboard' && <DashboardSection />}
          {active === 'users' && <UsersSection />}
          {active === 'printers' && <PrintersSection />}
          {active === 'engine' && <EngineSection />}
          {active === 'notifications' && <NotificationsSection />}
          {active === 'prints' && <PrintsSection />}
          {active === 'files' && <FilesSection />}
          {active === 'filaments' && <FilamentPresetsCard admin />}
          {active === 'settings' && <SettingsSection />}
          {active === 'logs' && <LogsSection />}
          {active === 'audit' && <AuditSection />}
        </div>
      </div>
    </div>
  )
}
