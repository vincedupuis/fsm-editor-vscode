/**
 * A JSON reader that keeps the line of every value and of every field, for the `.fsm` and `.fsm.layout` files: their
 * problems are reported with their lines. Strict JSON (RFC 8259), plus a byte order mark at the start, which is
 * skipped; a field given twice in one object is an error. The same reader as fsm-cli's `src/json.rs`: the same
 * values and the same errors, at the same lines.
 */

export type JsonValue = null | boolean | number | string | JsonNode[] | JsonField[];

/** A value and the line it starts on (1-based). Objects hold their fields in order, arrays their items. */
export interface JsonNode {
  kind: 'null' | 'bool' | 'number' | 'string' | 'array' | 'object';
  value: JsonValue;
  line: number;
}

export interface JsonField {
  key: string;
  /** Line of the field's name. */
  line: number;
  value: JsonNode;
}

export class JsonSyntaxError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

/** How a character is shown in a message: itself, or `\uXXXX` for control and invisible characters. */
function show(c: string): string {
  const code = c.codePointAt(0)!;
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xfeff) return `\\u${code.toString(16).padStart(4, '0')}`;
  return c;
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** Parses a JSON document; throws JsonSyntaxError. */
export function parseJson(text: string): JsonNode {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  const fail = (message: string, at = line): never => {
    throw new JsonSyntaxError(at, message);
  };
  const unexpected = (): never => {
    if (i >= text.length) return fail('Unexpected end of the file.');
    return fail(`Unexpected character '${show(String.fromCodePoint(text.codePointAt(i)!))}'.`);
  };
  const space = () => {
    while (i < text.length) {
      const c = text[i];
      if (c === '\n') line++;
      else if (c !== ' ' && c !== '\t' && c !== '\r') return;
      i++;
    }
  };
  const hex4 = (): number => {
    const h = text.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) return fail('Invalid escape in a text.');
    i += 4;
    return parseInt(h, 16);
  };
  const string = (): string => {
    i++; // the opening quote
    let out = '';
    for (;;) {
      if (i >= text.length) return fail('Unexpected end of the file in a text.');
      const c = text[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c === '\\') {
        const e = text[i + 1];
        i += 2;
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const u = hex4();
            if (u >= 0xd800 && u < 0xdc00) {
              if (text.slice(i, i + 2) !== '\\u') return fail('Invalid escape in a text.');
              i += 2;
              const low = hex4();
              if (low < 0xdc00 || low >= 0xe000) return fail('Invalid escape in a text.');
              out += String.fromCharCode(u, low);
            } else if (u >= 0xdc00 && u < 0xe000) {
              return fail('Invalid escape in a text.');
            } else out += String.fromCharCode(u);
            break;
          }
          default:
            return fail('Invalid escape in a text.');
        }
        continue;
      }
      if (c.charCodeAt(0) < 0x20) return fail(`Control character '${show(c)}' in a text: write it as an escape.`);
      // A lone surrogate can't be UTF-8: the file couldn't hold it.
      out += c;
      i++;
    }
  };
  const number = (): number => {
    const start = i;
    if (text[i] === '-') i++;
    if (!isDigit(text[i])) return fail('Invalid number.');
    if (text[i] === '0') {
      i++;
      if (isDigit(text[i])) return fail('Invalid number.');
    } else while (isDigit(text[i])) i++;
    if (text[i] === '.') {
      i++;
      if (!isDigit(text[i])) return fail('Invalid number.');
      while (isDigit(text[i])) i++;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      if (!isDigit(text[i])) return fail('Invalid number.');
      while (isDigit(text[i])) i++;
    }
    const n = Number(text.slice(start, i));
    return Number.isFinite(n) ? n : fail('Invalid number.');
  };
  const word = (w: string, v: boolean | null): boolean | null => {
    if (text.startsWith(w, i)) {
      i += w.length;
      return v;
    }
    return unexpected();
  };
  const value = (depth: number): JsonNode => {
    if (depth > 200) fail('The document is nested too deeply.');
    space();
    const at = line;
    const c = text[i];
    if (c === undefined) return unexpected();
    if (c === '{') {
      i++;
      const fields: JsonField[] = [];
      space();
      if (text[i] === '}') i++;
      else {
        for (;;) {
          space();
          if (text[i] !== '"') unexpected();
          const keyLine = line;
          const key = string();
          if (fields.some((f) => f.key === key)) fail(`Field '${key}' is given twice.`, keyLine);
          space();
          if (text[i] !== ':') unexpected();
          i++;
          const v = value(depth + 1);
          fields.push({ key, line: keyLine, value: v });
          space();
          if (text[i] === ',') i++;
          else if (text[i] === '}') {
            i++;
            break;
          } else unexpected();
        }
      }
      return { kind: 'object', value: fields, line: at };
    }
    if (c === '[') {
      i++;
      const items: JsonNode[] = [];
      space();
      if (text[i] === ']') i++;
      else {
        for (;;) {
          items.push(value(depth + 1));
          space();
          if (text[i] === ',') i++;
          else if (text[i] === ']') {
            i++;
            break;
          } else unexpected();
        }
      }
      return { kind: 'array', value: items, line: at };
    }
    if (c === '"') return { kind: 'string', value: string(), line: at };
    if (c === 't') return { kind: 'bool', value: word('true', true), line: at };
    if (c === 'f') return { kind: 'bool', value: word('false', false), line: at };
    if (c === 'n') return { kind: 'null', value: word('null', null), line: at };
    if (c === '-' || isDigit(c)) return { kind: 'number', value: number(), line: at };
    return unexpected();
  };
  const root = value(0);
  space();
  if (i < text.length) unexpected();
  return root;
}

// ------------------------------------------------------------------ access

export const fieldsOf = (n: JsonNode | undefined): JsonField[] | undefined => (n?.kind === 'object' ? (n.value as JsonField[]) : undefined);
export const itemsOf = (n: JsonNode | undefined): JsonNode[] | undefined => (n?.kind === 'array' ? (n.value as JsonNode[]) : undefined);
export const strOf = (n: JsonNode | undefined): string | undefined => (n?.kind === 'string' ? (n.value as string) : undefined);
export const numOf = (n: JsonNode | undefined): number | undefined => (n?.kind === 'number' ? (n.value as number) : undefined);
export const getField = (n: JsonNode | undefined, key: string): JsonField | undefined => fieldsOf(n)?.find((f) => f.key === key);

/** The plain value of a node (objects with their fields in order). */
export function plain(n: JsonNode): unknown {
  switch (n.kind) {
    case 'array':
      return (n.value as JsonNode[]).map(plain);
    case 'object':
      return Object.fromEntries((n.value as JsonField[]).map((f) => [f.key, plain(f.value)]));
    default:
      return n.value;
  }
}

// ------------------------------------------------------------------ writing

/** A text as the files write it: minimal escapes (`\"`, `\\`, `\n`, `\t`, `\u00XX` for other control characters). */
export function quote(s: string): string {
  let out = '"';
  for (const c of s) {
    const code = c.charCodeAt(0);
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    else if (c === '\n') out += '\\n';
    else if (c === '\t') out += '\\t';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += c;
  }
  return out + '"';
}

/** A value to write: texts, numbers, lists and objects (fields in order; undefined fields are left out). */
export type Out = string | number | boolean | Out[] | OutObject;
export interface OutObject {
  [key: string]: Out | undefined;
}

/**
 * Writes a document, 2-space indented, with a newline at the end. `inline(o)` says whether an object goes on one line
 * (lists are always one item per line, the top-level object one field per line). `onLine(o, line)` is told the line
 * where each object starts.
 */
export function writeJson(root: OutObject, inline: (o: OutObject) => boolean, onLine?: (o: OutObject, line: number) => void): string {
  const lines: string[] = [];
  const isObject = (v: Out): v is OutObject => typeof v === 'object' && !Array.isArray(v);
  const entries = (o: OutObject) => Object.entries(o).filter((e): e is [string, Out] => e[1] !== undefined);
  const flat = (v: Out): string => {
    if (typeof v === 'string') return quote(v);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return `[${v.map(flat).join(', ')}]`;
    const e = entries(v);
    return e.length ? `{ ${e.map(([k, x]) => `${quote(k)}: ${flat(x)}`).join(', ')} }` : '{}';
  };
  // Appends `v` after `prefix` (on the current new line, at `indent`), then `suffix`.
  const put = (v: Out, indent: string, prefix: string, suffix: string, top = false) => {
    if (isObject(v)) {
      onLine?.(v, lines.length + 1);
      const e = entries(v);
      if (!e.length || (!top && inline(v))) {
        lines.push(indent + prefix + flat(v) + suffix);
        return;
      }
      lines.push(indent + prefix + '{');
      e.forEach(([k, x], i) => put(x, indent + '  ', `${quote(k)}: `, i < e.length - 1 ? ',' : ''));
      lines.push(indent + '}' + suffix);
      return;
    }
    if (Array.isArray(v)) {
      if (!v.length) {
        lines.push(indent + prefix + '[]' + suffix);
        return;
      }
      lines.push(indent + prefix + '[');
      v.forEach((x, i) => put(x, indent + '  ', '', i < v.length - 1 ? ',' : ''));
      lines.push(indent + ']' + suffix);
      return;
    }
    lines.push(indent + prefix + flat(v) + suffix);
  };
  put(root, '', '', '', true);
  return lines.join('\n') + '\n';
}
