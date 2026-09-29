/**
 * Test helpers: build models in code, generate TypeScript for them with
 * templates/ts.hbs, bundle and load the result, and record what the machines
 * call.
 */
import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generate, GenerateHost } from '../../src/codegen/generate';
import { parseTemplate } from '../../src/codegen/render';
import { FsmModel, Transition, Vertex, VertexType } from '../../src/model';
import { toXmi } from '../../src/xmi';

export const root = resolve(__dirname, '../../..');

/** Builds an FsmModel in code; every method returns the new element's id. */
export class ModelBuilder {
  readonly model: FsmModel;
  private n = 0;

  constructor(name: string, kind: 'behavioral' | 'protocol' = 'behavioral') {
    this.model = { version: 1, id: 'sm', name, kind, context: '', documentation: '', regions: [{ id: 'r_root', name: '' }], vertices: [], transitions: [] };
  }

  vertex(type: VertexType, parent = 'r_root', extra: Partial<Vertex> = {}): string {
    const id = extra.id ?? `v${++this.n}`;
    this.model.vertices.push({ id, type, name: '', parent, x: 0, y: 0, w: 10, h: 10, regions: [], ...extra });
    return id;
  }

  /** A state; `regions` > 0 makes it composite, with region ids `<id>_r0`, `<id>_r1`, ... */
  state(name: string, parent = 'r_root', extra: Partial<Vertex> = {}, regions = 0): string {
    const id = extra.id ?? name;
    const regs = Array.from({ length: regions }, (_, i) => ({ id: `${id}_r${i}`, name: '' }));
    return this.vertex('state', parent, { id, name, regions: regs, ...extra });
  }

  t(source: string, target: string, extra: Partial<Transition> = {}): string {
    const id = extra.id ?? `t${++this.n}`;
    this.model.transitions.push({ id, source, target, kind: 'external', triggers: [], guard: '', effect: '', ...extra });
    return id;
  }

  /** Initial pseudostate of `region` targeting `target`. */
  init(target: string, region = 'r_root'): void {
    this.t(this.vertex('initial', region), target);
  }
}

/** Generates TypeScript for `machines` (file name → model or XMI text) and loads the machine classes. */
export async function load(machines: Record<string, FsmModel | string>): Promise<Record<string, any>> {
  const files = new Map<string, string>();
  for (const [name, m] of Object.entries(machines)) files.set(`/m/${name}`, typeof m === 'string' ? m : toXmi(m));
  const host: GenerateHost = {
    readFile: async (p) => {
      const text = files.get(p);
      if (text === undefined) throw new Error('not found');
      return text;
    },
    resolve: (from, href) => `${from.slice(0, from.lastIndexOf('/'))}/${decodeURI(href)}`,
    display: (p) => p.slice(3),
  };
  const template = parseTemplate(readFileSync(join(root, 'templates/ts.hbs'), 'utf8'));
  const result = await generate(Object.keys(machines).map((name) => `/m/${name}`), template, host);
  const dir = mkdtempSync(join(tmpdir(), 'fsm-codegen-'));
  try {
    for (const f of result.files) writeFileSync(join(dir, f.path), f.content);
    const names = result.files.filter((f) => !f.path.includes('Actions')).map((f) => f.path.replace(/\.ts$/, ''));
    writeFileSync(join(dir, 'index.ts'), names.map((n) => `export { ${n} } from './${n}';`).join('\n'));
    const out = join(dir, 'bundle.js');
    await esbuild.build({ entryPoints: [join(dir, 'index.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
    const mod = { exports: {} as Record<string, any> };
    new Function('module', 'exports', 'require', readFileSync(out, 'utf8'))(mod, mod.exports, require);
    return mod.exports;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Actions that record every call; conditions return the given values (false by default). */
export function recorder(conditions: Record<string, boolean> = {}) {
  const log: string[] = [];
  const make = (prefix: string): any =>
    new Proxy(
      {},
      {
        get: (_, name) => {
          if (typeof name !== 'string' || name === 'then') return undefined;
          if (name === 'submachines') return new Proxy({}, { get: (__, sub) => make(`${String(sub)}.`) });
          if (name === 'onConstraintViolation') return (kind: string, element: string) => log.push(`!${kind}: ${element}`);
          return () => {
            log.push(prefix + name);
            return !!conditions[name];
          };
        },
      },
    );
  return {
    actions: make(''),
    conditions,
    /** The calls recorded since the last take(). */
    take(): string[] {
      return log.splice(0);
    },
  };
}

export class FakeClock {
  private next = 1;
  readonly timers = new Map<number, { callback: () => void; ms: number }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { callback, ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Durations of the pending timers. */
  get pending(): number[] {
    return [...this.timers.values()].map((t) => t.ms);
  }

  /** Fires every pending timer. */
  fire(): void {
    const list = [...this.timers.values()];
    this.timers.clear();
    for (const t of list) t.callback();
  }
}
