/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" = use the in-browser fake API (dev only, see src/mock.ts) */
  readonly VITE_MOCK?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
