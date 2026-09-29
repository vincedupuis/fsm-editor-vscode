import * as vscode from 'vscode';
import { ConnectionPointInfo, FsmModel, MachineInfo, SubmachineInfo, defaultModel, machineConnectionPoints, normalizeModel } from './model';
import { Issue, validate } from './validation';
import { basename, decodeText, dirname, relative } from './util';
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
  'fsmEditor.generateCode',
  'fsmEditor.openAsText',
]);

interface MachineSummary {
  id: string;
  name: string;
  points: ConnectionPointInfo[];
}

/** Per-editor state shared with the message handler. */
interface EditorContext {
  document: vscode.TextDocument;
  sync: () => void;
  /** The last XMI written for the webview, with the model JSON it came from. */
  echo?: { xmi: string; json: string };
}

export class FsmEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'fsmEditor.stateMachine';

  private active: ActiveEditor | undefined;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('fsm');
  private readonly pendingSvg = new Map<number, (svg: string) => void>();
  private nextRequest = 1;
  /** Re-sync callbacks of every open editor, run when any .fsm file changes (submachines may be affected). */
  private readonly resyncs = new Set<() => void>();
  /** Parsed summaries of state machine files, keyed by URI, with the version they were read from. */
  private readonly summaries = new Map<string, { key: string; summary: MachineSummary | null }>();

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
    const ctx: EditorContext = { document, sync: () => scheduleSync() };
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
      if (current !== generation) return; // a newer sync is on its way
      this.publishDiagnostics(document, issues, error);
      void panel.webview.postMessage({ type: 'update', text, issues, error, submachines, machines });
    };
    const scheduleSync = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void sync(), 30);
    };
    this.resyncs.add(scheduleSync);

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
      this.resyncs.delete(scheduleSync);
      if (this.active?.panel === panel) this.active = undefined;
      subs.forEach((s) => s.dispose());
    });
  }

  private async onMessage(msg: any, ctx: EditorContext) {
    const { document } = ctx;
    switch (msg?.type) {
      case 'ready':
        ctx.sync();
        break;
      case 'edit': {
        if (typeof msg.text !== 'string') break;
        let xmi: string;
        try {
          xmi = toXmi(JSON.parse(msg.text));
        } catch (e) {
          void vscode.window.showErrorMessage(`The change could not be saved: ${e instanceof Error ? e.message : e}`);
          break;
        }
        ctx.echo = { xmi, json: msg.text };
        if (xmi !== document.getText()) {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), xmi);
          await vscode.workspace.applyEdit(edit);
        }
        break;
      }
      case 'command':
        if (WEBVIEW_COMMANDS.has(msg.command)) await vscode.commands.executeCommand(msg.command);
        break;
      case 'svg': {
        const resolve = this.pendingSvg.get(msg.requestId);
        this.pendingSvg.delete(msg.requestId);
        resolve?.(msg.svg);
        break;
      }
      case 'openSubmachine':
        await this.openSubmachine(document, String(msg.href ?? ''));
        break;
      case 'info':
        void vscode.window.showInformationMessage(String(msg.message));
        break;
    }
  }

  /** Asks the active diagram to render itself as a standalone SVG. */
  requestSvg(editor: ActiveEditor): Promise<string> {
    const requestId = this.nextRequest++;
    return new Promise((resolve, reject) => {
      this.pendingSvg.set(requestId, resolve);
      void editor.panel.webview.postMessage({ type: 'requestSvg', requestId });
      setTimeout(() => {
        if (this.pendingSvg.delete(requestId)) reject(new Error('The diagram did not respond.'));
      }, 5000);
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
    return { uri: vscode.Uri.joinPath(document.uri, '..', decodeURI(file)), id };
  }

  /** State machines in the workspace that `document` can use as submachines. */
  private async listMachines(document: vscode.TextDocument): Promise<MachineInfo[]> {
    const uris = await vscode.workspace.findFiles('**/*.fsm', '**/node_modules/**', 500);
    const out: MachineInfo[] = [];
    for (const uri of uris) {
      if (uri.toString() === document.uri.toString()) continue;
      const s = await this.summaryOf(uri);
      if (!s) continue;
      out.push({ href: `${encodeURI(this.relative(document, uri))}#${s.id}`, name: s.name, file: vscode.workspace.asRelativePath(uri), points: s.points });
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
  <div id="app">
    <div id="toolbar"></div>
    <div id="main">
      <div id="toolbox"></div>
      <div id="canvas-wrap">
        <svg id="canvas" tabindex="0"><g id="world"></g></svg>
        <div id="problems" hidden></div>
        <div id="toast" hidden></div>
        <div id="parse-error" hidden></div>
      </div>
      <div id="props"></div>
    </div>
    <div id="statusbar"></div>
  </div>
  <script nonce="${nonce}" src="${media('expressions.js')}"></script>
  <script nonce="${nonce}" src="${media('editor.js')}"></script>
</body>
</html>`;
  }
}
