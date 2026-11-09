import { useAuth } from './context/AuthContext'

/** True when the server runs with SLICEDOCK_READ_ONLY=1 (printer writes are refused with 423). */
export function useReadOnly(): boolean {
  return useAuth().config?.readOnly === true
}
