// Top navigation, modelled on WebinCloud's Navbar: logo left, icon nav links (labels hide on phones),
// Admin as a LayoutDashboard link (pending-approvals badge), and the avatar account menu with coloured icons and
// a sign-out confirmation. Full width; appearance lives in Account settings. SliceDock tokens.
import { FolderOpen, Home, LayoutDashboard, Lock, LogOut, SlidersHorizontal, TriangleAlert, UserRound, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, NavLink, useNavigate } from 'react-router'
import { useAuth } from '../context/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { usePendingApprovals } from '../pages/admin/prints/usePendingApprovals'
import { useUploads } from '../pages/files/uploads/UploadContext'
import type { User } from '../types'
import { useReadOnly } from '../readOnly'
import Logo from './Logo'
import Modal from './Modal'
import { Button } from './ui'

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `relative flex items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-[15px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-sky-500 sm:px-4 ${
    isActive ? 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300' : 'text-muted hover:bg-surface-2 hover:text-fg'
  }`

const NAV_ITEMS: { to: string; label: TranslationKey; icon: LucideIcon }[] = [
  { to: '/', label: 'nav.workspace', icon: Home },
  { to: '/files', label: 'nav.files', icon: FolderOpen },
]

const ACCOUNT_MENU: { to: string; label: TranslationKey; icon: LucideIcon; color: string }[] = [
  { to: '/account', label: 'nav.account', icon: UserRound, color: 'text-sky-500' },
  { to: '/account#appearance', label: 'nav.preferences', icon: SlidersHorizontal, color: 'text-amber-500' },
]

export default function Header({ user }: { user: User }) {
  const { t } = useI18n()
  const { logout } = useAuth()
  const { items: uploads, cancel } = useUploads()
  const isAdmin = user.role === 'admin'
  const pending = usePendingApprovals(isAdmin).items.length
  const [confirmingLogout, setConfirmingLogout] = useState(false)
  const readOnly = useReadOnly()

  const runningUploads = uploads.filter((u) => u.status === 'uploading' || u.status === 'queued')

  const signOut = async () => {
    cancel()
    setConfirmingLogout(false)
    await logout()
  }

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/85 backdrop-blur-md">
      <div className="flex h-16 w-full items-center justify-between gap-2 px-4 sm:h-20 sm:gap-4 sm:px-6">
        <Link to="/" className="flex shrink-0 items-center gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500">
          <Logo size={40} className="sm:hidden" />
          <Logo size={46} className="hidden sm:block" />
          <span className="hidden text-lg font-semibold tracking-tight md:block">SliceDock</span>
        </Link>

        <div className="flex min-w-0 items-center gap-0.5 sm:gap-1">
          <nav aria-label={t('nav.main')} className="flex items-center gap-0.5 sm:gap-1">
            {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
              <NavLink key={to} to={to} end={to === '/'} className={navLinkClass} title={t(label)}>
                <Icon size={21} aria-hidden />
                <span className="hidden sm:inline">{t(label)}</span>
              </NavLink>
            ))}
            {isAdmin && (
              <NavLink
                to="/admin"
                className={navLinkClass}
                title={pending ? `${t('nav.admin')} · ${t('nav.pendingApprovals', { n: pending })}` : t('nav.admin')}
              >
                <span className="relative">
                  <LayoutDashboard size={21} aria-hidden />
                  {pending > 0 && (
                    <span className="absolute -top-1.5 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] leading-none font-bold text-white ring-2 ring-surface">
                      {pending > 9 ? '9+' : pending}
                    </span>
                  )}
                </span>
                <span className="hidden sm:inline">{t('nav.admin')}</span>
                {pending > 0 && <span className="sr-only">{t('nav.pendingApprovals', { n: pending })}</span>}
              </NavLink>
            )}
          </nav>

          <AccountMenu user={user} onLogout={() => setConfirmingLogout(true)} />
        </div>
      </div>

      {readOnly && (
        <div role="status" className="flex items-center justify-center gap-2 border-t border-amber-500/30 bg-amber-500/15 px-4 py-1.5 text-center text-xs font-medium text-amber-800 dark:text-amber-200">
          <Lock size={13} className="shrink-0" />
          {t('readOnly.banner')}
        </div>
      )}

      {confirmingLogout && (
        <Modal
          size="sm"
          title={t('logout.title')}
          icon={<LogOut size={18} className="text-rose-500" />}
          onClose={() => setConfirmingLogout(false)}
          footer={
            <>
              <Button onClick={() => setConfirmingLogout(false)} data-autofocus>
                {t('logout.stay')}
              </Button>
              <Button variant="danger" icon={<LogOut size={14} />} onClick={() => void signOut()}>
                {t('logout.confirm')}
              </Button>
            </>
          }
        >
          {runningUploads.length > 0 ? (
            <>
              <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-sm text-amber-800 dark:text-amber-200">
                <TriangleAlert size={16} className="mt-0.5 shrink-0" />
                <p>{t('logout.uploadsRunning', { n: runningUploads.length })}</p>
              </div>
              <ul className="mt-3 space-y-1">
                {runningUploads.map((u) => (
                  <li key={u.id} className="truncate font-mono text-xs text-muted">
                    {u.file.name}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm leading-relaxed text-muted">{t('logout.body')}</p>
          )}
        </Modal>
      )}
    </header>
  )
}

export function Avatar({ user, size = 28 }: { user: User; size?: number }) {
  if (user.avatarUrl) {
    return <img src={user.avatarUrl} alt="" width={size} height={size} className="shrink-0 rounded-full object-cover" />
  }
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      className="flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sky-400 to-sky-600 font-semibold text-white uppercase"
    >
      {user.username.slice(0, 1)}
    </span>
  )
}

function AccountMenu({ user, onLogout }: { user: User; onLogout: () => void }) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const go = (to: string) => {
    setOpen(false)
    navigate(to)
    const hash = to.split('#')[1]
    if (hash) setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
  }

  return (
    <div ref={ref} className="relative ml-1">
      <button
        type="button"
        aria-label={t('nav.userMenu')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        className="shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
      >
        <Avatar user={user} size={36} />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 z-30 mt-2 w-60 max-w-[calc(100vw-2rem)] origin-top-right overflow-hidden rounded-xl border border-line bg-surface py-1.5 shadow-lg shadow-black/10 animate-[pop-in_.15s_ease-out]"
        >
          <div className="flex items-center gap-3 px-4 pt-1.5 pb-3">
            <Avatar user={user} size={34} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{user.username}</p>
              <p className="truncate text-xs text-muted">{user.email ?? t(user.role === 'admin' ? 'role.admin' : 'role.user')}</p>
            </div>
          </div>
          <span className="mb-1.5 block h-px bg-line" />
          {ACCOUNT_MENU.map(({ to, label, icon: Icon, color }) => (
            <button
              key={to}
              type="button"
              role="menuitem"
              onClick={() => go(to)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
            >
              <Icon size={18} className={color} />
              {t(label)}
            </button>
          ))}
          <span className="my-1.5 block h-px bg-line" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onLogout()
            }}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium transition-colors hover:bg-rose-50 hover:text-rose-700 focus-visible:bg-rose-50 focus-visible:outline-none dark:hover:bg-rose-500/15 dark:hover:text-rose-300 dark:focus-visible:bg-rose-500/15"
          >
            <LogOut size={18} className="text-rose-500" />
            {t('nav.logout')}
          </button>
        </div>
      )}
    </div>
  )
}
