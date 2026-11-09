// Dev-only fake WebSocket for `/api/ws` in `npm run dev:mock`. Messages come from the mock bus
// (mockF2.ts `mockPublish`), filtered by the signed-in mock user like the real hub would.
import type { SocketFactory, SocketLike } from '../realtime/client'
import type { ClientMessage } from '../types'
import { mockCore } from './mock'
import { audienceAllows, mockBus } from './mockF2'

class MockSocket implements SocketLike {
  readyState = 0
  onopen: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  private printers = new Set<number>()
  private off: (() => void) | null = null

  constructor() {
    setTimeout(() => {
      // Same as the real hub: no session cookie → the upgrade is refused
      if (!mockCore.state.sessionUserId) {
        this.readyState = 3
        this.onclose?.(new CloseEvent('close', { code: 1008, reason: 'unauthorized' }))
        return
      }
      this.readyState = 1
      this.off = mockBus.on((msg, audience) => {
        if (this.readyState !== 1 || !audienceAllows(audience)) return
        if (msg.type === 'printer.status' && !this.printers.has(msg.data.printerId)) return
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(msg) }))
      })
      this.onopen?.(new Event('open'))
    }, 150)
  }

  send(data: string) {
    const msg = JSON.parse(data) as ClientMessage
    if (msg.type === 'subscribe') this.printers = new Set(msg.printers)
    if (msg.type === 'ping') setTimeout(() => this.onmessage?.(new MessageEvent('message', { data: '{"type":"pong"}' })), 20)
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return
    this.readyState = 3
    this.off?.()
    setTimeout(() => this.onclose?.(new CloseEvent('close', { code, reason })), 0)
  }
}

export const mockSocketFactory: SocketFactory = () => new MockSocket()
