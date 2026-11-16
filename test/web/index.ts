/**
 * Smoke test for the browser build, run by @vscode/test-web inside the web
 * extension host (`npm run test:web`). The workspace is a temporary copy of
 * examples/, mounted as a virtual file system.
 *
 * Diagnostics are published only after the webview has loaded and the
 * provider has read the files, listed the workspace machines and validated, so
 * waiting for them exercises the whole editor pipeline in the browser.
 */
import * as vscode from 'vscode';
import { isOldFormat, readModel } from '../../src/format';
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
  const exists = async (name: string) => {
    try {
      await vscode.workspace.fs.stat(file(name));
      return true;
    } catch {
      return false;
    }
  };

  const api = () => ext!.exports as { sessionSummary(): string[] };
  // 1. The extension activates in the web extension host.
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'fsm-editor');
  assert(ext, 'the extension is installed');
  await ext.activate();
  console.log('✓ activates in the browser extension host');

  // 2. The custom editor opens, and validation runs on a machine with a broken guard.
  const play = '{ "type": "external", "trigger": "play", "target": "Playing" }';
  const media = await read('MediaPlayer.fsm');
  assert(media.includes(play), 'Stopped -play-> Playing is in the file');
  await vscode.workspace.fs.writeFile(file('Broken.fsm'), encodeText(media.replace(play, '{ "type": "external", "trigger": "play", "guard": "count > 0", "target": "Playing" }')));
  await vscode.workspace.fs.writeFile(file('Broken.fsm.layout'), encodeText(await read('MediaPlayer.fsm.layout')));
  await vscode.commands.executeCommand('vscode.openWith', file('Broken.fsm'), VIEW_TYPE);
  const guardError = await waitFor('the guard error diagnostic', () =>
    vscode.languages.getDiagnostics(file('Broken.fsm')).find((d) => d.message.startsWith('Guard:')),
  );
  assert(guardError.message.includes('no variables'), `guard error explains the rule: ${guardError.message}`);
  assert(guardError.range.start.line === media.split('\n').findIndex((l) => l.includes(play)), `the diagnostic is on the transition's line (${guardError.range.start.line})`);
  console.log('✓ opens the diagram editor and reports the guard error, at its line');

  // 3. The model edited as text is picked up: fixing the guard clears the error.
  const doc = await vscode.workspace.openTextDocument(file('Broken.fsm'));
  assert(doc.languageId === 'json', `a .fsm file is JSON (${doc.languageId})`);
  const text = doc.getText();
  const at = text.indexOf('count > 0');
  assert(at >= 0, 'the guard is in the text');
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + 'count > 0'.length)), 'isReady()');
  assert(await vscode.workspace.applyEdit(edit), 'the edit applies');
  await waitFor('the guard error to clear', () =>
    messages(file('Broken.fsm')).some((m) => m.startsWith('Guard:')) ? undefined : true,
  );
  await doc.save();
  const saved = readModel(await read('Broken.fsm'));
  assert(!('problems' in saved) && saved.model.transitions.some((t) => t.guard === 'isReady()'), 'the saved file has the fixed guard');
  console.log('✓ follows the model file edited as text, and its save');

  // 3b. Its text editor closed without saving: the diagram goes back to the file.
  const again = new vscode.WorkspaceEdit();
  const at2 = doc.getText().indexOf('isReady()');
  again.replace(doc.uri, new vscode.Range(doc.positionAt(at2), doc.positionAt(at2 + 'isReady()'.length)), 'count > 1');
  assert(await vscode.workspace.applyEdit(again), 'the second edit applies');
  await waitFor('the guard error of the unsaved text', () => (messages(file('Broken.fsm')).some((m) => m.startsWith('Guard:')) ? true : undefined));
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  await waitFor('the diagram back to the file', () => (messages(file('Broken.fsm')).some((m) => m.startsWith('Guard:')) ? undefined : true));
  console.log('✓ follows the file again when its unsaved text is closed');

  // 4. Submachine references resolve across files in the virtual file system.
  const order = await read('Order.fsm');
  await vscode.workspace.fs.writeFile(file('OrderCheck.fsm'), encodeText(order.replace('"elements": [', '"elements": [\n    { "name": "Orphan", "type": "state" },')));
  await vscode.commands.executeCommand('vscode.openWith', file('OrderCheck.fsm'), VIEW_TYPE);
  const orderMessages = await waitFor('diagnostics for OrderCheck.fsm', () => {
    const list = messages(file('OrderCheck.fsm'));
    return list.some((m) => m.includes('Orphan')) ? list : undefined;
  });
  const referenceProblems = orderMessages.filter((m) => /not found|no entry or exit point|referenced as/.test(m));
  assert(!referenceProblems.length, `submachine references resolve: ${referenceProblems.join(' | ')}`);
  console.log('✓ resolves the Payment submachine and its connection point references');

  // 5. An old file (XMI) opens converted, without being marked changed (auto save doesn't convert it); saving writes
  // the model and layout files in the new format.
  await vscode.workspace.fs.writeFile(file('Old.fsm'), encodeText(OLD));
  await vscode.commands.executeCommand('vscode.openWith', file('Old.fsm'), VIEW_TYPE);
  await waitFor('the old file open in the diagram', () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom && input.uri.toString() === file('Old.fsm').toString() ? true : undefined;
  });
  await new Promise((r) => setTimeout(r, 2000));
  assert(!vscode.window.tabGroups.activeTabGroup.activeTab?.isDirty, 'opening an old file does not mark it changed');
  assert(isOldFormat(await read('Old.fsm')) && !(await exists('Old.fsm.layout')), 'opening changes nothing on disk');
  const oldText = await vscode.workspace.openTextDocument(file('Old.fsm'));
  await waitFor('the old file as XML', () => (oldText.languageId === 'xml' ? true : undefined));
  await vscode.commands.executeCommand('vscode.openWith', file('Old.fsm'), VIEW_TYPE);
  await vscode.commands.executeCommand('workbench.action.files.save');
  for (let i = 0; i < 100 && !(await exists('Old.fsm.layout')); i++) await new Promise((r) => setTimeout(r, 200));
  assert(await exists('Old.fsm.layout'), 'saving creates the layout file');
  const now = readModel(await read('Old.fsm'));
  assert(!('problems' in now), 'the model file is in the new format');
  assert(now.model.vertices.map((v) => v.name).join(',') === ',Idle,state1*', `with a generated name: ${now.model.vertices.map((v) => v.name)}`);
  await waitFor('the converted file as JSON again', () =>
    vscode.workspace.textDocuments.find((d) => d.uri.toString() === file('Old.fsm').toString())?.languageId === 'json' ? true : undefined,
  );
  console.log('✓ converts an old file when it is saved');

  // 6. Code generation runs in the browser (fsm-cli's WebAssembly module, workspace.fs); the submachine is read
  // but not generated.
  const out = file('generated');
  const written: vscode.Uri[] = await vscode.commands.executeCommand('fsmEditor.generateCode', file('Order.fsm'), {
    template: vscode.Uri.joinPath(ext.extensionUri, 'fsm/templates/ts.jinja'),
    out,
  });
  const names = written.map((u) => u.path.slice(u.path.lastIndexOf('/') + 1)).sort();
  assert(names.includes('Order.ts') && !names.includes('Payment.ts'), `generates Order only: ${names.join(', ')}`);
  assert((await read('generated/Order.ts')).includes('export class Order'), 'the generated class is written');
  console.log('✓ generates code from a bundled template');

  // A template of the workspace, which sees the submachine.
  await vscode.workspace.fs.writeFile(
    file('states.jinja'),
    encodeText('{% filter file(machine.name ~ ".txt") %}{{ machine.name }}: {{ submachines | map(attribute="name") | join(", ") }}{% endfilter %}'),
  );
  const custom: vscode.Uri[] = await vscode.commands.executeCommand('fsmEditor.generateCode', file('Order.fsm'), { template: file('states.jinja'), out });
  assert(custom.length === 1 && (await read('generated/Order.txt')) === 'Order: Payment', `custom template output: ${await read('generated/Order.txt')}`);
  console.log('✓ generates code from a workspace template');

  // 7. VS Code's diff editor shows two machines as text (JSON): Compare as Diagrams opens them as a diagram diff.
  await vscode.workspace.fs.writeFile(file('MediaPlayer2.fsm'), encodeText(media.replace('"entry": "rewind()"', '"entry": "rewind(); beep()"')));
  await vscode.workspace.fs.writeFile(file('MediaPlayer2.fsm.layout'), encodeText(await read('MediaPlayer.fsm.layout')));
  await vscode.commands.executeCommand('vscode.diff', file('MediaPlayer.fsm'), file('MediaPlayer2.fsm'), 'MediaPlayer ↔ MediaPlayer2');
  const tabInput = await waitFor('the text diff', () => vscode.window.tabGroups.activeTabGroup.activeTab?.input ?? undefined);
  assert(tabInput instanceof vscode.TabInputTextDiff, 'VS Code opens a diff of .fsm files as text');
  await vscode.commands.executeCommand('fsmEditor.compareAsDiagrams');
  const diffs = await waitFor('a diagram diff', () => {
    const list = api().sessionSummary().filter((x) => x.startsWith('diff '));
    return list.length ? list : undefined;
  });
  assert(diffs.some((d) => d.startsWith('diff MediaPlayer.fsm') && d.includes('-> MediaPlayer2.fsm')), `the two versions are linked, the older first: ${diffs}`);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('✓ opens a diff of two machines as a diagram diff');

  // 8. A file with merge conflicts opens as the diagram merge: the result, with the incoming and current sides.
  const pay = await read('Payment.fsm');
  const captured = '      "entry": "capture()",\n';
  assert(pay.includes(captured), 'Captured has its entry');
  await vscode.workspace.fs.writeFile(file('Conflict.fsm'), encodeText(pay.replace(captured, '<<<<<<< HEAD\n      "entry": "capture(); log()",\n=======\n      "entry": "settle()",\n>>>>>>> feature\n')));
  await vscode.workspace.fs.writeFile(file('Conflict.fsm.layout'), encodeText(await read('Payment.fsm.layout')));
  await vscode.commands.executeCommand('vscode.openWith', file('Conflict.fsm'), VIEW_TYPE);
  const merge = await waitFor('the diagram merge with its three panes', () => api().sessionSummary().find((x) => x.startsWith('merge ') && x.endsWith('current,incoming,result')));
  assert(merge.startsWith('merge 1 conflicts'), `one conflict: ${merge}`);
  const result = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === file('Conflict.fsm').toString());
  assert(result && !result.isDirty, 'opening a conflicted file does not mark it changed');
  console.log(`✓ opens the diagram merge of a conflicted file (${merge})`);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  // 9. Renaming a machine's model file renames its layout file with it.
  await vscode.workspace.fs.writeFile(file('Rename.fsm'), encodeText(await read('Payment.fsm')));
  await vscode.workspace.fs.writeFile(file('Rename.fsm.layout'), encodeText(await read('Payment.fsm.layout')));
  const rename = new vscode.WorkspaceEdit();
  rename.renameFile(file('Rename.fsm'), file('Renamed.fsm'));
  assert(await vscode.workspace.applyEdit(rename), 'the rename applies');
  for (let i = 0; i < 50 && !(await exists('Renamed.fsm.layout')); i++) await new Promise((r) => setTimeout(r, 200));
  assert((await exists('Renamed.fsm.layout')) && !(await exists('Rename.fsm.layout')), 'the layout file follows its model file');
  console.log('✓ renames the layout file with its model file');

  // 10. File › New File… › State Machine opens an untitled machine in the diagram.
  await vscode.commands.executeCommand('fsmEditor.newUntitled');
  const tab = await waitFor('the untitled diagram', () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom && input.uri.scheme === 'untitled' ? input : undefined;
  });
  assert(tab.viewType === VIEW_TYPE && tab.uri.path.endsWith('/StateMachine.fsm'), 'it opens in the diagram editor');
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  console.log('✓ creates an untitled state machine in the diagram');

  // Let VS Code finish re-reading the saved file and close the editors, so
  // closing the browser doesn't cancel work in flight (logged as errors).
  await new Promise((r) => setTimeout(r, 1000));
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await new Promise((r) => setTimeout(r, 500));
}

/** A machine in the old format: an initial pseudostate, an unnamed state and a choice. */
const OLD = `<?xml version="1.0" encoding="UTF-8"?>
<xmi:XMI xmi:version="20131001" xmlns:xmi="http://www.omg.org/spec/XMI/20131001" xmlns:uml="http://www.omg.org/spec/UML/20161101">
  <uml:Model xmi:id="m" name="Old">
    <packagedElement xmi:type="uml:StateMachine" xmi:id="sm" name="Old">
      <region xmi:type="uml:Region" xmi:id="r">
        <subvertex xmi:type="uml:Pseudostate" xmi:id="i" kind="initial"/>
        <subvertex xmi:type="uml:State" xmi:id="a" name="Idle"/>
        <subvertex xmi:type="uml:State" xmi:id="b"/>
        <transition xmi:type="uml:Transition" xmi:id="t0" source="i" target="a"/>
        <transition xmi:type="uml:Transition" xmi:id="t1" source="a" target="b"><trigger xmi:id="g" name="go"/></transition>
      </region>
    </packagedElement>
  </uml:Model>
</xmi:XMI>
`;
