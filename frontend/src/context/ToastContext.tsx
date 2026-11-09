import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { isUnauthorized } from '../api'
import Toasts, { type Toast, type ToastTone } from '../components/Toasts'
import { useI18n } from '../i18n/I18nContext'
import { useAuth } from './AuthContext'

interface ToastValue {
  toast: (tone: ToastTone, message: string) => void
  /** Shows a translated error toast; a 401 also signs the user out (the guards redirect to /login). */
  onError: (err: unknown) => void
}

const ToastContext = createContext<ToastValue | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const { setUser } = useAuth()
  const { errorMessage } = useI18n()
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])

  const toast = useCallback(
    (tone: ToastTone, message: string) => {
      const id = ++nextId.current
      setToasts((t) => [...t.slice(-3), { id, tone, message }])
      setTimeout(() => dismiss(id), tone === 'error' ? 7000 : 4000)
    },
    [dismiss],
  )

  const onError = useCallback(
    (err: unknown) => {
      toast('error', errorMessage(err))
      if (isUnauthorized(err)) setUser(null)
    },
    [errorMessage, setUser, toast],
  )

  const value = useMemo(() => ({ toast, onError }), [toast, onError])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
