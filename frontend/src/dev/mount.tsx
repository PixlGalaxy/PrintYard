import { createRoot } from 'react-dom/client'
import MockToolbar from './MockToolbar'

/** Renders the mock toolbar in its own root (outside the app's providers). */
export function mountMockToolbar() {
  const el = document.createElement('div')
  el.id = 'mock-toolbar'
  document.body.appendChild(el)
  createRoot(el).render(<MockToolbar />)
}
