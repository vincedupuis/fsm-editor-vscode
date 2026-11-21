import * as vscode from 'vscode';
import { Issue, LoadError, Problem, checkText, convertGroup, derivedIds, hasConflictMarkers, isOldFormat, load, readMachine, splitConflicts, validate, writeMachine } from './common';
import { ExtractError, extractSubmachine, namesInside, proposedName } from './extract';
import { DiffSession, MergeFiles, MergeSession, Pane, Texts } from './sessions';
import { ConnectionPointInfo, FsmModel, MachineInfo, SubmachineInfo, defaultModel, machineConnectionPoints, normalizeModel } from './model';
import { TraceView } from './trace/replay';
import { basename, decodeText, dirname, encodeText, joinPath, relative } from './util';

/**
 * The diagram editor of `.fsm` files. A machine is two files, the model (`X.fsm`) and its layout (`X.fsm.layout`),
 * edited together: the editor is a `CustomEditorProvider` with its own document (FsmDocument), whose edits, undo and
 * redo, save, revert and backups (hot exit) cover both files. A move changes only the layout file, and is undone and
 * saved like any other change. The webview works on the JSON model (`FsmModel`); each of its edits is written
 * (`writeMachine`) into the texts of the two files, which the document holds until it is saved.
 */

interface ActiveEditor {
  panel: vscode.WebviewPanel;
  document: FsmDocument;
}

/** Commands the webview toolbar is allowed to run. */
const WEBVIEW_COMMANDS = new Set([
  'undo',
  'redo',
  'fsmEditor.exportSvg',
  'fsmEditor.exportPng',
  'fsmEditor.generateCode',
  'fsmEditor.openAsText',
  'fsmEditor.tracePlayer.focus',
]);

/** Which side panels of the diagram editor are shown, the same for every editor. */
interface PanelState {
  toolbox: boolean;
  props: boolean;
}
const PANELS_KEY = 'fsmEditor.panels';

interface MachineSummary {
  name: string;
  points: ConnectionPointInfo[];
}

/** What a document holds at one point of its history. */
export interface DocState {
  /** The model file's text: what saving writes (the file's own text when it can't be read). */
  modelText: string;
  /** The layout file's text: what saving writes; undefined when there is none to write (no file, unreadable model). */
  layoutText?: string;
  /** The model the webview works on, as JSON; undefined when the model file can't be read. */
  json?: string;
  /** Why the model file can't be read: no diagram then. */
  problems?: Problem[];
  /** Line of each element in `modelText`, by id. */
  lines: Map<string, number>;
}

/** An old file (XMI), converted when it was opened: what saving it will write and say. */
interface OldFile {
  /** Its text on disk, for the lines of problems. */
  text: string;
  renames: string[];
  generated: number;
  losses: string[];
}

/** The layout file at the open, when it couldn't be read: not overwritten without asking. */
interface UnreadableLayout {
  text: string;
  problem: string;
}

/** A `.fsm` file and its layout file, as the diagram edits them. */
export class FsmDocument implements vscode.CustomDocument {
  state: DocState;
  /** What is on disk (the state last loaded or saved). */
  saved: DocState;
  old?: OldFile;
  unreadableLayout?: UnreadableLayout;
  /** Elements placed automatically when the files were read (no layout entry). */
  placed = 0;
  /** No layout file was found: in a diff, this older version borrows the newer one's layout (`displayJson`). */
  layoutMissing = false;
  /** What the diagram shows when it isn't the state's model (a borrowed layout). */
  displayJson?: string;
  /** The model file has merge conflicts: its two sides, opened as the diagram merge (the document is the result). */
  merge?: { current: Texts; incoming: Texts; base?: Texts };
  /** The model file has merge conflicts the diagram merge can't open (a side isn't a valid machine file). */
  mergeFallback = false;
  /** Only the layout file has merge conflicts: the diagram uses its current side, and saving writes it clean. */
  layoutConflict = false;
  readonly readonly: boolean;
  private readonly disposed = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposed.event;
  /** Called when the state changes (an edit, undo, redo, revert, a change on disk). */
  readonly changed = new vscode.EventEmitter<void>();

  constructor(
    readonly uri: vscode.Uri,
    state: DocState,
    readonly: boolean,
  ) {
    this.state = state;
    this.saved = state;
    this.readonly = readonly;
  }

  get layoutUri(): vscode.Uri {
    return layoutUriOf(this.uri);
  }

  get dirty(): boolean {
    return this.state !== this.saved;
  }

  setState(s: DocState) {
    this.state = s;
    // A borrowed layout is only what the diagram showed before: an edit made on it holds its places.
    this.displayJson = undefined;
    this.changed.fire();
  }

  dispose(): void {
    this.disposed.fire();
    this.disposed.dispose();
    this.changed.dispose();
  }
}

/**
 * The file at `path` beside `uri`, in the same file system: for a Git version, the same version of that file (Git's
 * URIs say which file they read in their query too).
 */
export function uriWithPath(uri: vscode.Uri, path: string): vscode.Uri {
  if (uri.scheme === 'git') {
    try {
      const q = JSON.parse(uri.query);
      if (typeof q.path === 'string') return uri.with({ path, query: JSON.stringify({ ...q, path: vscode.Uri.from({ scheme: 'file', path }).fsPath }) });
    } catch {
      // not Git's JSON query
    }
  }
  return uri.with({ path });
}

/** The layout file of a model file (for a Git version, the same version of the layout file). */
export function layoutUriOf(uri: vscode.Uri): vscode.Uri {
  return uriWithPath(uri, `${uri.path}.layout`);
}

/** The state of a document whose files hold these texts (a new-format model; an old one is converted first). */
export function stateOf(modelText: string, layoutText: string | undefined): DocState & { placed: number; layoutProblem?: string } {
  const read = readMachine(modelText, layoutText);
  if ('problems' in read) return { modelText, problems: read.problems, lines: new Map(), placed: 0 };
  return { modelText, layoutText, json: JSON.stringify(read.model), lines: read.lines, placed: read.placed, layoutProblem: read.problem };
}

/**
 * The state after an edit of the webview: its model, written (references that named nothing and name something now
 * resolved, as reading the file again would). Throws when the format can't hold it. `sent`: the webview's own text of
 * `model`, kept as the state's JSON when the model is that text's, so that the webview gets back the text it holds
 * and doesn't reload (its focus, its typing and a drag in progress stay).
 */
export function stateOfModel(model: FsmModel, sent?: string): DocState {
  const w = writeMachine(model);
  // fsm-editor-common sends the model back only when writing changed it (names given, references resolved).
  const json = w.model === model ? (sent ?? JSON.stringify(model)) : JSON.stringify(w.model);
  return { modelText: w.modelText, layoutText: w.layoutText, json, lines: w.lines };
}

export class FsmEditorProvider implements vscode.CustomEditorProvider<FsmDocument> {
  static readonly viewType = 'fsmEditor.stateMachine';

  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<FsmDocument>>();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  private active: ActiveEditor | undefined;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('fsm');
  /** Exports asked of a webview, by request id: the result, or the error the webview reported. */
  private readonly pendingExports = new Map<number, (result: { data?: string; error?: string }) => void>();
  private nextRequest = 1;
  /** Re-sync callbacks of every open editor, run when any .fsm file changes (submachines may be affected). */
  private readonly resyncs = new Set<() => void>();
  /** Every open diagram, to show or hide the side panels in all of them. */
  private readonly webviews = new Set<vscode.Webview>();
  /** Parsed summaries of state machine files, keyed by URI, with the version they were read from. */
  private readonly summaries = new Map<string, { key: string; summary: MachineSummary | null }>();
  /** The summaries of open documents, by state. */
  private readonly stateSummaries = new WeakMap<DocState, MachineSummary | null>();
  /** The ids reading a document's state back would give, by own id (see `highlightFor`), by state. */
  private readonly stateIds = new WeakMap<DocState, { json: string; back: Map<string, string> }>();
  /** Every open diagram with its document, for the Trace Player's highlights. */
  private readonly diagrams = new Set<{ document: FsmDocument; webview: vscode.Webview }>();
  /** The Trace Player's highlights of each file, by URI; files without one show none. */
  private traceHighlights = new Map<string, TraceView>();
  /** The open documents, by URI. */
  private readonly documents = new Map<string, FsmDocument>();
  /** The open diagrams, for the diff and merge sessions that link them. */
  private readonly panes = new Set<Pane>();
  private readonly mergeFiles = new MergeFiles();
  /** The diagram merges, by the URI of their result, with the document they merge into. */
  private readonly merges = new Map<string, { session: MergeSession; doc: FsmDocument }>();
  private mergeSeq = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{fsm,fsm.layout}');
    const onDisk = (uri: vscode.Uri) => {
      const doc = this.documents.get(uri.toString()) ?? this.documents.get(uri.with({ path: uri.path.replace(/\.layout$/, '') }).toString());
      if (doc) void this.followDisk(doc);
      // A layout file changes no machine's names or points: the other diagrams have nothing to follow.
      if (!uri.path.endsWith('.layout')) this.resyncs.forEach((r) => r());
    };
    context.subscriptions.push(
      vscode.workspace.registerFileSystemProvider(MergeFiles.scheme, this.mergeFiles, { isReadonly: true, isCaseSensitive: true }),
      this.diagnostics,
      watcher,
      watcher.onDidChange(onDisk),
      watcher.onDidCreate(onDisk),
      watcher.onDidDelete(onDisk),
      // A model file edited as text: the diagram follows the text while it has no changes of its own.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!e.document.uri.path.endsWith('.fsm') || !e.contentChanges.length) return;
        const doc = this.documents.get(e.document.uri.toString());
        if (doc && !doc.dirty) void this.followText(doc, e.document.getText());
        this.resyncs.forEach((r) => r());
      }),
      // Its text editor closed: the text it had unsaved is gone, back to the file on disk.
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (!d.uri.path.endsWith('.fsm')) return;
        const doc = this.documents.get(d.uri.toString());
        if (doc) void this.followDisk(doc);
        this.resyncs.forEach((r) => r());
      }),
      // A model file renamed or moved: its layout file goes with it.
      vscode.workspace.onWillRenameFiles((e) => e.waitUntil(this.layoutRenames(e.files))),
    );
  }

  /** The layout files to rename with their model files (those that have one, unless the new name has one already). */
  private async layoutRenames(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<vscode.WorkspaceEdit> {
    const edit = new vscode.WorkspaceEdit();
    const exists = async (uri: vscode.Uri) => {
      try {
        await vscode.workspace.fs.stat(uri);
        return true;
      } catch {
        return false;
      }
    };
    for (const { oldUri, newUri } of files) {
      if (!oldUri.path.endsWith('.fsm') || !newUri.path.endsWith('.fsm')) continue;
      const from = layoutUriOf(oldUri);
      const to = layoutUriOf(newUri);
      if (files.some((f) => f.oldUri.toString() === from.toString())) continue; // renamed too
      if ((await exists(from)) && !(await exists(to))) edit.renameFile(from, to);
    }
    return edit;
  }

  get activeEditor(): ActiveEditor | undefined {
    return this.active;
  }

  // ---------------------------------------------------------------- documents

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<FsmDocument> {
    const readonly = uri.scheme !== 'untitled' && vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false;
    let doc: FsmDocument;
    if (uri.scheme === 'untitled') {
      const s = stateOfModel(defaultModel(basename(uri.path, '.fsm') || 'StateMachine'));
      doc = new FsmDocument(uri, s, false);
      // Nothing on disk: the first save writes everything.
      doc.saved = { modelText: '', lines: new Map() };
    } else {
      const loaded = await this.load(uri);
      doc = new FsmDocument(uri, loaded.state, readonly);
      this.apply(doc, loaded);
    }
    if (openContext.backupId) {
      try {
        const backup = JSON.parse(decodeText(await vscode.workspace.fs.readFile(vscode.Uri.parse(openContext.backupId))));
        doc.state = { modelText: backup.modelText, layoutText: backup.layoutText, json: backup.json, problems: backup.problems, lines: new Map(backup.lines) };
      } catch {
        // the backup is gone: what is on disk
      }
    }
    this.documents.set(uri.toString(), doc);
    doc.onDidDispose(() => {
      if (this.documents.get(uri.toString()) === doc) this.documents.delete(uri.toString());
      this.diagnostics.delete(uri);
      // Its merge ends with it: reopened, the file starts a new one.
      const merge = this.merges.get(uri.toString());
      if (merge?.doc === doc) this.endMerge(uri, merge.session);
    });
    return doc;
  }

  /** Reads a document's files: converting an old file, with the files linked to it. */
  private async load(uri: vscode.Uri): Promise<{ state: DocState; old?: OldFile; layout?: UnreadableLayout; placed: number; layoutMissing?: boolean; merge?: FsmDocument['merge']; mergeFallback?: boolean; layoutConflict?: boolean }> {
    const modelText = (await this.readText(uri)) ?? '';
    if (hasConflictMarkers(modelText)) return this.loadConflicted(uri, modelText);
    if (isOldFormat(modelText)) {
      const group = await this.linkedOldFiles(uri, modelText);
      const result = convertGroup(group).find((r) => r.path === uri.path)!;
      if (result.error) return { state: { modelText, problems: [{ line: 1, message: result.error }], lines: new Map() }, placed: 0 };
      // The converted model, with the old ids: the diagram's problems are found in the old text by them.
      const state: DocState = { modelText: result.modelText, layoutText: result.layoutText, json: JSON.stringify(result.model), lines: new Map() };
      return { state, old: { text: modelText, renames: result.renames, generated: result.generated, losses: result.losses }, placed: 0 };
    }
    let layoutText = await this.readText(layoutUriOf(uri));
    // Only the layout file has merge conflicts: its current side (saving writes it clean).
    let layoutConflict = false;
    if (layoutText !== undefined && hasConflictMarkers(layoutText)) {
      try {
        layoutText = splitConflicts(layoutText).current;
        layoutConflict = true;
      } catch {
        // unreadable: placed automatically
      }
    }
    const s = stateOf(modelText, layoutText);
    const layout = s.layoutProblem !== undefined && layoutText !== undefined && !layoutConflict ? { text: layoutText, problem: s.layoutProblem } : undefined;
    // An unreadable layout file is left for automatic places: writing the state as it is keeps that file.
    const state: DocState = { modelText: s.modelText, layoutText: layout ? undefined : layoutText, json: s.json, problems: s.problems, lines: s.lines };
    return { state, layout, placed: s.placed, layoutMissing: layoutText === undefined, layoutConflict };
  }

  /**
   * A model file with merge conflicts: its two sides (the layout file's too when it has conflicts) are the diagram
   * merge's, and the result starts as the current side. When a side isn't a valid machine file, no merge: its problems.
   */
  private async loadConflicted(uri: vscode.Uri, modelText: string) {
    const fail = (message: string) => ({ state: { modelText, problems: [{ line: 1, message }], lines: new Map() } as DocState, placed: 0, mergeFallback: true });
    let model;
    try {
      model = splitConflicts(modelText);
    } catch (e) {
      return fail(`The file has merge conflicts whose markers can't be read: ${e instanceof Error ? e.message : e}`);
    }
    const layoutRaw = await this.readText(layoutUriOf(uri));
    let layout = { current: layoutRaw, incoming: layoutRaw };
    if (layoutRaw !== undefined && hasConflictMarkers(layoutRaw)) {
      try {
        layout = splitConflicts(layoutRaw);
      } catch {
        layout = { current: undefined, incoming: undefined };
      }
    }
    for (const [side, text] of [['current', model.current], ['incoming', model.incoming]] as const) {
      const r = readMachine(text, undefined);
      if ('problems' in r) return fail(`The file has merge conflicts, and its ${side} side is not a valid state machine file: line ${r.problems[0].line}: ${r.problems[0].message}`);
    }
    const s = stateOf(model.current, layout.current);
    const state: DocState = { modelText: s.modelText, layoutText: layout.current, json: s.json, lines: s.lines };
    const merge = { current: { model: model.current, layout: layout.current }, incoming: { model: model.incoming, layout: layout.incoming }, base: await this.base(uri) };
    return { state, placed: 0, merge };
  }

  /** The common version of a conflicted file, from Git (stage 1), when the Git extension is there. */
  private async base(uri: vscode.Uri): Promise<Texts | undefined> {
    try {
      const git = vscode.extensions.getExtension('vscode.git');
      if (!git) return undefined;
      const api = (git.isActive ? git.exports : await git.activate())?.getAPI?.(1);
      const repo = api?.getRepository?.(uri);
      if (!repo) return undefined;
      const model: string = await repo.show(':1', uri.fsPath);
      let layout: string | undefined;
      try {
        layout = await repo.show(':1', layoutUriOf(uri).fsPath);
      } catch {
        layout = undefined;
      }
      return { model, layout };
    } catch {
      return undefined;
    }
  }

  /** A file's text, from an open text document with unsaved changes first; undefined when it can't be read. */
  private async readText(uri: vscode.Uri): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    try {
      return decodeText(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
  }

  /**
   * The old files linked to `uri` by submachine references, transitively and both ways (the files it uses, the files
   * using it), with their texts: they are converted together.
   */
  private async linkedOldFiles(uri: vscode.Uri, text: string): Promise<{ path: string; text: string }[]> {
    const found = new Map<string, string>([[uri.path, text]]);
    const others = new Map<string, string>();
    const at = (path: string) => uriWithPath(uri, path);
    const uses = (path: string, t: string) => {
      try {
        return load(t).submachines.map((f) => joinPath(dirname(path), f));
      } catch {
        return [];
      }
    };
    // The workspace's old files, for the machines using this one.
    if (uri.scheme === vscode.workspace.workspaceFolders?.[0]?.uri.scheme) {
      for (const u of await vscode.workspace.findFiles('**/*.fsm', '**/node_modules/**', 500)) {
        if (u.authority !== uri.authority || found.has(u.path)) continue;
        const t = await this.readText(u);
        if (t !== undefined && isOldFormat(t)) others.set(u.path, t);
      }
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const [path, t] of [...found]) {
        for (const p of uses(path, t)) {
          if (found.has(p)) continue;
          const sub = others.get(p) ?? (await this.readText(at(p)));
          if (sub !== undefined && isOldFormat(sub)) {
            found.set(p, sub);
            changed = true;
          }
        }
      }
      for (const [path, t] of others) {
        if (found.has(path)) continue;
        if (uses(path, t).some((p) => found.has(p))) {
          found.set(path, t);
          changed = true;
        }
      }
    }
    return [...found].map(([path, t]) => ({ path, text: t }));
  }

  /** The files changed on disk: a document without unsaved changes follows them. */
  private async followDisk(doc: FsmDocument) {
    if (doc.dirty || doc.uri.scheme === 'untitled' || doc.merge) return;
    const modelText = await this.readText(doc.uri);
    const layoutText = await this.readText(doc.layoutUri);
    if (modelText === undefined) return; // deleted: the editor keeps what it has
    if (modelText === doc.state.modelText && (layoutText === doc.state.layoutText || doc.unreadableLayout?.text === layoutText)) return;
    if (doc.old && modelText === doc.old.text) return;
    await this.reload(doc);
  }

  private async followText(doc: FsmDocument, text: string) {
    if (text === doc.state.modelText || (doc.old && text === doc.old.text)) return;
    if (isOldFormat(text)) {
      await this.reload(doc);
      return;
    }
    const layoutText = doc.state.layoutText ?? (await this.readText(doc.layoutUri));
    const s = stateOf(text, layoutText);
    const state: DocState = { modelText: s.modelText, layoutText: s.problems ? undefined : layoutText, json: s.json, problems: s.problems, lines: s.lines };
    doc.old = undefined;
    doc.saved = state;
    doc.setState(state);
  }

  private async reload(doc: FsmDocument) {
    const loaded = await this.load(doc.uri);
    this.apply(doc, loaded);
    doc.saved = loaded.state;
    doc.setState(loaded.state);
  }

  /** What reading a document's files said, onto the document. */
  private apply(doc: FsmDocument, loaded: Awaited<ReturnType<FsmEditorProvider['load']>>) {
    doc.old = loaded.old;
    doc.unreadableLayout = loaded.layout;
    doc.placed = loaded.placed;
    doc.layoutMissing = !!loaded.layoutMissing;
    doc.merge = loaded.merge;
    doc.mergeFallback = !!loaded.mergeFallback;
    doc.layoutConflict = !!loaded.layoutConflict;
  }

  async saveCustomDocument(document: FsmDocument, _cancellation: vscode.CancellationToken): Promise<void> {
    let state = document.state;
    await this.write(document, document.uri, state);
    document.old = undefined;
    document.unreadableLayout = undefined;
    document.layoutConflict = false;
    // An edit made while the files were written (a slow file system, converting linked files): VS Code counts it
    // saved once this save ends, so it is written too. `saved` is what was written.
    while (document.state !== state) {
      state = document.state;
      await this.write(document, document.uri, state);
    }
    document.saved = state;
    document.changed.fire();
  }

  async saveCustomDocumentAs(document: FsmDocument, destination: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<void> {
    await this.write(document, destination, document.state);
  }

  /**
   * Writes a document's state `s`, its two files, at `target` (and, for an old file saved in place, converts the files
   * linked to it).
   */
  private async write(doc: FsmDocument, target: vscode.Uri, s: DocState) {
    if (s.problems || s.json === undefined) {
      // A model file that can't be read: written as it is.
      await vscode.workspace.fs.writeFile(target, encodeText(s.modelText));
      return;
    }
    const layoutTarget = layoutUriOf(target);
    let writeLayout = true;
    if (doc.unreadableLayout && target.toString() === doc.uri.toString()) {
      const onDisk = await this.readText(layoutTarget);
      if (onDisk === doc.unreadableLayout.text) {
        const overwrite = 'Overwrite It';
        const answer = await vscode.window.showWarningMessage(
          `${basename(layoutTarget.path)} could not be read when the diagram was opened (${doc.unreadableLayout.problem}), so its elements were placed automatically. Replace it with the diagram's layout?`,
          { modal: true },
          overwrite,
          'Save the Model Only',
        );
        if (answer === undefined) throw new vscode.CancellationError();
        writeLayout = answer === overwrite;
      }
    }
    let layoutText = s.layoutText;
    if (layoutText === undefined) layoutText = stateOfModel(normalizeModel(JSON.parse(s.json!))).layoutText;
    await vscode.workspace.fs.writeFile(target, encodeText(s.modelText));
    if (writeLayout && layoutText !== undefined) await vscode.workspace.fs.writeFile(layoutTarget, encodeText(layoutText));
    if (doc.old && target.toString() === doc.uri.toString()) await this.convertLinked(doc);
  }

  /** After an old file was saved in the new format: converts the old files linked to it, and says which files changed format. */
  private async convertLinked(doc: FsmDocument) {
    const old = doc.old!;
    const group = await this.linkedOldFiles(doc.uri, old.text);
    const results = convertGroup(group);
    const converted = [basename(doc.uri.path)];
    const skipped: string[] = [];
    for (const r of results) {
      if (r.path === doc.uri.path) continue;
      const uri = uriWithPath(doc.uri, r.path);
      const open = this.documents.get(uri.toString());
      if (r.error || (open && open.dirty)) {
        skipped.push(basename(r.path));
        continue;
      }
      await vscode.workspace.fs.writeFile(uri, encodeText(r.modelText));
      await vscode.workspace.fs.writeFile(layoutUriOf(uri), encodeText(r.layoutText));
      converted.push(basename(r.path));
    }
    let message =
      converted.length === 1
        ? `${converted[0]} is no longer saved in XMI but in JSON, in two separate files: ${converted[0]} and ${converted[0]}.layout.`
        : `${converted.join(', ')} are no longer saved in XMI but in JSON, each in two separate files: .fsm and .fsm.layout.`;
    if (skipped.length) message += ` Still in XMI, as they have unsaved changes or can't be read: ${skipped.join(', ')}.`;
    void vscode.window.showInformationMessage(message);
  }

  async revertCustomDocument(document: FsmDocument, _cancellation: vscode.CancellationToken): Promise<void> {
    await this.reload(document);
  }

  async backupCustomDocument(document: FsmDocument, context: vscode.CustomDocumentBackupContext, _cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    const s = document.state;
    const data = { modelText: s.modelText, layoutText: s.layoutText, json: s.json, problems: s.problems, lines: [...s.lines] };
    await vscode.workspace.fs.writeFile(context.destination, encodeText(JSON.stringify(data)));
    return {
      id: context.destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(context.destination);
        } catch {
          // already gone
        }
      },
    };
  }

  /** An edit of the webview (its model's JSON): the document's new state, undoable. */
  edit(doc: FsmDocument, json: string, label = 'Edit'): string | undefined {
    if (doc.readonly) return 'This diagram is read-only.';
    let next: DocState;
    try {
      next = stateOfModel(normalizeModel(JSON.parse(json)), json);
    } catch (e) {
      return `The change can't be saved: ${e instanceof Error ? e.message : e}`;
    }
    const prev = doc.state;
    if (next.modelText === prev.modelText && next.layoutText === prev.layoutText) {
      // Nothing that the files hold changed (a selection, an equal value): no edit to undo.
      if (next.json !== prev.json) {
        prev.json = next.json;
        prev.lines = next.lines;
      }
      doc.changed.fire();
      return undefined;
    }
    doc.setState(next);
    this.changeEmitter.fire({
      document: doc,
      label,
      undo: () => doc.setState(prev),
      redo: () => doc.setState(next),
    });
    return undefined;
  }

  /** The texts of a `.fsm` file as the editor sees them: an open document's current state, else the file on disk. */
  async modelText(uri: vscode.Uri): Promise<string | undefined> {
    const doc = this.documents.get(uri.toString());
    if (doc) return doc.state.modelText;
    return this.readText(uri);
  }

  /** Whether a document is open for `uri`. */
  isOpen(uri: vscode.Uri): boolean {
    return this.documents.has(uri.toString());
  }

  /** The current model of an open document (with its layout), or undefined. */
  openModel(uri: vscode.Uri): FsmModel | undefined {
    const json = this.documents.get(uri.toString())?.state.json;
    return json ? normalizeModel(JSON.parse(json)) : undefined;
  }

  // ---------------------------------------------------------------- editors

  async resolveCustomEditor(document: FsmDocument, panel: vscode.WebviewPanel): Promise<void> {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.webview.html = this.html(panel.webview);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let disposed = false;
    /** Notices to show once the diagram is up. */
    const notices: string[] = [];
    if (document.placed) notices.push(`${document.placed} element${document.placed === 1 ? ' was' : 's were'} placed automatically: the layout file had no place for ${document.placed === 1 ? 'it' : 'them'}.`);
    if (document.unreadableLayout) notices.push(`The layout file could not be read (${document.unreadableLayout.problem}): the elements were placed automatically. It is replaced only if you confirm when saving.`);
    const sync = async () => {
      const current = ++generation;
      const s = document.state;
      const text = document.displayJson ?? s.json;
      let issues: Issue[] = [];
      let submachines: SubmachineInfo = {};
      let machines: MachineInfo[] = [];
      let error: string | undefined;
      let problems: Problem[] | undefined;
      if (s.problems || !s.json) {
        problems = s.problems;
        error = 'This file is not a valid state machine file:';
      } else {
        try {
          const model = normalizeModel(JSON.parse(text!));
          machines = await this.listMachines(document.uri);
          submachines = await this.resolveSubmachines(document.uri, model, machines);
          issues = validate(model, submachines);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      }
      if (current !== generation || disposed) return;
      // The document changed meanwhile: posting this older state would take the webview back to it.
      if (document.state !== s || (document.displayJson ?? s.json) !== text) {
        scheduleSync();
        return;
      }
      this.publishDiagnostics(document, issues, problems);
      void panel.webview.postMessage({ type: 'update', text, issues, error, problems, submachines, machines, readonly: document.readonly, mergeFallback: document.mergeFallback });
      while (notices.length) void panel.webview.postMessage({ type: 'toast', message: notices.shift() });
    };
    const scheduleSync = () => {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void sync(), 30);
    };
    this.resyncs.add(scheduleSync);
    const webview = panel.webview;
    this.webviews.add(webview);
    const diagram = { document, webview };
    this.diagrams.add(diagram);

    const subs: vscode.Disposable[] = [
      document.changed.event(scheduleSync),
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) this.active = { panel, document };
        else if (this.active?.panel === panel) this.active = undefined;
      }),
      panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg, document, panel)),
    ];
    if (panel.active) this.active = { panel, document };
    // An old file is converted when saved, a conflicted one resolved. Opening it changes nothing (it isn't marked
    // changed, so auto save doesn't write it): saving it does.
    if (document.old && !document.readonly) {
      notices.push('This file is in the old format (XMI): saving it writes the new format, a .fsm model file and a .fsm.layout layout file, and converts the files linked to it by submachines.');
    }
    if (document.layoutConflict && !document.readonly) {
      notices.push('The layout file has merge conflicts: the diagram uses the current positions, and saving writes a clean layout file.');
    }

    // Diff and merge: this diagram as a pane.
    const pane: Pane = {
      panel,
      uri: document.uri,
      writable: !document.readonly,
      model: () => {
        const json = document.displayJson ?? document.state.json;
        return json ? normalizeModel(JSON.parse(json)) : undefined;
      },
      post: (msg) => void panel.webview.postMessage(msg),
    };
    this.panes.add(pane);
    subs.push(document.changed.event(() => pane.session?.update()));
    if (document.merge && !document.readonly) this.openMerge(document, pane);
    else if (document.uri.scheme === MergeFiles.scheme) {
      const [, id, role] = document.uri.path.split('/');
      const merge = [...this.merges.values()].find((m) => m.session.id === id);
      merge?.session.attach(pane, role === 'Incoming' ? 'incoming' : 'current');
    } else this.pairSoon();

    panel.onDidDispose(() => {
      if (timer) clearTimeout(timer);
      disposed = true;
      const session = pane.session;
      session?.remove(pane);
      // The diff is over: its older version is drawn with its own layout again.
      if (session instanceof DiffSession) {
        const other = this.documents.get((pane === session.older ? session.newer : session.older).uri.toString());
        if (other?.displayJson !== undefined) {
          other.displayJson = undefined;
          other.changed.fire();
        }
      }
      this.panes.delete(pane);
      this.resyncs.delete(scheduleSync);
      this.webviews.delete(webview);
      this.diagrams.delete(diagram);
      if (this.active?.panel === panel) this.active = undefined;
      subs.forEach((s) => s.dispose());
    });
  }

  private async onMessage(msg: any, document: FsmDocument, panel: vscode.WebviewPanel) {
    const webview = panel.webview;
    const toast = (message: string) => void webview.postMessage({ type: 'toast', message });
    switch (msg?.type) {
      case 'ready':
        document.changed.fire();
        void webview.postMessage({ type: 'trace', highlight: this.highlightFor(document) });
        break;
      case 'panels': {
        const panels: PanelState = { toolbox: msg.panels?.toolbox !== false, props: msg.panels?.props !== false };
        await this.context.globalState.update(PANELS_KEY, panels);
        for (const w of this.webviews) void w.postMessage({ type: 'panels', panels });
        break;
      }
      case 'edit': {
        if (typeof msg.text !== 'string') break;
        const problem = this.edit(document, msg.text);
        if (problem) {
          toast(problem);
          // Back to what the document holds.
          document.changed.fire();
        }
        break;
      }
      case 'command':
        if (WEBVIEW_COMMANDS.has(msg.command)) await vscode.commands.executeCommand(msg.command);
        break;
      case 'view':
      case 'diffNav':
      case 'diffGo':
      case 'diffLayout':
      case 'mergeChoose':
      case 'mergeAll':
      case 'mergeComplete': {
        const p = [...this.panes].find((x) => x.panel === panel);
        if (p?.session) await p.session.message(p, msg);
        break;
      }
      case 'mergeText':
        // VS Code's text merge editor (Git's), else the text editor with its conflict decorations.
        try {
          await vscode.commands.executeCommand('git.openMergeEditor', document.uri);
        } catch {
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
        }
        break;
      case 'svg':
      case 'png': {
        const resolve = this.pendingExports.get(msg.requestId);
        this.pendingExports.delete(msg.requestId);
        resolve?.({ data: msg.type === 'svg' ? msg.svg : msg.png, error: msg.error });
        break;
      }
      case 'openSubmachine':
        await this.openSubmachine(document.uri, String(msg.href ?? ''));
        break;
      case 'extractCheck':
        void webview.postMessage({ type: 'extractCheck', requestId: msg.requestId, problem: this.extractProblem(document, msg.text, msg.ids) });
        break;
      case 'extract':
        if (typeof msg.text === 'string' && Array.isArray(msg.ids)) await this.extract(document, toast, msg.text, msg.ids.map(String));
        break;
      case 'info':
        void vscode.window.showInformationMessage(String(msg.message));
        break;
      // Cut, Copy and Paste of the diagram's context menu: the webview can't use the clipboard on its own.
      case 'clipboardWrite':
        if (typeof msg.text === 'string') await vscode.env.clipboard.writeText(msg.text);
        break;
      case 'checkText': {
        // The grammar's checks of the webview's fields and labels (fsm-editor-common's).
        let result: unknown;
        try {
          result = checkText(String(msg.kind), String(msg.text ?? ''), !!msg.allowElse);
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        void webview.postMessage({ type: 'checkedText', requestId: msg.requestId, result });
        break;
      }
      case 'clipboardRead':
        void webview.postMessage({ type: 'clipboard', requestId: msg.requestId, text: await vscode.env.clipboard.readText() });
        break;
    }
  }

  /**
   * For the tests: an edit of the open document of `uri`, as its diagram sends one (the model as JSON); undefined
   * when it was taken, else why not.
   */
  editForTests(uri: vscode.Uri, json: string): string | undefined {
    const doc = this.documents.get(uri.toString());
    return doc ? this.edit(doc, json) : `${uri} is not open`;
  }

  /**
   * For the tests: the open document of `uri` backed up as hot exit does it, then reopened from that backup as VS
   * Code does it at the next start; the reopened document's model (the open one is kept).
   */
  async backupRoundTripForTests(uri: vscode.Uri, destination: vscode.Uri): Promise<FsmModel | undefined> {
    const doc = this.documents.get(uri.toString());
    if (!doc) return undefined;
    const backup = await this.backupCustomDocument(doc, { destination }, new vscode.CancellationTokenSource().token);
    const restored = await this.openCustomDocument(uri, { backupId: backup.id, untitledDocumentData: undefined });
    this.documents.set(uri.toString(), doc);
    await backup.delete();
    return restored.state.json ? normalizeModel(JSON.parse(restored.state.json)) : undefined;
  }

  /** The diffs and merges open, described (for the tests). */
  sessionSummary(): string[] {
    const out = new Set<string>();
    for (const p of this.panes) {
      if (p.session instanceof DiffSession) out.add(`diff ${basename(p.session.older.uri.path)} (${p.session.older.uri.scheme}) -> ${basename(p.session.newer.uri.path)} (${p.session.newer.uri.scheme})`);
      if (p.session instanceof MergeSession) out.add(`merge ${p.session.conflictCount} conflicts, panes: ${[...p.session.sides.keys(), ...[...p.session.results].map(() => 'result')].sort().join(',')}`);
    }
    return [...out];
  }

  /** Diffs asked for (Compare as Diagrams), whose two diagrams are opening: older and newer URI. */
  private readonly wanted: { older: string; newer: string }[] = [];

  /**
   * Opens two versions of a machine as a diagram diff: the older one in the active editor group, read-only when its
   * file system is (Git's), the newer one beside it.
   */
  async openDiagramDiff(older: vscode.Uri, newer: vscode.Uri): Promise<void> {
    const w = { older: older.toString(), newer: newer.toString() };
    const forget = () => {
      const i = this.wanted.indexOf(w);
      if (i >= 0) this.wanted.splice(i, 1);
    };
    // Asked twice: once is enough.
    const known = this.wanted.findIndex((x) => x.older === w.older && x.newer === w.newer);
    if (known >= 0) this.wanted.splice(known, 1);
    this.wanted.push(w);
    try {
      await vscode.commands.executeCommand('vscode.openWith', older, FsmEditorProvider.viewType, { viewColumn: vscode.ViewColumn.Active, preview: false });
      await vscode.commands.executeCommand('vscode.openWith', newer, FsmEditorProvider.viewType, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    } catch (e) {
      forget();
      throw e;
    }
    this.pairSoon();
    // Both diagrams are open: a side that didn't open as a diagram never will, and isn't paired later by surprise.
    setTimeout(forget, 5000);
  }

  private pairTimer: ReturnType<typeof setTimeout> | undefined;
  /** Pairs the diffs asked for, soon (their two diagrams resolve one after the other). */
  private pairSoon() {
    if (this.pairTimer) clearTimeout(this.pairTimer);
    this.pairTimer = setTimeout(() => this.pair(), 250);
  }

  /**
   * The diffs asked for (Compare as Diagrams), whose sides are known: their two diagrams, wherever they are, become a
   * diagram diff, the older version on the left. Nothing else is paired, so a side is never guessed.
   */
  private pair() {
    for (const w of [...this.wanted]) {
      const older = [...this.panes].reverse().find((p) => !p.session && p.uri.toString() === w.older);
      const newer = [...this.panes].reverse().find((p) => !p.session && p.uri.toString() === w.newer && p !== older);
      if (!older || !newer) continue;
      this.wanted.splice(this.wanted.indexOf(w), 1);
      this.startDiff(older, newer);
    }
  }

  private startDiff(older: Pane, newer: Pane) {
    // An older version without its layout file borrows the newer one's, for the elements with the same names.
    const doc = this.documents.get(older.uri.toString());
    const newerDoc = this.documents.get(newer.uri.toString());
    if (doc && newerDoc && doc.layoutMissing && !doc.old && newerDoc.state.layoutText !== undefined) {
      const read = readMachine(doc.state.modelText, newerDoc.state.layoutText);
      if (!('problems' in read)) {
        doc.displayJson = JSON.stringify(read.model);
        doc.changed.fire();
        older.post({ type: 'toast', message: 'This version has no layout file: its elements are drawn where the newer version has them.' });
      }
    }
    new DiffSession(older, newer).update();
  }

  /**
   * Opens the diagram merge of a document with conflicts: its two sides beside it (incoming, then current), read-only,
   * and the document as the result.
   */
  private openMerge(doc: FsmDocument, pane: Pane) {
    const known = this.merges.get(doc.uri.toString());
    let merge = known?.doc === doc ? known.session : undefined;
    if (!merge) {
      if (known) this.endMerge(doc.uri, known.session);
      const id = `m${++this.mergeSeq}`;
      const m = doc.merge!;
      const read = (t: Texts) => {
        const r = readMachine(t.model, t.layout);
        return 'problems' in r ? undefined : r.model;
      };
      const session: MergeSession = new MergeSession(id, m.current, m.incoming, m.base, {
        read,
        edit: (model, label) => this.edit(doc, JSON.stringify(model), label),
        state: () => doc.state,
        complete: async () => {
          // Saved as VS Code saves it (the editor's dirty mark goes away); without workspace.save (before VS Code
          // 1.86), or with nothing chosen (no changes to save: the file still has its markers), written directly.
          const save = (vscode.workspace as unknown as { save?: (u: vscode.Uri) => Thenable<vscode.Uri | undefined> }).save;
          try {
            if (save && doc.dirty) {
              if (!(await save(doc.uri))) throw new Error('it was not saved');
            } else await this.saveCustomDocument(doc, new vscode.CancellationTokenSource().token);
          } catch (e) {
            if (e instanceof vscode.CancellationError) return;
            void vscode.window.showErrorMessage(`${basename(doc.uri.path)}: the merge could not be completed, ${e instanceof Error ? e.message : e}. The file keeps its conflicts.`);
            return;
          }
          await this.markResolved(doc.uri);
          doc.merge = undefined;
          this.endMerge(doc.uri, session);
          for (const p of session.results) {
            p.session = undefined;
            p.post({ type: 'diff', diff: null });
          }
          void vscode.window.showInformationMessage(`${basename(doc.uri.path)}: merge completed.`);
        },
      }, () => {
        const json = doc.state.json;
        return json ? normalizeModel(JSON.parse(json)) : undefined;
      });
      merge = session;
      this.merges.set(doc.uri.toString(), { session, doc });
      const name = basename(doc.uri.path);
      for (const [role, t] of [['Incoming', m.incoming], ['Current', m.current]] as const) {
        this.mergeFiles.set(`/${id}/${role}/${name}`, encodeText(t.model));
        if (t.layout !== undefined) this.mergeFiles.set(`/${id}/${role}/${name}.layout`, encodeText(t.layout));
      }
      const open = (role: string) =>
        vscode.commands.executeCommand('vscode.openWith', vscode.Uri.from({ scheme: MergeFiles.scheme, path: `/${id}/${role}/${name}` }), FsmEditorProvider.viewType, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
      void open('Incoming').then(() => open('Current'));
      if (!merge.conflictCount) pane.post({ type: 'toast', message: 'The two sides of the conflicts describe the same machine.' });
    }
    merge.attach(pane, 'result');
  }

  /** Forgets a merge: its side panes close, and its files go. */
  private endMerge(uri: vscode.Uri, session: MergeSession) {
    if (this.merges.get(uri.toString())?.session === session) this.merges.delete(uri.toString());
    for (const p of [...this.panes]) if (p.uri.scheme === MergeFiles.scheme && p.uri.path.startsWith(`/${session.id}/`)) p.panel.dispose();
    this.mergeFiles.drop(`/${session.id}/`);
  }

  /** Marks a file and its layout file resolved in Git (staged), when the Git extension is there. */
  private async markResolved(uri: vscode.Uri) {
    try {
      const git = vscode.extensions.getExtension('vscode.git');
      const api = git && (git.isActive ? git.exports : await git.activate())?.getAPI?.(1);
      const repo = api?.getRepository?.(uri);
      if (!repo) return;
      const layout = layoutUriOf(uri);
      let hasLayout = true;
      try {
        await vscode.workspace.fs.stat(layout);
      } catch {
        hasLayout = false;
      }
      await repo.add(hasLayout ? [uri.fsPath, layout.fsPath] : [uri.fsPath]);
    } catch (e) {
      void vscode.window.showWarningMessage(`The merge was saved, but could not be marked resolved in Git: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Extract to Submachine: moves the selected elements (`ids` of the webview's model `text`) into a new
   * state machine next to the document (its two files), and puts a submachine state referencing it in their place:
   * an edit of the document, which undo takes back (the new files stay).
   */
  private async extract(document: FsmDocument, toast: (m: string) => void, text: string, ids: string[]) {
    // The context menu only offers it after the same check; the model may have changed since.
    const problem = this.extractProblem(document, text, ids);
    if (problem) {
      toast(problem);
      return;
    }
    const model = normalizeModel(JSON.parse(text));
    const folder = vscode.Uri.joinPath(document.uri, '..');
    const fileOf = (name: string) => vscode.Uri.joinPath(folder, `${name}.fsm`);
    const exists = async (uri: vscode.Uri) => {
      try {
        await vscode.workspace.fs.stat(uri);
        return true;
      } catch {
        return false;
      }
    };
    let value = proposedName(model, ids);
    for (let n = 2; await exists(fileOf(value)); n++) value = `${proposedName(model, ids)}${n}`;
    const name = await vscode.window.showInputBox({
      title: 'Extract to Submachine',
      prompt: 'Name of the new state machine, saved next to this one',
      value,
      validateInput: async (v) =>
        !/^[\w-]+$/.test(v) ? 'Use letters, digits, dashes or underscores.'
          : namesInside(model, ids).has(v) ? `An element of the new machine is named ${v}: names are unique in a machine.`
            : (await exists(fileOf(v))) ? `${v}.fsm already exists.`
              : undefined,
    });
    if (!name) return;
    const uri = fileOf(name);
    const { parent, machine } = extractSubmachine(model, ids, name, `${name}.fsm`);
    const parentText = JSON.stringify(parent);
    let sub: DocState;
    try {
      sub = stateOfModel(machine);
      // The parent's edit, checked before anything is written.
      stateOfModel(normalizeModel(JSON.parse(parentText)));
    } catch (e) {
      toast(`The change can't be saved: ${e instanceof Error ? e.message : e}`);
      return;
    }
    // The new machine's files first: the parent references a file that exists.
    try {
      await vscode.workspace.fs.writeFile(uri, encodeText(sub.modelText));
      await vscode.workspace.fs.writeFile(layoutUriOf(uri), encodeText(sub.layoutText!));
    } catch (e) {
      void vscode.window.showErrorMessage(`Extract to Submachine: ${name}.fsm could not be written (${e instanceof Error ? e.message : e}). Nothing was changed.`);
      return;
    }
    const problemAfter = this.edit(document, parentText, 'Extract to Submachine');
    if (problemAfter) toast(problemAfter);
  }

  /** Why the selected `ids` of the webview's model `text` can't be extracted to a submachine, or undefined when they can. */
  private extractProblem(document: FsmDocument, text: unknown, ids: unknown): string | undefined {
    if (document.uri.scheme === 'untitled') return 'Save the state machine first: the submachine goes in a file next to it.';
    if (document.readonly) return 'This diagram is read-only.';
    try {
      if (typeof text !== 'string' || !Array.isArray(ids)) throw new Error('no selection');
      extractSubmachine(normalizeModel(JSON.parse(text)), ids.map(String), 'Submachine', 'Submachine.fsm');
      return undefined;
    } catch (e) {
      return e instanceof ExtractError ? e.message : `The selection can't be extracted: ${e instanceof Error ? e.message : e}`;
    }
  }

  /** Shows the Trace Player's highlights (by file URI) in the open diagrams; the other diagrams show none. */
  setTraceHighlights(highlights: Map<string, TraceView>): void {
    const before = this.traceHighlights;
    this.traceHighlights = highlights;
    for (const { document, webview } of this.diagrams) {
      const key = document.uri.toString();
      if (JSON.stringify(highlights.get(key) ?? null) !== JSON.stringify(before.get(key) ?? null)) {
        void webview.postMessage({ type: 'trace', highlight: this.highlightFor(document) });
      }
    }
  }

  /**
   * The Trace Player's highlights of a document, with the ids of its diagram: the trace's ids are those reading the
   * file gives (see `derivedIds`), which elements created since the file was read, and an old file's (by their
   * xmi:ids, until it is saved converted), don't have.
   */
  private highlightFor(document: FsmDocument): TraceView | null {
    const h = this.traceHighlights.get(document.uri.toString());
    if (!h || !document.state.json) return h ?? null;
    const json = document.state.json;
    let back = this.stateIds.get(document.state)?.json === json ? this.stateIds.get(document.state)!.back : undefined;
    if (!back) {
      try {
        const derived = derivedIds(normalizeModel(JSON.parse(json)));
        back = new Map([...derived].map(([own, d]) => [d, own]));
      } catch {
        return h;
      }
      this.stateIds.set(document.state, { json, back });
    }
    const map = (ids: string[]) => ids.map((id) => back.get(id) ?? id);
    return { ...h, instances: h.instances.map((i) => ({ ...i, active: map(i.active), taken: map(i.taken), via: map(i.via), current: map(i.current) })) };
  }

  /** Asks the active diagram to render itself as a standalone SVG. */
  requestSvg(editor: ActiveEditor): Promise<string> {
    return this.requestExport(editor, 'requestSvg');
  }

  /** Asks the active diagram to render itself as a PNG image, base64-encoded. */
  requestPng(editor: ActiveEditor): Promise<string> {
    return this.requestExport(editor, 'requestPng');
  }

  private requestExport(editor: ActiveEditor, type: 'requestSvg' | 'requestPng'): Promise<string> {
    const requestId = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.pendingExports.set(requestId, ({ data, error }) => {
        if (typeof data === 'string') resolve(data);
        else reject(new Error(error || 'The diagram sent no image.'));
      });
      void editor.panel.webview.postMessage({ type, requestId });
      setTimeout(() => {
        if (this.pendingExports.delete(requestId)) reject(new Error('The diagram did not respond.'));
      }, 10000);
    });
  }

  /**
   * Name and connection points of the state machine in `uri`, or null when it cannot be read: an open diagram's
   * (possibly unsaved) model, else an open text document's (possibly unsaved) text, else the file on disk. An old
   * file's are its names once converted, which the references of a converted file use.
   */
  private async summaryOf(uri: vscode.Uri): Promise<MachineSummary | null> {
    const doc = this.documents.get(uri.toString());
    if (doc) {
      const s = doc.state;
      if (!this.stateSummaries.has(s)) {
        let summary: MachineSummary | null = null;
        try {
          const m = s.json ? normalizeModel(JSON.parse(s.json)) : undefined;
          if (m) summary = { name: m.name, points: machineConnectionPoints(m) };
        } catch {
          summary = null;
        }
        this.stateSummaries.set(s, summary);
      }
      return this.stateSummaries.get(s)!;
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    let key: string;
    try {
      key = open ? `t${open.version}` : `m${(await vscode.workspace.fs.stat(uri)).mtime}`;
    } catch {
      return null; // missing file
    }
    const cached = this.summaries.get(uri.toString());
    if (cached && cached.key === key) return cached.summary;
    let summary: MachineSummary | null = null;
    try {
      const text = (await this.readText(uri)) ?? '';
      if (isOldFormat(text)) {
        // An old file's names as converting it gives them.
        const converted = convertGroup([{ path: uri.path, text }])[0];
        if (converted.error || !converted.model) throw new LoadError(converted.error);
        summary = { name: converted.model.name, points: machineConnectionPoints(converted.model) };
      } else {
        const loaded = load(text);
        summary = { name: loaded.name, points: loaded.points };
      }
    } catch (e) {
      if (!(e instanceof LoadError) && !(e instanceof SyntaxError)) throw e;
      summary = null;
    }
    this.summaries.set(uri.toString(), { key, summary });
    return summary;
  }

  /** Where a document's submachine path leads (for a Git version, the same version of that file). */
  private resolvePath(uri: vscode.Uri, path: string): vscode.Uri {
    const at = this.location(uri);
    return uriWithPath(at, vscode.Uri.joinPath(at, '..', path).path);
  }

  /** Where `uri` is, or for an untitled document, where it will be saved (its path in the workspace's file system). */
  private location(uri: vscode.Uri): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    return uri.scheme === 'untitled' && folder ? uri.with({ scheme: folder.scheme, authority: folder.authority }) : uri;
  }

  /** State machines in the workspace that the document can use as submachines. */
  private async listMachines(uri: vscode.Uri): Promise<MachineInfo[]> {
    if (!vscode.workspace.workspaceFolders?.length) return [];
    const uris = await vscode.workspace.findFiles('**/*.fsm', '**/node_modules/**', 500);
    const out: MachineInfo[] = [];
    for (const u of uris) {
      if (u.toString() === uri.toString()) continue;
      const s = await this.summaryOf(u);
      if (!s) continue;
      out.push({ href: relative(dirname(this.location(uri).path), u.path), name: s.name, file: vscode.workspace.asRelativePath(u), points: s.points });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Reads the machines referenced by submachine states, to learn their names and connection points. */
  private async resolveSubmachines(uri: vscode.Uri, model: FsmModel, machines: MachineInfo[]): Promise<SubmachineInfo> {
    const paths = new Set(model.vertices.filter((v) => v.type === 'state' && v.submachine).map((v) => v.submachine!));
    const info: SubmachineInfo = {};
    for (const path of paths) {
      const known = machines.find((m) => m.href === path);
      if (known) {
        info[path] = { found: true, name: known.name, file: known.file, points: known.points };
        continue;
      }
      // Outside the workspace, or written with a different relative path.
      const target = this.resolvePath(uri, path);
      const s = await this.summaryOf(target);
      info[path] = s ? { found: true, name: s.name, file: vscode.workspace.asRelativePath(target), points: s.points } : { found: false, points: [] };
    }
    return info;
  }

  private async openSubmachine(from: vscode.Uri, path: string) {
    if (!path) return;
    const uri = this.resolvePath(from, path);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      void vscode.window.showErrorMessage(`The referenced state machine file ${path} does not exist.`);
      return;
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, FsmEditorProvider.viewType);
  }

  private publishDiagnostics(document: FsmDocument, issues: Issue[], problems?: Problem[]) {
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled' && document.uri.scheme !== vscode.workspace.workspaceFolders?.[0]?.uri.scheme) return;
    const s = document.state;
    const old = document.old;
    const lineRange = (line: number) => new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), Number.MAX_SAFE_INTEGER);
    const rangeOf = (id: string) => {
      if (old) {
        // The old file, by its xmi:ids.
        const at = id ? old.text.indexOf(`xmi:id="${id}"`) : -1;
        return lineRange(at >= 0 ? old.text.slice(0, at).split('\n').length : 1);
      }
      return lineRange(s.lines.get(id) ?? 1);
    };
    const severity = {
      error: vscode.DiagnosticSeverity.Error,
      warning: vscode.DiagnosticSeverity.Warning,
      info: vscode.DiagnosticSeverity.Information,
    };
    const list = issues.map((i) => {
      const d = new vscode.Diagnostic(rangeOf(i.id), i.message, severity[i.severity]);
      d.source = 'fsm';
      return d;
    });
    for (const p of problems ?? []) {
      const d = new vscode.Diagnostic(lineRange(p.line), p.message, vscode.DiagnosticSeverity.Error);
      d.source = 'fsm';
      list.push(d);
    }
    this.diagnostics.set(document.uri, list);
  }

  private html(webview: vscode.Webview): string {
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const panels = this.context.globalState.get<PanelState>(PANELS_KEY) ?? { toolbox: true, props: true };
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${media('editor.css')}" rel="stylesheet">
  <title>FSM Editor</title>
</head>
<body>
  <div id="app" data-panels='${JSON.stringify(panels)}'>
    <div id="toolbar"></div>
    <div id="main">
      <aside id="toolbox-pane" class="side left"><div class="side-head"><span>Toolbox</span></div><div id="toolbox"></div></aside>
      <div id="canvas-wrap">
        <svg id="canvas" tabindex="0"><g id="world"></g></svg>
        <div id="problems" hidden></div>
        <div id="toast" hidden><span id="toast-text"></span><button id="toast-close" title="Close" aria-label="Close">×</button></div>
        <div id="parse-error" hidden></div>
      </div>
      <aside id="props-pane" class="side right"><div class="side-head"><span>Properties</span></div><div id="props" class="props"></div></aside>
    </div>
    <div id="statusbar"></div>
  </div>
  <script nonce="${nonce}" src="${media('editor.js')}"></script>
</body>
</html>`;
  }
}
