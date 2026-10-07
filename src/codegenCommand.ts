/**
 * The "Generate Code…" command: picks a template (bundled or any .hbs file)
 * and an output folder, then runs the code generation pipeline through
 * vscode.workspace.fs, so it works on desktop and on the web.
 *
 * Arguments (all optional, for tasks and keybindings):
 *   fsmEditor.generateCode(source?: Uri, { template?: Uri | string, out?: Uri | string })
 */
import * as vscode from 'vscode';
import { GenerateError, GenerateHost, generate } from './codegen/generate';
import { TemplateError, parseTemplate } from './codegen/render';
import { basename, decodeText, encodeText } from './util';

export interface GenerateArgs {
  template?: vscode.Uri | string;
  out?: vscode.Uri | string;
}

const TEMPLATE_KEY = 'fsmEditor.codegen.template';
const OUT_KEY = 'fsmEditor.codegen.out';

let output: vscode.OutputChannel | undefined;
const log = () => (output ??= vscode.window.createOutputChannel('FSM Code Generation'));

/** A Uri, a URI string, an absolute path, or a path relative to the first workspace folder. */
function asUri(u: vscode.Uri | string): vscode.Uri {
  if (typeof u !== 'string') return u;
  if (/^[a-z][\w+.-]+:\/\//i.test(u)) return vscode.Uri.parse(u);
  if (u.startsWith('/') || /^[A-Za-z]:[\\/]/.test(u)) return vscode.Uri.file(u);
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder ? vscode.Uri.joinPath(folder, ...u.split(/[\\/]/)) : vscode.Uri.file(u);
}


async function pickTemplate(context: vscode.ExtensionContext): Promise<vscode.Uri | undefined> {
  const bundledDir = vscode.Uri.joinPath(context.extensionUri, 'templates');
  const items: (vscode.QuickPickItem & { uri?: vscode.Uri })[] = [];
  try {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(bundledDir)) {
      if (type === vscode.FileType.File && name.endsWith('.hbs')) {
        items.push({ label: name.replace(/\.hbs$/, ''), description: 'bundled template', uri: vscode.Uri.joinPath(bundledDir, name) });
      }
    }
  } catch {
    // no bundled templates
  }
  for (const uri of await vscode.workspace.findFiles('**/*.hbs', '**/node_modules/**', 50)) {
    items.push({ label: basename(uri.path, '.hbs'), description: vscode.workspace.asRelativePath(uri), uri });
  }
  const last = context.workspaceState.get<string>(TEMPLATE_KEY);
  items.sort((a, b) => Number(b.uri?.toString() === last) - Number(a.uri?.toString() === last));
  items.push({ label: '$(folder-opened) Browse…', description: 'another .hbs template' });
  const picked = await vscode.window.showQuickPick(items, { title: 'Generate Code: template', placeHolder: 'Template to generate the code with' });
  if (!picked) return undefined;
  if (picked.uri) return picked.uri;
  const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Handlebars template': ['hbs'] }, openLabel: 'Use Template' });
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

export async function generateCode(context: vscode.ExtensionContext, source: vscode.Uri | undefined, args: GenerateArgs = {}): Promise<vscode.Uri[]> {
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

  const host: GenerateHost = {
    // Open documents may have unsaved changes: use them.
    readFile: async (p) => {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === p);
      return open ? open.getText() : decodeText(await vscode.workspace.fs.readFile(vscode.Uri.parse(p)));
    },
    resolve: (from, href) => vscode.Uri.joinPath(vscode.Uri.parse(from), '..', decodeURI(href)).toString(),
    display: (p) => vscode.workspace.asRelativePath(vscode.Uri.parse(p)),
  };

  const channel = log();
  try {
    const template = parseTemplate(decodeText(await vscode.workspace.fs.readFile(templateUri)));
    const result = await generate([source.toString()], template, host);
    const written: vscode.Uri[] = [];
    for (const f of result.files) {
      const target = vscode.Uri.joinPath(out, ...f.path.split('/'));
      await vscode.workspace.fs.writeFile(target, encodeText(f.content));
      written.push(target);
    }
    const where = vscode.workspace.asRelativePath(out);
    channel.appendLine(`${new Date().toLocaleTimeString()} ${result.machines.join(', ')} → ${where}: ${written.length} written`);
    for (const w of written) channel.appendLine(`  ${vscode.workspace.asRelativePath(w)}`);
    const warnings = result.issues.filter((i) => i.severity === 'warning');
    for (const i of warnings) channel.appendLine(`  ${i.file}: warning: ${i.message}`);
    if (!args.template || !args.out) {
      const also = warnings.length ? `, with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : '';
      void vscode.window.showInformationMessage(`Generated ${written.length} file${written.length === 1 ? '' : 's'} in ${where}${also}.`, 'Show Output').then((a) => {
        if (a) channel.show();
      });
    }
    return written;
  } catch (e) {
    const message =
      e instanceof TemplateError ? `Template ${vscode.workspace.asRelativePath(templateUri)}: ${e.message}` : e instanceof Error ? e.message : String(e);
    channel.appendLine(`${new Date().toLocaleTimeString()} ${message}`);
    if (e instanceof GenerateError) {
      for (const i of e.issues.filter((x) => x.severity !== 'info')) channel.appendLine(`  ${i.file}: ${i.severity}: ${i.message}`);
    }
    void vscode.window.showErrorMessage(`Code generation failed: ${message}`, 'Show Output').then((a) => {
      if (a) channel.show();
    });
    return [];
  }
}
