import type { Language } from '../types'
import en from './en.json'
import es from './es.json'

/** Every key of en.json. Other locales are checked against it, so a missing key fails `tsc`. */
export type TranslationKey = keyof typeof en

export const SUPPORTED_LANGUAGES: readonly Language[] = ['en', 'es']

export const dictionaries: Record<Language, Record<TranslationKey, string>> = { en, es }

/** Each language's own name for itself, shown regardless of the current UI language. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', es: 'Español' }

export const isLanguage = (value: unknown): value is Language => SUPPORTED_LANGUAGES.includes(value as Language)

export const isTranslationKey = (key: string): key is TranslationKey => key in en

/** First supported language from the browser preferences, if any. */
export function browserLanguage(): Language | null {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag?.toLowerCase().split('-')[0]
    if (isLanguage(base)) return base
  }
  return null
}
