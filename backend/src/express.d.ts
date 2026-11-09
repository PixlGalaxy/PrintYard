import type { ResolvedSession } from './modules/auth/sessions.service.js';

declare global {
  namespace Express {
    interface Request {
      /** Real client IP resolved per `exposure.mode` (see lib/client-ip.ts). */
      clientIp: string;
      /** TLS here, or `X-Forwarded-Proto: https` from a trusted proxy. Drives the cookie `Secure` flag. */
      isHttps: boolean;
      /** Set by loadSession when the cookie maps to a live session. */
      session?: ResolvedSession;
    }
  }
}

export {};
