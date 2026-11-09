import type { IncomingMessage } from 'node:http';
import type { AppContext } from '../context.js';
import { resolveClientIp } from '../lib/client-ip.js';
import { SESSION_COOKIE } from '../modules/auth/sessions.service.js';
import type { Role } from '../types.js';
import { isSameOrigin, RealtimeHub, type HubAuth, type HubOptions } from './hub.js';

export {
  RealtimeHub,
  forAdmins,
  forPrinterSubscribers,
  forUser,
  forUserAndAdmins,
  isSameOrigin,
  type HubClientInfo,
  type HubFilter,
} from './hub.js';

/** Topic names used across the backend (contract §Realtime). */
export const TOPICS = {
  printerStatus: 'printer.status',
  sliceJob: 'slice.job',
  engineProgress: 'engine.progress',
  printUpdate: 'print.update',
  /** G-code upload SliceDock → printer progress (`PrintUploadProgress`), owner + admins. */
  printUpload: 'print.upload',
  approvalPending: 'approval.pending',
  /** Global appearance defaults changed (Admin → Settings → Appearance); data = AppConfig['appearance']. */
  appearanceDefaults: 'appearance.defaults',
} as const;

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    const raw = part.slice(i + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/** HubAuth backed by the session cookie, IP bans and the exposure settings. */
export function contextHubAuth(ctx: Pick<AppContext, 'sessions' | 'bans' | 'settings' | 'exposure'>): HubAuth {
  const clientIp = (req: IncomingMessage) => {
    const exposure = ctx.exposure();
    return resolveClientIp(req, exposure, exposure.matcher);
  };
  return {
    banned: (req) => ctx.bans.isBanned(clientIp(req)),
    originAllowed: (req) => isSameOrigin(req, ctx.settings.get('exposure.publicUrl')),
    authenticate(req) {
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      const s = ctx.sessions.resolve(token, clientIp(req));
      if (!s) return null;
      return { userId: s.user.id, username: s.user.username, role: s.user.role as Role, sessionId: token!, sessionKey: s.id };
    },
    revalidate(token, req) {
      // An open socket must not keep an idle session alive (finding #11): no last_seen touch here.
      const s = ctx.sessions.resolve(token, clientIp(req), { touch: false });
      return s ? { role: s.user.role as Role } : null;
    },
  };
}

export function createHub(
  ctx: Pick<AppContext, 'sessions' | 'bans' | 'settings' | 'exposure'>,
  opts: HubOptions = {},
): RealtimeHub {
  return new RealtimeHub(contextHubAuth(ctx), opts);
}
