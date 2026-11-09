// Realtime client for `GET /api/ws` (status/phase2-contract.md "Realtime").
// One shared socket per tab: it opens when the first listener subscribes, reconnects with backoff,
// pings every 25 s, re-sends printer subscriptions after a reconnect, and closes a few seconds after
// the last listener goes away (e.g. on logout).
import type { ClientMessage, ServerMessage } from '../types'

export type RealtimeState = 'idle' | 'connecting' | 'open' | 'closed'
export type MessageType = Exclude<ServerMessage['type'], 'pong'>
export type MessageOf<T extends MessageType> = Extract<ServerMessage, { type: T }>
export type DataOf<T extends MessageType> = MessageOf<T> extends { data: infer D } ? D : never
export type Listener = (msg: ServerMessage) => void

/** The subset of WebSocket the client uses (lets the dev mock plug in a fake socket). */
export interface SocketLike {
  readonly readyState: number
  onopen: ((ev: Event) => void) | null
  onclose: ((ev: CloseEvent) => void) | null
  onerror: ((ev: Event) => void) | null
  onmessage: ((ev: MessageEvent) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}
export type SocketFactory = (url: string) => SocketLike

const PING_MS = 25_000
const IDLE_CLOSE_MS = 4_000
const OPEN = 1

let factoryPromise: Promise<SocketFactory> = Promise.resolve((url: string) => new WebSocket(url))
// Dev-only fake socket for `npm run dev:mock` (removed from production builds: DEV is false there)
if (import.meta.env.DEV && import.meta.env.VITE_MOCK === '1') {
  factoryPromise = import('../dev/mockRealtime').then((m) => m.mockSocketFactory)
}

class RealtimeClient {
  private socket: SocketLike | null = null
  private listeners = new Set<Listener>()
  private stateListeners = new Set<() => void>()
  /** printerId → number of components interested in it */
  private printers = new Map<number, number>()
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private wanted = false
  state: RealtimeState = 'idle'

  private setState(s: RealtimeState) {
    if (this.state === s) return
    this.state = s
    for (const l of this.stateListeners) l()
  }

  onState(cb: () => void) {
    this.stateListeners.add(cb)
    return () => void this.stateListeners.delete(cb)
  }

  /** Listen to every server message. Keeps the socket open while at least one listener exists. */
  listen(cb: Listener) {
    this.listeners.add(cb)
    this.retain()
    return () => {
      this.listeners.delete(cb)
      this.release()
    }
  }

  /** Ask the server for `printer.status` of this printer (ref-counted). */
  watchPrinter(id: number) {
    const before = this.printers.size
    this.printers.set(id, (this.printers.get(id) ?? 0) + 1)
    if (this.printers.size !== before) this.sendSubscriptions()
    return () => {
      const n = (this.printers.get(id) ?? 1) - 1
      if (n <= 0) {
        this.printers.delete(id)
        this.sendSubscriptions()
      } else this.printers.set(id, n)
    }
  }

  send(msg: ClientMessage) {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(msg))
  }

  private sendSubscriptions() {
    this.send({ type: 'subscribe', printers: [...this.printers.keys()] })
  }

  private retain() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (!this.wanted) {
      this.wanted = true
      void this.connect()
    }
  }

  private release() {
    if (this.listeners.size > 0) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.shutdown(), IDLE_CLOSE_MS)
  }

  private shutdown() {
    this.wanted = false
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.retryTimer = null
    this.pingTimer = null
    const s = this.socket
    this.socket = null
    s?.close(1000, 'idle')
    this.setState('idle')
  }

  private async connect() {
    if (!this.wanted || this.socket) return
    this.setState('connecting')
    const factory = await factoryPromise
    if (!this.wanted || this.socket) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let socket: SocketLike
    try {
      socket = factory(`${proto}//${location.host}/api/ws`)
    } catch {
      this.scheduleRetry()
      return
    }
    this.socket = socket
    socket.onopen = () => {
      this.attempt = 0
      this.setState('open')
      this.sendSubscriptions()
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_MS)
    }
    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      let msg: ServerMessage
      try {
        msg = JSON.parse(ev.data) as ServerMessage
      } catch {
        return
      }
      if (!msg || typeof msg.type !== 'string' || msg.type === 'pong') return
      for (const l of [...this.listeners]) {
        try {
          l(msg)
        } catch (err) {
          console.error('[realtime] listener failed', err)
        }
      }
    }
    socket.onerror = () => undefined // onclose follows
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = null
      if (this.wanted) this.scheduleRetry()
      else this.setState('idle')
    }
  }

  private scheduleRetry() {
    this.setState('closed')
    // 1 s, 2 s, 4 s … capped at 30 s, with jitter so tabs don't reconnect in lockstep
    const base = Math.min(30_000, 1000 * 2 ** this.attempt++)
    const wait = base * (0.75 + Math.random() * 0.5)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect()
    }, wait)
  }

  /** Reconnect right away (e.g. a "retry" button). */
  reconnectNow() {
    if (this.socket || !this.wanted) return
    this.attempt = 0
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    void this.connect()
  }
}

export const realtime = new RealtimeClient()
