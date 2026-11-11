import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import App from './App.tsx'
import { AuthProvider } from './context/AuthContext.tsx'
import { ThemeProvider } from './context/ThemeContext.tsx'
import { ToastProvider } from './context/ToastContext.tsx'
import { I18nProvider } from './i18n/I18nContext.tsx'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './index.css'
import { registerServiceWorker } from './pages/account/notifications/pushClient'
import { syncFavicon } from './theme/favicon'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <I18nProvider>
          <ThemeProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </ThemeProvider>
        </I18nProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)

// Browser-tab icon follows the accent skin
syncFavicon()

// Web Push service worker: production builds, or dev with ?sw=1 (Phase 4)
registerServiceWorker()

// Dev-only scenario toolbar for `npm run dev:mock` (stripped from production builds, like the mock API)
if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') {
  void import('./dev/mount').then((m) => m.mountMockToolbar())
}
