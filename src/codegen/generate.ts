/**
 * The whole pipeline: read `.fsm` files (and the machines their submachine
 * states reference), validate them, build their code models and render them
 * with a template. File access goes through `GenerateHost`, so this runs in
 * the CLI (Node), the desktop extension and the web extension alike.
 */
import { FsmModel, SubmachineInfo, machineConnectionPoints } from '../model';
import { Issue, validate } from '../validation';
import { fromXmi } from '../xmi';
import { CodeGenError, CodeModel, toCodeModel } from './codeModel';
import { OutputFile, Template, TemplateIssue, render } from './render';

export interface GenerateHost {
  readFile(path: string): Promise<string>;
  /** The path of `href` (relative, `/`-separated, URI-encoded, without `#id`) as seen from the file `from`. */
  resolve(from: string, href: string): string;
  /** How to show a path in messages and generated comments. */
  display?(path: string): string;
}

export interface FileIssue extends Issue {
  file: string;
}

export interface GenerateResult {
  files: OutputFile[];
  /** Validation problems; generation stops when one of them is an error. */
  issues: FileIssue[];
  /** The machines generated, as displayed paths. */
  machines: string[];
}

export class GenerateError extends Error {
  constructor(
    message: string,
    readonly issues: FileIssue[] = [],
  ) {
    super(message);
  }
}

interface Loaded {
  path: string;
  model: FsmModel;
  /** href as written in this model → key of the loaded machine. */
  refs: Map<string, string>;
  code?: CodeModel;
}

export async function generate(sources: string[], template: Template, host: GenerateHost): Promise<GenerateResult> {
  const display = (p: string) => host.display?.(p) ?? p;
  const loaded = new Map<string, Loaded>();
  const issues: FileIssue[] = [];

  const load = async (path: string, expectedId?: string): Promise<string> => {
    const known = loaded.get(path);
    if (known) {
      if (expectedId && (known.model.id ?? 'sm') !== expectedId) throw new GenerateError(`${display(path)} has no state machine with id '${expectedId}'.`);
      return known.path;
    }
    let text: string;
    try {
      text = await host.readFile(path);
    } catch {
      throw new GenerateError(`${display(path)} does not exist or cannot be read.`);
    }
    let model: FsmModel;
    try {
      model = fromXmi(text);
    } catch (e) {
      throw new GenerateError(`${display(path)} is not a valid state machine file: ${e instanceof Error ? e.message : e}`);
    }
    if (expectedId && (model.id ?? 'sm') !== expectedId) throw new GenerateError(`${display(path)} has no state machine with id '${expectedId}'.`);
    const entry: Loaded = { path, model, refs: new Map() };
    loaded.set(path, entry);

    // Submachines, then validation with what is known about them.
    const info: SubmachineInfo = {};
    for (const v of model.vertices) {
      if (v.type !== 'state' || !v.submachine || entry.refs.has(v.submachine)) continue;
      const [file, id = ''] = v.submachine.split('#');
      const subPath = host.resolve(path, file);
      try {
        await load(subPath, id);
        const sub = loaded.get(subPath)!;
        entry.refs.set(v.submachine, subPath);
        info[v.submachine] = { found: true, name: sub.model.name, file: display(subPath), points: machineConnectionPoints(sub.model) };
      } catch (e) {
        if (!(e instanceof GenerateError)) throw e;
        // Reported by the validator as a missing machine; say why.
        issues.push({ file: display(path), id: v.id, severity: 'error', message: e.message });
        info[v.submachine] = { found: false, points: [] };
      }
    }
    for (const issue of validate(model, info)) issues.push({ ...issue, file: display(path) });
    return path;
  };

  const roots: string[] = [];
  for (const s of sources) roots.push(await load(s));

  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length) {
    throw new GenerateError(`${errors.length} error${errors.length > 1 ? 's' : ''} in the state machine${loaded.size > 1 ? 's' : ''}; nothing was generated.`, issues);
  }

  // Code models, submachines first.
  const building = new Set<string>();
  const codeOf = (path: string): CodeModel => {
    const l = loaded.get(path)!;
    if (l.code) return l.code;
    if (building.has(path)) throw new GenerateError(`${display(path)} uses itself as a submachine (directly or through other machines).`);
    building.add(path);
    const submachines: Record<string, CodeModel> = {};
    for (const [href, sub] of l.refs) submachines[href] = codeOf(sub);
    try {
      l.code = toCodeModel(l.model, { submachines, sourceFile: display(path) });
    } catch (e) {
      if (e instanceof CodeGenError) throw new GenerateError(`${display(path)}: ${e.message}`);
      throw e;
    }
    building.delete(path);
    return l.code;
  };

  const targets = roots;
  const files: OutputFile[] = [];
  const owner = new Map<string, string>();
  for (const path of [...new Set(targets)]) {
    const reported: TemplateIssue[] = [];
    const rendered = render(template, codeOf(path), reported);
    // What the template reports about this machine, as issues of its file.
    for (const r of reported) issues.push({ file: display(path), id: r.id, severity: r.severity, message: r.message });
    for (const f of rendered) {
      const other = owner.get(f.path);
      if (other) {
        // A file shared by several machines (a common header) is written once, when they agree on its content.
        if (files.find((x) => x.path === f.path)?.content === f.content) continue;
        throw new GenerateError(`${display(path)} and ${display(other)} both generate '${f.path}': give the state machines different names.`);
      }
      owner.set(f.path, path);
      files.push(f);
    }
  }
  const templateErrors = issues.filter((i) => i.severity === 'error');
  if (templateErrors.length) {
    throw new GenerateError(`The template reported ${templateErrors.length} error${templateErrors.length > 1 ? 's' : ''}; nothing was generated.`, issues);
  }
  return { files, issues, machines: [...new Set(targets)].map(display) };
}
