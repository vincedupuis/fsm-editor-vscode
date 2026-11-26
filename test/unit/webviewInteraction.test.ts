/**
 * The diagram editor's webview (media/editor.js) in headless Chromium (webview.ts): the mouse work, the view, the
 * properties panel and the clipboard, which webview.test.ts's editing tests don't cover.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { readMachine } from '../../src/common';
import { FsmModel, Vertex } from '../../src/model';
import { Webview, closeBrowser, example } from './webview';

after(closeBrowser);

/** A machine of the format's JSON, placed by fsm-editor-common. */
function machine(elements: unknown[], extra: Record<string, unknown> = {}): FsmModel {
  const r = readMachine(JSON.stringify({ version: 1, name: 'M', type: 'behavioral', ...extra, elements }), undefined);
  if ('problems' in r) throw new Error(JSON.stringify(r.problems));
  return r.model;
}

/** A → fork → X, Y (the regions of C); X, Y → join → A; C's entry point in → X; a choice → A. */
const segments = (type = 'behavioral') => machine([
  { name: 'A', type: 'state', transitions: [{ type: 'external', target: 'f*' }] },
  { name: 'f*', type: 'fork', transitions: [{ type: 'external', target: 'X' }, { type: 'external', target: 'Y' }] },
  {
    name: 'C', type: 'state', points: [{ name: 'in', type: 'entryPoint', transitions: [{ type: 'local', target: 'X' }] }], regions: [
      { name: 'r1', elements: [{ name: 'X', type: 'state', transitions: [{ type: 'external', target: 'j*' }] }] },
      { name: 'r2', elements: [{ name: 'Y', type: 'state', transitions: [{ type: 'external', target: 'j*' }] }] },
    ],
  },
  { name: 'j*', type: 'join', transitions: [{ type: 'external', target: 'A' }] },
  { name: 'ch*', type: 'choice', transitions: [{ type: 'external', target: 'A' }] },
], { type, initial: { target: 'A' } });

/** A, B and the transition A#1 (A → B on go). */
const small = () => machine([
  { name: 'A', type: 'state', transitions: [{ type: 'external', trigger: 'go', target: 'B' }] },
  { name: 'B', type: 'state' },
], { initial: { target: 'A' } });

const named = (m: FsmModel, name: string): Vertex => {
  const v = m.vertices.find((x) => x.name === name);
  if (!v) throw new Error(`no ${name}`);
  return v;
};
const onGrid = (n: number) => n % 10 === 0;

describe('webview: mouse work', () => {
  it('resizes a state from each handle, on the grid', async () => {
    const view = await Webview.open(small());
    let a = named(view.model, 'A');
    for (const corner of ['se', 'nw', 'ne', 'sw']) {
      const n = view.edits.length;
      await view.select(a.id);
      const box = (await view.page.locator(`[data-handle="resize-${corner}"]`).boundingBox())!;
      const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const sx = corner.includes('w') ? -1 : 1;
      const sy = corner.includes('n') ? -1 : 1;
      await view.drag(from, { x: from.x + 33 * sx, y: from.y + 27 * sy });
      const b = named(await view.nextEdit(n), 'A');
      assert.ok(b.w > a.w && b.h > a.h, `${corner}: grows (${a.w}×${a.h} → ${b.w}×${b.h})`);
      // The opposite corner stays put.
      if (sx < 0) assert.equal(b.x + b.w, a.x + a.w, `${corner}: right edge kept`);
      else assert.equal(b.x, a.x, `${corner}: left edge kept`);
      if (sy < 0) assert.equal(b.y + b.h, a.y + a.h, `${corner}: bottom edge kept`);
      else assert.equal(b.y, a.y, `${corner}: top edge kept`);
      assert.ok([b.x, b.y, b.x + b.w, b.y + b.h].every(onGrid), `${corner}: on the grid (${b.x},${b.y} ${b.w}×${b.h})`);
      a = b;
    }
    await view.close();
  });

  it('adds a bend point with a double-click, drags it, and removes it with a double-click', async () => {
    const view = await Webview.open(small());
    const a = named(view.model, 'A');
    const b = named(view.model, 'B');
    await view.select('A#1');
    // A point of the line a quarter along, away from the label.
    const len = await view.page.evaluate(() => {
      const p = (globalThis as any).document.querySelector('#world [data-id="A#1"] path.line');
      const m = p.getScreenCTM();
      const q = p.getPointAtLength(p.getTotalLength() / 4);
      return { x: m.a * q.x + m.e, y: m.d * q.y + m.f };
    });
    await view.page.mouse.click(len.x, len.y);
    await view.page.mouse.click(len.x, len.y);
    let t = (await view.nextEdit(0)).transitions.find((x) => x.id === 'A#1')!;
    assert.equal(t.points?.length, 1, 'a bend point');
    const wp = (await view.page.locator('[data-wp="A#1:0"]').boundingBox())!;
    const c = { x: wp.x + wp.width / 2, y: wp.y + wp.height / 2 };
    await view.drag(c, { x: c.x + 47, y: c.y + 61 });
    t = (await view.nextEdit(1)).transitions.find((x) => x.id === 'A#1')!;
    const moved = t.points![0];
    assert.ok(onGrid(moved.x) && onGrid(moved.y), `on the grid (${moved.x},${moved.y})`);
    assert.ok(moved.y > Math.max(a.y, b.y), 'dragged down');
    const at = await view.toScreen(moved.x, moved.y);
    await view.page.mouse.click(at.x, at.y);
    await view.page.mouse.click(at.x, at.y);
    t = (await view.nextEdit(2)).transitions.find((x) => x.id === 'A#1')!;
    assert.equal(t.points, undefined, 'no bend point left');
    await view.close();
  });

  it("drags a transition's label", async () => {
    const view = await Webview.open(small());
    const box = (await view.page.locator('[data-label="A#1"]').boundingBox())!;
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await view.drag(c, { x: c.x + 30, y: c.y + 40 });
    const t = (await view.nextEdit(0)).transitions.find((x) => x.id === 'A#1')!;
    const zoom = (await view.view()).zoom;
    assert.ok(t.labelOffset, 'an offset');
    assert.ok(Math.abs(t.labelOffset!.x - 30 / zoom) <= 2 && Math.abs(t.labelOffset!.y - 40 / zoom) <= 2, JSON.stringify(t.labelOffset));
    await view.close();
  });

  it('selects a composite state with a click in its area, and moves it by its border', async () => {
    const view = await Webview.open(machine([
      { name: 'C', type: 'state', initial: { target: 'C1' }, elements: [{ name: 'C1', type: 'state' }] },
    ], { initial: { target: 'C' } }));
    const c = named(view.model, 'C');
    const selected = () => view.page.locator('#props h3').first().textContent();
    // A click in its area, away from C1: C.
    await view.page.mouse.click(...Object.values(await view.toScreen(c.x + c.w - 15, c.y + c.h - 15)) as [number, number]);
    await view.page.waitForTimeout(100);
    assert.equal(await selected(), 'State');
    assert.equal(await view.field('Name').inputValue(), 'C');
    // A click on empty canvas, then a drag from its left border: C moves.
    await view.page.mouse.click(...Object.values(await view.toScreen(c.x - 60, c.y + c.h / 2)) as [number, number]);
    const from = await view.toScreen(c.x + 1, c.y + c.h - 10);
    await view.drag(from, { x: from.x + 47, y: from.y + 33 });
    const moved = named(await view.nextEdit(0), 'C');
    assert.ok(moved.x > c.x && moved.y > c.y, `moved (${c.x},${c.y} → ${moved.x},${moved.y})`);
    assert.equal(named(view.model, 'C1').parent, moved.regions![0].id, 'C1 still inside');
    await view.close();
  });

  it('drops a state into a composite state, and takes it out with Leave Parent', async () => {
    const view = await Webview.open(machine([
      { name: 'A', type: 'state' },
      { name: 'C', type: 'state', initial: { target: 'C1' }, elements: [{ name: 'C1', type: 'state' }] },
    ], { initial: { target: 'A' } }));
    const c = named(view.model, 'C');
    const c1 = named(view.model, 'C1');
    const region = c1.parent;
    const a = named(view.model, 'A');
    // Grows C first, so that A fits in its region beside C1.
    await view.select(c.id);
    const se = (await view.page.locator('[data-handle="resize-se"]').boundingBox())!;
    const zoom = (await view.view()).zoom;
    await view.drag({ x: se.x + 4, y: se.y + 4 }, { x: se.x + 4 + (a.w + 80) * zoom, y: se.y + 4 + (a.h + 80) * zoom });
    const grown = named(await view.nextEdit(0), 'C');
    // A's top-left corner to the free space at the bottom right of C's region.
    const from = await view.screenOf(a.id);
    const to = await view.toScreen(grown.x + grown.w - a.w / 2 - 30, grown.y + grown.h - a.h / 2 - 30);
    await view.drag(from, to);
    let m = await view.nextEdit(1);
    assert.equal(named(m, 'A').parent, region, 'A is in C');
    await view.select(named(m, 'A').id);
    const at = await view.screenOf(named(m, 'A').id);
    await view.page.mouse.click(at.x, at.y, { button: 'right' });
    await view.page.locator('.ctx-menu button', { hasText: 'Leave Parent' }).click();
    m = await view.nextEdit(2);
    assert.equal(named(m, 'A').parent, named(m, 'C').parent, 'A is beside C again');
    await view.close();
  });

  it('drags the divider between orthogonal regions', async () => {
    const view = await Webview.open(machine([
      { name: 'O', type: 'state', regions: [
        { name: 'r1', elements: [{ name: 'X', type: 'state' }] },
        { name: 'r2', elements: [{ name: 'Y', type: 'state' }] },
      ] },
    ], { initial: { target: 'O' } }));
    const o = named(view.model, 'O');
    const sep = (await view.page.locator(`[data-handle="sep:${o.id}:0"]`).boundingBox())!;
    const from = { x: sep.x + sep.width / 2, y: sep.y + sep.height / 2 };
    const horizontal = o.regionLayout === 'horizontal';
    await view.drag(from, horizontal ? { x: from.x + 60, y: from.y } : { x: from.x, y: from.y + 60 });
    const after = named(await view.nextEdit(0), 'O');
    const size = (v: Vertex) => (horizontal ? v.w : v.h);
    assert.ok(size(after) > size(o), `the state grows (${size(o)} → ${size(after)})`);
    const [r0, r1] = [o.regions![0].size, after.regions![0].size];
    assert.ok(r1! > (r0 ?? size(o) / 2), `the first region grows (${r0} → ${r1})`);
    await view.close();
  });

  it('selects with a rubber band and moves the group', async () => {
    const view = await Webview.open(small());
    const a = named(view.model, 'A');
    const b = named(view.model, 'B');
    const x0 = Math.min(a.x, b.x) - 20;
    const y0 = Math.min(a.y, b.y) - 20;
    const x1 = Math.max(a.x + a.w, b.x + b.w) + 20;
    const y1 = Math.max(a.y + a.h, b.y + b.h) + 20;
    await view.drag(await view.toScreen(x0, y0), await view.toScreen(x1, y1));
    await view.page.waitForTimeout(50);
    const selected = await view.page.locator('#world g.selected').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')).sort());
    assert.deepEqual(selected, ['A#1', a.id, b.id].sort(), 'the band selects A, B and the transition between them');
    const c = await view.screenOf(a.id);
    await view.drag(c, { x: c.x + 50, y: c.y + 40 });
    const m = await view.nextEdit(0);
    const [a2, b2] = [named(m, 'A'), named(m, 'B')];
    assert.ok(a2.x - a.x > 0 && a2.y - a.y > 0, 'A moved');
    assert.deepEqual([b2.x - b.x, b2.y - b.y], [a2.x - a.x, a2.y - a.y], 'B moved with A');
    await view.close();
  });

  it("attaches a comment to the state when dropped on an internal transition's line", async () => {
    const view = await Webview.open(machine([
      { name: 'S', type: 'state', entry: 'a()', transitions: [{ type: 'internal', trigger: 'tick', action: 'b()' }] },
      { name: 'note*', type: 'comment', text: 'n' },
    ]));
    const s = named(view.model, 'S');
    // The compartment's second line, tick / b(): LINE_H (14) below entry / a(), under the name (NAME_H, 24).
    const n = view.edits.length;
    await view.page.locator('[data-tool="transition"]').click();
    await view.drag(await view.screenOf(named(view.model, 'note*').id), await view.toScreen(s.x + 20, s.y + 24 + 14 + 10));
    assert.deepEqual(named(await view.nextEdit(n), 'note*').anchors, [s.id]);
    await view.close();
  });
});

describe('webview: zoom and pan', () => {
  it('zooms with the wheel around the pointer, with Ctrl/Cmd and the keys, fits with Ctrl/Cmd+0', async () => {
    const view = await Webview.open(example('MediaPlayer'));
    await view.page.waitForTimeout(100);
    const fitted = await view.view();
    const box = (await view.page.locator('#canvas').boundingBox())!;
    const p = { x: box.x + 300, y: box.y + 200 };
    // The model point under the pointer stays under it.
    const under = (v: { x: number; y: number; zoom: number }) => ({ x: (p.x - box.x - v.x) / v.zoom, y: (p.y - box.y - v.y) / v.zoom });
    await view.page.mouse.move(p.x, p.y);
    await view.page.mouse.wheel(0, -120);
    await view.page.waitForTimeout(100);
    const zoomed = await view.view();
    assert.ok(zoomed.zoom > fitted.zoom, `the wheel zooms in (${fitted.zoom} → ${zoomed.zoom})`);
    const u0 = under(fitted);
    const u1 = under(zoomed);
    assert.ok(Math.abs(u0.x - u1.x) < 1 && Math.abs(u0.y - u1.y) < 1, 'around the pointer');
    await view.page.locator('#canvas').focus();
    await view.page.keyboard.press('ControlOrMeta+-');
    await view.page.waitForTimeout(50);
    assert.ok((await view.view()).zoom < zoomed.zoom, 'Ctrl/Cmd+- zooms out');
    await view.page.keyboard.press('ControlOrMeta+=');
    await view.page.waitForTimeout(50);
    assert.ok(Math.abs((await view.view()).zoom - zoomed.zoom) < 1e-3, 'Ctrl/Cmd+= zooms back in');
    await view.page.keyboard.press('ControlOrMeta+0');
    await view.page.waitForTimeout(50);
    assert.deepEqual(await view.view(), fitted, 'Ctrl/Cmd+0 fits');
    assert.equal(view.edits.length, 0, 'the view is no edit');
    await view.close();
  });

  it('pans with Space+drag, a middle drag and a right drag', async () => {
    const view = await Webview.open(example('MediaPlayer'));
    await view.page.waitForTimeout(100);
    const box = (await view.page.locator('#canvas').boundingBox())!;
    const p = { x: box.x + box.width - 30, y: box.y + box.height - 30 };
    let v0 = await view.view();
    await view.page.locator('#canvas').focus();
    await view.page.keyboard.down(' ');
    await view.drag(p, { x: p.x - 100, y: p.y - 50 });
    await view.page.keyboard.up(' ');
    let v1 = await view.view();
    assert.deepEqual([v1.x - v0.x, v1.y - v0.y, v1.zoom], [-100, -50, v0.zoom], 'Space+drag pans');
    for (const button of ['middle', 'right'] as const) {
      v0 = v1;
      await view.drag(p, { x: p.x - 40, y: p.y - 20 }, button);
      v1 = await view.view();
      assert.deepEqual([v1.x - v0.x, v1.y - v0.y], [-40, -20], `a ${button} drag pans`);
    }
    assert.equal(await view.page.locator('.ctx-menu').count(), 0, 'a right drag opens no menu');
    assert.equal(view.edits.length, 0, 'the view is no edit');
    await view.close();
  });
});

describe('webview: properties panel', () => {
  /** Types `text` into the field `label` and commits it (Enter for a line, blur for a text area). */
  const fill = async (view: Webview, label: string, text: string) => {
    const input = view.field(label);
    await input.fill(text);
    if ((await input.evaluate((e) => e.tagName)) === 'TEXTAREA') await input.blur();
    else await input.press('Enter');
  };

  it("edits every field of a state, and refuses text that breaks the grammar with its message", async () => {
    const view = await Webview.open(small());
    await view.select(named(view.model, 'A').id);
    const fields: [string, string, (v: Vertex) => unknown, unknown][] = [
      ['Stereotype', 'Critical', (v) => v.stereotype, 'Critical'],
      ['entry /', 'start(); log()', (v) => v.entry, 'start(); log()'],
      ['exit /', 'stop()', (v) => v.exit, 'stop()'],
      ['do /', 'poll()', (v) => v.doActivity, 'poll()'],
      ['Deferrable events', 'evA, evB', (v) => v.deferrable, ['evA', 'evB']],
      ['State invariant', 'isRunning() && !isFaulty()', (v) => v.invariant, 'isRunning() && !isFaulty()'],
      // Last: ids follow names, so the renamed state is a new selection.
      ['Name', 'Idle', (v) => v.name, 'Idle'],
    ];
    for (const [label, text, get, want] of fields) {
      const n = view.edits.length;
      await fill(view, label, text);
      const m = await view.nextEdit(n);
      const v = named(m, label === 'Name' ? 'Idle' : 'A');
      assert.deepEqual(get(v), want, label);
    }
    const bad: [string, string][] = [
      ['Name', 'bad name'],
      ['entry /', 'x = 1'],
      ['Deferrable events', 'after(1s)'],
      ['State invariant', 'x > 1'],
    ];
    await view.select(named(view.model, 'Idle').id);
    for (const [label, text] of bad) {
      const n = view.edits.length;
      await fill(view, label, text);
      await view.page.waitForTimeout(200);
      assert.equal(view.edits.length, n, `${label}: no edit`);
      assert.ok(await view.field(label).evaluate((e) => e.classList.contains('invalid')), `${label}: marked invalid`);
      assert.notEqual(await view.fieldError(label), '', `${label}: its message`);
    }
    await view.close();
  });

  it("edits a transition's kind, triggers, guard and action", async () => {
    const view = await Webview.open(small());
    await view.select('A#1');
    for (const [label, text] of [['Triggers', 'go, after(2s)'], ['Guard', 'ready() && !busy()'], ['Action', 'notify(); log()']]) {
      const n = view.edits.length;
      await fill(view, label, text);
      await view.nextEdit(n);
    }
    let t = view.model.transitions.find((x) => x.id === 'A#1')!;
    assert.deepEqual([t.triggers, t.guard, t.action], [['go', 'after(2s)'], 'ready() && !busy()', 'notify(); log()']);
    const n = view.edits.length;
    const kinds = await view.field('Kind').locator('option').evaluateAll((os) => os.map((o) => (o as unknown as { value: string }).value));
    assert.deepEqual(kinds, ['external', 'internal'], 'no local transition out of a simple state');
    await view.field('Kind').selectOption('internal');
    t = (await view.nextEdit(n)).transitions.find((x) => x.id === 'A#1')!;
    assert.equal(t.kind, 'internal');
    await fill(view, 'Guard', 'else');
    await view.page.waitForTimeout(200);
    assert.ok(await view.field('Guard').evaluate((e) => e.classList.contains('invalid')), 'else is refused out of a choice');
    await view.close();
  });

  it('offers a transition leaving a pseudostate no triggers and no other kind', async () => {
    const view = await Webview.open(machine([
      { name: 'A', type: 'state', transitions: [{ type: 'external', trigger: 'go', target: 'c*' }] },
      { name: 'c*', type: 'choice', transitions: [{ type: 'external', guard: 'ok()', target: 'A' }] },
    ], { initial: { target: 'A' } }));
    await view.select('c*#1');
    for (const label of ['Kind', 'Triggers']) assert.equal(await view.field(label).count(), 0, label);
    assert.equal(await view.field('Guard').count(), 1, 'the guard');
    await view.page.locator('#canvas').focus();
    await view.page.keyboard.press('Enter');
    await view.page.locator('.inline-edit').fill('go [ok()]');
    const n = view.edits.length;
    await view.page.locator('.inline-edit').press('Enter');
    await view.page.waitForTimeout(200);
    assert.equal(view.edits.length, n, 'a trigger in the label is refused');
    await view.close();
  });

  it('offers no guard or triggers on a transition leaving a fork or an entry point, or entering a join', async () => {
    for (const type of ['behavioral', 'protocol']) {
      const view = await Webview.open(segments(type));
      const guard = type === 'protocol' ? 'Precondition' : 'Guard';
      for (const id of ['f*#1', 'X#1', 'C.in#1']) {
        await view.select(id);
        assert.equal(await view.field(guard).count(), 0, `${type}: no ${guard} on ${id}`);
        assert.equal(await view.field('Triggers').count(), 0, `${type}: no Triggers on ${id}`);
      }
      // Nor in the label of X → join.
      for (const text of ['[ok()]', 'go']) {
        await view.select('X#1');
        await view.page.locator('#canvas').focus();
        await view.page.keyboard.press('Enter');
        await view.page.locator('.inline-edit').fill(text);
        const n = view.edits.length;
        await view.page.locator('.inline-edit').press('Enter');
        await view.page.waitForTimeout(200);
        assert.equal(view.edits.length, n, `${type}: ${text} refused`);
        await view.page.keyboard.press('Escape');
      }
      await view.close();
    }
  });

  it("names the machine's only region and a state's, and refuses a second [else] branch", async () => {
    const view = await Webview.open(machine([
      { name: 'A', type: 'state', transitions: [{ type: 'external', trigger: 'go', target: 'c*' }], initial: { target: 'A1' }, elements: [{ name: 'A1', type: 'state' }] },
      { name: 'c*', type: 'choice', transitions: [{ type: 'external', guard: 'else', target: 'A' }, { type: 'external', target: 'A' }] },
    ], { initial: { target: 'A' } }));
    let n = view.edits.length;
    await fill(view, 'Region', 'main');
    assert.equal((await view.nextEdit(n)).regions[0].name, 'main');
    await view.select(named(view.model, 'A').id);
    const input = view.page.locator('#props .row.field input').first();
    n = view.edits.length;
    await input.fill('inner');
    await input.press('Enter');
    assert.equal(named(await view.nextEdit(n), 'A').regions![0].name, 'inner');
    // Written as named regions, in `regions`.
    const file = JSON.parse(view.files.at(-1)!.model);
    assert.equal(file.regions[0].name, 'main');
    assert.equal(file.regions[0].elements.find((e: { name: string }) => e.name === 'A').regions[0].name, 'inner');
    await view.select('c*#2');
    n = view.edits.length;
    await fill(view, 'Guard', 'else');
    await view.page.waitForTimeout(200);
    assert.equal(view.edits.length, n, 'a second [else] is refused');
    assert.equal(await view.fieldError('Guard'), 'This choice already has an [else] branch.');
    await view.close();
  });

  it("edits the machine's context, and refuses one that isn't a name", async () => {
    const view = await Webview.open(small());
    let n = view.edits.length;
    await fill(view, 'Context', 'DoorController');
    assert.equal((await view.nextEdit(n)).context, 'DoorController');
    n = view.edits.length;
    await fill(view, 'Context', 'Door controller');
    await view.page.waitForTimeout(200);
    assert.equal(view.edits.length, n, 'no edit');
    assert.notEqual(await view.fieldError('Context'), '', 'its message');
    await view.close();
  });

  it('offers a protocol machine nothing it cannot have: history, state behaviors, guards, actions, else out of a branch', async () => {
    const view = await Webview.open(machine([
      { name: 'A', type: 'state', transitions: [{ type: 'external', trigger: 'go', target: 'c*' }] },
      { name: 'c*', type: 'choice', transitions: [{ type: 'external', precondition: 'ok()', target: 'B' }, { type: 'external', target: 'A' }] },
      { name: 'B', type: 'state' },
    ], { type: 'protocol', initial: { target: 'A' } }));
    const tool = (id: string) => view.page.locator(`#toolbox .tb-item[data-tool="${id}"]`);
    assert.equal(await tool('shallowHistory').isVisible(), false, 'no shallow history tool');
    assert.equal(await tool('deepHistory').isVisible(), false, 'no deep history tool');
    assert.equal(await tool('choice').isVisible(), true, 'the other tools');
    await view.page.keyboard.press('h');
    assert.equal(await tool('shallowHistory').evaluate((e) => e.classList.contains('active')), false, 'nor its key');
    await view.select('c*');
    const kinds = await view.field('Kind').locator('option').evaluateAll((os) => os.map((o) => (o as unknown as { value: string }).value));
    assert.ok(kinds.includes('junction') && !kinds.includes('shallowHistory') && !kinds.includes('deepHistory'), kinds.join());
    await view.select(named(view.model, 'A').id);
    for (const label of ['entry /', 'exit /', 'do /']) assert.equal(await view.field(label).count(), 0, label);
    assert.equal(await view.field('State invariant').count(), 1, 'the invariant');
    await view.select('A#1');
    for (const label of ['Guard', 'Action']) assert.equal(await view.field(label).count(), 0, label);
    let n = view.edits.length;
    await fill(view, 'Precondition', 'else');
    await view.page.waitForTimeout(200);
    assert.equal(view.edits.length, n, 'else is refused out of a branch');
    await view.select('c*#2');
    n = view.edits.length;
    await fill(view, 'Precondition', 'else');
    assert.equal((await view.nextEdit(n)).transitions.find((t) => t.id === 'c*#2')!.precondition, 'else', 'else on a branch');
    await view.close();
  });

  it("edits a comment's text", async () => {
    const view = await Webview.open(machine([{ name: 'A', type: 'state' }, { name: 'note*', type: 'comment', text: 'old' }], { initial: { target: 'A' } }));
    const c = view.model.vertices.find((v) => v.type === 'comment')!;
    await view.select(c.id);
    await fill(view, 'Text', 'two\nlines');
    const m = await view.nextEdit(0);
    assert.equal(m.vertices.find((v) => v.id === c.id)!.text, 'two\nlines');
    await view.close();
  });

  it('picks a color from the palette, then the default again', async () => {
    const view = await Webview.open(small());
    const id = named(view.model, 'A').id;
    await view.select(id);
    await view.page.locator('#props .color-field .swatch-btn').first().click();
    await view.page.locator('.color-pop .swatch[title="#30a46c"]').click();
    let v = (await view.nextEdit(0)).vertices.find((x) => x.id === id)!;
    assert.equal(v.color, '#30a46c');
    await view.page.waitForTimeout(100);
    await view.page.locator('#props .color-field .swatch-btn').first().click();
    await view.page.locator('.color-pop button', { hasText: 'Default' }).click();
    v = (await view.nextEdit(1)).vertices.find((x) => x.id === id)!;
    assert.equal(v.color, undefined);
    await view.close();
  });

  it('picks a submachine file and adds its connection point references', async () => {
    const view = await Webview.open(small(), { machines: { 'Payment.fsm': example('Payment') } });
    const id = named(view.model, 'B').id;
    await view.select(id);
    await view.field('Referenced state machine').selectOption('Payment.fsm');
    let m = await view.nextEdit(0);
    assert.equal(m.vertices.find((v) => v.id === id)!.submachine, 'Payment.fsm');
    await view.page.locator('#props button', { hasText: 'Add all references' }).click();
    m = await view.nextEdit(1);
    const refs = m.vertices.filter((v) => v.type === 'connectionPointRef' && v.parent === id);
    assert.deepEqual(refs.map((r) => r.ref).sort(), ['cancelled', 'failed', 'retry']);
    await view.close();
  });
});

describe('webview: Alt+click and middle click', () => {
  const pop = (view: Webview) => view.page.locator('.props-pop');
  const altClick = async (view: Webview, at: { x: number; y: number }) => {
    await view.page.keyboard.down('Alt');
    await view.page.mouse.click(at.x, at.y);
    await view.page.keyboard.up('Alt');
  };

  it("opens an element's properties in a window; Alt+drag moves it off the grid instead", async () => {
    const view = await Webview.open(small());
    const a = named(view.model, 'A');
    await altClick(view, await view.screenOf(a.id));
    await pop(view).waitFor();
    assert.equal(await pop(view).locator('h3').first().textContent(), 'State');
    assert.equal(await pop(view).locator('.field input').first().inputValue(), 'A');
    // A transition's, from its label.
    await view.page.keyboard.press('Escape');
    await altClick(view, await view.page.locator('[data-label="A#1"]').first().boundingBox().then((b) => ({ x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 })));
    await pop(view).waitFor();
    assert.equal(await pop(view).locator('h3').first().textContent(), 'Transition');
    await view.page.keyboard.press('Escape');
    // Alt+drag: a move, no window.
    const from = await view.screenOf(a.id);
    await view.page.keyboard.down('Alt');
    await view.drag(from, { x: from.x + 37, y: from.y + 23 });
    await view.page.keyboard.up('Alt');
    const moved = named(await view.nextEdit(0), 'A');
    assert.ok(moved.x !== a.x && moved.y !== a.y, 'moved');
    assert.equal(await pop(view).count(), 0, 'no window');
    assert.equal(view.edits.length, 1);
    await view.close();
  });

  it("a middle click opens an element's properties in a window; a middle drag pans", async () => {
    const view = await Webview.open(small());
    const a = named(view.model, 'A');
    const at = await view.screenOf(a.id);
    await view.page.mouse.click(at.x, at.y, { button: 'middle' });
    await pop(view).waitFor();
    assert.equal(await pop(view).locator('.field input').first().inputValue(), 'A');
    await view.page.keyboard.press('Escape');
    const before = await view.view();
    await view.drag(at, { x: at.x + 60, y: at.y + 40 }, 'middle');
    const after = await view.view();
    assert.ok(after.x !== before.x && after.y !== before.y, 'panned');
    assert.equal(await pop(view).count(), 0, 'no window');
    assert.equal(view.edits.length, 0);
    await view.close();
  });

  it('on a submachine state: opens the window once no second click came, and Alt+double-click opens the submachine', async () => {
    const view = await Webview.open(machine([{ name: 'P', type: 'state', submachine: 'Payment.fsm' }], { initial: { target: 'P' } }), {
      machines: { 'Payment.fsm': example('Payment') },
    });
    const at = await view.screenOf(named(view.model, 'P').id);
    await view.page.keyboard.down('Alt');
    await view.page.mouse.click(at.x, at.y);
    await view.page.mouse.click(at.x, at.y);
    await view.page.keyboard.up('Alt');
    await view.until('the submachine opened', () => view.posted.some((m) => m.type === 'openSubmachine' && m.href === 'Payment.fsm'));
    await view.page.waitForTimeout(700);
    assert.equal(await pop(view).count(), 0, 'no window after a double-click');
    await view.page.waitForTimeout(600); // no double-click with the next click
    await altClick(view, at);
    assert.equal(await pop(view).count(), 0, 'not yet');
    await pop(view).waitFor({ timeout: 2000 });
    assert.equal(view.posted.filter((m) => m.type === 'openSubmachine').length, 1, 'opened once');
    await view.close();
  });
});

describe('webview: clipboard', () => {
  /** A clipboard event as the browser fires it for the keyboard's Cut, Copy and Paste, with its data. */
  const clip = (view: Webview, type: 'copy' | 'cut' | 'paste', text = '') =>
    view.page.evaluate(([t, s]) => {
      const w = globalThis as any;
      const data = new w.DataTransfer();
      if (s) data.setData('text/plain', s);
      w.document.dispatchEvent(new w.ClipboardEvent(t, { clipboardData: data, bubbles: true, cancelable: true }));
      return data.getData('text/plain') as string;
    }, [type, text] as const);

  it('copies, cuts and pastes with the keyboard, as clipboard JSON', async () => {
    const view = await Webview.open(small());
    const a = named(view.model, 'A');
    const b = named(view.model, 'B');
    await view.select(a.id);
    const at = await view.screenOf(b.id);
    await view.page.keyboard.down('Shift');
    await view.page.mouse.click(at.x, at.y);
    await view.page.keyboard.up('Shift');
    const text = await clip(view, 'copy');
    const data = JSON.parse(text);
    assert.equal(data.fsmClipboard, 1);
    assert.deepEqual(data.vertices.map((v: Vertex) => v.name).sort(), ['A', 'B']);
    assert.deepEqual(data.transitions.map((t: { id: string }) => t.id), ['A#1']);
    await clip(view, 'paste', text);
    let m = await view.nextEdit(0);
    assert.deepEqual(m.vertices.filter((v) => v.type === 'state').map((v) => v.name).sort(), ['A', 'A2', 'B', 'B2']);
    const a2 = named(m, 'A2');
    assert.deepEqual([a2.x - a.x, a2.y - a.y], [20, 20], 'offset by 20');
    assert.ok(m.transitions.some((t) => t.source === a2.id && t.target === named(m, 'B2').id), 'with its transition');
    await view.select(b.id);
    const cut = await clip(view, 'cut');
    m = await view.nextEdit(1);
    assert.deepEqual(JSON.parse(cut).vertices.map((v: Vertex) => v.name), ['B']);
    assert.ok(!m.vertices.some((v) => v.name === 'B'), 'cut removes B');
    await clip(view, 'paste', '{"not":"ours"}');
    await view.page.waitForTimeout(100);
    assert.equal(view.edits.length, 2, 'other text is not pasted');
    await view.close();
  });

  it("copies and pastes through the context menu and the extension's clipboard", async () => {
    const view = await Webview.open(small());
    const a = named(view.model, 'A');
    const at = await view.screenOf(a.id);
    await view.page.mouse.click(at.x, at.y, { button: 'right' });
    await view.page.locator('.ctx-menu button', { hasText: /^Copy$/ }).click();
    await view.until('the clipboard written', () => view.clipboard !== '');
    assert.deepEqual(JSON.parse(view.clipboard).vertices.map((v: Vertex) => v.name), ['A']);
    const box = (await view.page.locator('#canvas').boundingBox())!;
    const p = { x: box.x + box.width - 200, y: box.y + box.height - 120 };
    await view.page.mouse.click(p.x, p.y, { button: 'right' });
    const paste = view.page.locator('.ctx-menu button', { hasText: /^Paste$/ });
    await paste.waitFor();
    await view.page.waitForFunction(() => {
      const b = [...(globalThis as any).document.querySelectorAll('.ctx-menu button')].find((x: any) => x.textContent === 'Paste');
      return b && !b.disabled;
    });
    await paste.click();
    const m = await view.nextEdit(0);
    const a2 = named(m, 'A2');
    const world = await view.toScreen(a2.x, a2.y);
    assert.ok(Math.abs(world.x - p.x) < 15 && Math.abs(world.y - p.y) < 15, 'pasted where the menu opened');
    await view.close();
  });
});

describe('webview: export', () => {
  it('exports a PNG at twice the size of the SVG', async () => {
    for (const name of ['MediaPlayer', 'Order']) {
      const view = await Webview.open(example(name));
      const svg = await view.svg();
      const png = Buffer.from(await view.png(), 'base64');
      // The PNG signature, then the IHDR chunk: width and height, big-endian.
      assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
      const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
      const sw = Number(/<svg [^>]*width="([\d.]+)"/.exec(svg)![1]);
      const sh = Number(/<svg [^>]*height="([\d.]+)"/.exec(svg)![1]);
      assert.deepEqual([w, h], [Math.round(sw * 2), Math.round(sh * 2)], `${name}: ${sw}×${sh} → ${w}×${h}`);
      await view.close();
    }
  });
});

describe('webview: toolbar and side panels', () => {
  it("runs the extension's commands from the toolbar", async () => {
    const view = await Webview.open(small());
    for (const [title, command] of [
      ['Undo (Ctrl/Cmd+Z)', 'undo'],
      ['Redo (Ctrl/Cmd+Shift+Z)', 'redo'],
      ['Show the Trace Player: replay a log on the diagrams', 'fsmEditor.tracePlayer.focus'],
      ['Generate code from a template', 'fsmEditor.generateCode'],
      ['Export as SVG', 'fsmEditor.exportSvg'],
      ['Export as PNG', 'fsmEditor.exportPng'],
    ]) {
      await view.page.locator(`#toolbar button[title="${title}"]`).click();
      assert.deepEqual(view.posted.at(-1), { type: 'command', command }, title);
    }
    await view.close();
  });

  it('hides and shows the Toolbox and the Properties, for every diagram', async () => {
    const view = await Webview.open(small());
    const shown = async () => ({
      toolbox: !(await view.page.locator('#toolbox-pane').evaluate((e) => (e as any).hidden)),
      props: !(await view.page.locator('#props-pane').evaluate((e) => (e as any).hidden)),
    });
    assert.deepEqual(await shown(), { toolbox: true, props: true });
    await view.page.locator('#toolbar button[title="Toggle Toolbox"]').click();
    assert.deepEqual(await shown(), { toolbox: false, props: true });
    assert.deepEqual(view.posted.at(-1), { type: 'panels', panels: { toolbox: false, props: true } }, 'kept by the extension');
    await view.page.locator('#props-pane button[title="Close Properties"]').click();
    assert.deepEqual(await shown(), { toolbox: false, props: false });
    assert.deepEqual(view.posted.at(-1), { type: 'panels', panels: { toolbox: false, props: false } });
    // Another diagram's change, as the extension passes it on to every diagram.
    await view.send({ type: 'panels', panels: { toolbox: true, props: false } });
    await view.page.waitForTimeout(30);
    assert.deepEqual(await shown(), { toolbox: true, props: false });
    await view.close();
    // A new diagram (another window): as the extension's global state says.
    const next = await Webview.open(small(), { panels: { toolbox: false, props: true } });
    assert.deepEqual({
      toolbox: !(await next.page.locator('#toolbox-pane').evaluate((e) => (e as any).hidden)),
      props: !(await next.page.locator('#props-pane').evaluate((e) => (e as any).hidden)),
    }, { toolbox: false, props: true });
    await next.close();
  });
});
