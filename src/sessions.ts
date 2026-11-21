/**
 * The diagram diff (two panes) and merge (three panes): the diagrams are ordinary diagram editors, which this module
 * links. A diff's two panes are the two sides of VS Code's own diff editor (Source Control, the timeline, Compare
 * With…), recognized as two diagrams shown at once in one editor group. A merge's panes are the conflicted file (the
 * result) and its two sides, served read-only by the `fsm-merge` file system.
 */
import * as vscode from 'vscode';
import { Change, adopt, compareModels, describeChange, isModelChange, keysOf } from './common';
import { FsmModel } from './model';

/** An open diagram, as sessions see it. */
export interface Pane {
  panel: vscode.WebviewPanel;
  uri: vscode.Uri;
  writable: boolean;
  /** The model it shows (with its layout), or undefined when it can't be read. */
  model(): FsmModel | undefined;
  post(msg: unknown): void;
  session?: Session;
}

export interface Session {
  update(): void;
  message(pane: Pane, msg: any): Promise<void> | void;
  remove(pane: Pane): void;
}

/** A Git URI's ref (`HEAD`, a commit, '' or `~` for the index), or undefined for other URIs. */
function gitRef(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== 'git') return undefined;
  try {
    return String(JSON.parse(uri.query).ref ?? '');
  } catch {
    return undefined;
  }
}

/** How a side of a diff is described: the Git version, else the file. */
function sideTitle(uri: vscode.Uri): string {
  const ref = gitRef(uri);
  const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
  if (ref === undefined) return uri.scheme === 'file' || uri.scheme === 'untitled' ? name : `${name} (${uri.scheme})`;
  if (ref === '' || ref === '~') return `${name} (index)`;
  return `${name} (${/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 8) : ref})`;
}

export class DiffSession implements Session {
  private showLayout = false;
  private index = -1;
  private changes: Change[] = [];

  constructor(
    readonly older: Pane,
    readonly newer: Pane,
  ) {
    older.session = this;
    newer.session = this;
  }

  /** How many changes the two panes mark (for the tests). */
  get changeCount(): number {
    return this.changes.length;
  }

  update(): void {
    const a = this.older.model();
    const b = this.newer.model();
    const all = a && b ? compareModels(a, b) : [];
    this.changes = this.showLayout ? all : all.filter(isModelChange);
    if (this.index >= this.changes.length) this.index = -1;
    for (const [pane, role] of [[this.older, 'old'], [this.newer, 'new']] as const) {
      const marks: Record<string, string> = {};
      const details: Record<string, string[]> = {};
      for (const c of this.changes) {
        const id = role === 'old' ? c.oldId : c.newId;
        if (!id) continue;
        marks[id] = c.kind;
        details[id] = c.kind === 'changed' ? describeChange(c, this.showLayout) : [c.kind === 'added' ? 'Added' : 'Removed'];
      }
      pane.post({ type: 'diff', diff: { role, title: sideTitle(pane.uri), marks, details, count: this.changes.length, showLayout: this.showLayout } });
    }
  }

  message(pane: Pane, msg: any): void {
    const other = pane === this.older ? this.newer : this.older;
    switch (msg.type) {
      case 'view':
        other.post({ type: 'diffView', view: msg.view });
        break;
      case 'diffLayout':
        this.showLayout = !!msg.show;
        this.update();
        break;
      case 'diffNav': {
        if (!this.changes.length) return;
        const n = this.changes.length;
        this.index = (this.index + (msg.dir < 0 ? -1 : 1) + n) % n;
        const c = this.changes[this.index];
        this.older.post({ type: 'reveal', id: c.oldId ?? null });
        this.newer.post({ type: 'reveal', id: c.newId ?? null });
        break;
      }
    }
  }

  remove(pane: Pane): void {
    const other = pane === this.older ? this.newer : this.older;
    other.session = undefined;
    other.post({ type: 'diff', diff: null });
  }
}

/** Two texts of a machine: its model file and its layout file (undefined when there is none). */
export interface Texts {
  model: string;
  layout?: string;
}

/** What the merge needs from the extension. */
export interface MergeHost {
  /** The model of a side's texts (with its layout), or undefined when it can't be read. */
  read(texts: Texts): FsmModel | undefined;
  /** Applies a model to the result as an undoable edit; a message when the format can't hold it. */
  edit(model: FsmModel, label: string): string | undefined;
  /** The result's state now: a new object at each edit, undo or redo (an earlier one again when it comes back). */
  state(): object;
  /** Saves the result, marks it resolved in Git when Git is there, and closes the side panes. */
  complete(): Promise<void>;
}

export class MergeSession implements Session {
  readonly sides = new Map<'incoming' | 'current', Pane>();
  readonly results = new Set<Pane>();
  private readonly conflicts: Change[];
  /**
   * The choices made, by state of the result: undo and redo take them back with the result. A state reached
   * otherwise (an edit of the result) keeps the choices of the one before.
   */
  private readonly history = new WeakMap<object, Map<string, 'incoming' | 'current'>>();
  private last = new Map<string, 'incoming' | 'current'>();
  private readonly incomingModel?: FsmModel;
  private readonly currentModel?: FsmModel;
  /** Changes of each side since the common version, when Git gives it: highlighted lightly. */
  private readonly ours: Change[] = [];
  private readonly theirs: Change[] = [];
  private index = -1;

  constructor(
    readonly id: string,
    readonly current: Texts,
    readonly incoming: Texts,
    readonly base: Texts | undefined,
    private readonly host: MergeHost,
    /** The model of the result, as it is now. */
    private readonly result: () => FsmModel | undefined,
  ) {
    this.currentModel = host.read(current);
    this.incomingModel = host.read(incoming);
    this.conflicts = this.currentModel && this.incomingModel ? compareModels(this.currentModel, this.incomingModel) : [];
    const baseModel = base ? host.read(base) : undefined;
    if (baseModel && this.currentModel && this.incomingModel) {
      this.ours = compareModels(baseModel, this.currentModel).filter(isModelChange);
      this.theirs = compareModels(baseModel, this.incomingModel).filter(isModelChange);
    }
  }

  get conflictCount(): number {
    return this.conflicts.length;
  }

  /** The choices of the result as it is now. */
  private get choices(): Map<string, 'incoming' | 'current'> {
    const state = this.host.state();
    let choices = this.history.get(state);
    if (!choices) {
      choices = new Map(this.last);
      this.history.set(state, choices);
    }
    this.last = choices;
    return choices;
  }

  attach(pane: Pane, role: 'incoming' | 'current' | 'result') {
    pane.session = this;
    if (role === 'result') this.results.add(pane);
    else this.sides.set(role, pane);
    this.update();
  }

  update(): void {
    const conflictKeys = new Set(this.conflicts.flatMap((c) => [c.key, c.oldKey ?? c.key]));
    const merged = [...this.ours, ...this.theirs].filter((c) => !conflictKeys.has(c.key) && !conflictKeys.has(c.oldKey ?? c.key));
    const details = (c: Change) => (c.kind === 'changed' ? describeChange(c, true) : [c.kind === 'added' ? 'Only in incoming' : 'Only in current']);
    const list = this.conflicts.map((c) => ({
      key: c.key,
      label: c.label,
      how: c.kind === 'changed' ? 'differs' : c.kind === 'added' ? 'only in incoming' : 'only in current',
      details: details(c),
      choice: this.choices.get(c.key) ?? null,
    }));
    const post = (pane: Pane, role: string, marks: Record<string, string>, det: Record<string, string[]>, title: string) =>
      pane.post({ type: 'diff', diff: { role, title, marks, details: det, count: this.conflicts.length, conflicts: role === 'result' ? list : undefined } });
    for (const [role, pane] of this.sides) {
      const marks: Record<string, string> = {};
      const det: Record<string, string[]> = {};
      const idOf = (c: Change) => (role === 'incoming' ? c.newId : c.oldId);
      for (const c of role === 'incoming' ? this.theirs : this.ours) {
        if (c.newId && !conflictKeys.has(c.key)) marks[c.newId] = 'merged';
      }
      for (const c of this.conflicts) {
        const id = idOf(c);
        if (!id) continue;
        marks[id] = 'conflict';
        det[id] = details(c);
      }
      post(pane, role, marks, det, role === 'incoming' ? 'theirs' : 'yours');
    }
    const r = this.result();
    const items = r ? keysOf(r) : new Map<string, string>();
    const resultMarks: Record<string, string> = {};
    const resultDetails: Record<string, string[]> = {};
    for (const c of merged) {
      const id = items.get(c.key);
      if (id) resultMarks[id] = 'merged';
    }
    for (const c of this.conflicts) {
      const id = items.get(c.oldKey ?? c.key) || items.get(c.key);
      if (!id) continue;
      resultMarks[id] = this.choices.has(c.key) ? 'resolved' : 'conflict';
      resultDetails[id] = details(c);
    }
    for (const pane of this.results) post(pane, 'result', resultMarks, resultDetails, `${this.choices.size} of ${this.conflicts.length} chosen`);
  }

  /** The result with conflict `c` taken from `side`. */
  private take(model: FsmModel, c: Change, side: 'incoming' | 'current'): FsmModel {
    const source = side === 'incoming' ? this.incomingModel! : this.currentModel!;
    const keys = side === 'incoming' ? [c.key, c.oldKey ?? c.key] : [c.oldKey ?? c.key, c.key];
    return adopt(model, source, ...keys);
  }

  async message(pane: Pane, msg: any): Promise<void> {
    switch (msg.type) {
      case 'view':
        for (const p of [...this.sides.values(), ...this.results]) if (p !== pane) p.post({ type: 'diffView', view: msg.view });
        break;
      case 'diffNav':
      case 'diffGo': {
        if (!this.conflicts.length) return;
        const n = this.conflicts.length;
        this.index = msg.type === 'diffGo' ? Math.max(0, this.conflicts.findIndex((c) => c.key === msg.key)) : (this.index + (msg.dir < 0 ? -1 : 1) + n) % n;
        const c = this.conflicts[this.index];
        this.sides.get('incoming')?.post({ type: 'reveal', id: c.newId ?? null });
        this.sides.get('current')?.post({ type: 'reveal', id: c.oldId ?? null });
        const r = this.result();
        const keys = r ? keysOf(r) : undefined;
        const id = keys && (keys.get(c.oldKey ?? c.key) || keys.get(c.key));
        for (const p of this.results) p.post({ type: 'reveal', id: id || null });
        break;
      }
      case 'mergeChoose':
      case 'mergeAll': {
        let model = this.result();
        if (!model || !this.incomingModel || !this.currentModel) return;
        const side = msg.side === 'incoming' ? 'incoming' : 'current';
        const list = msg.type === 'mergeAll' ? this.conflicts : this.conflicts.filter((c) => c.key === msg.key);
        const choices = new Map(this.choices);
        for (const c of list) {
          model = this.take(model, c, side);
          choices.set(c.key, side);
        }
        const problem = this.host.edit(model, side === 'incoming' ? 'Take Incoming' : 'Keep Current');
        // The choices go with the result's new state (the same one when the choice changed nothing in it).
        if (problem) for (const p of this.results) p.post({ type: 'toast', message: problem });
        else {
          this.history.set(this.host.state(), choices);
          this.last = choices;
        }
        this.update();
        break;
      }
      case 'mergeComplete':
        await this.host.complete();
        break;
    }
  }

  remove(pane: Pane): void {
    this.results.delete(pane);
    for (const [role, p] of this.sides) if (p === pane) this.sides.delete(role);
  }
}

/** The read-only files of the merges' two sides: `fsm-merge:/<merge>/Incoming/Order.fsm` and its layout. */
export class MergeFiles implements vscode.FileSystemProvider {
  static readonly scheme = 'fsm-merge';
  private readonly files = new Map<string, Uint8Array>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  set(path: string, content: Uint8Array) {
    this.files.set(path, content);
  }

  /** Forgets the files of a merge. */
  drop(prefix: string) {
    for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.files.delete(k);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const f = this.files.get(uri.path);
    if (!f) {
      const dir = [...this.files.keys()].some((k) => k.startsWith(`${uri.path}/`));
      if (dir) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: f.length, permissions: vscode.FilePermission.Readonly };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const f = this.files.get(uri.path);
    if (!f) throw vscode.FileSystemError.FileNotFound(uri);
    return f;
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}
