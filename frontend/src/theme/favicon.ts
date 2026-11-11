// The browser-tab icon follows the effective accent skin: /theme.js points it at /icons/<skin>/favicon.svg before
// React mounts; from then on this keeps it in sync with an SVG data URL built from the live `--accent-400`.
// Like the static favicon.svg, it swaps tile and mark when the OS is in dark mode (tab chrome follows the OS).
import { LOGO_ACCENT, LOGO_INK, LOGO_MARK, LOGO_MARK_TRANSFORM, LOGO_TILE } from './brand'

/** Standalone favicon SVG for one accent colour. */
export function faviconSvg(accent: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">` +
    `<style>.t{fill:${LOGO_INK}}.m{fill:${accent}}@media (prefers-color-scheme:dark){.t{fill:${accent}}.m{fill:${LOGO_INK}}}</style>` +
    `<path class="t" d="${LOGO_TILE}"/>` +
    `<path class="m" fill-rule="evenodd" transform="${LOGO_MARK_TRANSFORM}" d="${LOGO_MARK}"/></svg>`
  )
}

let last = ''

function apply() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent-400').trim()
  const accent = /^#[0-9a-f]{3,8}$/i.test(raw) ? raw : LOGO_ACCENT
  if (accent === last) return
  last = accent
  let link = document.querySelector<HTMLLinkElement>('link#favicon')
  if (!link) {
    link = document.createElement('link')
    link.id = 'favicon'
    link.rel = 'icon'
    link.type = 'image/svg+xml'
    document.head.appendChild(link)
  }
  link.href = `data:image/svg+xml,${encodeURIComponent(faviconSvg(accent))}`
}

/** Starts keeping the favicon in sync with the skin (call once at startup). */
export function syncFavicon() {
  apply()
  new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin', 'style'] })
}
