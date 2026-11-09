// Scroll-spy for a settings list: which page is at the top, and a smooth jump to a page.
import { useCallback, useEffect, useState, type RefObject } from 'react'

export function usePageSpy(scroller: RefObject<HTMLElement | null>, pages: string[], deps: unknown) {
  const [active, setActive] = useState<string | null>(null)
  const pagesKey = pages.join('|')
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const update = () => {
      const top = el.getBoundingClientRect().top + 8
      let cur: string | null = null
      for (const s of el.querySelectorAll<HTMLElement>('[data-page]')) {
        if (s.getBoundingClientRect().top <= top + 1) cur = s.dataset.page ?? null
        else break
      }
      setActive(cur ?? el.querySelector<HTMLElement>('[data-page]')?.dataset.page ?? null)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    return () => el.removeEventListener('scroll', update)
  }, [scroller, pagesKey, deps])
  const jump = useCallback(
    (page: string) => {
      const el = scroller.current
      const target = el?.querySelector<HTMLElement>(`[data-page="${CSS.escape(page)}"]`)
      if (!el || !target) return
      // the scroller is position:relative, so offsetTop is relative to it
      el.scrollTo({ top: Math.max(0, target.offsetTop - 2), behavior: 'smooth' })
      setActive(page)
    },
    [scroller],
  )
  return { active, jump }
}
