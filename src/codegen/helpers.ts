/**
 * The helpers every template can use. They are built in on purpose: templates
 * are data (no JavaScript), so generating code never runs code from a
 * workspace, and templates work the same in the CLI, the desktop and the web
 * extension. Language-specific output (guards, reserved words) comes from the
 * template's language config (see languages.ts).
 */
import type HandlebarsNamespace from 'handlebars';
import type { Condition } from './codeModel';
import { LanguageConfig } from './languages';

export interface OutputFile {
  path: string;
  content: string;
}

/** A warning or error a template reports with `{{warn}}` or `{{error}}`, about the element with xmi:id `id` ('' when none). */
export interface TemplateIssue {
  severity: 'warning' | 'error';
  message: string;
  id: string;
}

type Handlebars = typeof HandlebarsNamespace;
type Options = HandlebarsNamespace.HelperOptions;

/** Words of an identifier: `blinkLed`, `blink_led` and `BlinkLED` all give blink, led. */
export function words(text: string): string[] {
  return String(text ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

export const pascal = (s: string) => words(s).map(cap).join('');
export const camel = (s: string) => {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
};
export const snake = (s: string) => words(s).map((w) => w.toLowerCase()).join('_');
export const upper = (s: string) => words(s).map((w) => w.toUpperCase()).join('_');

/** Prints a condition tree in the syntax of `lang`, with `overrides` (from the helper's hash) applied. */
export function printCondition(c: Condition | null | undefined, lang: LanguageConfig, overrides: Record<string, unknown> = {}): string {
  const g = { ...lang.guard };
  for (const [k, v] of Object.entries(overrides)) if (k in g && typeof v === 'string') (g as Record<string, string>)[k] = v;
  const id = (name: string) => escapeId(name, lang);
  // Precedence: or < and < not < call.
  const rank = (x: Condition) => (x.op === 'or' ? 1 : x.op === 'and' ? 2 : 3);
  const print = (x: Condition, min: number): string => {
    let s: string;
    if (x.op === 'call') s = `${g.prefix}${id(x.name)}${g.suffix}`;
    else if (x.op === 'not') s = `${g.not}${print(x.arg, 3)}`;
    else s = x.args.map((a) => print(a, rank(x))).join(x.op === 'and' ? g.and : g.or);
    return rank(x) < min ? `(${s})` : s;
  };
  return c ? print(c, 0) : g.true;
}

export function escapeId(name: string, lang: LanguageConfig): string {
  const s = String(name ?? '');
  return lang.keywords.includes(s) ? `${s}${lang.escape}` : s;
}

/** A path relative to the output folder, without `..`. */
export function checkOutputPath(p: string): string {
  const path = String(p ?? '').trim().replace(/\\/g, '/');
  if (!path) throw new Error('A {{#file}} block has an empty file name.');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw new Error(`Generated file '${path}' must be a relative path.`);
  const parts = path.split('/').filter((x) => x && x !== '.');
  if (parts.includes('..')) throw new Error(`Generated file '${path}' must stay inside the output folder (no '..').`);
  return parts.join('/');
}

/** Registers the helpers on `hb`; `files` receives the output of `{{#file}}` blocks, `issues` what `{{warn}}` and `{{error}}` report. */
export function registerHelpers(hb: Handlebars, lang: LanguageConfig, files: OutputFile[], issues: TemplateIssue[] = []): void {
  const args = (list: unknown[]) => list.slice(0, -1); // drop Handlebars' options argument

  hb.registerHelper('file', function (this: unknown, name: unknown, options: Options) {
    const path = checkOutputPath(String(name));
    if (files.some((f) => f.path === path)) throw new Error(`The template writes '${path}' twice.`);
    files.push({ path, content: options.fn(this) });
    return '';
  });

  hb.registerHelper('concat', (...list: unknown[]) => args(list).map((x) => String(x ?? '')).join(''));
  hb.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  hb.registerHelper('ne', (a: unknown, b: unknown) => a !== b);
  hb.registerHelper('and', (...list: unknown[]) => args(list).every(Boolean));
  hb.registerHelper('or', (...list: unknown[]) => args(list).some(Boolean));
  hb.registerHelper('not', (a: unknown) => !a);

  hb.registerHelper('guard', (c: Condition | null, options: Options) => printCondition(c, lang, options.hash));
  hb.registerHelper('id', (name: string) => escapeId(name, lang));
  hb.registerHelper('pascal', (s: string) => escapeId(pascal(s), lang));
  hb.registerHelper('camel', (s: string) => escapeId(camel(s), lang));
  hb.registerHelper('snake', (s: string) => escapeId(snake(s), lang));
  hb.registerHelper('upper', (s: string) => escapeId(upper(s), lang));

  /** `{{join list ", "}}`, or `{{join list ", " "name"}}` to join a property of each item. */
  hb.registerHelper('join', (...list: unknown[]) => {
    const [items, sep = ', ', prop] = args(list) as [unknown, string?, string?];
    if (!Array.isArray(items)) return '';
    return items.map((x) => (prop && x && typeof x === 'object' ? (x as Record<string, unknown>)[prop] : x)).join(String(sep));
  });
  /** A double-quoted string literal (valid in C, C++, Java, TypeScript and Python). */
  hb.registerHelper('quote', (s: unknown) => JSON.stringify(String(s ?? '')));
  /**
   * `{{#switch kind}}{{#case "a" "b"}}…{{/case}}{{#default}}…{{/default}}{{/switch}}`: the first case listing the
   * value, or the default. Text between the cases is dropped.
   */
  const switches: { value: unknown; done: boolean }[] = [];
  hb.registerHelper('switch', function (this: unknown, value: unknown, options: Options) {
    switches.push({ value, done: false });
    try {
      return options.fn(this).replace(/\u0000([\s\S]*?)\u0001|[\s\S]/g, (_, chosen) => chosen ?? '');
    } finally {
      switches.pop();
    }
  });
  hb.registerHelper('case', function (this: unknown, ...list: unknown[]) {
    const options = list[list.length - 1] as Options;
    const top = switches[switches.length - 1];
    if (!top) throw new Error('{{#case}} must be inside {{#switch}}.');
    if (top.done || !args(list).includes(top.value)) return '';
    top.done = true;
    return `\u0000${options.fn(this)}\u0001`;
  });
  hb.registerHelper('default', function (this: unknown, options: Options) {
    const top = switches[switches.length - 1];
    if (!top) throw new Error('{{#default}} must be inside {{#switch}}.');
    if (top.done) return '';
    top.done = true;
    return `\u0000${options.fn(this)}\u0001`;
  });
  /** `{{#if (includes list value)}}`: whether a list holds a value. */
  hb.registerHelper('includes', (list: unknown, value: unknown) => Array.isArray(list) && list.includes(value));

  /**
   * `{{warn "message" id=id}}` reports a warning; `{{error ...}}` an error, which stops the generation once the
   * template has been rendered (so that every error is reported). Several arguments are joined, like `concat`.
   */
  const report = (severity: TemplateIssue['severity']) => (...list: unknown[]) => {
    const options = list[list.length - 1] as Options;
    const message = args(list).map((x) => String(x ?? '')).join('');
    const id = String(options.hash?.id ?? '');
    if (!issues.some((i) => i.severity === severity && i.message === message && i.id === id)) issues.push({ severity, message, id });
    return '';
  };
  hb.registerHelper('warn', report('warning'));
  hb.registerHelper('error', report('error'));
}
