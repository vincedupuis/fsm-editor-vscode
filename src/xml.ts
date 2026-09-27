/**
 * Minimal XML reader and writer, enough for XMI documents: elements,
 * attributes, text, CDATA, comments, processing instructions and namespaces.
 * Element and attribute names are rewritten to canonical prefixes for known
 * namespace URIs, so documents using other prefixes read the same.
 */

export interface XmlElement {
  /** Qualified name using the canonical prefix when the namespace is known, e.g. `uml:Model`. */
  name: string;
  /** Namespace URI of the element ('' when none). */
  ns: string;
  /** Local part of the name. */
  local: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
  line: number;
}

export class XmlError extends Error {
  constructor(message: string, readonly line: number) {
    super(`Line ${line}: ${message}`);
  }
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string, line: number): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    if (e in ENTITIES) return ENTITIES[e];
    throw new XmlError(`Unknown entity ${m}.`, line);
  });
}

/**
 * Parses `text` and returns the document element.
 * `canonical` maps namespace URIs to the prefix used in the returned names.
 */
export function parseXml(text: string, canonical: Record<string, string> = {}): XmlElement {
  let i = 0;
  let line = 1;
  const advance = (to: number) => {
    for (let k = i; k < to; k++) if (text.charCodeAt(k) === 10) line++;
    i = to;
  };
  const expect = (s: string) => {
    if (!text.startsWith(s, i)) throw new XmlError(`Expected '${s}'.`, line);
    advance(i + s.length);
  };
  const skipUntil = (end: string, what: string) => {
    const j = text.indexOf(end, i);
    if (j < 0) throw new XmlError(`Unterminated ${what}.`, line);
    const content = text.slice(i, j);
    advance(j + end.length);
    return content;
  };
  const skipSpace = () => {
    let j = i;
    while (j < text.length && /\s/.test(text[j])) j++;
    advance(j);
  };
  const nameAt = () => {
    const m = /^[A-Za-z_][\w.\-:]*/.exec(text.slice(i, i + 256));
    if (!m) throw new XmlError('Expected a name.', line);
    advance(i + m[0].length);
    return m[0];
  };

  type Raw = { qname: string; attrs: [string, string][]; children: Raw[]; text: string; line: number };

  const element = (): Raw => {
    const start = line;
    expect('<');
    const qname = nameAt();
    const attrs: [string, string][] = [];
    for (;;) {
      skipSpace();
      if (text.startsWith('/>', i)) {
        advance(i + 2);
        return { qname, attrs, children: [], text: '', line: start };
      }
      if (text[i] === '>') {
        advance(i + 1);
        break;
      }
      const an = nameAt();
      skipSpace();
      expect('=');
      skipSpace();
      const q = text[i];
      if (q !== '"' && q !== "'") throw new XmlError(`Attribute ${an} must be quoted.`, line);
      advance(i + 1);
      const at = line;
      const raw = skipUntil(q, `attribute ${an}`);
      if (raw.includes('<')) throw new XmlError(`'<' is not allowed in attribute ${an}.`, at);
      attrs.push([an, decode(raw, at)]);
    }
    const children: Raw[] = [];
    let content = '';
    for (;;) {
      if (i >= text.length) throw new XmlError(`Element <${qname}> is not closed.`, start);
      if (text.startsWith('</', i)) {
        advance(i + 2);
        const close = nameAt();
        if (close !== qname) throw new XmlError(`Expected </${qname}>, found </${close}>.`, line);
        skipSpace();
        expect('>');
        return { qname, attrs, children, text: content, line: start };
      }
      if (text.startsWith('<!--', i)) {
        advance(i + 4);
        skipUntil('-->', 'comment');
      } else if (text.startsWith('<![CDATA[', i)) {
        advance(i + 9);
        content += skipUntil(']]>', 'CDATA section');
      } else if (text.startsWith('<?', i)) {
        advance(i + 2);
        skipUntil('?>', 'processing instruction');
      } else if (text[i] === '<') {
        children.push(element());
      } else {
        const j = text.indexOf('<', i);
        const at = line;
        const chunk = text.slice(i, j < 0 ? text.length : j);
        advance(j < 0 ? text.length : j);
        content += decode(chunk, at);
      }
    }
  };

  // Prolog
  for (;;) {
    skipSpace();
    if (text.startsWith('<?', i)) {
      advance(i + 2);
      skipUntil('?>', 'processing instruction');
    } else if (text.startsWith('<!--', i)) {
      advance(i + 4);
      skipUntil('-->', 'comment');
    } else if (text.startsWith('<!DOCTYPE', i)) {
      skipUntil('>', 'DOCTYPE');
    } else break;
  }
  if (text[i] !== '<') throw new XmlError('The document does not start with an element.', line);
  const root = element();
  skipSpace();
  while (text.startsWith('<!--', i)) {
    advance(i + 4);
    skipUntil('-->', 'comment');
    skipSpace();
  }
  if (i < text.length) throw new XmlError('Content after the document element.', line);

  // Namespace resolution
  const resolve = (raw: Raw, scope: Record<string, string>): XmlElement => {
    const s = { ...scope };
    for (const [k, v] of raw.attrs) {
      if (k === 'xmlns') s[''] = v;
      else if (k.startsWith('xmlns:')) s[k.slice(6)] = v;
    }
    const qualify = (qname: string, isAttr: boolean) => {
      const c = qname.indexOf(':');
      const prefix = c < 0 ? '' : qname.slice(0, c);
      const local = c < 0 ? qname : qname.slice(c + 1);
      if (isAttr && c < 0) return { name: local, ns: '', local };
      const ns = s[prefix] ?? '';
      const p = canonical[ns] ?? prefix;
      return { name: p ? `${p}:${local}` : local, ns, local };
    };
    const el = qualify(raw.qname, false);
    const attrs: Record<string, string> = {};
    for (const [k, v] of raw.attrs) {
      if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
      attrs[qualify(k, true).name] = v;
    }
    // Qualified values (xmi:type="uml:State") follow the same prefix mapping.
    for (const k of Object.keys(attrs)) {
      if (k.endsWith(':type')) attrs[k] = qualify(attrs[k], false).name;
    }
    return {
      name: el.name,
      ns: el.ns,
      local: el.local,
      attrs,
      children: raw.children.map((c) => resolve(c, s)),
      text: raw.text,
      line: raw.line,
    };
  };
  return resolve(root, {});
}

// ------------------------------------------------------------------ writing

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

/** An element to write: `[name, attributes, ...children]`, children being elements or text. */
export type Node = [string, Record<string, string | number | undefined>, ...(Node | string)[]];

export function writeXml(root: Node): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const write = (node: Node, indent: string) => {
    const [name, attrs, ...children] = node;
    let open = `${indent}<${name}`;
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === '') continue;
      open += ` ${k}="${escapeXml(String(v))}"`;
    }
    if (!children.length) {
      out.push(`${open}/>`);
    } else if (children.length === 1 && typeof children[0] === 'string') {
      out.push(`${open}>${escapeXml(children[0]).replace(/&#10;/g, '\n')}</${name}>`);
    } else {
      out.push(`${open}>`);
      for (const c of children) {
        if (typeof c === 'string') out.push(`${indent}  ${escapeXml(c)}`);
        else write(c, indent + '  ');
      }
      out.push(`${indent}</${name}>`);
    }
  };
  write(root, '');
  return out.join('\n') + '\n';
}
