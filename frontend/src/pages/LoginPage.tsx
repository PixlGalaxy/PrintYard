import { LockKeyhole, User } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api } from '../api'
import Logo from '../components/Logo'
import { PublicShell } from '../components/RouteGuards'
import { inputCls } from '../components/styles'
import { Button, PasswordInput } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useI18n } from '../i18n/I18nContext'

export default function LoginPage() {
  const { setUser } = useAuth()
  const { t, errorMessage } = useI18n()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const { user } = await api.login(username.trim(), password)
      setUser(user) // PublicOnlyRoute redirects to ?next= or /
    } catch (err) {
      setError(errorMessage(err))
      setLoading(false)
    }
  }

  return (
    <PublicShell>
      <form
        onSubmit={submit}
        noValidate
        className="relative w-full max-w-sm rounded-2xl border border-line bg-surface p-8 shadow-xl shadow-black/5 animate-[pop-in_.25s_ease-out]"
      >
        <Logo size={64} className="mx-auto block drop-shadow-[0_8px_16px_color-mix(in_srgb,var(--accent-600)_35%,transparent)]" />
        <h1 className="mt-4 text-center text-xl font-semibold tracking-tight">{t('login.title')}</h1>
        <p className="mt-1 text-center text-sm text-muted">{t('login.subtitle')}</p>

        <div className="mt-6 space-y-3">
          <div className="relative">
            <label htmlFor="login-username" className="sr-only">
              {t('login.username')}
            </label>
            <User size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
            <input
              id="login-username"
              required
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={t('login.username')}
              className={`${inputCls} h-10! pl-9!`}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="relative">
            <label htmlFor="login-password" className="sr-only">
              {t('login.password')}
            </label>
            <LockKeyhole size={16} className="pointer-events-none absolute top-1/2 left-3 z-10 -translate-y-1/2 text-muted" />
            <PasswordInput
              id="login-password"
              required
              autoComplete="current-password"
              placeholder={t('login.password')}
              className="h-10! pl-9!"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <Button
          type="submit"
          variant="primary"
          size="md"
          loading={loading}
          disabled={!username.trim() || !password}
          className="mt-5 w-full"
        >
          {t('login.submit')}
        </Button>
      </form>
    </PublicShell>
  )
}
