/**
 * The code generator: fsm-cli (github.com/vincedupuis/fsm-cli, Rust) built as
 * WebAssembly (fsm/fsm.wasm), the same code as the `fsm write` command of the
 * other editions. It reads no files: the request holds the texts of the .fsm
 * files and of the template, the response the files to write and the problems.
 * Plain JavaScript (the standard WebAssembly API, no imports), so it runs in the
 * desktop and the web extension hosts, and in the unit tests.
 */

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
  /** xmi:id of the element, or ''. */
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
  /** Validation problems and what the template reported, as `fsm write` prints them: file:line: severity: message. */
  issues: FsmIssue[];
  /** Why nothing was generated (`fsm write`'s last line without `fsm: `), or null. */
  error: string | null;
}

// The ES2022 library has no WebAssembly declarations: the little used here.
declare const WebAssembly: {
  instantiate(bytes: Uint8Array, imports: object): Promise<{ instance: { exports: Record<string, unknown> } }>;
};

interface Exports {
  memory: { buffer: ArrayBuffer };
  fsm_alloc(len: number): number;
  fsm_generate(ptr: number, len: number): number;
  fsm_free(ptr: number, len: number): void;
}

export type Generator = (request: FsmRequest) => Promise<FsmResponse>;

/** Compiles the module (the bytes of fsm.wasm) and returns its generate function. */
export function loadGenerator(bytes: Uint8Array): Generator {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let instance: Promise<Exports> | undefined;
  return async (request) => {
    instance ??= WebAssembly.instantiate(bytes, {}).then((r) => r.instance.exports as unknown as Exports);
    try {
      const x = await instance;
      const req = encoder.encode(JSON.stringify(request));
      const p = x.fsm_alloc(req.length) >>> 0;
      new Uint8Array(x.memory.buffer, p, req.length).set(req);
      const out = x.fsm_generate(p, req.length) >>> 0;
      const len = new DataView(x.memory.buffer).getUint32(out, true);
      const response = JSON.parse(decoder.decode(new Uint8Array(x.memory.buffer, out + 4, len))) as FsmResponse;
      x.fsm_free(out, len + 4);
      return response;
    } catch (e) {
      // A trap leaves the instance in an unknown state (and a failed compilation is not kept): the next request gets a new one.
      instance = undefined;
      throw e;
    }
  };
}
