/**
 * The "Generate Code…" command: picks a template (bundled or any .jinja file)
 * and an output folder, then generates the code with fsm-cli's WebAssembly
 * module (fsmCli.ts). The files go through vscode.workspace.fs, so this works on
 * desktop and on the web alike.
 *
 * Arguments (all optional, for tasks and keybindings):
 *   fsmEditor.generateCode(source?: Uri, { template?: Uri | string, out?: Uri | string })
 */
import * as vscode from 'vscode';
import { FsmIssue, Generator, loadGenerator } from './fsmCli';
import { loadModel, submachineFiles } from './load';
import { basename, encodeText } from './util';

export interface GenerateArgs {
  template?: vscode.Uri | string;
  out?: vscode.Uri | string;
}

const TEMPLATE_KEY = 'fsmEditor.codegen.template';
const OUT_KEY = 'fsmEditor.codegen.out';

let output: vscode.OutputChannel | undefined;
const log = () => (output ??= vscode.window.createOutputChannel('FSM Code Generation'));

/** The module and its templates, shipped in the extension's fsm/ folder. */
const fsmFolder = (context: vscode.ExtensionContext) => vscode.Uri.joinPath(context.extensionUri, 'fsm');

let generator: Generator | undefined;
async function getGenerator(context: vscode.ExtensionContext): Promise<Generator> {
  if (!generator) {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(fsmFolder(context), 'fsm.wasm'));
    } catch {
      throw new Error('The code generator (fsm/fsm.wasm) is missing from the extension.');
    }
    generator = loadGenerator(bytes);
  }
  return generator;
}

/** A Uri, a URI string, an absolute path, or a path relative to the first workspace folder. */
function asUri(u: vscode.Uri | string): vscode.Uri {
  if (typeof u !== 'string') return u;
  if (/^[a-z][\w+.-]+:\/\//i.test(u)) return vscode.Uri.parse(u);
  if (u.startsWith('/') || /^[A-Za-z]:[\\/]/.test(u)) return vscode.Uri.file(u);
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder ? vscode.Uri.joinPath(folder, ...u.split(/[\\/]/)) : vscode.Uri.file(u);
}

/** Templates: the bundled ones, then the workspace's. */
async function pickTemplate(context: vscode.ExtensionContext): Promise<vscode.Uri | undefined> {
  const bundledDir = vscode.Uri.joinPath(fsmFolder(context), 'templates');
  const items: (vscode.QuickPickItem & { uri?: vscode.Uri })[] = [];
  try {
    const entries = await vscode.workspace.fs.readDirectory(bundledDir);
    for (const [name, type] of entries.sort(([a], [b]) => a.localeCompare(b))) {
      if (type === vscode.FileType.File && name.endsWith('.jinja')) {
        items.push({ label: basename(name, '.jinja'), description: 'bundled template', uri: vscode.Uri.joinPath(bundledDir, name) });
      }
    }
  } catch {
    // no bundled templates
  }
  const found = await vscode.workspace.findFiles('**/*.jinja', '**/node_modules/**', 50);
  for (const uri of found.sort((a, b) => a.path.localeCompare(b.path))) {
    items.push({ label: basename(uri.path, '.jinja'), description: vscode.workspace.asRelativePath(uri), uri });
  }
  const last = context.workspaceState.get<string>(TEMPLATE_KEY);
  items.sort((a, b) => Number(b.uri?.toString() === last) - Number(a.uri?.toString() === last));
  items.push({ label: '$(folder-opened) Browse…', description: 'another .jinja template' });
  const picked = await vscode.window.showQuickPick(items, { title: 'Generate Code: template', placeHolder: 'Template to generate the code with' });
  if (!picked) return undefined;
  if (picked.uri) return picked.uri;
  const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Jinja template': ['jinja'] }, openLabel: 'Use Template' });
  return files?.[0];
}

async function pickOutput(context: vscode.ExtensionContext, source: vscode.Uri): Promise<vscode.Uri | undefined> {
  const last = context.workspaceState.get<string>(`${OUT_KEY}:${source.toString()}`);
  const folders = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    defaultUri: last ? vscode.Uri.parse(last) : vscode.Uri.joinPath(source, '..'),
    openLabel: 'Generate Here',
    title: 'Generate Code: output folder',
  });
  return folders?.[0];
}

/** UTF-8 with its BOM kept, as `fsm write` reads files; undefined when the bytes aren't UTF-8. */
function decodeFile(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Reads a `.fsm` file's text as the editor sees it (a diagram with unsaved changes); undefined when it can't. */
export type ReadText = (uri: vscode.Uri) => Promise<string | undefined>;

/**
 * The texts of `source` and of the machines its submachine states use, transitively, by path (the module reads no
 * files). Open documents may have unsaved changes: their text is used. A file that can't be read is left out, and
 * the module reports it as `fsm write` does. Layout files aren't read: the module doesn't need them.
 */
async function readMachines(source: vscode.Uri, readText?: ReadText): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const seen = new Set<string>();
  const queue = [source];
  for (let uri = queue.shift(); uri; uri = queue.shift()) {
    if (seen.has(uri.path)) continue;
    seen.add(uri.path);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri!.toString());
    let text: string | undefined;
    try {
      text = readText ? await readText(uri) : open ? open.getText() : decodeFile(await vscode.workspace.fs.readFile(uri));
    } catch {
      text = undefined;
    }
    if (text === undefined) continue;
    files[uri.path] = text;
    let paths: string[] = [];
    try {
      paths = submachineFiles(loadModel(text));
    } catch {
      // not a state machine: the module says why
    }
    for (const file of paths) {
      if (!file) continue;
      queue.push(file.startsWith('/') ? uri.with({ path: file }) : vscode.Uri.joinPath(uri, '..', file));
    }
  }
  return files;
}

export async function generateCode(context: vscode.ExtensionContext, source: vscode.Uri | undefined, args: GenerateArgs = {}, readText?: ReadText): Promise<vscode.Uri[]> {
  if (!source || !source.path.endsWith('.fsm')) {
    void vscode.window.showWarningMessage('Select or open a .fsm state machine to generate code from.');
    return [];
  }
  const templateUri = args.template ? asUri(args.template) : await pickTemplate(context);
  if (!templateUri) return [];
  const out = args.out ? asUri(args.out) : await pickOutput(context, source);
  if (!out) return [];
  await context.workspaceState.update(TEMPLATE_KEY, templateUri.toString());
  await context.workspaceState.update(`${OUT_KEY}:${source.toString()}`, out.toString());

  // Paths in messages are relative to the source's workspace folder (its own folder outside a workspace), and
  // shown as VS Code shows workspace paths.
  const folder = vscode.workspace.getWorkspaceFolder(source);
  const cwd = folder?.uri.scheme === source.scheme && folder.uri.authority === source.authority ? folder.uri : vscode.Uri.joinPath(source, '..');
  const display = (file: string) => vscode.workspace.asRelativePath(file.startsWith('/') ? cwd.with({ path: file }) : vscode.Uri.joinPath(cwd, file));
  const issueLine = (i: FsmIssue) => `${display(i.file)}:${i.line}: ${i.severity}: ${i.message}`;
  const templateName = templateUri.toString().startsWith(fsmFolder(context).toString()) ? basename(templateUri.path) : vscode.workspace.asRelativePath(templateUri);

  const channel = log();
  const time = () => new Date().toLocaleTimeString();
  const fail = (message: string, issues: FsmIssue[] = []) => {
    channel.appendLine(`${time()} ${message}`);
    for (const line of issues.map(issueLine)) channel.appendLine(`  ${line}`);
    void vscode.window.showErrorMessage(`Code generation failed: ${message}`, 'Show Output').then((a) => {
      if (a) channel.show();
    });
    return [];
  };

  try {
    let template: string | undefined;
    try {
      template = decodeFile(await vscode.workspace.fs.readFile(templateUri));
    } catch {
      template = undefined;
    }
    if (template === undefined) return fail(`Cannot read the template ${templateName}.`);
    const files = await readMachines(source, readText);
    const generate = await getGenerator(context);
    const result = await generate({ cwd: cwd.path, files, generate: [source.path], template, templateName });
    if (result.exitCode !== 0) return fail(result.error ?? `The code generator stopped with exit code ${result.exitCode}.`, result.issues);

    const written: vscode.Uri[] = [];
    for (const f of result.files) {
      const target = vscode.Uri.joinPath(out, ...f.path.split('/'));
      await vscode.workspace.fs.writeFile(target, encodeText(f.content));
      written.push(target);
    }
    const where = vscode.workspace.asRelativePath(out);
    channel.appendLine(`${time()} ${vscode.workspace.asRelativePath(source)} → ${where}: ${written.length} written`);
    for (const w of written) channel.appendLine(`  ${vscode.workspace.asRelativePath(w)}`);
    const warnings = result.issues.filter((i) => i.severity === 'warning');
    for (const i of warnings) channel.appendLine(`  ${issueLine(i)}`);
    if (!args.template || !args.out) {
      const also = warnings.length ? `, with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : '';
      void vscode.window.showInformationMessage(`Generated ${written.length} file${written.length === 1 ? '' : 's'} in ${where}${also}.`, 'Show Output').then((a) => {
        if (a) channel.show();
      });
    }
    return written;
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
