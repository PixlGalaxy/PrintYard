import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { ApiError } from '../api'
import { useAuth } from '../context/AuthContext'
import { useStoredState } from '../hooks'
import type { Language } from '../types'
import { browserLanguage, dictionaries, isLanguage, isTranslationKey, type TranslationKey } from './translations'

export type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string

interface I18nValue {
  language: Language
  t: Translate
  /** Saved to the account when signed in, and locally in any case. */
  setLanguage: (language: Language) => Promise<void>
  /** Translated message for any thrown value (ApiError codes are i18n keys under `errors.`). */
  errorMessage: (err: unknown) => string
  /** Locale-aware formatters */
  formatDate: (ms: number | string) => string
  formatNumber: (n: number, options?: Intl.NumberFormatOptions) => string
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const { user, config, updateAccount } = useAuth()
  const [stored, setStored] = useStoredState<Language | null>('sd:lang', null)

  // Account → explicit local choice → browser → server default
  const language: Language =
    (user && isLanguage(user.language) ? user.language : null) ??
    (isLanguage(stored) ? stored : null) ??
    browserLanguage() ??
    config?.defaultLanguage ??
    'en'

  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  const t = useCallback<Translate>(
    (key, vars) => {
      const template = dictionaries[language][key] ?? dictionaries.en[key] ?? key
      if (!vars) return template
      return Object.entries(vars).reduce((out, [name, value]) => out.replaceAll(`{${name}}`, String(value)), template)
    },
    [language],
  )

  const setLanguage = useCallback(
    async (next: Language) => {
      setStored(next)
      if (user && user.language !== next) await updateAccount({ language: next })
    },
    [setStored, updateAccount, user],
  )

  const errorMessage = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError) {
        if (err.code === 'auth.rate_limited' && err.retryAfter) {
          return t('errors.auth.rate_limited_wait', { minutes: Math.max(1, Math.ceil(err.retryAfter / 60)) })
        }
        const key = `errors.${err.code}`
        if (isTranslationKey(key)) return t(key)
        return err.message || t('errors.common.unknown')
      }
      return err instanceof Error && err.message ? err.message : t('errors.common.unknown')
    },
    [t],
  )

  const value = useMemo<I18nValue>(() => {
    const locale = language === 'es' ? 'es' : 'en'
    const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
    return {
      language,
      t,
      setLanguage,
      errorMessage,
      formatDate: (ms) => dateFmt.format(new Date(ms)),
      formatNumber: (n, options) => new Intl.NumberFormat(locale, options).format(n),
    }
  }, [language, t, setLanguage, errorMessage])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
