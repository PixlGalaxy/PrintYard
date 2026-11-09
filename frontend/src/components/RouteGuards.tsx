import { LoaderCircle, Moon, ServerCrash, Sun } from 'lucide-react'
import { Suspense, type ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { useI18n } from '../i18n/I18nContext'
import Footer from './Footer'
import UploadTray from '../pages/files/uploads/UploadTray'
import { UploadProvider } from '../pages/files/uploads/UploadContext'
import Header from './Header'
import LanguageSwitcher from './LanguageSwitcher'
import Logo from './Logo'
import { Button, IconButton } from './ui'

function FullPageSpinner() {
  const { t } = useI18n()
  return (
    <div role="status" className="flex min-h-dvh items-center justify-center text-muted">
      <LoaderCircle className="animate-spin" aria-hidden />
      <span className="sr-only">{t('common.loading')}</span>
    </div>
  )
}

/** Wraps every route: waits for /api/config + session, then sends to /setup until setup is done. */
export function BootGate() {
  const { config, loading, loadError, reload } = useAuth()
  const { t, errorMessage } = useI18n()
  const { pathname } = useLocation()

  if (loading && !config) return <FullPageSpinner />
  if (loadError || !config) {
    return (
      <PublicShell>
        <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-8 text-center shadow-xl shadow-black/5 animate-[pop-in_.25s_ease-out]">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-red-500/10 text-red-500">
            <ServerCrash size={22} />
          </div>
          <h1 className="mt-4 text-lg font-semibold">{t('common.loadError')}</h1>
          <p className="mt-1 text-sm text-muted">{errorMessage(loadError)}</p>
          <Button variant="primary" className="mt-5" loading={loading} onClick={() => void reload()}>
            {t('common.retry')}
          </Button>
        </div>
      </PublicShell>
    )
  }
  if (!config.setupComplete && pathname !== '/setup') return <Navigate to="/setup" replace />
  return <Outlet />
}

/** /setup is only reachable while no admin exists. */
export function SetupRoute() {
  const { config } = useAuth()
  if (config?.setupComplete) return <Navigate to="/" replace />
  return <Outlet />
}

/** /login: signed-in users go straight to where they wanted to be. */
export function PublicOnlyRoute() {
  const { user } = useAuth()
  const { search } = useLocation()
  if (user === undefined) return <FullPageSpinner />
  if (user) {
    const next = new URLSearchParams(search).get('next')
    return <Navigate to={next && next.startsWith('/') && !next.startsWith('//') ? next : '/'} replace />
  }
  return <Outlet />
}

/** Signed-in area with header and footer. */
export function ProtectedRoute() {
  const { user } = useAuth()
  const { t } = useI18n()
  const location = useLocation()
  // The Workspace (`/`) is a full-height editor: no page padding, no footer, panels scroll on their own
  const fullBleed = location.pathname === '/'
  if (user === undefined) return <FullPageSpinner />
  if (!user) {
    const here = location.pathname + location.search
    const next = here !== '/' ? `?next=${encodeURIComponent(here)}` : ''
    return <Navigate to={`/login${next}`} replace />
  }
  return (
    <UploadProvider>
      <div className={fullBleed ? 'flex h-dvh min-h-[560px] flex-col' : 'flex min-h-dvh flex-col'}>
        <a
          href="#main"
          className="sr-only z-50 rounded-lg bg-accent-600 px-3 py-2 text-sm text-white focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          {t('nav.skip')}
        </a>
        <Header user={user} />
        <main
          id="main"
          className={fullBleed ? 'flex min-h-0 w-full flex-1 flex-col' : 'mx-auto w-full max-w-[1800px] flex-1 px-4 py-6 sm:px-6'}
        >
          <Suspense
            fallback={
              <div className="flex justify-center py-20 text-muted">
                <LoaderCircle className="animate-spin" aria-hidden />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </main>
        {!fullBleed && <Footer />}
        <UploadTray />
      </div>
    </UploadProvider>
  )
}

export function AdminRoute() {
  const { user } = useAuth()
  if (!user || user.role !== 'admin') return <Navigate to="/" replace />
  return <Outlet />
}

/** Layout for pages shown while signed out (login, setup, errors). */
export function PublicShell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const { t } = useI18n()
  const { resolved, setTheme } = useTheme()
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden">
      <div className="pointer-events-none absolute -top-40 left-1/2 size-[600px] -translate-x-1/2 rounded-full bg-accent-500/15 blur-3xl" />
      <div className="relative mx-auto flex w-full max-w-[1800px] items-center gap-2 px-4 py-3 sm:px-6">
        {wide && (
          <span className="flex items-center gap-2.5">
            <Logo size={30} />
            <span className="text-sm font-semibold tracking-tight">SliceDock</span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <LanguageSwitcher />
          <IconButton label={t('theme.toggle')} onClick={() => void setTheme(resolved === 'dark' ? 'light' : 'dark')}>
            {resolved === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </IconButton>
        </div>
      </div>
      <main className={`relative flex flex-1 justify-center px-4 ${wide ? 'items-start py-4 sm:py-8' : 'items-center py-10'}`}>
        {children}
      </main>
      <Footer />
    </div>
  )
}
