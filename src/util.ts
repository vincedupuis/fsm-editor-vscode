/**
 * Helpers that work in both the desktop (Node.js) and the browser extension
 * hosts, which have no `path` module or `Buffer`.
 */

/** Last segment of a `/`-separated path, without `ext` when given. */
export function basename(p: string, ext = ''): string {
  const base = p.slice(p.lastIndexOf('/') + 1);
  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
}

/** Extension of the last segment, including the dot (`.fsm`), or ''. */
export function extname(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i) : '';
}

/** Path of the directory containing `p`. */
export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/** Relative path from directory `from` to `to`, both absolute `/`-separated paths. */
export function relative(from: string, to: string): string {
  const a = from.split('/').filter(Boolean);
  const b = to.split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/');
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const encodeText = (text: string): Uint8Array => encoder.encode(text);
export const decodeText = (bytes: Uint8Array): string => decoder.decode(bytes);
