/** C0/C1 control characters, DEL and the Unicode line/paragraph separators. */
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * Makes client-supplied text safe to store or log: control characters (CR/LF, ANSI escapes, separators) become a
 * single space, and the result is truncated to `max` code points.
 */
export function cleanUserText(value: string, max = 64): string {
  const cleaned = value.replace(CONTROL_CHARS, ' ').trim();
  const chars = Array.from(cleaned);
  return chars.length > max ? chars.slice(0, max).join('') : cleaned;
}
