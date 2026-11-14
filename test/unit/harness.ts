/**
 * Test helpers: build models in code, generate code for them with fsm-cli's
 * WebAssembly module (fsm/fsm.wasm, as the extension does) and the bundled
 * templates (fsm/templates/ts.jinja), bundle and load the TypeScript, and
 * record what the machines call.
 */
import * as esbuild from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FsmFile, FsmIssue, FsmResponse, Generator, loadGenerator } from '../../src/fsmCli';
import { FsmModel, Transition, Vertex, VertexType } from '../../src/model';
import { toXmi } from '../../src/xmi';

export const root = resolve(__dirname, '../../..');

let generator: Generator | undefined;

/** The module's response for `machines` (file name → model or XMI text), all generated, in a folder /m. */
export async function run(machines: Record<string, FsmModel | string>, template: string, templateName = 'test.jinja'): Promise<FsmResponse> {
  if (!generator) {
    const wasm = join(root, 'fsm/fsm.wasm');
    if (!existsSync(wasm)) throw new Error('fsm/fsm.wasm is missing: build it with npm run build:fsm (see README.md, Development).');
    generator = loadGenerator(readFileSync(wasm));
  }
  const files: Record<string, string> = {};
  for (const [name, m] of Object.entries(machines)) files[`/m/${name}`] = typeof m === 'string' ? m : toXmi(m);
  return generator({ cwd: '/m', files, generate: Object.keys(machines), template, templateName });
}

/** A failed generation: the module's error, with the problems it reported. */
export class GenerateFailure extends Error {
  constructor(readonly response: FsmResponse) {
    super(response.error ?? `exit code ${response.exitCode}`);
  }

  get issues(): FsmIssue[] {
    return this.response.issues;
  }
}

/** Generates `machines` with a template's text; throws GenerateFailure when nothing is generated. */
export async function generate(machines: Record<string, FsmModel | string>, template: string, templateName?: string): Promise<{ files: FsmFile[]; issues: FsmIssue[] }> {
  const r = await run(machines, template, templateName);
  if (r.exitCode !== 0) throw new GenerateFailure(r);
  return r;
}

/** A bundled template's text (fsm/templates/<name>.jinja). */
export const bundled = (name: 'ts' | 'sml') => readFileSync(join(root, 'fsm/templates', `${name}.jinja`), 'utf8');

/** Template printing the code model of each machine as JSON, in <machine>.json: the keys of the code model. */
const DUMP = `{% filter file(machine.name ~ ".json") %}{{ {"machine": machine, "regions": regions, "topRegions": topRegions, "states": states, "events": events, "timers": timers, "signals": signals, "actions": actions, "conditions": conditions, "activities": activities, "transitions": transitions, "submachines": submachines, "entryPoints": entryPoints, "exitPoints": exitPoints, "start": start, "invariants": invariants, "features": features, "tables": tables} | tojson }}{% endfilter %}`;

/** The code model of a machine, as templates see it. */
export async function codeModel(model: FsmModel): Promise<any> {
  const { files } = await generate({ [`${model.name}.fsm`]: model }, DUMP);
  return JSON.parse(files[0].content);
}

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
  const result = await generate(machines, bundled('ts'), 'ts.jinja');
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
