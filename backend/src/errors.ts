/** Thrown anywhere; the error handler turns it into `{ error: { code, message, details? } }`. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const validationFailed = (details?: unknown) =>
  new AppError(400, 'validation.failed', 'Request validation failed', details);
export const unauthorized = () => new AppError(401, 'auth.unauthorized', 'Authentication required');
export const forbidden = (code = 'auth.forbidden', message = 'Forbidden') => new AppError(403, code, message);
export const notFound = () => new AppError(404, 'common.not_found', 'Not found');
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const rateLimited = (retryAfterSec: number) =>
  new AppError(429, 'auth.rate_limited', 'Too many attempts, try again later', { retryAfter: retryAfterSec }, {
    'Retry-After': String(retryAfterSec),
  });
