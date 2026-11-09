// Realtime (WebSocket `/api/ws`) — shared by Workspace (F1) and Preview/Printer/Admin (F2).
export { realtime } from './client'
export type { DataOf, MessageOf, MessageType, RealtimeState } from './client'
export { usePrinterStatus, useRealtime, useRealtimeMessage, useRealtimeState } from './useRealtime'
