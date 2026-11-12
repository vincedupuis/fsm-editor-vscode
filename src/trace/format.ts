/**
 * Trace formats: how the Trace Player recognizes the lines of a log.
 *
 * The built-in format is what an `onTrace` hook of the generated code (see
 * docs/CODEGEN.md) can write, after any prefix of the application's logger:
 *
 *   2026-11-11T10:02:03.120Z INFO fsm Order event checkout checkout
 *   2026-11-11T10:02:03.121Z INFO fsm Order.Payment enter p_auth Authorizing
 *
 * Other logs are read with formats of the `fsmEditor.trace.formats` setting:
 * regular expressions with named groups (see TraceFormatSpec). Lines that no
 * rule matches are ignored.
 *
 * No VS Code API here: the unit tests run it in Node.js.
 */

export type TraceKind = 'event' | 'enter' | 'exit' | 'transition';
export const TRACE_KINDS: readonly TraceKind[] = ['event', 'enter', 'exit', 'transition'];

/** One line of a trace that a format recognized. */
export interface TraceRecord {
  kind: TraceKind;
  /** Milliseconds (since 1970, or since midnight for times without a date); undefined when the line has none. */
  time?: number;
  /** Machine name, followed for a submachine by the submachine states leading to it (`Order.Payment`); '' when the line has none. */
  machine: string;
  /** xmi:id of the state or transition, or the event's name. */
  id: string;
  /** Name of the state, transition or event. */
  name: string;
  /** Transitions without an id: the names of their source and target. */
  source?: string;
  target?: string;
  /** 0-based line number in the file. */
  line: number;
  /** The line as written, for display. */
  text: string;
}

/** A format of the `fsmEditor.trace.formats` setting. */
export interface TraceFormatSpec {
  name: string;
  /**
   * Rules, tried in order on each line; the first that matches makes the record. Named groups: `kind` (unless the
   * rule gives it), `time`, `machine`, `id`, `name`, and for transitions `source` and `target`.
   */
  rules: { kind?: string; match: string }[];
  /** Optional: a regular expression whose `time` group gives the time of every line (unless the rule has one). */
  time?: string;
  /** Optional: the machine of lines without a `machine` group (by default, the machine the trace is opened for). */
  machine?: string;
}

export interface TraceFormat {
  name: string;
  builtIn: boolean;
  parse(text: string, line: number): TraceRecord | null;
}

export const BUILT_IN_NAME = 'FSM Editor (built-in)';

/** An ISO 8601 date and time, or a time of day, as loggers print them. */
const ISO_TIME = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?/;

const BUILT_IN_LINE = /(?:^|\s)fsm\s+(\S+)\s+(event|enter|exit|transition)\s+(\S+)(?:\s+(.*?))?\s*$/;

export const builtInFormat: TraceFormat = {
  name: BUILT_IN_NAME,
  builtIn: true,
  parse(text, line) {
    const m = BUILT_IN_LINE.exec(text);
    if (!m) return null;
    const t = ISO_TIME.exec(text.slice(0, m.index));
    return { kind: m[2] as TraceKind, time: t ? parseTime(t[0]) : undefined, machine: m[1], id: m[3], name: m[4] ?? m[3], line, text };
  },
};

/**
 * Milliseconds of a time as written in a log: an ISO 8601 date and time (since 1970), a time of day (since midnight),
 * or a number (milliseconds, or seconds when below 10^11, as Unix timestamps in seconds are). Undefined otherwise.
 */
export function parseTime(text: string): number | undefined {
  const s = text.trim();
  if (!s) return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n < 1e11 ? n * 1000 : n;
  }
  const day = /^(\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?$/.exec(s);
  if (day) {
    const ms = day[4] ? Number(`0.${day[4]}`) * 1000 : 0;
    return ((Number(day[1]) * 60 + Number(day[2])) * 60 + Number(day[3])) * 1000 + ms;
  }
  const iso = Date.parse(s.replace(' ', 'T').replace(',', '.'));
  return Number.isNaN(iso) ? undefined : iso;
}

export class TraceFormatError extends Error {}

/** A format of the setting, compiled. Throws a TraceFormatError for a bad specification. */
export function compileFormat(spec: TraceFormatSpec): TraceFormat {
  const name = typeof spec?.name === 'string' && spec.name.trim() ? spec.name.trim() : 'Unnamed format';
  const regex = (source: unknown, what: string): RegExp => {
    if (typeof source !== 'string' || !source) throw new TraceFormatError(`Trace format '${name}': ${what} needs a regular expression.`);
    try {
      return new RegExp(source);
    } catch (e) {
      throw new TraceFormatError(`Trace format '${name}': ${what} is not a valid regular expression: ${e instanceof Error ? e.message : e}`);
    }
  };
  if (!Array.isArray(spec?.rules) || !spec.rules.length) throw new TraceFormatError(`Trace format '${name}' has no rules.`);
  const rules = spec.rules.map((r, i) => {
    const kind = r?.kind === undefined || r.kind === '' ? undefined : String(r.kind);
    if (kind !== undefined && !TRACE_KINDS.includes(kind as TraceKind)) {
      throw new TraceFormatError(`Trace format '${name}': rule ${i + 1} has kind '${kind}'; use event, enter, exit or transition.`);
    }
    const re = regex(r?.match, `rule ${i + 1}`);
    if (kind === undefined && !re.source.includes('?<kind>')) throw new TraceFormatError(`Trace format '${name}': rule ${i + 1} needs a kind, or a 'kind' group.`);
    return { kind: kind as TraceKind | undefined, re };
  });
  const timeRe = spec.time ? regex(spec.time, 'time') : undefined;
  const fixedMachine = typeof spec.machine === 'string' ? spec.machine.trim() : '';
  return {
    name,
    builtIn: false,
    parse(text, line) {
      for (const rule of rules) {
        const m = rule.re.exec(text);
        if (!m) continue;
        const g = m.groups ?? {};
        const kind = (rule.kind ?? g.kind?.trim().toLowerCase()) as TraceKind;
        if (!TRACE_KINDS.includes(kind)) continue;
        const timeText = g.time ?? (timeRe ? timeRe.exec(text)?.groups?.time : undefined);
        const id = g.id?.trim() ?? '';
        const nm = g.name?.trim() ?? '';
        const source = g.source?.trim();
        const target = g.target?.trim();
        if (!id && !nm && !(kind === 'transition' && source && target)) continue;
        return {
          kind,
          time: timeText !== undefined ? parseTime(timeText) : undefined,
          machine: g.machine?.trim() || fixedMachine,
          id,
          name: nm || id || `${source} -> ${target}`,
          source,
          target,
          line,
          text,
        };
      }
      return null;
    },
  };
}

/** The built-in format, then the setting's; bad ones are left out and reported in `errors`. */
export function traceFormats(specs: unknown, errors: string[] = []): TraceFormat[] {
  const out: TraceFormat[] = [builtInFormat];
  for (const spec of Array.isArray(specs) ? specs : []) {
    try {
      out.push(compileFormat(spec as TraceFormatSpec));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

/** The format recognizing the most of `lines` (the first one on a tie, so the built-in format when none does). */
export function detectFormat(formats: TraceFormat[], lines: string[]): TraceFormat {
  let best = formats[0];
  let bestCount = -1;
  for (const f of formats) {
    let n = 0;
    lines.forEach((l, i) => {
      if (f.parse(l, i)) n++;
    });
    if (n > bestCount) {
      best = f;
      bestCount = n;
    }
  }
  return best;
}
