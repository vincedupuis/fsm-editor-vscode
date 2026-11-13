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

const RESERVED = ';/?:@&=+$,#';
const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * `decodeURI` without its URIError: decodes `%XX` escapes (UTF-8), except those of reserved characters
 * (`;/?:@&=+$,#`), and keeps malformed ones as they are (as fsm-generator does).
 */
export function decodeHref(s: string): string {
  const at = (i: number) => (s[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3)) ? parseInt(s.slice(i + 1, i + 3), 16) : -1);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const b = at(i);
    if (b >= 0) {
      const len = b < 0x80 ? 1 : b >= 0xc0 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf7 ? 4 : 0;
      const run = [b];
      let j = i + 3;
      while (run.length < len && at(j) >= 0) {
        run.push(at(j));
        j += 3;
      }
      let text: string | null = null;
      try {
        if (run.length === len) text = utf8.decode(new Uint8Array(run));
      } catch {
        text = null;
      }
      if (text !== null) {
        out += len === 1 && RESERVED.includes(text) ? s.slice(i, j) : text;
        i = j;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const encodeText = (text: string): Uint8Array => encoder.encode(text);
export const decodeText = (bytes: Uint8Array): string => decoder.decode(bytes);
