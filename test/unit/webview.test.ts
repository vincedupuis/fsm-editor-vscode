/**
 * The diagram editor's webview (media/editor.js) in headless Chromium, with a host answering as the extension does
 * (webview.ts).
 *
 * Geometry: `fixtures/geometry` holds machines (the examples, fsm-editor-common's converted edge cases, machines it
 * placed) and their SVG export, the reference for the three editions: Visual Studio's and JetBrains' Core tests
 * export the same machines and compare them with copies of these files. Text is measured with their estimate, and
 * the webview's `data-*` attributes are left out. After a geometry change here: `FSM_UPDATE_SVG=1 npm run
 * test:unit`, check the SVGs, copy the folder to the other editions and port the change until their tests pass.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { readMachine } from '../../src/common';
import { FsmModel } from '../../src/model';
import { root } from './harness';
import { Webview, closeBrowser, example } from './webview';

after(closeBrowser);

const GEOMETRY = join(root, 'test/unit/fixtures/geometry');
const CLIPBOARD = join(root, 'test/unit/fixtures/clipboard');

/** The export without the webview's own attributes (the other editions' export has none). */
const plain = (svg: string) => svg.replace(/ data-(?:id|label)="[^"]*"/g, '');

describe('webview', () => {
  it('draws the examples and exports them as SVG', async () => {
    for (const name of ['MediaPlayer', 'Order', 'Payment']) {
      const model = example(name);
      const view = await Webview.open(model);
      const svg = await view.svg();
      assert.match(svg, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg /);
      assert.equal((svg.match(/<g class="vertex /g) ?? []).length, model.vertices.length, name);
      assert.deepEqual(view.errors, []);
      await view.close();
    }
  });

  it('draws the geometry fixtures as their reference SVGs', async () => {
    const names = readdirSync(GEOMETRY).filter((f) => f.endsWith('.fsm')).map((f) => f.slice(0, -4));
    assert.ok(names.length >= 20);
    const update = !!process.env.FSM_UPDATE_SVG;
    const failed: string[] = [];
    for (const name of names) {
      const read = readMachine(readFileSync(join(GEOMETRY, `${name}.fsm`), 'utf8'), readFileSync(join(GEOMETRY, `${name}.fsm.layout`), 'utf8'));
      if ('problems' in read) throw new Error(`${name}: ${JSON.stringify(read.problems)}`);
      const view = await Webview.open(read.model, { estimateText: true });
      const svg = plain(await view.svg());
      await view.close();
      const file = join(GEOMETRY, `${name}.svg`);
      if (update) writeFileSync(file, svg);
      else if (svg !== readFileSync(file, 'utf8').replace(/\r\n/g, '\n')) failed.push(name);
    }
    assert.deepEqual(failed, [], 'drawn differently from their reference SVG (FSM_UPDATE_SVG=1 writes them)');
  });

  it('copies the clipboard JSON of the clipboard fixtures', async () => {
    // A case: a machine of the geometry fixtures, the selection (every vertex, or one vertex with what it contains)
    // and the clipboard JSON this edition copies for it, which the other editions' Core tests copy too.
    const update = !!process.env.FSM_UPDATE_CLIPBOARD;
    const cases: { name: string; machine: string; select: string }[] = [
      ...readdirSync(GEOMETRY).filter((f) => f.endsWith('.fsm')).map((f) => f.slice(0, -4)).map((m) => ({ name: m, machine: m, select: '*' })),
      { name: 'MediaPlayer-On', machine: 'MediaPlayer', select: 'On' },
      { name: 'Order-Payment', machine: 'Order', select: 'Payment' },
    ];
    const failed: string[] = [];
    for (const c of cases) {
      const read = readMachine(readFileSync(join(GEOMETRY, `${c.machine}.fsm`), 'utf8'), readFileSync(join(GEOMETRY, `${c.machine}.fsm.layout`), 'utf8'));
      if ('problems' in read) throw new Error(`${c.machine}: ${JSON.stringify(read.problems)}`);
      const view = await Webview.open(read.model);
      if (c.select === '*') await view.page.keyboard.press('ControlOrMeta+a');
      else await view.send({ type: 'reveal', id: c.select });
      await view.page.waitForTimeout(30);
      const text = await view.page.evaluate(() => {
        const w = globalThis as any;
        const data = new w.DataTransfer();
        w.document.dispatchEvent(new w.ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
        return data.getData('text/plain') as string;
      });
      await view.close();
      assert.ok(text, `${c.name}: something copied`);
      const fixture = `${JSON.stringify({ machine: c.machine, select: c.select, clipboard: JSON.parse(text) }, null, 2)}\n`;
      const file = join(CLIPBOARD, `${c.name}.json`);
      if (update) writeFileSync(file, fixture);
      else if (fixture !== readFileSync(file, 'utf8').replace(/\r\n/g, '\n')) failed.push(c.name);
    }
    assert.deepEqual(failed, [], 'copied differently from the clipboard fixtures (FSM_UPDATE_CLIPBOARD=1 writes them)');
  });

  describe('editing', () => {
    /** A, B and the transition A#1 (A → B on go), placed by fsm-editor-common. */
    const small = (): FsmModel => {
      const text = JSON.stringify({
        version: 1, name: 'M', type: 'behavioral', initial: { target: 'A' },
        elements: [
          { name: 'A', type: 'state', transitions: [{ type: 'external', trigger: 'go', target: 'B' }] },
          { name: 'B', type: 'state' },
        ],
      });
      const r = readMachine(text, undefined);
      if ('problems' in r) throw new Error(JSON.stringify(r.problems));
      return r.model;
    };
    const named = (m: FsmModel, name: string) => m.vertices.find((v) => v.name === name);
    const toast = (view: Webview) => view.page.locator('#toast-text').textContent();
    /** Selects an element as the extension's reveal does (a transition is hard to hit with the mouse). */
    const select = async (view: Webview, id: string) => {
      await view.send({ type: 'reveal', id });
      await view.page.waitForTimeout(50);
    };
    /** A point of the canvas far from the machine. */
    const empty = async (view: Webview) => {
      const box = (await view.page.locator('#canvas').boundingBox())!;
      return { x: box.x + box.width - 40, y: box.y + box.height - 40 };
    };

    it('creates a state with its shortcut and a click on the canvas', async () => {
      const view = await Webview.open(small());
      const p = await empty(view);
      await view.page.keyboard.press('s');
      await view.page.mouse.click(p.x, p.y);
      const m = await view.nextEdit(0);
      assert.equal(m.vertices.filter((v) => v.type === 'state').length, 3);
      assert.ok(named(m, 'State'), 'the new state is named State');
      await view.close();
    });

    it('moves a state by dragging it, on the grid', async () => {
      const view = await Webview.open(small());
      const before = named(view.model, 'A')!;
      const c = await view.screenOf(before.id);
      await view.page.mouse.move(c.x, c.y);
      await view.page.mouse.down();
      await view.page.mouse.move(c.x + 40, c.y + 30, { steps: 8 });
      await view.page.mouse.up();
      const after = named(await view.nextEdit(0), 'A')!;
      assert.ok(after.x > before.x && after.y > before.y, `moved right and down (${before.x},${before.y} → ${after.x},${after.y})`);
      assert.equal(after.x % 10, 0);
      assert.equal(after.y % 10, 0);
      await view.close();
    });

    it('renames a state inline, and refuses a name with a space', async () => {
      const view = await Webview.open(small());
      await select(view, named(view.model, 'A')!.id);
      await view.page.keyboard.press('Enter');
      await view.page.keyboard.press('ControlOrMeta+a');
      await view.page.keyboard.type('Idle');
      await view.page.keyboard.press('Enter');
      const m = await view.nextEdit(0);
      assert.ok(named(m, 'Idle') && !named(m, 'A'));
      await select(view, named(m, 'Idle')!.id);
      await view.page.keyboard.press('Enter');
      await view.page.keyboard.press('ControlOrMeta+a');
      await view.page.keyboard.type('bad name');
      await view.page.keyboard.press('Enter');
      await view.page.waitForTimeout(200);
      assert.equal(view.edits.length, 1, 'no edit');
      assert.match((await toast(view)) ?? '', /^Name not changed\./);
      await view.close();
    });

    it("keeps a transition's label open while it breaks the grammar", async () => {
      const view = await Webview.open(small());
      await select(view, 'A#1');
      await view.page.keyboard.press('Enter');
      const box = view.page.locator('.inline-edit');
      await box.fill('go [x > 1]');
      await box.press('Enter');
      await view.page.waitForSelector('.inline-edit.invalid');
      assert.equal(view.edits.length, 0, 'no edit');
      await box.fill('go [ready()] / start()');
      await box.press('Enter');
      const t = (await view.nextEdit(0)).transitions.find((x) => x.id === 'A#1')!;
      assert.deepEqual([t.triggers, t.guard, t.action], [['go'], 'ready()', 'start()']);
      assert.equal(await view.page.locator('.inline-edit').count(), 0, 'the box is closed');
      await view.close();
    });

    it('deletes the selection with its transitions', async () => {
      const view = await Webview.open(small());
      await select(view, named(view.model, 'B')!.id);
      await view.page.keyboard.press('Delete');
      const m = await view.nextEdit(0);
      assert.ok(!named(m, 'B'));
      assert.ok(!m.transitions.some((t) => t.id === 'A#1'));
      await view.close();
    });

    it('connects two states with the transition tool', async () => {
      const view = await Webview.open(small());
      const a = await view.screenOf(named(view.model, 'A')!.id);
      const b = await view.screenOf(named(view.model, 'B')!.id);
      await view.page.keyboard.press('t');
      await view.page.mouse.move(a.x, a.y);
      await view.page.mouse.down();
      await view.page.mouse.move(b.x, b.y, { steps: 8 });
      await view.page.mouse.up();
      const m = await view.nextEdit(0);
      const [ida, idb] = [named(m, 'A')!.id, named(m, 'B')!.id];
      assert.equal(m.transitions.filter((t) => t.source === ida && t.target === idb).length, 2);
      await view.close();
    });

    it('duplicates the selection', async () => {
      const view = await Webview.open(small());
      await select(view, named(view.model, 'A')!.id);
      await view.page.keyboard.press('ControlOrMeta+d');
      const m = await view.nextEdit(0);
      assert.equal(m.vertices.filter((v) => v.type === 'state').length, 3);
      await view.close();
    });

    it('refuses edits in a read-only diagram', async () => {
      const view = await Webview.open(small(), { readonly: true });
      await select(view, named(view.model, 'B')!.id);
      await view.page.keyboard.press('Delete');
      await view.page.waitForTimeout(200);
      assert.equal(view.posted.filter((m) => m.type === 'edit').length, 0);
      assert.equal(await toast(view), 'This diagram is read-only.');
      assert.ok(named(view.model, 'B'));
      await view.close();
    });
  });
});
