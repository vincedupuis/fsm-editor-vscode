/**
 * The IDE tests of the extension in VS Code: run by @vscode/test-web inside the web extension host
 * (`npm run test:web`), the workspace a temporary copy of examples/ mounted as a virtual file system, and by
 * @vscode/test-electron in desktop VS Code (`npm run test:desktop`, `npm run test:install`), on a temporary copy on disk.
 *
 * Each `scenario(<id>, …)` call implements the scenario of test/scenarios.md with that id (test/unit/scenarios.test.ts
 * checks that every id is implemented here or listed as not applicable to VS Code). A failed scenario is reported and
 * the next ones still run; the run fails at the end.
 *
 * Diagnostics are published only after the webview has loaded and the provider has read the files, listed the
 * workspace machines and validated, so waiting for them exercises the whole editor pipeline.
 */
import * as vscode from 'vscode';
import { generate, initCommon, isOldFormat, readMachine } from '../../src/common';
import type { FsmEditorApi } from '../../src/extension';
import { basename, decodeText, encodeText } from '../../src/util';

const VIEW_TYPE = 'fsmEditor.stateMachine';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function waitFor<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 30000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const messages = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).map((d) => d.message);
const command = <T>(id: string, ...args: unknown[]) => vscode.commands.executeCommand<T>(id, ...args);
const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs);
const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;

const failures: string[] = [];

/**
 * The scenario `id` of test/scenarios.md. `body` returns a reason when it can't run here (it is then reported as not
 * run). A failure is logged, the dirty editors reverted, and the next scenarios run.
 */
async function scenario(id: string, body: () => Promise<string | void>): Promise<void> {
  try {
    const skipped = await body();
    console.log(skipped ? `- ${id}: not run here: ${skipped}` : `✓ ${id}`);
  } catch (e) {
    failures.push(`${id}: ${e instanceof Error ? e.message : e}`);
    console.log(`✗ ${id}: ${e instanceof Error ? e.stack ?? e.message : e}`);
    for (const tab of tabs().filter((t) => t.isDirty)) {
      const input = tab.input;
      if (input instanceof vscode.TabInputCustom) await command('vscode.openWith', input.uri, input.viewType);
      else if (input instanceof vscode.TabInputText) await vscode.window.showTextDocument(input.uri);
      else continue;
      await command('workbench.action.revertAndCloseActiveEditor');
    }
  }
}

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert(folder, 'a workspace folder is open');
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'fsm-editor');
  assert(ext, 'the extension is installed');
  // This bundle's own client of fsm-editor-common, to read the files the extension writes.
  initCommon(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ext.extensionUri, 'common', 'common.wasm')));
  await ext.activate();
  console.log('✓ activates');
  const api = ext.exports as FsmEditorApi;
  const desktop = vscode.env.uiKind === vscode.UIKind.Desktop;
  const contributes = ext.packageJSON.contributes as {
    commands: { command: string }[];
    menus: Record<string, { command: string; when?: string }[]>;
    jsonValidation: { fileMatch: string; url: string }[];
    views: Record<string, { id: string }[]>;
    viewsContainers: Record<string, { id: string }[]>;
  };

  const file = (name: string) => vscode.Uri.joinPath(folder, name);
  const same = (a: vscode.Uri, b: vscode.Uri) => a.toString() === b.toString();
  const read = async (name: string) => decodeText(await vscode.workspace.fs.readFile(file(name)));
  const write = (name: string, text: string) => vscode.workspace.fs.writeFile(file(name), encodeText(text));
  const exists = async (name: string) => {
    try {
      await vscode.workspace.fs.stat(file(name));
      return true;
    } catch {
      return false;
    }
  };
  /** The tab of `name`'s diagram. */
  const diagramTab = (name: string) => tabs().find((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === VIEW_TYPE && same(t.input.uri, file(name)));
  /** Whether the active editor is `name`'s diagram. */
  const isDiagram = (name: string) => {
    const input = activeTab()?.input;
    return input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE && same(input.uri, file(name));
  };
  const openDiagram = async (name: string) => {
    await command('vscode.openWith', file(name), VIEW_TYPE);
    await waitFor(`${name} in the diagram`, () => (isDiagram(name) && api.openModel(file(name)) ? true : undefined));
  };
  /** The active diagram drawn, `text` in it: its SVG export, asked until the webview has drawn the model. */
  const drawn = (text: string) =>
    waitFor(`the diagram drawn, ${text} in it`, async () => {
      await vscode.workspace.fs.delete(file('drawn.svg')).then(undefined, () => undefined);
      await command('fsmEditor.exportSvg', { target: file('drawn.svg') });
      const svg = (await exists('drawn.svg')) ? await read('drawn.svg') : '';
      return svg.includes(text) ? svg : undefined;
    });

  const media = await read('MediaPlayer.fsm');
  const order = await read('Order.fsm');

  // ---------------------------------------------------------------- Documents

  await scenario('open-diagram', async () => {
    // As a double-click in the explorer: the default editor.
    await command('vscode.open', file('MediaPlayer.fsm'));
    await waitFor('MediaPlayer.fsm in the diagram', () => (isDiagram('MediaPlayer.fsm') ? true : undefined));
    await drawn('Stopped');
    assert(!activeTab()?.isDirty, 'the document is not marked changed');
    await command('workbench.action.closeAllEditors');
  });

  await scenario('open-as-text-and-back', async () => {
    await openDiagram('Payment.fsm');
    await command('fsmEditor.openAsText');
    await waitFor('Payment.fsm in a text editor', () => (vscode.window.activeTextEditor && same(vscode.window.activeTextEditor.document.uri, file('Payment.fsm')) ? true : undefined));
    await command('fsmEditor.openDiagram');
    await waitFor('Payment.fsm in the diagram again', () => (isDiagram('Payment.fsm') ? true : undefined));
    await command('workbench.action.closeAllEditors');
  });

  await scenario('text-editor-json', async () => {
    for (const name of ['MediaPlayer.fsm', 'MediaPlayer.fsm.layout']) {
      const doc = await vscode.workspace.openTextDocument(file(name));
      assert(doc.languageId === 'json', `${name} is JSON (${doc.languageId})`);
    }
    // The schemas contributed are the ones of common/: fsm-cli's for the model, fsm-editor-common's for the layout.
    const url = (match: string) => contributes.jsonValidation.find((j) => j.fileMatch === match)?.url;
    assert(url('*.fsm') === './common/schemas/fsm.schema.json', `*.fsm has the model schema: ${url('*.fsm')}`);
    assert(url('*.fsm.layout') === './common/schemas/fsm-layout.schema.json', `*.fsm.layout has the layout schema: ${url('*.fsm.layout')}`);
    const schema = async (name: string) => JSON.parse(decodeText(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ext.extensionUri, 'common/schemas', name))));
    const model = await schema('fsm.schema.json');
    const layout = await schema('fsm-layout.schema.json');
    assert(String(model.$id).includes('/fsm-cli/') && String(model.title).includes('.fsm'), `the model schema is fsm-cli's: ${model.$id}`);
    assert(String(layout.title).includes('.fsm.layout'), `the layout schema is the layout file's: ${layout.title}`);
    // Applied by the text editor: a property neither schema has, and no name and type, which only the model schema requires.
    const bad = '{\n  "version": 1,\n  "bogus": 1\n}\n';
    await write('Schema.fsm', bad);
    await write('Schema.fsm.layout', bad);
    for (const name of ['Schema.fsm', 'Schema.fsm.layout']) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file(name)), { preview: false });
    const modelProblems = await waitFor("the model schema's problems on Schema.fsm", () => {
      const list = messages(file('Schema.fsm'));
      return list.some((m) => m.includes('bogus')) && list.some((m) => /missing/i.test(m) && m.includes('name')) ? list : undefined;
    });
    const layoutProblems = await waitFor("the layout schema's problems on Schema.fsm.layout", () => {
      const list = messages(file('Schema.fsm.layout'));
      return list.some((m) => m.includes('bogus')) ? list : undefined;
    });
    assert(!layoutProblems.some((m) => /missing/i.test(m)), `the layout file has the layout schema, not the model's: ${layoutProblems.join(' | ')}`);
    console.log(`  model: ${modelProblems.join(' | ')}; layout: ${layoutProblems.join(' | ')}`);
    await command('workbench.action.closeAllEditors');
  });

  // Broken.fsm: MediaPlayer.fsm with the guard `count > 0` on Stopped -play-> Playing.
  const play = '{ "type": "external", "trigger": "play", "target": "Playing" }';
  let brokenText: vscode.TextDocument | undefined;

  await scenario('validation-at-line', async () => {
    assert(media.includes(play), 'Stopped -play-> Playing is in the file');
    await write('Broken.fsm', media.replace(play, '{ "type": "external", "trigger": "play", "guard": "count > 0", "target": "Playing" }'));
    await write('Broken.fsm.layout', await read('MediaPlayer.fsm.layout'));
    await openDiagram('Broken.fsm');
    const guardError = await waitFor('the guard error diagnostic', () => vscode.languages.getDiagnostics(file('Broken.fsm')).find((d) => d.message.startsWith('Guard:')));
    assert(guardError.message.includes('no variables'), `the guard error explains the rule: ${guardError.message}`);
    const line = media.split('\n').findIndex((l) => l.includes(play));
    assert(guardError.range.start.line === line, `the diagnostic is on the transition's line (${guardError.range.start.line}, not ${line})`);
  });

  await scenario('text-edit-reaches-diagram', async () => {
    await openDiagram('Broken.fsm');
    const doc = (brokenText = await vscode.workspace.openTextDocument(file('Broken.fsm')));
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
    const at = doc.getText().indexOf('count > 0');
    assert(at >= 0, 'the guard is in the text');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + 'count > 0'.length)), 'isReady()');
    assert(await vscode.workspace.applyEdit(edit), 'the edit applies');
    await waitFor('the guard error to clear', () => (messages(file('Broken.fsm')).some((m) => m.startsWith('Guard:')) ? undefined : true));
    await doc.save();
    const saved = readMachine(await read('Broken.fsm'), undefined);
    assert(!('problems' in saved) && saved.model.transitions.some((t) => t.guard === 'isReady()'), 'the saved file holds isReady()');
  });

  await scenario('text-closed-unsaved', async () => {
    const doc = brokenText ?? (await vscode.workspace.openTextDocument(file('Broken.fsm')));
    const at = doc.getText().indexOf('isReady()');
    assert(at >= 0, 'the saved guard is in the text');
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + 'isReady()'.length)), 'count > 1');
    assert(await vscode.workspace.applyEdit(edit), 'the edit applies');
    await waitFor('the guard error of the unsaved text', () => (messages(file('Broken.fsm')).some((m) => m.startsWith('Guard:')) ? true : undefined));
    await vscode.window.showTextDocument(doc);
    await command('workbench.action.revertAndCloseActiveEditor');
    await waitFor('the diagram back to the file', () => (messages(file('Broken.fsm')).some((m) => m.startsWith('Guard:')) ? undefined : true));
    await command('workbench.action.closeAllEditors');
  });

  // Old.fsm: an initial pseudostate, a state Idle, an unnamed state (XMI).
  await scenario('old-file-opens-unchanged', async () => {
    await write('Old.fsm', OLD);
    await openDiagram('Old.fsm');
    await settle(2000);
    assert(!diagramTab('Old.fsm')?.isDirty, 'opening an old file does not mark it changed');
    assert((await read('Old.fsm')) === OLD, 'the file is unchanged on disk');
    assert(!(await exists('Old.fsm.layout')), 'no layout file is written');
    const text = await vscode.workspace.openTextDocument(file('Old.fsm'));
    await waitFor('the old file as XML', () => (text.languageId === 'xml' ? true : undefined));
  });

  await scenario('old-file-saved-converts', async () => {
    await openDiagram('Old.fsm');
    await command('workbench.action.files.save');
    await waitFor('the layout file written', async () => ((await exists('Old.fsm.layout')) ? true : undefined), 20000);
    const now = readMachine(await read('Old.fsm'), await read('Old.fsm.layout'));
    assert(!('problems' in now), 'the model file is in the current format');
    const names = now.model.vertices.map((v) => v.name).join(',');
    assert(names === ',Idle,state1*', `with the generated name of the unnamed state: ${names}`);
    await waitFor('the converted file as JSON again', () => (vscode.workspace.textDocuments.find((d) => same(d.uri, file('Old.fsm')))?.languageId === 'json' ? true : undefined));
    await command('workbench.action.closeAllEditors');
  });

  await scenario('layout-follows-rename', async () => {
    await write('Rename.fsm', await read('Payment.fsm'));
    await write('Rename.fsm.layout', await read('Payment.fsm.layout'));
    const rename = new vscode.WorkspaceEdit();
    rename.renameFile(file('Rename.fsm'), file('Renamed.fsm'));
    assert(await vscode.workspace.applyEdit(rename), 'the rename applies');
    await waitFor('the layout file renamed', async () => ((await exists('Renamed.fsm.layout')) && !(await exists('Rename.fsm.layout')) ? true : undefined), 10000);
    await vscode.workspace.fs.createDirectory(file('moved'));
    const move = new vscode.WorkspaceEdit();
    move.renameFile(file('Renamed.fsm'), file('moved/Renamed.fsm'));
    assert(await vscode.workspace.applyEdit(move), 'the move applies');
    await waitFor('the layout file moved', async () => ((await exists('moved/Renamed.fsm.layout')) && !(await exists('Renamed.fsm.layout')) ? true : undefined), 10000);
  });

  await scenario('new-state-machine', async () => {
    // File › New File… › State Machine.
    assert(contributes.menus['file/newFile']?.some((m) => m.command === 'fsmEditor.newUntitled'), 'State Machine is in File › New File…');
    await command('fsmEditor.newUntitled');
    const tab = await waitFor('the untitled diagram', () => {
      const input = activeTab()?.input;
      return input instanceof vscode.TabInputCustom && input.uri.scheme === 'untitled' ? input : undefined;
    });
    assert(tab.viewType === VIEW_TYPE && tab.uri.path.endsWith('/StateMachine.fsm'), 'it opens in the diagram editor');
    const model = await waitFor('the new machine', () => api.openModel(tab.uri));
    assert(model.name === 'StateMachine' && model.vertices.some((v) => v.type === 'initial') && model.vertices.some((v) => v.type === 'state' && v.name === 'Idle'), `the template's machine: ${model.vertices.map((v) => v.name || v.type)}`);
    await command('workbench.action.revertAndCloseActiveEditor');
  });

  // ---------------------------------------------------------------- Problems

  await scenario('valid-machines-no-problems', async () => {
    const examples: [string, string][] = [['MediaPlayer.fsm', 'Stopped'], ['Order.fsm', 'Cart'], ['Payment.fsm', 'Authorizing']];
    for (const [name, text] of examples) {
      await openDiagram(name);
      await drawn(text);
    }
    await settle(1500);
    const problems = examples.flatMap(([name]) => messages(file(name)).map((m) => `${name}: ${m}`));
    assert(!problems.length, `the examples report no problems: ${problems.join(' | ')}`);
    await command('workbench.action.closeAllEditors');
  });

  await scenario('submachine-references-resolve', async () => {
    // A copy of Order.fsm with an unreachable state, whose problem says the validation has run.
    await write('OrderCheck.fsm', order.replace('"elements": [', '"elements": [\n    { "name": "Orphan", "type": "state" },'));
    await openDiagram('OrderCheck.fsm');
    const list = await waitFor('the problems of OrderCheck.fsm', () => {
      const m = messages(file('OrderCheck.fsm'));
      return m.some((x) => x.includes('Orphan')) ? m : undefined;
    });
    const references = list.filter((m) => /not found|no entry or exit point|referenced as|Payment/.test(m));
    assert(!references.length, `the references to Payment.fsm and its connection points resolve: ${references.join(' | ')}`);
    await command('workbench.action.closeAllEditors');
  });

  // The diagram follows a submachine state on Alt+double-click, or with its properties' Open button: both send
  // `openSubmachine` with the state's submachine, sent here as the webview does.
  const follow = async (name: string) => {
    const state = api.openModel(file(name))?.vertices.find((v) => v.type === 'state' && v.name === 'Payment' && v.submachine);
    assert(state?.submachine, `${name} has the submachine state Payment`);
    const refused = await api.message(file(name), { type: 'openSubmachine', href: state.submachine });
    assert(!refused, `the diagram's message is handled: ${refused}`);
    return state.submachine;
  };

  await scenario('follow-reference', async () => {
    await openDiagram('Order.fsm');
    await follow('Order.fsm');
    await waitFor('Payment.fsm in the diagram', () => (isDiagram('Payment.fsm') ? true : undefined));
    await command('workbench.action.closeAllEditors');
  });

  await scenario('missing-submachine', async () => {
    assert(order.includes('"submachine": "Payment.fsm"'), 'Order.fsm references Payment.fsm');
    await write('MissingRef.fsm', order.replace('"submachine": "Payment.fsm"', '"submachine": "Nowhere.fsm"'));
    await openDiagram('MissingRef.fsm');
    const before = api.errors().length;
    const href = await follow('MissingRef.fsm');
    assert(href === 'Nowhere.fsm', `the state references Nowhere.fsm: ${href}`);
    const said = await waitFor('the error shown', () => api.errors().slice(before).find((m) => m.includes('Nowhere.fsm')), 5000);
    assert(/does not exist/.test(said), `it says the file doesn't exist: ${said}`);
    await settle(500);
    assert(isDiagram('MissingRef.fsm'), 'the diagram stays active');
    assert(!tabs().some((t) => t.label.startsWith('Nowhere')), 'nothing is opened');
    await command('workbench.action.closeAllEditors');
  });

  // ---------------------------------------------------------------- Editing through the IDE

  // VS Code sends its Select All, Copy, Cut and Paste (Edit menu, keys) to a focused webview. In VS Code for the Web they
  // don't reach the diagram (tried: the clipboard unchanged after Copy, nothing pasted), so these run on desktop only.
  const noClipboard = "VS Code for the Web: the Copy and Paste commands VS Code sends to a webview (the browser's execCommand) don't reach the diagram";
  const empty = JSON.stringify({ version: 1, name: 'Empty', type: 'behavioral', elements: [] }, null, 2) + '\n';
  const emptyLayout = '{\n  "version": 1\n}\n';
  let pasted = false;
  const editCommand = async (id: string) => {
    await command('workbench.action.focusActiveEditorGroup');
    await settle(300);
    await command(id);
  };
  /** An item of the context menu of `name`'s diagram (VS Code sends its own Copy and Paste to a webview as the browser's
   * execCommand, which Chromium ignores without a real key press or click: the menu's items take the extension's clipboard). */
  const menuItem = (name: string, label: string) => {
    const refused = api.contextMenu(file(name), label);
    assert(!refused, `the context menu's ${label}: ${refused}`);
  };

  await scenario('ide-edit-commands', async () => {
    if (!desktop) return noClipboard;
    await write('Empty.fsm', empty);
    await write('Empty.fsm.layout', emptyLayout);
    await openDiagram('Order.fsm');
    await drawn('Cart');
    await vscode.env.clipboard.writeText('');
    await editCommand('editor.action.selectAll');
    menuItem('Order.fsm', 'Copy');
    const copied = await waitFor('the elements copied', async () => {
      const text = await vscode.env.clipboard.readText();
      return text.includes('"fsmClipboard"') ? text : undefined;
    }, 5000).catch(async (e) => {
      throw new Error(`${e.message}; the clipboard holds ${JSON.stringify((await vscode.env.clipboard.readText()).slice(0, 120))}`);
    });
    assert(copied.includes('"Cart"'), 'Cart is copied');
    await openDiagram('Empty.fsm');
    await settle(1000);
    menuItem('Empty.fsm', 'Paste');
    await waitFor("Order's elements pasted into Empty", () => (api.openModel(file('Empty.fsm'))?.vertices.some((v) => v.name === 'Cart') ? true : undefined), 5000);
    pasted = true;
    assert((await read('Order.fsm')) === order && !diagramTab('Order.fsm')?.isDirty, 'Order.fsm is unchanged');
    // Cut, of the selection (everything: the test can't select one state in the webview). Delete is the diagram's
    // own key: VS Code has no Delete command for a webview.
    await openDiagram('Order.fsm');
    menuItem('Order.fsm', 'Cut');
    await waitFor('Cart cut from Order', () => (api.openModel(file('Order.fsm'))?.vertices.some((v) => v.name === 'Cart') ? undefined : true), 5000);
    await command('workbench.action.files.revert');
    await waitFor('Order reverted', () => (diagramTab('Order.fsm')?.isDirty === false && api.openModel(file('Order.fsm'))?.vertices.some((v) => v.name === 'Cart') ? true : undefined));
  });

  await scenario('undo-redo-save-both-files', async () => {
    if (!desktop) return noClipboard;
    assert(pasted, 'after the paste of ide-edit-commands');
    const hasCart = () => !!api.openModel(file('Empty.fsm'))?.vertices.some((v) => v.name === 'Cart');
    await openDiagram('Empty.fsm');
    await command('undo');
    await waitFor('the paste undone, not marked changed', () => (!hasCart() && diagramTab('Empty.fsm')?.isDirty === false ? true : undefined), 5000);
    await command('redo');
    await waitFor('the paste redone, marked changed', () => (hasCart() && diagramTab('Empty.fsm')?.isDirty ? true : undefined), 5000);
    await command('workbench.action.files.save');
    await waitFor('both files written', async () => ((await read('Empty.fsm')).includes('"Cart"') && (await read('Empty.fsm.layout')) !== emptyLayout ? true : undefined), 10000);
    assert(!diagramTab('Empty.fsm')?.isDirty, 'saved');
    await command('workbench.action.closeAllEditors');
  });

  await scenario('move-changes-layout-only', async () => {
    const layout = await read('MediaPlayer.fsm.layout');
    await openDiagram('MediaPlayer.fsm');
    const model = api.openModel(file('MediaPlayer.fsm'))!;
    const off = model.vertices.find((v) => v.name === 'Off');
    assert(off, 'MediaPlayer has Off');
    off.x += 40;
    const refused = api.edit(file('MediaPlayer.fsm'), JSON.stringify(model));
    assert(!refused, `the move is taken: ${refused}`);
    await waitFor('the diagram marked changed', () => (diagramTab('MediaPlayer.fsm')?.isDirty ? true : undefined));
    await command('workbench.action.files.save');
    await waitFor('the layout file written', async () => ((await read('MediaPlayer.fsm.layout')) !== layout ? true : undefined), 10000);
    assert((await read('MediaPlayer.fsm')) === media, 'MediaPlayer.fsm is unchanged');
    await command('workbench.action.closeAllEditors');
  });

  await scenario('hot-exit', async () => {
    // An unsaved change backed up and the document reopened from its backup, as VS Code does at exit and at the next
    // start.
    await openDiagram('MediaPlayer.fsm');
    const model = api.openModel(file('MediaPlayer.fsm'))!;
    model.vertices.find((v) => v.name === 'Off')!.name = 'Standby';
    const refused = api.edit(file('MediaPlayer.fsm'), JSON.stringify(model));
    assert(!refused, `the edit is taken: ${refused}`);
    await waitFor('the diagram marked changed', () => (diagramTab('MediaPlayer.fsm')?.isDirty ? true : undefined));
    const restored = await api.backupRoundTrip(file('MediaPlayer.fsm'), file('MediaPlayer.backup'));
    assert(restored?.vertices.some((v) => v.name === 'Standby'), 'the reopened document has the unsaved change');
    assert(!(await exists('MediaPlayer.backup')), 'the backup is deleted once used');
    assert((await read('MediaPlayer.fsm')) === media, 'the file on disk is unchanged');
    await command('workbench.action.revertAndCloseActiveEditor');
  });

  // ---------------------------------------------------------------- Commands and tool windows

  await scenario('commands-registered', async () => {
    const contributed = new Set(contributes.commands.map((c) => c.command));
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const [menu, items] of Object.entries(contributes.menus)) {
      for (const item of items) assert(contributed.has(item.command), `${menu} names ${item.command}, a contributed command`);
    }
    for (const c of contributed) assert(registered.has(c), `${c} is registered`);
    // The scenario's commands: contributed ones are in the Command Palette (unless hidden there) and in their menus;
    // Show Trace Player is the focus command of the Trace Player view, in the panel.
    const named: Record<string, string> = {
      'New State Machine': 'fsmEditor.new',
      'Generate Code': 'fsmEditor.generateCode',
      'Export as SVG': 'fsmEditor.exportSvg',
      'Export as PNG': 'fsmEditor.exportPng',
      'Open as Text': 'fsmEditor.openAsText',
      'Open in Diagram': 'fsmEditor.openDiagram',
      'Open Trace': 'fsmEditor.openTrace',
      'Show Trace Player': 'fsmEditor.tracePlayer.focus',
      'Compare as Diagrams': 'fsmEditor.compareAsDiagrams',
    };
    for (const [title, id] of Object.entries(named)) {
      assert(registered.has(id), `${title} (${id}) is registered`);
      if (id === 'fsmEditor.tracePlayer.focus') continue;
      assert(contributed.has(id), `${title} (${id}) is contributed`);
      assert(!contributes.menus.commandPalette?.some((m) => m.command === id && m.when === 'false'), `${title} is in the Command Palette`);
    }
    const menus = (id: string) => Object.entries(contributes.menus).filter(([m, items]) => m !== 'commandPalette' && items.some((i) => i.command === id)).map(([m]) => m);
    for (const [id, menu] of [['fsmEditor.new', 'explorer/context'], ['fsmEditor.generateCode', 'explorer/context'], ['fsmEditor.openAsText', 'editor/title'], ['fsmEditor.openDiagram', 'editor/title'], ['fsmEditor.compareAsDiagrams', 'editor/title']]) {
      assert(menus(id).includes(menu), `${id} is in ${menu}: ${menus(id)}`);
    }
    const panel = contributes.viewsContainers.panel?.map((c) => c.id) ?? [];
    assert(panel.some((c) => contributes.views[c]?.some((v) => v.id === 'fsmEditor.tracePlayer')), 'the Trace Player is a view of the panel');
    console.log(`  ${contributed.size} commands, ${Object.keys(contributes.menus).length} menus`);
  });

  await scenario('export-svg-png', async () => {
    // To a given file: the save dialog aside. The PNG is twice the SVG's size.
    await openDiagram('MediaPlayer.fsm');
    await settle(500);
    await command('fsmEditor.exportSvg', { target: file('export.svg') });
    const svg = await read('export.svg');
    assert(svg.startsWith('<?xml') && svg.includes('<svg ') && svg.includes('Stopped'), 'an SVG of the diagram');
    await command('fsmEditor.exportPng', { target: file('export.png') });
    const png = await vscode.workspace.fs.readFile(file('export.png'));
    const be = (i: number) => ((png[i] << 24) | (png[i + 1] << 16) | (png[i + 2] << 8) | png[i + 3]) >>> 0;
    const [sw, sh] = [/<svg [^>]*width="([\d.]+)"/, /<svg [^>]*height="([\d.]+)"/].map((r) => Number(r.exec(svg)![1]));
    assert(String.fromCharCode(png[1], png[2], png[3]) === 'PNG', 'a PNG');
    assert(be(16) === Math.round(sw * 2) && be(20) === Math.round(sh * 2), `the PNG is ${be(16)}×${be(20)}, the SVG ${sw}×${sh}`);
    await command('workbench.action.closeAllEditors');
  });

  const out = file('generated');

  await scenario('codegen-bundled', async () => {
    // fsm-cli's WebAssembly module, through workspace.fs: the submachine is read, not generated.
    const written = await command<vscode.Uri[]>('fsmEditor.generateCode', file('Order.fsm'), { template: vscode.Uri.joinPath(ext.extensionUri, 'common/templates/ts.jinja'), out });
    const names = written.map((u) => u.path.slice(u.path.lastIndexOf('/') + 1)).sort();
    assert(names.includes('Order.ts') && !names.includes('Payment.ts'), `generates Order only: ${names.join(', ')}`);
    assert((await read('generated/Order.ts')).includes('export class Order'), 'the generated class is written');
  });

  await scenario('codegen-workspace-template', async () => {
    await write('states.jinja', '{% filter file(machine.name ~ ".txt") %}{{ machine.name }}: {{ submachines | map(attribute="name") | join(", ") }}{% endfilter %}');
    const written = await command<vscode.Uri[]>('fsmEditor.generateCode', file('Order.fsm'), { template: file('states.jinja'), out });
    const text = await read('generated/Order.txt');
    assert(written.length === 1 && text === 'Order: Payment', `the workspace template's output: ${text}`);
  });

  await scenario('codegen-refused-template', async () => {
    await write('states.hbs', '{{machine.name}}');
    // fsm-cli's message, from this bundle's own client of the module.
    const refusal = generate({ files: {}, generate: [], template: '', templateName: 'states.hbs' }).error ?? '';
    assert(refusal?.includes('Handlebars'), `fsm-cli refuses a .hbs template: ${refusal}`);
    const before = api.errors().length;
    const written = await command<vscode.Uri[]>('fsmEditor.generateCode', file('Order.fsm'), { template: file('states.hbs'), out });
    assert(!written.length, 'nothing is written');
    const shown = api.errors().slice(before);
    assert(shown.some((m) => m.endsWith(refusal)), `fsm-cli's message is shown as it is: ${shown.join(' | ')}`);
  });

  await scenario('compare-as-diagrams', async () => {
    // VS Code opens a diff of two .fsm files as text (JSON): Compare as Diagrams opens them as a diagram diff.
    await write('MediaPlayer2.fsm', media.replace('"entry": "rewind()"', '"entry": "rewind(); beep()"'));
    await write('MediaPlayer2.fsm.layout', await read('MediaPlayer.fsm.layout'));
    await command('vscode.diff', file('MediaPlayer.fsm'), file('MediaPlayer2.fsm'), 'MediaPlayer ↔ MediaPlayer2');
    const input = await waitFor('the text diff', () => activeTab()?.input ?? undefined);
    assert(input instanceof vscode.TabInputTextDiff, 'VS Code opens a diff of .fsm files as text');
    await command('fsmEditor.compareAsDiagrams');
    const diff = await waitFor('a diagram diff', () => api.sessionSummary().find((x) => x.startsWith('diff ')));
    assert(diff.startsWith('diff MediaPlayer.fsm') && diff.includes('-> MediaPlayer2.fsm'), `the two versions are linked, the older first: ${diff}`);
    const changes = Number(/, (\d+) changes$/.exec(diff)?.[1]);
    assert(changes === 1, `the change is marked: ${diff}`);
    await command('workbench.action.closeAllEditors');
  });

  await scenario('merge-conflicts', async () => {
    // Payment.fsm with one conflicting change: the diagram merge (the result, with the incoming and current sides).
    const pay = await read('Payment.fsm');
    const captured = '      "entry": "capture()",\n';
    assert(pay.includes(captured), 'Captured has its entry');
    await write('Conflict.fsm', pay.replace(captured, '<<<<<<< HEAD\n      "entry": "capture(); log()",\n=======\n      "entry": "settle()",\n>>>>>>> feature\n'));
    await write('Conflict.fsm.layout', await read('Payment.fsm.layout'));
    await command('vscode.openWith', file('Conflict.fsm'), VIEW_TYPE);
    const merge = await waitFor('the diagram merge with its three panes', () => api.sessionSummary().find((x) => x.startsWith('merge ') && x.endsWith('current,incoming,result')));
    assert(merge.startsWith('merge 1 conflicts'), `one conflict: ${merge}`);
    assert(diagramTab('Conflict.fsm') && !diagramTab('Conflict.fsm')!.isDirty, 'opening a conflicted file does not mark it changed');
    await command('workbench.action.closeAllEditors');
  });

  await scenario('trace-player', async () => {
    const trace = () => api.traceSummary();
    // Show Trace Player: the focus command of its view.
    await command('fsmEditor.tracePlayer.focus');
    await waitFor('the Trace Player shown', () => (trace().shown ? true : undefined));
    // demo.log (as Open Trace… with files), its records on MediaPlayer's diagram. Earlier scenarios left copies of
    // MediaPlayer and Order (Broken.fsm, …), machines of the same name, any of which the player may show the records
    // on: they go first.
    await command('workbench.action.closeAllEditors');
    for (const uri of await vscode.workspace.findFiles('**/*.fsm')) {
      const name = basename(uri.path);
      if (name === 'MediaPlayer.fsm' || name === 'Order.fsm' || name === 'Payment.fsm') continue;
      if (/"name": "(MediaPlayer|Order)"/.test(decodeText(await vscode.workspace.fs.readFile(uri)))) {
        await vscode.workspace.fs.delete(uri);
        await vscode.workspace.fs.delete(uri.with({ path: uri.path + '.layout' })).then(undefined, () => undefined);
      }
    }
    await openDiagram('MediaPlayer.fsm');
    const lines = (await read('demo.log')).split('\n').filter((l) => l.trim()).length;
    await command('fsmEditor.openTrace', file('demo.log'));
    const demo = await waitFor('demo.log read', () => trace().traces.find((t) => t.name === 'demo.log' && t.records > 0));
    assert(!demo.error && demo.records === lines, `its ${lines} records read: ${JSON.stringify(demo)}`);
    const onMedia = () => trace().active[file('MediaPlayer.fsm').toString()]?.some((a) => a.length);
    await waitFor("the records shown on MediaPlayer's diagram", () => (onMedia() ? true : undefined)).catch((e) => {
      throw new Error(`${e.message}: ${JSON.stringify(trace())}`);
    });
    if (trace().live) {
      // Followed where logs can be (desktop): records appended to it are shown.
      const more = 'fsm MediaPlayer exit Off Off\nfsm MediaPlayer transition Off#1 powerOn -> On\nfsm MediaPlayer enter On On\n';
      const text = await read('demo.log');
      await write('demo.log', text + (text.endsWith('\n') ? '' : '\n') + more);
      await waitFor('the records appended', () => (trace().traces.find((t) => t.name === 'demo.log')?.records === lines + 3 ? true : undefined), 20000);
      await waitFor('On active, at the last record', () => (trace().active[file('MediaPlayer.fsm').toString()]?.some((a) => a.some((s) => s.includes('On'))) && trace().cursor === trace().count - 1 ? true : undefined));
      console.log('  follows a log as it grows');
    }
    // A log in a format of fsmEditor.trace.formats.
    await vscode.workspace.getConfiguration('fsmEditor').update('trace.formats', [{ name: 'plain', machine: 'MediaPlayer', rules: [{ kind: 'enter', match: '^ENTER (?<name>\\w+)$' }] }], vscode.ConfigurationTarget.Workspace);
    await write('plain.log', 'ENTER Off\nENTER On\n');
    await command('fsmEditor.openTrace', file('plain.log'));
    const plain = await waitFor('the log in the configured format', () => trace().traces.find((t) => t.name === 'plain.log' && t.records === 2));
    assert(plain.format === 'plain' && !plain.error, `read with the configured format: ${JSON.stringify(plain)}`);
  });

  // Let VS Code finish re-reading the saved files and close the editors, so closing the browser doesn't cancel work
  // in flight (logged as errors).
  await settle(1000);
  await command('workbench.action.closeAllEditors');
  await settle(500);
  if (failures.length) throw new Error(`${failures.length} scenario${failures.length === 1 ? '' : 's'} failed:\n${failures.join('\n')}`);
}

/** A machine in the old format: an initial pseudostate, a state Idle and an unnamed state. */
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
