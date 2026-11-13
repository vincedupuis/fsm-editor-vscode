/**
 * The Trace Player: reads trace files (logs) and replays them on the diagrams.
 *
 * - Traces: files opened with "Open Trace…", each read with a format (format.ts). On the desktop they are followed as
 *   they grow: a file watcher signals changes, and only the bytes after those already read are read again (tail.ts;
 *   the whole file on other file systems than the disk). The web edition reads them once, without Live.
 * - Timeline: the records of every trace, merged by time (lines without a time take the previous line's). The
 *   cursor is a position in it; Live keeps it on the last record as new ones come in.
 * - Machines: each record is about a machine instance, `Order` or `Order.Payment` (a submachine, through the
 *   submachine states leading to it), resolved to the .fsm file of the machine. The lines of a trace that name no
 *   machine are about one instance of a machine the user chooses (asked when the first such line is read).
 * - Highlights: replay.ts works out each instance's active states and taken transitions at the cursor; every open
 *   diagram of a file shows those of the instances of that file, each in its own color when there are several. A
 *   submachine's states show in its own diagram when open; its parent's diagram shows the submachine state as active.
 *
 * The panel (media/tracePlayer.js) is a webview view in the bottom panel.
 */
import * as vscode from 'vscode';
import { FsmEditorProvider } from '../fsmEditorProvider';
import { FsmModel, ModelIndex } from '../model';
import { basename, decodeHref, decodeText } from '../util';
import { fromXmi } from '../xmi';
import { TraceFormat, TraceRecord, detectFormat, traceFormats } from './format';
import { Instance, TimelineEntry, TraceView, isResolved, replay } from './replay';
import { canFollow, readFrom } from './tail';

/** Records shown in the panel around the cursor. */
const WINDOW = 150;

interface Trace {
  uri: vscode.Uri;
  format: TraceFormat;
  /** Whether the format was picked: detected from the first lines, or chosen in the panel. */
  formatPicked: boolean;
  records: TraceRecord[];
  /** Effective time of each record (its own, the previous record's, or the time it was read). */
  times: number[];
  /** Bytes of the file already read, up to the last line break. */
  offset: number;
  lines: number;
  /** Whether the file was read once: lines without a time read after that get the time they were read. */
  followed: boolean;
  /** The read in progress, and whether the file changed again during it. */
  reading?: Promise<void>;
  again: boolean;
  /** The file watcher following it (none on the web). */
  watcher?: vscode.Disposable;
  error?: string;
  /** The instances of the machine paths its lines name (each log is a run of its own: its instances are its own). */
  instances: Map<string, Instance | null>;
  /** Lines naming no machine: URI of the machine chosen for them ('' before), whether it was asked, and the instance. */
  machineUri: string;
  machineAsked: boolean;
  instance: Instance | null;
}

interface Entry extends TimelineEntry {
  time: number;
}

/** A machine file, parsed. */
interface Machine {
  uri: string;
  key: string;
  model: FsmModel;
  ix: ModelIndex;
}

export class TracePlayer implements vscode.WebviewViewProvider {
  static readonly viewType = 'fsmEditor.tracePlayer';

  private view: vscode.WebviewView | undefined;
  private traces: Trace[] = [];
  private entries: Entry[] = [];
  /** Kinds of records each instance has in the whole timeline. */
  private kinds = new Map<string, Set<string>>();
  /** Color of each instance key: its rank among the instances of its file, or -1 when it is the only one. */
  private colors = new Map<string, number>();
  private cursor = -1;
  /** Following the end of the traces as they grow (desktop only). */
  private live = canFollow;
  private playing = false;
  private speed = 1;
  private playTimer: ReturnType<typeof setTimeout> | undefined;
  /** Parsed machine files by URI, and the machines (or submachines) of instance paths. */
  private machines = new Map<string, Machine>();
  private instances = new Map<string, Instance | null>();
  /** Why an instance could not be resolved, by key. */
  private instanceProblems = new Map<string, string>();
  /** Those of the instances of the open traces, and the records designating nothing; set by rebuild(). */
  private problems: string[] = [];
  private modelsDirty = true;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly editors: FsmEditorProvider,
  ) {
    const changed = () => this.modelsChanged();
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.fsm');
    context.subscriptions.push(
      watcher,
      watcher.onDidChange(changed),
      watcher.onDidCreate(changed),
      watcher.onDidDelete(changed),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.path.endsWith('.fsm') && e.contentChanges.length) changed();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('fsmEditor.trace.formats')) this.post();
      }),
      { dispose: () => this.dispose() },
    );
  }

  private dispose(): void {
    this.stopTimers();
    for (const t of this.traces) t.watcher?.dispose();
  }

  // ---------------------------------------------------------------- panel

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        this.post();
        break;
      case 'open':
        await this.open();
        break;
      case 'close':
        this.close(Number(msg.trace));
        break;
      case 'machine':
        if (this.traces[Number(msg.trace)]) await this.askMachine(this.traces[Number(msg.trace)]);
        break;
      case 'format':
        this.setFormat(Number(msg.trace), String(msg.format));
        break;
      case 'seek':
        this.seek(Number(msg.index));
        break;
      case 'step':
        this.seek(this.cursor + (Number(msg.delta) < 0 ? -1 : 1));
        break;
      case 'first':
        this.seek(this.entries.length ? 0 : -1);
        break;
      case 'play':
        this.play();
        break;
      case 'pause':
        this.pause();
        break;
      case 'live':
        if (canFollow) this.goLive();
        break;
      case 'speed':
        if (Number(msg.speed) > 0) this.speed = Number(msg.speed);
        this.post();
        break;
    }
  }

  // ---------------------------------------------------------------- traces

  /** "Open Trace…": asks for log files and opens them. */
  async open(files?: vscode.Uri[]): Promise<void> {
    files ??= await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Open Trace', title: 'Open Trace: log files' });
    if (!files?.length) return;
    const added: Trace[] = [];
    for (const uri of files) {
      if (this.traces.some((t) => t.uri.toString() === uri.toString())) continue;
      const trace: Trace = {
        uri,
        format: this.formats()[0],
        formatPicked: false,
        records: [],
        times: [],
        offset: 0,
        lines: 0,
        followed: false,
        again: false,
        watcher: canFollow ? this.watch(uri, () => this.read(trace), () => this.missing(trace)) : undefined,
        instances: new Map(),
        machineUri: '',
        machineAsked: false,
        instance: null,
      };
      this.traces.push(trace);
      added.push(trace);
    }
    this.live = canFollow;
    await vscode.commands.executeCommand(`${TracePlayer.viewType}.focus`);
    await Promise.all(added.map((t) => this.read(t)));
    // Not following them: on the last record all the same.
    if (!canFollow && added.length) this.seek(this.entries.length - 1);
  }

  /** Watches `uri` alone, inside or outside the workspace. */
  private watch(uri: vscode.Uri, changed: () => void, deleted: () => void): vscode.Disposable {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), basename(uri.path)));
    return vscode.Disposable.from(w, w.onDidCreate(changed), w.onDidChange(changed), w.onDidDelete(deleted));
  }

  private close(i: number): void {
    const trace = this.traces[i];
    if (!trace) return;
    trace.watcher?.dispose();
    this.traces.splice(i, 1);
    if (!this.traces.length) {
      this.stopTimers();
      this.playing = false;
      this.cursor = -1;
      this.live = canFollow;
    }
    this.rebuild();
  }

  /** Reads `trace` again from the start with another format. */
  private setFormat(i: number, name: string): void {
    const trace = this.traces[i];
    const format = this.formats().find((f) => f.name === name);
    if (!trace || !format) return;
    trace.format = format;
    trace.formatPicked = true;
    this.restart(trace);
    void this.read(trace);
  }

  /** Forgets what was read of `trace`. */
  private restart(trace: Trace): void {
    Object.assign(trace, { records: [], times: [], offset: 0, lines: 0, instance: null });
    trace.instances = new Map();
  }

  private formats(): TraceFormat[] {
    const errors: string[] = [];
    const list = traceFormats(vscode.workspace.getConfiguration('fsmEditor.trace').get('formats'), errors);
    this.formatErrors = errors;
    return list;
  }
  private formatErrors: string[] = [];

  private stopTimers(): void {
    if (this.playTimer) clearTimeout(this.playTimer);
    this.playTimer = undefined;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private missing(trace: Trace): void {
    trace.error = `${basename(trace.uri.path)} does not exist.`;
    this.post();
  }

  /** Reads what was added to `trace` since the last read; one read at a time, again when it changed meanwhile. */
  private read(trace: Trace): Promise<void> {
    if (trace.reading) {
      trace.again = true;
      return trace.reading;
    }
    trace.reading = this.readNew(trace).finally(() => {
      trace.reading = undefined;
      if (trace.again && this.traces.includes(trace)) {
        trace.again = false;
        void this.read(trace);
      }
    });
    return trace.reading;
  }

  private async readNew(trace: Trace): Promise<void> {
    let chunk: { size: number; bytes: Uint8Array };
    try {
      chunk = await readFrom(trace.uri, trace.offset);
      if (chunk.size < trace.offset) {
        // Truncated or replaced (log rotation): read it again.
        this.restart(trace);
        chunk = await readFrom(trace.uri, 0);
      }
    } catch (e) {
      if (!this.traces.includes(trace)) return;
      trace.error = `Cannot read ${basename(trace.uri.path)}: ${e instanceof Error ? e.message : e}`;
      this.post();
      return;
    }
    if (!this.traces.includes(trace)) return;
    const hadError = !!trace.error;
    trace.error = undefined;
    // Complete lines only: a line break byte never occurs inside a UTF-8 character.
    const end = chunk.bytes.lastIndexOf(10) + 1;
    const lines = end ? decodeText(chunk.bytes.subarray(0, end)).split('\n').slice(0, -1) : [];
    trace.offset += end;
    if (lines.length && !trace.formatPicked) {
      trace.format = detectFormat(this.formats(), lines.slice(0, 1000));
      trace.formatPicked = true;
    }
    let added = false;
    const now = Date.now();
    for (const raw of lines) {
      const rec = trace.format.parse(raw.replace(/\r$/, ''), trace.lines++);
      if (!rec) continue;
      const prev = trace.times.length ? trace.times[trace.times.length - 1] : undefined;
      // Without a time: the previous record's, else (lines appended while followed) the time it was read.
      trace.times.push(rec.time ?? prev ?? (trace.followed ? now : 0));
      trace.records.push(rec);
      added = true;
    }
    trace.followed = true;
    if (added) await this.refresh();
    else if (hadError) this.post();
    if (!trace.machineAsked && !trace.machineUri && trace.records.some((r) => !r.machine)) {
      trace.machineAsked = true;
      void this.askMachine(trace);
    }
  }

  private asking: Promise<void> = Promise.resolve();

  /** Asks which machine the lines of `trace` naming none are about (one question at a time). */
  private askMachine(trace: Trace): Promise<void> {
    this.asking = this.asking.then(async () => {
      if (!this.traces.includes(trace)) return;
      if (this.modelsDirty) await this.refresh();
      const open = new Set(vscode.workspace.textDocuments.map((d) => d.uri.toString()));
      const items = [...this.machines.values()]
        .sort((a, b) => Number(open.has(b.uri)) - Number(open.has(a.uri)) || a.model.name.localeCompare(b.model.name))
        .map((m) => ({
          label: m.model.name,
          description: vscode.workspace.asRelativePath(vscode.Uri.parse(m.uri)),
          detail: open.has(m.uri) ? 'open' : undefined,
          picked: m.uri === trace.machineUri,
          uri: m.uri,
        }));
      if (!items.length) {
        void vscode.window.showWarningMessage(`${basename(trace.uri.path)} has lines without a state machine, and the workspace has none.`);
        return;
      }
      const pick = await vscode.window.showQuickPick(items, {
        title: `State machine of ${basename(trace.uri.path)}`,
        placeHolder: 'Its lines name no state machine: which one are they about?',
      });
      if (!pick || !this.traces.includes(trace)) return;
      trace.machineUri = pick.uri;
      trace.instance = null;
      await this.refresh();
    });
    return this.asking;
  }

  // ---------------------------------------------------------------- machines

  private modelsChanged(): void {
    this.modelsDirty = true;
    if (!this.traces.length) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 200);
  }

  private refreshing: Promise<void> = Promise.resolve();

  /** Reloads the machine files when they changed, then rebuilds the timeline; one refresh at a time. */
  private refresh(): Promise<void> {
    this.refreshing = this.refreshing.then(() => this.doRefresh()).catch(() => undefined);
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    if (this.modelsDirty) {
      this.modelsDirty = false;
      await this.loadMachines();
    }
    await this.resolveInstances();
    this.rebuild();
  }

  /** The workspace's machines and the open ones (with their unsaved changes). */
  private async loadMachines(): Promise<void> {
    const uris = new Map<string, vscode.Uri>();
    for (const uri of await vscode.workspace.findFiles('**/*.fsm', '**/node_modules/**', 500)) uris.set(uri.toString(), uri);
    for (const d of vscode.workspace.textDocuments) if (d.uri.path.endsWith('.fsm')) uris.set(d.uri.toString(), d.uri);
    const machines = new Map<string, Machine>();
    for (const [key, uri] of uris) {
      const m = await this.readMachine(uri);
      if (m) machines.set(key, m);
    }
    this.machines = machines;
    this.instances.clear();
    this.instanceProblems.clear();
    for (const t of this.traces) {
      t.instance = null;
      t.instances = new Map();
    }
  }

  private async readMachine(uri: vscode.Uri): Promise<Machine | null> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    try {
      const text = open ? open.getText() : decodeText(await vscode.workspace.fs.readFile(uri));
      const model = fromXmi(text);
      return { uri: uri.toString(), key: open ? `v${open.version}` : text, model, ix: new ModelIndex(model) };
    } catch {
      return null;
    }
  }

  /** Resolves the machine of every record not resolved yet, loading submachine files outside the workspace. */
  private async resolveInstances(): Promise<void> {
    for (const trace of this.traces) {
      if (trace.machineUri && !trace.instance) {
        const m = this.machines.get(trace.machineUri) ?? (await this.readMachine(vscode.Uri.parse(trace.machineUri)));
        if (m) trace.instance = { key: `${trace.uri.toString()}#`, label: `${m.model.name} (${basename(trace.uri.path)})`, uri: m.uri, model: m.model, ix: m.ix };
      }
      for (const rec of trace.records) {
        const path = rec.machine;
        if (!path || trace.instances.has(path)) continue;
        if (!this.instances.has(path)) {
          const problems: string[] = [];
          this.instances.set(path, await this.resolveInstance(path, (text) => problems.push(text)));
          if (problems.length) this.instanceProblems.set(path, problems[0]);
        }
        const found = this.instances.get(path);
        trace.instances.set(path, found ? { ...found, key: `${trace.uri.toString()}|${path}`, label: path } : null);
      }
    }
  }

  private instanceOf(trace: Trace, rec: TraceRecord): Instance | null {
    return rec.machine ? (trace.instances.get(rec.machine) ?? null) : trace.instance;
  }

  /** The instance `path` designates (`Order`, `Order.Payment`), or null when no machine fits. */
  private async resolveInstance(path: string, problem: (text: string) => void): Promise<Instance | null> {
    const ident = (s: string) => s.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    const named = (m: Machine, name: string) => m.model.name === name || ident(m.model.name) === name;
    const segments = path.split('.');
    // The open machines first, then the others.
    const open = new Set(vscode.workspace.textDocuments.map((d) => d.uri.toString()));
    const candidates = [...this.machines.values()].sort((a, b) => Number(open.has(b.uri)) - Number(open.has(a.uri)));
    let machine = candidates.find((m) => named(m, segments[0]));
    if (!machine) {
      problem(`No state machine named '${segments[0]}' in the workspace (${path}).`);
      return null;
    }
    for (const seg of segments.slice(1)) {
      const state = machine.model.vertices.find((v) => v.type === 'state' && v.submachine && (v.id === seg || v.name === seg || ident(v.name) === seg));
      if (!state) {
        problem(`${machine.model.name} has no submachine state '${seg}' (${path}).`);
        return null;
      }
      const [file, id = 'sm'] = state.submachine!.split('#');
      const uri = vscode.Uri.joinPath(vscode.Uri.parse(machine.uri), '..', decodeHref(file));
      let sub = this.machines.get(uri.toString());
      if (!sub) {
        sub = (await this.readMachine(uri)) ?? undefined;
        if (sub) this.machines.set(uri.toString(), sub);
      }
      if (!sub || (sub.model.id ?? 'sm') !== id) {
        problem(`The submachine of ${machine.model.name}.${state.name || seg} (${file}) cannot be read (${path}).`);
        return null;
      }
      machine = sub;
    }
    return { key: path, uri: machine.uri, model: machine.model, ix: machine.ix };
  }

  // ---------------------------------------------------------------- timeline

  /** Merges the traces into the timeline, keeping the cursor on the same record (or on the last one when live). */
  private rebuild(): void {
    const at = this.entries[this.cursor];
    const list: Entry[] = [];
    this.traces.forEach((trace, t) => {
      trace.records.forEach((record, i) => {
        list.push({ record, trace: t, time: trace.times[i], instance: this.instanceOf(trace, record) });
      });
    });
    list.sort((a, b) => a.time - b.time || a.trace - b.trace || a.record.line - b.record.line);
    this.entries = list;
    this.kinds = new Map();
    // The instances of each file, in the order they first appear: their colors.
    const byFile = new Map<string, string[]>();
    for (const e of list) {
      if (!e.instance) continue;
      let set = this.kinds.get(e.instance.key);
      if (!set) {
        this.kinds.set(e.instance.key, (set = new Set()));
        byFile.set(e.instance.uri, [...(byFile.get(e.instance.uri) ?? []), e.instance.key]);
      }
      set.add(e.record.kind);
    }
    // The same path in several logs: labeled with the log's name.
    const paths = new Map<string, number>();
    for (const t of this.traces) for (const path of t.instances.keys()) paths.set(path, (paths.get(path) ?? 0) + 1);
    for (const t of this.traces) {
      for (const [path, inst] of t.instances) if (inst) inst.label = paths.get(path)! > 1 ? `${path} (${basename(t.uri.path)})` : path;
    }
    this.colors = new Map();
    for (const keys of byFile.values()) keys.forEach((key, i) => this.colors.set(key, keys.length > 1 ? i : -1));
    const problems = new Set<string>();
    for (const trace of this.traces) {
      if (!trace.instance && trace.records.some((r) => !r.machine)) {
        const name = basename(trace.uri.path);
        problems.add(trace.machineUri ? `The state machine chosen for ${name} cannot be read.` : `Choose the state machine of the lines of ${name} that name none.`);
      }
      for (const key of new Set(trace.records.map((r) => r.machine))) {
        const p = key && this.instanceProblems.get(key);
        if (p) problems.add(p);
      }
    }
    const unresolved = list.filter((e) => !isResolved(e)).length;
    if (unresolved) problems.add(`${unresolved} record${unresolved === 1 ? '' : 's'} designate${unresolved === 1 ? 's' : ''} nothing in their state machine (shown crossed out).`);
    this.problems = [...problems];
    if (this.live) this.cursor = list.length - 1;
    else if (at) this.cursor = Math.max(-1, list.findIndex((e) => e.record === at.record));
    else this.cursor = Math.min(this.cursor, list.length - 1);
    this.update();
  }

  private seek(index: number): void {
    this.live = false;
    this.cursor = Math.max(-1, Math.min(index, this.entries.length - 1));
    if (this.playing && this.cursor >= this.entries.length - 1) this.pause();
    this.update();
  }

  private play(): void {
    if (!this.entries.length) return;
    this.live = false;
    if (this.cursor >= this.entries.length - 1) this.cursor = -1;
    this.playing = true;
    this.scheduleNext();
    this.update();
  }

  private pause(): void {
    this.playing = false;
    if (this.playTimer) clearTimeout(this.playTimer);
    this.playTimer = undefined;
    this.post();
  }

  private scheduleNext(): void {
    if (this.playTimer) clearTimeout(this.playTimer);
    const next = this.entries[this.cursor + 1];
    if (!this.playing || !next) {
      // Played to the end: Live follows the records still to come.
      if (this.playing) this.live = canFollow;
      this.playing = false;
      this.post();
      return;
    }
    const cur = this.entries[this.cursor];
    const pause = cur ? Math.max(0, (next.time - cur.time) / this.speed) : 0;
    this.playTimer = setTimeout(() => {
      this.cursor++;
      this.update();
      this.scheduleNext();
    }, pause);
  }

  private goLive(): void {
    this.pause();
    this.live = true;
    this.cursor = this.entries.length - 1;
    this.update();
  }

  /** Highlights at the cursor for the diagrams, and the panel's state. */
  private update(): void {
    const views = new Map<string, TraceView>();
    for (const { inst, highlight } of replay(this.entries, this.cursor, this.kinds).values()) {
      let view = views.get(inst.uri);
      if (!view) views.set(inst.uri, (view = { instances: [] }));
      view.instances.push({ ...highlight, label: inst.label ?? inst.key, color: this.colors.get(inst.key) ?? -1 });
    }
    for (const view of views.values()) view.instances.sort((a, b) => a.color - b.color);
    this.editors.setTraceHighlights(views);
    this.post();
  }

  private post(): void {
    if (!this.view) return;
    const formats = this.formats().map((f) => f.name);
    const from = Math.max(0, this.cursor - Math.floor(WINDOW / 2));
    const rows = this.entries.slice(from, from + WINDOW).map((e, k) => ({
      index: from + k,
      time: formatTime(e.time),
      trace: e.trace,
      machine: e.instance?.label ?? e.record.machine,
      color: e.instance ? (this.colors.get(e.instance.key) ?? -1) : -1,
      kind: e.record.kind,
      name: e.record.name,
      resolved: isResolved(e),
    }));
    const cur = this.entries[this.cursor];
    void this.view.webview.postMessage({
      type: 'state',
      traces: this.traces.map((t) => ({
        name: basename(t.uri.path),
        path: t.uri.scheme === 'file' ? t.uri.fsPath : t.uri.toString(),
        format: t.format.name,
        // Lines naming no machine: the one chosen for them ('' when none yet).
        needsMachine: t.records.some((r) => !r.machine),
        machine: t.instance?.model.name ?? '',
        records: t.records.length,
        error: t.error ?? '',
      })),
      formats,
      count: this.entries.length,
      cursor: this.cursor,
      time: cur ? formatTime(cur.time) : '',
      live: this.live,
      canFollow,
      playing: this.playing,
      speed: this.speed,
      rows,
      problems: [
        ...this.formatErrors,
        ...this.problems,
      ],
    });
  }

  private html(webview: vscode.Webview): string {
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${media('tracePlayer.css')}" rel="stylesheet">
  <title>Trace Player</title>
</head>
<body>
  <div id="player"></div>
  <script nonce="${nonce}" src="${media('tracePlayer.js')}"></script>
</body>
</html>`;
  }
}

/** A record's time for display: the time of day with milliseconds, or nothing for lines without a time. */
export function formatTime(ms: number): string {
  if (!ms) return '';
  const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');
  if (ms > 1e11) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }
  const day = ms % 86_400_000;
  return `${pad(day / 3_600_000)}:${pad((day / 60_000) % 60)}:${pad((day / 1000) % 60)}.${pad(day % 1000, 3)}`;
}
