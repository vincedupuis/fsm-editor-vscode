/**
 * Renders a code model with a Handlebars template. One template produces any
 * number of files through `{{#file "path"}}...{{/file}}` blocks; text outside
 * those blocks is ignored.
 *
 * A template may start with front matter (a YAML subset) between `---` lines:
 *
 *   ---
 *   lang: ts                   # language preset for `guard` and `id`
 *   guard:
 *     prefix: "this.actions."  # overrides the preset
 *   keywords: [signals]        # extra reserved words
 *   options:                   # free values, available as {{options.x}}
 *     namespace: fsm
 *   ---
 */
import Handlebars from 'handlebars';
import { CodeModel } from './codeModel';
import { OutputFile, registerHelpers } from './helpers';
import { LanguageConfig, languageConfig } from './languages';

export type { OutputFile } from './helpers';

export interface Template {
  /** Parsed front matter. */
  config: Record<string, unknown>;
  lang: LanguageConfig;
  body: string;
  /** Line of the body's first line in the template file (for error messages). */
  bodyLine: number;
}

export class TemplateError extends Error {}

export function parseTemplate(text: string): Template {
  const src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let config: Record<string, unknown> = {};
  let body = src;
  let bodyLine = 1;
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (m) {
    config = parseFrontMatter(m[1]);
    body = src.slice(m[0].length);
    bodyLine = m[0].split('\n').length;
  }
  return {
    config,
    lang: languageConfig(config.lang, config as { keywords?: unknown; guard?: unknown; escape?: unknown }),
    body,
    bodyLine,
  };
}

/** Renders `model` and returns the files declared by the template's `{{#file}}` blocks. */
export function render(template: Template, model: CodeModel): OutputFile[] {
  const hb = Handlebars.create();
  const files: OutputFile[] = [];
  registerHelpers(hb, template.lang, files);
  let fn: HandlebarsTemplateDelegate;
  try {
    fn = hb.compile(template.body, { noEscape: true, strict: false });
    fn({ ...model, lang: template.lang, options: template.config.options ?? {}, config: template.config });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Handlebars parse errors mention body lines; shift them to template file lines.
    throw new TemplateError(msg.replace(/on line (\d+)/, (_, n) => `on line ${Number(n) + template.bodyLine - 1}`));
  }
  if (!files.length) throw new TemplateError('The template declares no files: wrap the output in {{#file "Name.ext"}}...{{/file}} blocks.');
  for (const f of files) {
    f.content = f.content.replace(/\r\n?/g, '\n').replace(/^\n+/, '');
  }
  return files;
}

// ------------------------------------------------------------------ front matter

/**
 * A small YAML subset: `key: value` maps nested by indentation, `- item`
 * lists, inline `[a, b]` lists, quoted or plain scalars, numbers, booleans,
 * null and `#` comments.
 */
export function parseFrontMatter(text: string): Record<string, unknown> {
  const lines = text
    .split('\n')
    .map((raw, i) => ({ raw: stripComment(raw), no: i + 1 }))
    .filter((l) => l.raw.trim())
    .map((l) => ({ indent: l.raw.length - l.raw.trimStart().length, text: l.raw.trim(), no: l.no }));
  let i = 0;

  const block = (indent: number): unknown => {
    if (i < lines.length && lines[i].text.startsWith('- ')) {
      const list: unknown[] = [];
      while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
        list.push(scalar(lines[i].text.slice(2).trim()));
        i++;
      }
      return list;
    }
    const map: Record<string, unknown> = {};
    while (i < lines.length && lines[i].indent === indent) {
      const line = lines[i];
      const m = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*))?$/.exec(line.text);
      if (!m) throw new TemplateError(`Front matter line ${line.no}: expected 'key: value'.`);
      i++;
      if (m[2] !== undefined && m[2] !== '') map[m[1]] = scalar(m[2]);
      else if (i < lines.length && lines[i].indent > indent) map[m[1]] = block(lines[i].indent);
      else map[m[1]] = null;
    }
    if (i < lines.length && lines[i].indent > indent) throw new TemplateError(`Front matter line ${lines[i].no}: unexpected indentation.`);
    return map;
  };

  const result = lines.length ? block(lines[0].indent) : {};
  if (i < lines.length) throw new TemplateError(`Front matter line ${lines[i].no}: unexpected indentation.`);
  if (Array.isArray(result)) throw new TemplateError('Front matter must be a map of keys.');
  return result as Record<string, unknown>;
}

function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

function scalar(text: string): unknown {
  const s = text.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner ? splitList(inner).map(scalar) : [];
  }
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s);
    } catch {
      throw new TemplateError(`Front matter: invalid string ${s}.`);
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function splitList(text: string): string[] {
  const out: string[] = [];
  let quote = '';
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') {
        cur += c + (text[++i] ?? '');
        continue;
      }
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ',') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}
