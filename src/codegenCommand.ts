/**
 * The "Generate Code…" command: picks a template (bundled or any .hbs or .jinja
 * file) and an output folder, then generates the code. A Handlebars template
 * (.hbs) runs the code generation pipeline through vscode.workspace.fs, so it
 * works on desktop and on the web; a Jinja template (.jinja) runs fsm-generator,
 * on desktop only.
 *
 * Arguments (all optional, for tasks and keybindings):
 *   fsmEditor.generateCode(source?: Uri, { template?: Uri | string, out?: Uri | string })
 */
import * as vscode from 'vscode';
import { GenerateError, GenerateHost, generate } from './codegen/generate';
import { TemplateError, parseTemplate } from './codegen/render';
import { generatorTemplates, locateGenerator, runGenerator } from './fsmGenerator';
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


/** fsm-generator, which runs the Jinja templates: undefined on the web, or when it isn't found. */
const generatorPath = (context: vscode.ExtensionContext) =>
  locateGenerator(context.extensionUri.fsPath, vscode.workspace.getConfiguration('fsmEditor.codegen').get<string>('generatorPath', ''));

const isJinja = (uri: vscode.Uri) => uri.path.toLowerCase().endsWith('.jinja');

/** Templates: the bundled ones, then the workspace's; Jinja ones only where fsm-generator can run them. */
async function pickTemplate(context: vscode.ExtensionContext): Promise<vscode.Uri | undefined> {
  const bundledDir = vscode.Uri.joinPath(context.extensionUri, 'templates');
  const items: (vscode.QuickPickItem & { uri?: vscode.Uri })[] = [];
  try {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(bundledDir)) {
      if (type === vscode.FileType.File && name.endsWith('.hbs')) {
        items.push({ label: name.replace(/\.hbs$/, ''), description: 'bundled Handlebars template', uri: vscode.Uri.joinPath(bundledDir, name) });
      }
    }
  } catch {
    // no bundled templates
  }
  const generator = generatorPath(context);
  if (generator) {
    for (const file of generatorTemplates(generator)) {
      const uri = vscode.Uri.file(file);
      items.push({ label: basename(uri.path, '.jinja'), description: 'bundled Jinja template (fsm-generator)', uri });
    }
  }
  const found = await vscode.workspace.findFiles(generator ? '**/*.{hbs,jinja}' : '**/*.hbs', '**/node_modules/**', 50);
  for (const uri of found.sort((a, b) => a.path.localeCompare(b.path))) {
    items.push({ label: basename(basename(uri.path, '.hbs'), '.jinja'), description: vscode.workspace.asRelativePath(uri), uri });
  }
  const last = context.workspaceState.get<string>(TEMPLATE_KEY);
  items.sort((a, b) => Number(b.uri?.toString() === last) - Number(a.uri?.toString() === last));
  items.push({ label: '$(folder-opened) Browse…', description: generator ? 'another .hbs or .jinja template' : 'another .hbs template' });
  const picked = await vscode.window.showQuickPick(items, { title: 'Generate Code: template', placeHolder: 'Template to generate the code with' });
  if (!picked) return undefined;
  if (picked.uri) return picked.uri;
  const filters: Record<string, string[]> = generator ? { Template: ['hbs', 'jinja'] } : { 'Handlebars template': ['hbs'] };
  const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters, openLabel: 'Use Template' });
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
  if (isJinja(templateUri)) return generateWithJinja(context, source, templateUri, out, !args.template || !args.out);

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

/** `file:line: severity: message`, as fsm-generator prints problems. */
const ISSUE_LINE = /^(.+?):(\d+): (error|warning|info): (.*)$/;

/** Generates with a Jinja template: runs fsm-generator, which reads the files on disk. */
async function generateWithJinja(context: vscode.ExtensionContext, source: vscode.Uri, templateUri: vscode.Uri, out: vscode.Uri, notify: boolean): Promise<vscode.Uri[]> {
  const channel = log();
  const fail = (message: string) => {
    channel.appendLine(`${new Date().toLocaleTimeString()} ${message}`);
    void vscode.window.showErrorMessage(`Code generation failed: ${message}`, 'Show Output').then((a) => {
      if (a) channel.show();
    });
    return [];
  };
  const configured = vscode.workspace.getConfiguration('fsmEditor.codegen').get<string>('generatorPath', '');
  const generator = generatorPath(context);
  if (!generator) {
    return fail(
      vscode.env.uiKind === vscode.UIKind.Web
        ? 'Jinja templates need fsm-generator, which does not run in VS Code for the Web.'
        : configured.trim()
          ? `fsm-generator '${configured}' (setting fsmEditor.codegen.generatorPath) does not exist.`
          : 'fsm-generator was not found. Set its path in the fsmEditor.codegen.generatorPath setting, or put it on the PATH.',
    );
  }
  if ([source, templateUri, out].some((u) => u.scheme !== 'file')) return fail('Jinja templates need the state machine, the template and the output folder on disk.');

  // fsm-generator reads the files on disk: save the open state machines first.
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isDirty && doc.uri.path.endsWith('.fsm')) await doc.save();
  }
  const cwd = vscode.Uri.joinPath(source, '..').fsPath;
  const args = [source.fsPath, '--template', templateUri.fsPath, '--out', out.fsPath];
  channel.appendLine(`${new Date().toLocaleTimeString()} ${[generator, ...args].map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  let result;
  try {
    result = await runGenerator(generator, args, cwd);
  } catch (e) {
    return fail(`Could not run ${generator}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const lines = (text: string) => text.split(/\r?\n/).filter((l) => l.length > 0);
  const output = lines(result.stdout);
  const errors = lines(result.stderr);
  for (const line of [...output, ...errors]) channel.appendLine(`  ${line}`);
  // Paths are printed relative to the working folder, or absolute outside it.
  const resolve = (p: string) => (/^([A-Za-z]:)?[\\/]/.test(p) ? vscode.Uri.file(p) : vscode.Uri.joinPath(vscode.Uri.file(cwd), ...p.split(/[\\/]/)));
  const written = output.filter((l) => l.startsWith('wrote ')).map((l) => resolve(l.slice(6)));
  const issues = errors.map((l) => ISSUE_LINE.exec(l)).filter((m) => m !== null);
  const where = vscode.workspace.asRelativePath(out);
  if (result.exitCode !== 0) {
    if (result.exitCode === 2) return fail('fsm-generator was called with bad arguments.');
    if (issues.some((m) => m[3] === 'error')) return fail('The state machine has errors.');
    return fail(errors[errors.length - 1] ?? `fsm-generator exited with code ${result.exitCode}.`);
  }
  channel.appendLine(`  ${written.length} file${written.length === 1 ? '' : 's'} written in ${where}`);
  if (notify) {
    const warnings = issues.filter((m) => m[3] === 'warning').length;
    const also = warnings ? `, with ${warnings} warning${warnings === 1 ? '' : 's'}` : '';
    void vscode.window.showInformationMessage(`Generated ${written.length} file${written.length === 1 ? '' : 's'} in ${where}${also}.`, 'Show Output').then((a) => {
      if (a) channel.show();
    });
  }
  return written;
}
