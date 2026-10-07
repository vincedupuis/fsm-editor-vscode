import * as vscode from 'vscode';
import { GenerateArgs, generateCode } from './codegenCommand';
import { FsmEditorProvider } from './fsmEditorProvider';
import { defaultModel } from './model';
import { basename, encodeText, extname } from './util';
import { toXmi } from './xmi';

export function activate(context: vscode.ExtensionContext) {
  const provider = new FsmEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(FsmEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand('fsmEditor.new', async (folder?: vscode.Uri) => {
      const name = await vscode.window.showInputBox({
        prompt: 'Name of the new state machine',
        value: 'StateMachine',
        validateInput: (v) => (/^[\w .-]+$/.test(v) ? undefined : 'Use letters, digits, spaces, dots, dashes or underscores.'),
      });
      if (!name) return;
      let dir = folder ?? vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!dir) {
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Create Here' });
        dir = picked?.[0];
      }
      if (!dir) return;
      const uri = vscode.Uri.joinPath(dir, `${name}.fsm`);
      try {
        await vscode.workspace.fs.stat(uri);
        void vscode.window.showErrorMessage(`${name}.fsm already exists.`);
        return;
      } catch {
        // does not exist yet
      }
      await vscode.workspace.fs.writeFile(uri, encodeText(toXmi(defaultModel(name))));
      await vscode.commands.executeCommand('vscode.openWith', uri, FsmEditorProvider.viewType);
    }),

    vscode.commands.registerCommand('fsmEditor.newUntitled', async () => {
      // An untitled document next to the workspace's files, so Save proposes that folder.
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const untitled = (name: string) =>
        folder ? vscode.Uri.joinPath(folder, name).with({ scheme: 'untitled' }) : vscode.Uri.from({ scheme: 'untitled', path: name });
      const taken = async (name: string) => {
        if (vscode.workspace.textDocuments.some((d) => d.uri.toString() === untitled(name).toString())) return true;
        if (!folder) return false;
        try {
          await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, name));
          return true;
        } catch {
          return false;
        }
      };
      let name = 'StateMachine';
      for (let n = 2; await taken(`${name}.fsm`); n++) name = `StateMachine${n}`;
      const uri = untitled(`${name}.fsm`);
      const document = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(0, 0), toXmi(defaultModel(name)));
      await vscode.workspace.applyEdit(edit);
      await vscode.commands.executeCommand('vscode.openWith', document.uri, FsmEditorProvider.viewType);
    }),

    vscode.commands.registerCommand('fsmEditor.openAsText', async () => {
      const uri = provider.activeEditor?.document.uri;
      if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),

    vscode.commands.registerCommand('fsmEditor.openDiagram', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, FsmEditorProvider.viewType);
    }),

    vscode.commands.registerCommand('fsmEditor.generateCode', (uri?: vscode.Uri | GenerateArgs, args?: GenerateArgs) => {
      // A keybinding passes its "args" as the only argument.
      if (uri && !(uri instanceof vscode.Uri)) [uri, args] = [undefined, uri];
      const active = vscode.window.activeTextEditor?.document.uri;
      const source = uri ?? provider.activeEditor?.document.uri ?? (active?.path.endsWith('.fsm') ? active : undefined);
      return generateCode(context, source, args);
    }),

    vscode.commands.registerCommand('fsmEditor.exportSvg', async () => {
      const editor = provider.activeEditor;
      if (!editor) return noEditor();
      try {
        const svg = await provider.requestSvg(editor);
        await saveExport(editor.document.uri, '.svg', { SVG: ['svg'] }, svg);
      } catch (e) {
        void vscode.window.showErrorMessage(`SVG export failed: ${e instanceof Error ? e.message : e}`);
      }
    }),
  );
}

export function deactivate() {}

function noEditor() {
  void vscode.window.showWarningMessage('Open a .fsm state machine in the FSM Editor first.');
}

async function saveExport(source: vscode.Uri, ext: string, filters: Record<string, string[]>, content: string) {
  const base = basename(source.path, extname(source.path));
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(source, '..', base + ext),
    filters,
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, encodeText(content));
  const open = await vscode.window.showInformationMessage(`Exported to ${basename(target.path)}.`, 'Open');
  if (open) await vscode.commands.executeCommand('vscode.open', target);
}
