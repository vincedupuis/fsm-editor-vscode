/**
 * fsm-editor-common (github.com/vincedupuis/fsm-editor-common, Rust) built as WebAssembly (common/common.wasm): the
 * file half of the editions, written once. Reading and writing a machine's two files, converting old (XMI) files,
 * validation, the text grammar's checks, comparing and merging, code generation (fsm-cli's). Its interface is JSON
 * requests (`schemas/api.schema.json`): one function per `fn`, texts and models in, texts and models out.
 *
 * The module is compiled once (`initCommon`, at activation and in the tests), synchronously: Node and the web
 * extension host (a worker) allow it, so the functions here are synchronous, like the TypeScript they replace.
 */
import { ConnectionPointInfo, FsmModel, SubmachineInfo } from './model';
import { decodeHref } from './util';

// The ES2022 library has no WebAssembly declarations: the little used here.
declare const WebAssembly: {
  Module: new (bytes: Uint8Array) => object;
  Instance: new (module: object, imports: object) => { exports: Record<string, unknown> };
};

interface Exports {
  memory: { buffer: ArrayBuffer };
  common_alloc(len: number): number;
  common_call(ptr: number, len: number): number;
  common_free(ptr: number, len: number): void;
}

let module: object | undefined;
let exports: Exports | undefined;

/** Compiles the module (the bytes of common.wasm). */
export function initCommon(bytes: Uint8Array): void {
  module = new WebAssembly.Module(bytes);
  exports = undefined;
}

export const commonReady = () => module !== undefined;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Answers a request: its result, or throws its error. */
export function call<T>(fn: string, args: object): T {
  if (!module) throw new Error('fsm-editor-common is not loaded (common/common.wasm).');
  exports ??= new WebAssembly.Instance(module, {}).exports as unknown as Exports;
  const x = exports;
  let answer: { result?: T; error?: string };
  try {
    const req = encoder.encode(JSON.stringify({ fn, args }));
    const p = x.common_alloc(req.length) >>> 0;
    new Uint8Array(x.memory.buffer, p, req.length).set(req);
    const out = x.common_call(p, req.length) >>> 0;
    const len = new DataView(x.memory.buffer).getUint32(out, true);
    answer = JSON.parse(decoder.decode(new Uint8Array(x.memory.buffer, out + 4, len)));
    x.common_free(out, len + 4);
  } catch (e) {
    // A trap (a panic) leaves the instance in an unknown state: the next request gets a new one.
    exports = undefined;
    throw e;
  }
  if (answer.error !== undefined) throw new Error(answer.error);
  return answer.result as T;
}

// ------------------------------------------------------------------ files

export const UNRESOLVED = '';
export const UNRESOLVED_ANCHOR = '';

/** The reference of a target that names nothing ('' for an `initial` without `target`), or undefined. */
export const unresolved = (target: string): string | undefined => (target.startsWith(UNRESOLVED) ? target.slice(1) : undefined);

/** A problem of a file's text or shape, with its line. */
export interface Problem {
  line: number;
  message: string;
}

/** Whether a text is a file in the old format (XMI). */
export const isOldFormat = (text: string) => /^[﻿ \t\r\n]*</.test(text);

/** A machine read from its two files. */
export interface ReadMachine {
  model: FsmModel;
  /** Line of each element, region, point and transition, by id. */
  lines: Map<string, number>;
  /** Why the layout file couldn't be used (it is then left out entirely), or undefined. */
  problem?: string;
  /** How many elements had no layout entry and were placed automatically. */
  placed: number;
}

/** Reads a machine's two files; the problems of a model file that can't be read. */
export function readMachine(modelText: string, layoutText: string | undefined): ReadMachine | { problems: Problem[] } {
  const r = call<{ model: FsmModel; lines: Record<string, number>; layoutProblem?: string; placed: number } | { problems: Problem[] }>('read', {
    model: modelText,
    layout: layoutText ?? null,
  });
  if ('problems' in r) return r;
  return { model: r.model, lines: new Map(Object.entries(r.lines)), problem: r.layoutProblem, placed: r.placed };
}

export class LoadError extends Error {}

/** A model and what is known of it, from a file in either format. */
export interface Loaded {
  model: FsmModel;
  name: string;
  points: ConnectionPointInfo[];
  /** The submachine paths of the model, relative to its file (an old file's hrefs without their `#id`). */
  submachines: string[];
  /** An old (XMI) file, read as it is. */
  old: boolean;
}

/** A model from a `.fsm` file's text, either format, and its layout file's text when given. Throws LoadError. */
export function load(text: string, layout?: string): Loaded {
  const r = call<Loaded | { error: string }>('load', { model: text, layout: layout ?? null });
  if ('error' in r) throw new LoadError(r.error);
  if (r.old) (r.model as unknown as { xmiId: string }).xmiId = '';
  return r;
}

/** The model of a `.fsm` file's text (either format). Throws LoadError. */
export const loadModel = (text: string, layout?: string): FsmModel => load(text, layout).model;

/** The submachine paths of a model, relative to its file (`Payment.fsm`; an old file's hrefs without their `#id`). */
export function submachineFiles(model: FsmModel): string[] {
  const old = 'xmiId' in model;
  return model.vertices.flatMap((v) => {
    if (v.type !== 'state' || !v.submachine) return [];
    return [old ? decodeHref(v.submachine.split('#')[0]) : v.submachine];
  });
}

/** A model written into its two files. */
export interface Written {
  modelText: string;
  layoutText: string;
  /** Line of each vertex and transition in the model file, by id. */
  lines: Map<string, number>;
  /** The model as written: generated names given, references that name something now resolved. */
  model: FsmModel;
}

/** What the format can't hold (an edit that made it is refused). */
export class LostError extends Error {
  constructor(readonly lost: string[]) {
    super(`the file can't hold ${lost.join('; ')}.`);
  }
}

/** Writes a model into its two files (giving generated names and resolving references). Throws LostError. */
export function writeMachine(model: FsmModel): Written {
  const r = call<{ modelText: string; layoutText: string; lines: Record<string, number>; model?: FsmModel } | { lost: string[] }>('write', { model });
  if ('lost' in r) throw new LostError(r.lost);
  return { modelText: r.modelText, layoutText: r.layoutText, lines: new Map(Object.entries(r.lines)), model: r.model ?? model };
}

/** The ids fsm-cli gives a model's elements (in its problems and generated code's traces), by the model's own ids. */
export const derivedIds = (model: FsmModel): Map<string, string> => new Map(Object.entries(call<Record<string, string>>('derivedIds', { model })));

/** An old file to convert: its path (`/`-separated, absolute) and text. */
export interface ConvertInput {
  path: string;
  text: string;
}

export interface Converted {
  path: string;
  /** The converted model (its ids are the old file's); none when the file could not be read. */
  model?: FsmModel;
  modelText: string;
  layoutText: string;
  /** Names changed, as sentences. */
  renames: string[];
  /** How many unnamed elements got a generated name. */
  generated: number;
  /** What was left out, as sentences. */
  losses: string[];
  /** Why the file could not be read (nothing else is set then). */
  error?: string;
}

/** Converts old files together (a machine and the machines linked to it by submachine references). */
export const convertGroup = (inputs: ConvertInput[]): Converted[] => call<Converted[]>('convert', { inputs });

// ------------------------------------------------------------------ checks

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  /** Id of the offending vertex, transition or region ('' for the machine itself). */
  id: string;
  severity: Severity;
  message: string;
}

/** The UML well-formedness rules, names and references, the text grammar and reachability (fsm-cli's). */
export const validate = (model: FsmModel, submachines: SubmachineInfo = {}): Issue[] => call<Issue[]>('validate', { model, submachines });

export type Check = { ok: true; value: string | string[] } | { ok: false; error: string };

/** A field's text checked by the grammar, and normalized when valid. */
export const checkText = (kind: string, text: string, allowElse = false): Check => call<Check>('checkText', { kind, text, allowElse });

// ------------------------------------------------------------------ compare and merge

export type ChangeKind = 'added' | 'removed' | 'changed';

/** A property that differs, with its two values as text ('' when absent). */
export interface PropertyChange {
  name: string;
  old: string;
  new: string;
  /** A property of the drawing, not of the model. */
  layout: boolean;
}

export interface Change {
  /** What identifies the element in the newer version. */
  key: string;
  /** Its key in the older version, when it differs (a transition whose target or trigger changed). */
  oldKey?: string;
  kind: ChangeKind;
  /** `machine`, `state`, `choice`…, `region`, `transition`. */
  what: string;
  /** How a person names it: `state 'Off'`, `transition Off -> On (powerOn)`. */
  label: string;
  oldId?: string;
  newId?: string;
  /** For `changed`: what differs. */
  properties: PropertyChange[];
  /** The properties as lines (`guard: a() → b()`): all of them, and the model's only. */
  described: string[];
  modelDescribed: string[];
  /** Whether it shows when layout changes are hidden. */
  modelChange: boolean;
}

/** What changed from `older` to `newer`, in the order of the newer version (removed elements last). */
export const compareModels = (older: FsmModel, newer: FsmModel): Change[] => call<Change[]>('compare', { older, newer });

/** Whether a change shows when layout changes are hidden. */
export const isModelChange = (c: Change) => c.modelChange;

/** A change's properties as lines: `guard: a() → b()`. */
export const describeChange = (c: Change, layout: boolean): string[] => (layout ? c.described : c.modelDescribed);

/** The id of each element of a model by the key that matches it across versions. */
export const keysOf = (model: FsmModel): Map<string, string> => new Map(Object.entries(call<Record<string, string>>('keys', { model })));

/** Whether a text holds Git's conflict markers. */
export const hasConflictMarkers = (text: string) => /^<{7}(?: |\r?$)/m.test(text) && /^>{7}(?: |\r?$)/m.test(text);

export interface Split {
  /** The text with the current side of every conflict ("ours"). */
  current: string;
  /** The text with the incoming side of every conflict ("theirs"). */
  incoming: string;
  /** How many conflicts. */
  conflicts: number;
}

/** Splits a text with conflict markers into its two sides. Throws when the markers don't nest. */
export function splitConflicts(text: string): Split {
  const r = call<Split | { error: string }>('splitConflicts', { text });
  if ('error' in r) throw new Error(r.error);
  return r;
}

/** The result with the element of `keys` (from `compareModels`) as `source` has it. */
export const adopt = (result: FsmModel, source: FsmModel, ...keys: string[]): FsmModel => call<FsmModel>('adopt', { result, source, keys });

// ------------------------------------------------------------------ code generation

export interface FsmRequest {
  /** Folder that relative paths are resolved against and that messages show paths relative to (`/` by default). */
  cwd?: string;
  /** Every .fsm file the generation may read, `/`-separated path → text: a file not here can't be read. */
  files: Record<string, string>;
  /** The files to generate, in order. */
  generate: string[];
  /** The template's text. */
  template: string;
  /** Its name in messages; a name ending in .hbs is refused. */
  templateName: string;
}

export interface FsmIssue {
  /** As displayed: relative to `cwd` when inside it. */
  file: string;
  line: number;
  /** Id of the element, or ''. */
  id: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface FsmFile {
  /** Relative to the output folder, `/`-separated. */
  path: string;
  content: string;
  /** The .fsm file it was generated from, as displayed. */
  source: string;
  /** The model hash of that file, which the template may write in the file. */
  modelHash: string;
}

export interface FsmResponse {
  /** `fsm write`'s exit code: 0 generated, 1 errors in the machines or the template, 2 bad request. */
  exitCode: number;
  /** The files to write (none unless exitCode is 0). */
  files: FsmFile[];
  /** Validation problems and what the template reported, as `fsm write` prints them. */
  issues: FsmIssue[];
  /** Why nothing was generated (`fsm write`'s last line without `fsm: `), or null. */
  error: string | null;
}

/** Code generation: fsm-cli's request and response. */
export const generate = (request: FsmRequest): FsmResponse => call<FsmResponse>('generate', request);
