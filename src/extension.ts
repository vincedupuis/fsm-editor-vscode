import * as vscode from 'vscode';
import { GenerateArgs, generateCode } from './codegenCommand';
import { FsmEditorProvider, layoutUriOf, stateOfModel } from './fsmEditorProvider';
import { isOldFormat } from './format';
import { defaultModel } from './model';
import { TracePlayer } from './trace/player';
import { basename, encodeText, extname } from './util';

export function activate(context: vscode.ExtensionContext): { sessionSummary(): string[] } {
  const provider = new FsmEditorProvider(context);
  const player = new TracePlayer(context, provider);

  vscode.workspace.textDocuments.forEach(oldFilesAsXml);
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(oldFilesAsXml),
    // Reloaded from disk (not typed in): a file converted, or an old version checked out.
    vscode.workspace.onDidChangeTextDocument((e) => !e.document.isDirty && oldFilesAsXml(e.document)),
    vscode.window.registerCustomEditorProvider(FsmEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),

    vscode.window.registerWebviewViewProvider(TracePlayer.viewType, player, { webviewOptions: { retainContextWhenHidden: true } }),

    vscode.commands.registerCommand('fsmEditor.openTrace', (uri?: vscode.Uri, uris?: vscode.Uri[]) => player.open(uris?.length ? uris : uri ? [uri] : undefined)),

    vscode.commands.registerCommand('fsmEditor.new', async (folder?: vscode.Uri) => {
      const name = await vscode.window.showInputBox({
        prompt: 'Name of the new state machine',
        value: 'StateMachine',
        validateInput: (v) => (/^[\w-]+$/.test(v) ? undefined : 'Use letters, digits, dashes or underscores.'),
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
      const files = stateOfModel(defaultModel(name));
      await vscode.workspace.fs.writeFile(uri, encodeText(files.modelText));
      await vscode.workspace.fs.writeFile(layoutUriOf(uri), encodeText(files.layoutText!));
      await vscode.commands.executeCommand('vscode.openWith', uri, FsmEditorProvider.viewType);
    }),

    vscode.commands.registerCommand('fsmEditor.newUntitled', async () => {
      // An untitled document next to the workspace's files, so Save proposes that folder.
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const untitled = (name: string) =>
        folder ? vscode.Uri.joinPath(folder, name).with({ scheme: 'untitled' }) : vscode.Uri.from({ scheme: 'untitled', path: name });
      const taken = async (name: string) => {
        if (provider.isOpen(untitled(name))) return true;
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
      // The diagram makes the new machine (defaultModel) for an untitled file; saving asks where to put it.
      await vscode.commands.executeCommand('vscode.openWith', untitled(`${name}.fsm`), FsmEditorProvider.viewType);
    }),

    vscode.commands.registerCommand('fsmEditor.openAsText', async () => {
      const document = provider.activeEditor?.document;
      if (!document) return;
      // The text editor shows the file: the diagram's unsaved changes aren't in it.
      if (document.dirty && document.uri.scheme !== 'untitled') {
        const save = 'Save and Open as Text';
        const answer = await vscode.window.showWarningMessage(
          `${basename(document.uri.path)} has unsaved changes in the diagram, which the text editor won't show (and saving the diagram later would replace what is changed in the text). Save them first?`,
          { modal: true },
          save,
          'Open Without Saving',
        );
        if (answer === undefined) return;
        if (answer === save) {
          // workspace.save is VS Code 1.86's; before, the active editor (this diagram) is saved.
          const save = (vscode.workspace as unknown as { save?: (u: vscode.Uri) => Thenable<vscode.Uri | undefined> }).save;
          if (save) await save(document.uri);
          else await vscode.commands.executeCommand('workbench.action.files.save');
          if (document.dirty) return;
        }
      }
      await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
    }),

    // A diagram diff: from a text diff of a .fsm file (the editor title: Source Control, the timeline, Compare With…),
    // or from a changed .fsm file in Source Control (the versions Git's own diff of it shows).
    vscode.commands.registerCommand('fsmEditor.compareAsDiagrams', async (arg?: unknown) => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      const diff = input instanceof vscode.TabInputTextDiff && input.modified.path.endsWith('.fsm') ? input : undefined;
      const resource = arg instanceof vscode.Uri ? undefined : (arg as GitResource | undefined);
      const uri = arg instanceof vscode.Uri ? arg : resource?.resourceUri;
      // The active diff, when the command is about it (its title bar passes its file, the palette nothing).
      if (diff && (!uri || [diff.original.toString(), diff.modified.toString()].includes(uri.toString()))) {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        return provider.openDiagramDiff(diff.original, diff.modified);
      }
      if (uri?.path.endsWith('.fsm')) {
        if (resource?.leftUri instanceof vscode.Uri && resource.rightUri instanceof vscode.Uri) return provider.openDiagramDiff(resource.leftUri, resource.rightUri);
        const git = (ref: string) => vscode.Uri.from({ scheme: 'git', path: uri.path, query: JSON.stringify({ path: uri.fsPath, ref }) });
        // Git's resource groups: 0 merge, 1 index (staged), 2 working tree, 3 untracked.
        if (resource?.resourceGroupType === 3) {
          void vscode.window.showWarningMessage(`${basename(uri.path)} is untracked: Git has no earlier version to compare it with.`);
          return;
        }
        if (resource?.resourceGroupType === 0) return vscode.commands.executeCommand('vscode.openWith', uri, FsmEditorProvider.viewType);
        if (resource?.resourceGroupType === 1) return provider.openDiagramDiff(git('HEAD'), git(''));
        return provider.openDiagramDiff(git('~'), uri);
      }
      void vscode.window.showWarningMessage('Open the changes of a .fsm file (a diff), or pick one in Source Control, to compare it as diagrams.');
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
      return generateCode(context, source, args, (u) => provider.modelText(u));
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

    vscode.commands.registerCommand('fsmEditor.exportPng', async () => {
      const editor = provider.activeEditor;
      if (!editor) return noEditor();
      try {
        const png = await provider.requestPng(editor);
        await saveExport(editor.document.uri, '.png', { PNG: ['png'] }, decodeBase64(png));
      } catch (e) {
        void vscode.window.showErrorMessage(`PNG export failed: ${e instanceof Error ? e.message : e}`);
      }
    }),
  );
  // For the tests: the diagram diffs and merges open.
  return { sessionSummary: () => provider.sessionSummary() };
}

export function deactivate() {}


/** What Source Control passes for a changed file: Git's resource (the fields read here, when it has them). */
interface GitResource {
  resourceUri?: vscode.Uri;
  leftUri?: unknown;
  rightUri?: unknown;
  resourceGroupType?: number;
}

/**
 * An old file (XMI) opened as text is XML, not the JSON that .fsm files are now; once converted (the file saved by
 * the diagram, reloaded in the text editor), it is JSON again.
 */
function oldFilesAsXml(d: vscode.TextDocument) {
  if (!d.uri.path.endsWith('.fsm')) return;
  if (d.languageId === 'json' && isOldFormat(d.getText())) void vscode.languages.setTextDocumentLanguage(d, 'xml');
  else if (d.languageId === 'xml' && !isOldFormat(d.getText())) void vscode.languages.setTextDocumentLanguage(d, 'json');
}

function noEditor() {
  void vscode.window.showWarningMessage('Open a .fsm state machine in the FSM Editor first.');
}

/** Bytes of base64 text, in the desktop and the web extension hosts alike. */
function decodeBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function saveExport(source: vscode.Uri, ext: string, filters: Record<string, string[]>, content: string | Uint8Array) {
  const base = basename(source.path, extname(source.path));
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(source, '..', base + ext),
    filters,
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, typeof content === 'string' ? encodeText(content) : content);
  const open = await vscode.window.showInformationMessage(`Exported to ${basename(target.path)}.`, 'Open');
  if (open) await vscode.commands.executeCommand('vscode.open', target);
}
