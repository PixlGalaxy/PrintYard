import { useAuth } from '../context/AuthContext'
import { useI18n } from '../i18n/I18nContext'

// Same structure as WebinCloud's footer (bordered strip, author link, source link), in PrintYard tokens
const link =
  'inline-flex items-center gap-1.5 font-medium text-accent-600 transition-colors hover:text-accent-700 hover:underline dark:text-accent-400 dark:hover:text-accent-300'

const YEAR = new Date().getFullYear()

const formatVersion = (v: string | undefined) => (!v ? '…' : /^\d/.test(v) ? `v${v}` : v)

function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

export default function Footer() {
  const { config } = useAuth()
  const { t } = useI18n()
  return (
    <footer className="border-t border-line bg-surface-2/60 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-3 text-center text-xs text-muted sm:px-6">
        <span>
          © {YEAR} <span className="font-semibold text-fg/80">PrintYard</span>{' '}
          <span className="font-mono" title={t('footer.version')}>
            {formatVersion(config?.version)}
          </span>
        </span>
        <span aria-hidden>·</span>
        <a href="https://github.com/PixlGalaxy" target="_blank" rel="noreferrer noopener" className={link}>
          <GithubMark /> PixlGalaxy
        </a>
        <span aria-hidden>·</span>
        <a href="https://github.com/PixlGalaxy/PrintYard" target="_blank" rel="noreferrer noopener" className={link}>
          {t('footer.source')}
        </a>
        {/* Phones: the disclaimer gets its own line instead of a dangling separator */}
        <span aria-hidden className="max-sm:hidden">
          ·
        </span>
        <span className="max-sm:basis-full">{t('footer.compat')}</span>
      </div>
    </footer>
  )
}
