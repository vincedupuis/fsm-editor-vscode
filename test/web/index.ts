/**
 * Smoke test for the browser build, run by @vscode/test-web inside the web
 * extension host (`npm run test:web`). The workspace is a temporary copy of
 * examples/, mounted as a virtual file system.
 *
 * Diagnostics are published only after the webview has loaded and the
 * provider has parsed the XMI, listed the workspace machines and validated, so
 * waiting for them exercises the whole editor pipeline in the browser.
 */
import * as vscode from 'vscode';
import { fromXmi, toXmi } from '../../src/xmi';
import { decodeText, encodeText } from '../../src/util';

const VIEW_TYPE = 'fsmEditor.stateMachine';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 30000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const messages = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).map((d) => d.message);

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert(folder, 'a workspace folder is open');
  const file = (name: string) => vscode.Uri.joinPath(folder, name);
  const read = async (name: string) => decodeText(await vscode.workspace.fs.readFile(file(name)));

  // 1. The extension activates in the web extension host.
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'fsm-editor');
  assert(ext, 'the extension is installed');
  await ext.activate();
  console.log('✓ activates in the browser extension host');

  // 2. The custom editor opens, and validation runs on a machine with a broken guard.
  const media = fromXmi(await read('MediaPlayer.fsm'));
  const play = media.transitions.find((t) => t.id === 't7');
  assert(play, 'transition t7 exists');
  play.guard = 'count > 0';
  await vscode.workspace.fs.writeFile(file('Broken.fsm'), encodeText(toXmi(media)));
  await vscode.commands.executeCommand('vscode.openWith', file('Broken.fsm'), VIEW_TYPE);
  const guardError = await waitFor('the guard error diagnostic', () =>
    messages(file('Broken.fsm')).find((m) => m.startsWith('Guard:')),
  );
  assert(guardError.includes('no variables'), `guard error explains the rule: ${guardError}`);
  console.log('✓ opens the diagram editor and reports the guard error');

  // 3. Editing the document is picked up: fixing the guard clears the error.
  const doc = await vscode.workspace.openTextDocument(file('Broken.fsm'));
  const text = doc.getText();
  const at = text.indexOf('count &gt; 0');
  assert(at >= 0, 'the guard is in the XMI');
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + 'count &gt; 0'.length)), 'isReady()');
  assert(await vscode.workspace.applyEdit(edit), 'the edit applies');
  await waitFor('the guard error to clear', () =>
    messages(file('Broken.fsm')).some((m) => m.startsWith('Guard:')) ? undefined : true,
  );
  console.log('✓ re-validates after a document edit');

  // 4. Submachine references resolve across files in the virtual file system.
  const order = fromXmi(await read('Order.fsm'));
  order.vertices.push({ id: 'o_orphan', type: 'state', name: 'Orphan', parent: order.regions[0].id, x: 40, y: 400, w: 120, h: 56, regions: [] });
  await vscode.workspace.fs.writeFile(file('OrderCheck.fsm'), encodeText(toXmi(order)));
  await vscode.commands.executeCommand('vscode.openWith', file('OrderCheck.fsm'), VIEW_TYPE);
  const orderMessages = await waitFor('diagnostics for OrderCheck.fsm', () => {
    const list = messages(file('OrderCheck.fsm'));
    return list.some((m) => m.includes('Orphan')) ? list : undefined;
  });
  const referenceProblems = orderMessages.filter((m) => /not found|no entry or exit point|referenced as/.test(m));
  assert(!referenceProblems.length, `submachine references resolve: ${referenceProblems.join(' | ')}`);
  console.log('✓ resolves the Payment submachine and its connection point references');

  // 5. Saving writes XMI that reads back.
  await doc.save();
  const saved = fromXmi(await read('Broken.fsm'));
  assert(saved.transitions.find((t) => t.id === 't7')?.guard === 'isReady()', 'the saved file has the fixed guard');
  console.log('✓ saves the file as XMI');

  // 6. Code generation runs in the browser (Handlebars, workspace.fs); the submachine is read but not generated.
  const out = file('generated');
  const written: vscode.Uri[] = await vscode.commands.executeCommand('fsmEditor.generateCode', file('Order.fsm'), {
    template: vscode.Uri.joinPath(ext.extensionUri, 'templates/ts.hbs'),
    out,
  });
  const names = written.map((u) => u.path.slice(u.path.lastIndexOf('/') + 1)).sort();
  assert(names.includes('Order.ts') && !names.includes('Payment.ts'), `generates Order only: ${names.join(', ')}`);
  assert((await read('generated/Order.ts')).includes('export class Order'), 'the generated class is written');
  console.log('✓ generates code from a template');

  // Let VS Code finish re-reading the saved file and close the editors, so
  // closing the browser doesn't cancel work in flight (logged as errors).
  await new Promise((r) => setTimeout(r, 1000));
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await new Promise((r) => setTimeout(r, 500));
}
