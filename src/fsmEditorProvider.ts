import * as vscode from 'vscode';
import { ConnectionPointInfo, FsmModel, MachineInfo, SubmachineInfo, defaultModel, machineConnectionPoints, normalizeModel } from './model';
import { ExtractError, extractSubmachine, proposedName } from './extract';
import { Issue, validate } from './validation';
import { TraceView } from './trace/replay';
import { basename, decodeHref, decodeText, dirname, encodeHref, encodeText, relative } from './util';
import { fromXmi, toXmi } from './xmi';

interface ActiveEditor {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
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
  id: string;
  name: string;
  points: ConnectionPointInfo[];
}

/** Per-editor state shared with the message handler. */
interface EditorContext {
  document: vscode.TextDocument;
  webview: vscode.Webview;
  sync: () => void;
  /** The last XMI written for the webview, with the model JSON it came from. */
  echo?: { xmi: string; json: string };
  /** Edits of the webview being applied to the document. */
  pending: number;
}

export class FsmEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'fsmEditor.stateMachine';

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
  /** Every open diagram with its document, for the Trace Player's highlights. */
  private readonly diagrams = new Set<{ document: vscode.TextDocument; webview: vscode.Webview }>();
  /** The Trace Player's highlights of each file, by URI; files without one show none. */
  private traceHighlights = new Map<string, TraceView>();

  constructor(private readonly context: vscode.ExtensionContext) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.fsm');
    const resyncAll = () => this.resyncs.forEach((r) => r());
    context.subscriptions.push(
      this.diagnostics,
      watcher,
      watcher.onDidChange(resyncAll),
      watcher.onDidCreate(resyncAll),
      watcher.onDidDelete(resyncAll),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.path.endsWith('.fsm') && e.contentChanges.length) resyncAll();
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.diagnostics.delete(d.uri)),
    );
  }

  get activeEditor(): ActiveEditor | undefined {
    return this.active;
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.webview.html = this.html(panel.webview);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let disposed = false;
    const ctx: EditorContext = { document, webview: panel.webview, sync: () => scheduleSync(), pending: 0 };
    const sync = async () => {
      const current = ++generation;
      const xmi = document.getText();
      let issues: Issue[] = [];
      let error: string | undefined;
      let text = '';
      let submachines: SubmachineInfo = {};
      let machines: MachineInfo[] = [];
      try {
        let model: FsmModel;
        if (ctx.echo && ctx.echo.xmi === xmi) {
          // Our own edit coming back: hand the webview the exact model it sent.
          text = ctx.echo.json;
          model = normalizeModel(JSON.parse(text));
        } else {
          model = xmi.trim() ? fromXmi(xmi) : defaultModel(basename(document.uri.path, '.fsm'));
          text = JSON.stringify(model, null, 2) + '\n';
        }
        machines = await this.listMachines(document);
        submachines = await this.resolveSubmachines(document, model, machines);
        issues = validate(model, submachines);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      if (current !== generation || disposed) return; // a newer sync is on its way, or the editor is gone
      // The document changed meanwhile, or the webview's edit is on its way to it: posting this older text would
      // take the webview back to it. The change syncs again (the edit once applied).
      if (ctx.pending) return;
      if (document.getText() !== xmi) {
        scheduleSync();
        return;
      }
      this.publishDiagnostics(document, issues, error);
      void panel.webview.postMessage({ type: 'update', text, issues, error, submachines, machines });
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
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) this.active = { panel, document };
        else if (this.active?.panel === panel) this.active = undefined;
      }),
      panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg, ctx)),
    ];
    if (panel.active) this.active = { panel, document };

    panel.onDidDispose(() => {
      if (timer) clearTimeout(timer);
      disposed = true;
      this.resyncs.delete(scheduleSync);
      this.webviews.delete(webview);
      this.diagrams.delete(diagram);
      if (this.active?.panel === panel) this.active = undefined;
      subs.forEach((s) => s.dispose());
    });
  }

  private async onMessage(msg: any, ctx: EditorContext) {
    const { document } = ctx;
    switch (msg?.type) {
      case 'ready':
        ctx.sync();
        void ctx.webview.postMessage({ type: 'trace', highlight: this.traceHighlights.get(document.uri.toString()) ?? null });
        break;
      case 'panels': {
        const panels: PanelState = { toolbox: msg.panels?.toolbox !== false, props: msg.panels?.props !== false };
        await this.context.globalState.update(PANELS_KEY, panels);
        for (const w of this.webviews) void w.postMessage({ type: 'panels', panels });
        break;
      }
      case 'edit': {
        if (typeof msg.text !== 'string') break;
        let xmi: string;
        try {
          xmi = toXmi(JSON.parse(msg.text));
        } catch (e) {
          void vscode.window.showErrorMessage(`The change could not be saved: ${e instanceof Error ? e.message : e}`);
          // Back to what the document holds.
          ctx.sync();
          break;
        }
        ctx.echo = { xmi, json: msg.text };
        if (xmi !== document.getText()) {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), xmi);
          ctx.pending++;
          try {
            await vscode.workspace.applyEdit(edit);
          } finally {
            ctx.pending--;
            ctx.sync();
          }
        }
        break;
      }
      case 'command':
        if (WEBVIEW_COMMANDS.has(msg.command)) await vscode.commands.executeCommand(msg.command);
        break;
      case 'svg':
      case 'png': {
        const resolve = this.pendingExports.get(msg.requestId);
        this.pendingExports.delete(msg.requestId);
        resolve?.({ data: msg.type === 'svg' ? msg.svg : msg.png, error: msg.error });
        break;
      }
      case 'openSubmachine':
        await this.openSubmachine(document, String(msg.href ?? ''));
        break;
      case 'extractCheck':
        void ctx.webview.postMessage({ type: 'extractCheck', requestId: msg.requestId, problem: this.extractProblem(document, msg.text, msg.ids) });
        break;
      case 'extract':
        if (typeof msg.text === 'string' && Array.isArray(msg.ids)) await this.extract(ctx, msg.text, msg.ids.map(String));
        break;
      case 'info':
        void vscode.window.showInformationMessage(String(msg.message));
        break;
      // Cut, Copy and Paste of the diagram's context menu: the webview can't use the clipboard on its own.
      case 'clipboardWrite':
        if (typeof msg.text === 'string') await vscode.env.clipboard.writeText(msg.text);
        break;
      case 'clipboardRead':
        void ctx.webview.postMessage({ type: 'clipboard', requestId: msg.requestId, text: await vscode.env.clipboard.readText() });
        break;
    }
  }

  /**
   * Extract to Submachine: moves the selected elements (`ids` of the webview's model `text`) into a new
   * state machine file next to the document, and puts a submachine state referencing it in their place.
   * One workspace edit creates the file and changes the document, so undo takes back both.
   */
  private async extract(ctx: EditorContext, text: string, ids: string[]) {
    const { document } = ctx;
    const toast = (message: string) => void ctx.webview.postMessage({ type: 'toast', message });
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
        !/^[\w .-]+$/.test(v) ? 'Use letters, digits, spaces, dots, dashes or underscores.'
          : (await exists(fileOf(v))) ? `${v}.fsm already exists.`
            : undefined,
    });
    if (!name) return;
    const uri = fileOf(name);
    const { parent, machine } = extractSubmachine(model, ids, name, `${encodeHref(name)}.fsm#sm`);
    let machineXmi: string;
    let parentXmi: string;
    try {
      machineXmi = toXmi(machine);
      parentXmi = toXmi(parent);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      return;
    }
    const contents = encodeText(machineXmi);
    const edit = new vscode.WorkspaceEdit();
    const metadata = { label: 'Extract to Submachine', needsConfirmation: false };
    edit.createFile(uri, { contents }, metadata);
    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), parentXmi, metadata);
    if (!(await vscode.workspace.applyEdit(edit))) {
      toast(`${name}.fsm could not be created.`);
      return;
    }
    // VS Code versions without file contents in workspace edits create an empty file.
    if ((await vscode.workspace.fs.stat(uri)).size === 0) await vscode.workspace.fs.writeFile(uri, contents);
  }

  /** Why the selected `ids` of the webview's model `text` can't be extracted to a submachine, or undefined when they can. */
  private extractProblem(document: vscode.TextDocument, text: unknown, ids: unknown): string | undefined {
    if (document.isUntitled) return 'Save the state machine first: the submachine goes in a file next to it.';
    try {
      if (typeof text !== 'string' || !Array.isArray(ids)) throw new Error('no selection');
      extractSubmachine(normalizeModel(JSON.parse(text)), ids.map(String), 'Submachine', 'Submachine.fsm#sm');
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
      const h = highlights.get(key) ?? null;
      if (JSON.stringify(h) !== JSON.stringify(before.get(key) ?? null)) void webview.postMessage({ type: 'trace', highlight: h });
    }
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

  /** Name, id and connection points of the state machine in `uri`, or null when it cannot be read. */
  private async summaryOf(uri: vscode.Uri): Promise<MachineSummary | null> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    let key: string;
    try {
      key = open ? `v${open.version}` : `m${(await vscode.workspace.fs.stat(uri)).mtime}`;
    } catch {
      return null; // missing file
    }
    const cached = this.summaries.get(uri.toString());
    if (cached && cached.key === key) return cached.summary;
    let summary: MachineSummary | null = null;
    try {
      // Prefer the open (possibly unsaved) document over the file on disk.
      const text = open ? open.getText() : decodeText(await vscode.workspace.fs.readFile(uri));
      const m = fromXmi(text);
      summary = { id: m.id ?? 'sm', name: m.name, points: machineConnectionPoints(m) };
    } catch {
      summary = null;
    }
    this.summaries.set(uri.toString(), { key, summary });
    return summary;
  }

  /** href of `target` as seen from `document`, e.g. `sub/Payment.fsm`. */
  private relative(document: vscode.TextDocument, target: vscode.Uri): string {
    return relative(dirname(document.uri.path), target.path);
  }

  private resolveHref(document: vscode.TextDocument, href: string): { uri: vscode.Uri; id: string } {
    const [file, id = ''] = href.split('#');
    return { uri: vscode.Uri.joinPath(this.location(document), '..', decodeHref(file)), id };
  }

  /** Where `document` is, or for an untitled one, where it will be saved (its path in the workspace's file system). */
  private location(document: vscode.TextDocument): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    return document.isUntitled && folder ? document.uri.with({ scheme: folder.scheme, authority: folder.authority }) : document.uri;
  }

  /** State machines in the workspace that `document` can use as submachines. */
  private async listMachines(document: vscode.TextDocument): Promise<MachineInfo[]> {
    const uris = await vscode.workspace.findFiles('**/*.fsm', '**/node_modules/**', 500);
    const out: MachineInfo[] = [];
    for (const uri of uris) {
      if (uri.toString() === document.uri.toString()) continue;
      const s = await this.summaryOf(uri);
      if (!s) continue;
      out.push({ href: `${encodeHref(this.relative(document, uri))}#${s.id}`, name: s.name, file: vscode.workspace.asRelativePath(uri), points: s.points });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Reads the machines referenced by submachine states, to learn their names and connection points. */
  private async resolveSubmachines(document: vscode.TextDocument, model: FsmModel, machines: MachineInfo[]): Promise<SubmachineInfo> {
    const hrefs = new Set(model.vertices.filter((v) => v.type === 'state' && v.submachine).map((v) => v.submachine!));
    const info: SubmachineInfo = {};
    for (const href of hrefs) {
      const known = machines.find((m) => m.href === href);
      if (known) {
        info[href] = { found: true, name: known.name, file: known.file, points: known.points };
        continue;
      }
      // Outside the workspace, or written with a different relative path.
      const { uri, id } = this.resolveHref(document, href);
      const s = await this.summaryOf(uri);
      info[href] = s && s.id === id
        ? { found: true, name: s.name, file: vscode.workspace.asRelativePath(uri), points: s.points }
        : { found: false, points: [] };
    }
    return info;
  }

  private async openSubmachine(document: vscode.TextDocument, href: string) {
    if (!href) return;
    const { uri } = this.resolveHref(document, href);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      void vscode.window.showErrorMessage(`The referenced state machine file ${href.split('#')[0]} does not exist.`);
      return;
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, FsmEditorProvider.viewType);
  }

  private publishDiagnostics(document: vscode.TextDocument, issues: Issue[], error?: string) {
    const text = document.getText();
    const rangeOf = (id: string) => {
      if (id) {
        const at = text.indexOf(`xmi:id="${id}"`);
        const idx = at >= 0 ? at : text.indexOf(`"${id}"`);
        if (idx >= 0) {
          const start = document.positionAt(idx);
          return new vscode.Range(start, document.lineAt(start.line).range.end);
        }
      }
      return new vscode.Range(0, 0, 0, 0);
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
    if (error) list.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), error, vscode.DiagnosticSeverity.Error));
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
        <div id="toast" hidden></div>
        <div id="parse-error" hidden></div>
      </div>
      <aside id="props-pane" class="side right"><div class="side-head"><span>Properties</span></div><div id="props" class="props"></div></aside>
    </div>
    <div id="statusbar"></div>
  </div>
  <script nonce="${nonce}" src="${media('expressions.js')}"></script>
  <script nonce="${nonce}" src="${media('editor.js')}"></script>
</body>
</html>`;
  }
}
