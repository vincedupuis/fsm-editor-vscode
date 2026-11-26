/**
 * The webview doesn't offer what the file can't hold (media/editor.js): the fields, kinds, handles, buttons, menu items
 * and drop targets it leaves out, so that the writer never has to refuse an edit (`LostError`).
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { readMachine } from '../../src/common';
import { FsmModel, Vertex } from '../../src/model';
import { Webview, closeBrowser, example } from './webview';

after(closeBrowser);

function machine(elements: unknown[], extra: Record<string, unknown> = {}): FsmModel {
  const r = readMachine(JSON.stringify({ version: 1, name: 'M', type: 'behavioral', ...extra, elements }), undefined);
  if ('problems' in r) throw new Error(JSON.stringify(r.problems));
  return r.model;
}

/**
 * A (A → C on go), C (composite: its initial → C1, a history without a transition, C1 → C.history on back,
 * C1 → A on tick), a choice (A → choice, choice [ok()] → A), a comment; the machine's initial → A / start().
 */
const sample = (type = 'behavioral') => machine([
  { name: 'A', type: 'state', transitions: [{ type: 'external', trigger: 'go', target: 'C' }, { type: 'external', trigger: 'pick', target: 'ch*' }] },
  {
    name: 'C', type: 'state', initial: { target: 'C1' }, history: {}, elements: [
      { name: 'C1', type: 'state', transitions: [{ type: 'external', trigger: 'back', target: 'C.history' }, { type: 'external', trigger: 'tick', target: 'A' }] },
    ],
  },
  { name: 'ch*', type: 'choice', transitions: [{ type: 'external', ...(type === 'protocol' ? {} : { guard: 'ok()' }), target: 'A' }] },
  { name: 'note*', type: 'comment', text: 'n' },
], { type, initial: { target: 'A', ...(type === 'protocol' ? {} : { action: 'start()' }) } });

const named = (m: FsmModel, name: string): Vertex => {
  const v = m.vertices.find((x) => x.name === name);
  if (!v) throw new Error(`no ${name}`);
  return v;
};
const of = (m: FsmModel, type: string, parent?: string): Vertex => {
  const v = m.vertices.find((x) => x.type === type && (!parent || x.parent === parent));
  if (!v) throw new Error(`no ${type}`);
  return v;
};
const leaving = (m: FsmModel, source: string) => m.transitions.filter((t) => t.source === source);
const rootRegion = (m: FsmModel) => m.regions[0].id;
const toast = (view: Webview) => view.page.locator('#toast-text').textContent();
const labels = (view: Webview) => view.page.locator('#props .field label').allTextContents();

/** Nothing written: no edit within a while. */
async function noEdit(view: Webview, n: number, what: string): Promise<void> {
  await view.page.waitForTimeout(250);
  assert.equal(view.edits.length, n, `${what}: no edit`);
}

const INITIAL_ONLY = 'A transition leaving an initial pseudostate holds its target and an action only.';

describe("webview: what the file can't hold is not offered", () => {
  it("shows only the action of an initial pseudostate's transition", async () => {
    let view = await Webview.open(sample());
    const init = of(view.model, 'initial', rootRegion(view.model));
    await view.select(leaving(view.model, init.id)[0].id);
    let shown = await labels(view);
    for (const hidden of ['Kind', 'Triggers', 'Guard']) assert.ok(!shown.includes(hidden), `no ${hidden} field (${shown})`);
    assert.equal(await view.field('Action').inputValue(), 'start()');
    await view.field('Action').fill('begin()');
    await view.field('Action').press('Enter');
    const m = await view.nextEdit(0);
    assert.equal(leaving(m, init.id)[0].action, 'begin()');
    await view.close();

    view = await Webview.open(sample('protocol'));
    await view.select(leaving(view.model, of(view.model, 'initial', rootRegion(view.model)).id)[0].id);
    shown = await labels(view);
    for (const hidden of ['Kind', 'Triggers', 'Precondition', 'Postcondition']) assert.ok(!shown.includes(hidden), `protocol: no ${hidden} field (${shown})`);
    // Another transition keeps them.
    await view.select(leaving(view.model, named(view.model, 'A').id)[0].id);
    shown = await labels(view);
    for (const field of ['Kind', 'Triggers', 'Precondition', 'Postcondition']) assert.ok(shown.includes(field), `protocol: ${field} on A's transition`);
    await view.close();
  });

  it("refuses triggers and a guard in the label of an initial pseudostate's transition", async () => {
    const view = await Webview.open(sample());
    const init = of(view.model, 'initial', rootRegion(view.model));
    await view.select(leaving(view.model, init.id)[0].id);
    await view.page.locator('#canvas').focus();
    await view.page.keyboard.press('Enter');
    const box = view.page.locator('.inline-edit');
    for (const text of ['go / start()', '[ready()] / start()']) {
      await box.fill(text);
      await box.press('Enter');
      await noEdit(view, 0, text);
      assert.equal(await toast(view), INITIAL_ONLY, text);
      assert.equal(await box.count(), 1, `${text}: the box stays open`);
    }
    await box.fill('/ begin()');
    await box.press('Enter');
    const m = await view.nextEdit(0);
    assert.equal(leaving(m, init.id)[0].action, 'begin()');
    await view.close();
  });

  it('offers only the kinds a pseudostate can be with its transitions and region', async () => {
    const view = await Webview.open(sample());
    const kinds = () => view.field('Kind').locator('option').evaluateAll((os) => os.map((o) => (o as unknown as { value: string }).value));
    // The choice: a target (no initial), a guarded transition (no history), an outgoing transition (no terminate).
    await view.select(of(view.model, 'choice').id);
    assert.deepEqual(await kinds(), ['choice', 'junction']);
    // C's history: its region has an initial pseudostate; it has an incoming transition.
    await view.select(of(view.model, 'shallowHistory').id);
    assert.deepEqual(await kinds(), ['shallowHistory', 'deepHistory', 'choice', 'junction', 'terminate']);
    await view.close();
  });

  it('moves the transition of an initial pseudostate when it is drawn again, and offers no Reverse for it', async () => {
    const view = await Webview.open(sample());
    const init = of(view.model, 'initial', rootRegion(view.model));
    const handle = () => view.page.locator('[data-handle="connect"]').first().boundingBox().then((b) => ({ x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 }));
    // Room around the machine: C beside the properties panel.
    await view.page.locator('#canvas').focus();
    await view.page.keyboard.press('ControlOrMeta+-');
    await view.page.keyboard.press('ControlOrMeta+-');
    // Drawn again to the same state, A: nothing, and no message.
    await view.select(init.id);
    await view.drag(await handle(), await view.screenOf(named(view.model, 'A').id));
    await noEdit(view, 0, 'to the same state');
    assert.ok(await view.page.locator('#toast').isHidden(), 'no message');
    // To C (inside its bottom right corner, clear of C1 and the labels): its one transition goes to C.
    const c = named(view.model, 'C');
    await view.select(init.id);
    await view.drag(await handle(), await view.toScreen(c.x + c.w - 8, c.y + c.h - 8));
    const m = await view.nextEdit(0);
    assert.deepEqual(leaving(m, init.id).map((t) => t.target), [named(m, 'C').id]);
    assert.equal(leaving(m, init.id)[0].action, 'start()', 'its action kept');
    assert.ok(await view.page.locator('#toast').isHidden(), 'no message');
    await view.select(leaving(view.model, init.id)[0].id);
    assert.equal(await view.page.locator('#props button', { hasText: 'Reverse' }).count(), 0, 'no Reverse');
    await view.select(leaving(view.model, named(view.model, 'A').id)[0].id);
    assert.equal(await view.page.locator('#props button', { hasText: 'Reverse' }).count(), 1, "Reverse for A's transition");
    await view.close();
  });

  it('puts no entry point on a simple state, and removes no last region of a state with points', async () => {
    const view = await Webview.open(machine([
      { name: 'A', type: 'state' },
      { name: 'C', type: 'state', points: [{ name: 'in', type: 'entryPoint', transitions: [{ type: 'local', target: 'C1' }] }], initial: { target: 'C1' }, elements: [{ name: 'C1', type: 'state' }] },
    ], { initial: { target: 'A' } }));
    const a = named(view.model, 'A');
    await view.page.locator('[data-tool="entryPoint"]').click();
    await view.page.mouse.click(...Object.values(await view.toScreen(a.x, a.y + a.h / 2)) as [number, number]);
    await noEdit(view, 0, 'an entry point on a simple state');
    assert.match((await toast(view)) ?? "", /Only composite states have entry and exit points/);
    await view.select(named(view.model, 'C').id);
    await view.page.locator('#props button[title="Remove region and its contents"]').click();
    await noEdit(view, 0, "C's last region");
    assert.match((await toast(view)) ?? "", /has entry or exit points/);
    await view.close();
  });

  it('attaches a comment to an initial pseudostate, a region and the machine, which the file names', async () => {
    const view = await Webview.open(sample());
    await view.page.locator('#canvas').focus();
    await view.page.keyboard.press('ControlOrMeta+-');
    await view.page.keyboard.press('ControlOrMeta+-');
    const note = named(view.model, 'note*');
    const init = of(view.model, 'initial', rootRegion(view.model));
    const c = named(view.model, 'C');
    const tool = async () => view.page.locator('[data-tool="transition"]').click();
    await tool();
    await view.drag(await view.screenOf(note.id), await view.screenOf(init.id));
    let m = await view.nextEdit(0);
    // C's region, in its bottom right corner, clear of C1.
    await tool();
    await view.drag(await view.screenOf(note.id), await view.toScreen(c.x + c.w - 12, c.y + c.h - 12));
    m = await view.nextEdit(1);
    // Empty canvas: the machine.
    const right = Math.max(...view.model.vertices.map((v) => v.x + v.w));
    await tool();
    await view.drag(await view.screenOf(note.id), await view.toScreen(right + 150, note.y));
    m = await view.nextEdit(2);
    // Ids follow names: C's region, unnamed, got a generated name to be referenced, and its id with it.
    assert.deepEqual(named(m, 'note*').anchors, [init.id, named(m, 'C').regions![0].id, '']);
    const file = JSON.parse(view.files.at(-1)!.model);
    const comment = file.elements.find((e: { name: string }) => e.name === 'note*');
    // C's region, unnamed, gets a generated name, which references it.
    assert.deepEqual(comment.anchors, ['M.initial', 'region1*', 'M']);
    await view.close();
  });

  it("doesn't drop an initial pseudostate into a region that has one, and leaves out Leave Parent", async () => {
    const view = await Webview.open(sample());
    const c = named(view.model, 'C');
    const init = of(view.model, 'initial', rootRegion(view.model));
    // Grows C, then drops the machine's initial pseudostate at the bottom right of C's region.
    await view.select(c.id);
    const se = (await view.page.locator('[data-handle="resize-se"]').boundingBox())!;
    const zoom = (await view.view()).zoom;
    await view.drag({ x: se.x + 4, y: se.y + 4 }, { x: se.x + 4 + 120 * zoom, y: se.y + 4 + 120 * zoom });
    const grown = named(await view.nextEdit(0), 'C');
    await view.select(init.id);
    // While dragged over C's region, C isn't marked as where it drops.
    const from = await view.screenOf(init.id);
    const to = await view.toScreen(grown.x + grown.w - 40, grown.y + grown.h - 40);
    await view.page.mouse.move(from.x, from.y);
    await view.page.mouse.down();
    await view.page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
    await view.page.mouse.move(to.x, to.y, { steps: 4 });
    assert.equal(await view.page.locator(`#world g.vertex.drop-target[data-id="${c.id}"]`).count(), 0, 'C not marked');
    await view.page.mouse.up();
    const m = await view.nextEdit(1);
    assert.equal(m.vertices.find((v) => v.id === init.id)!.parent, rootRegion(m), 'still at the top level');
    assert.ok(await view.page.locator('#toast').isHidden(), 'no message');
    // C's initial pseudostate can't leave C: the machine's region has one.
    const inner = of(m, 'initial', c.regions![0].id);
    await view.select(inner.id);
    const at = await view.screenOf(inner.id);
    await view.page.mouse.click(at.x, at.y, { button: 'right' });
    await view.page.locator('.ctx-menu').waitFor();
    assert.equal(await view.page.locator('.ctx-menu button', { hasText: 'Leave Parent' }).count(), 0);
    await view.close();
  });

  it('leaves out a pasted initial pseudostate that would be a second in its region', async () => {
    const view = await Webview.open(sample());
    /** Copies the selection and pastes it, as the keyboard does; gives what was copied. */
    const paste = () => view.page.evaluate(() => {
      const w = globalThis as any;
      const copy = new w.DataTransfer();
      w.document.dispatchEvent(new w.ClipboardEvent('copy', { clipboardData: copy, bubbles: true, cancelable: true }));
      const data = new w.DataTransfer();
      data.setData('text/plain', copy.getData('text/plain'));
      w.document.dispatchEvent(new w.ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      return copy.getData('text/plain') as string;
    });
    const init = of(view.model, 'initial', rootRegion(view.model));
    await view.select(init.id);
    assert.equal(JSON.parse(await paste()).vertices[0].type, 'initial');
    await noEdit(view, 0, 'paste');
    assert.ok(await view.page.locator('#toast').isHidden(), 'no message');
    // With A: A is pasted, the initial pseudostate and its transition are left out.
    const a = named(view.model, 'A');
    const p = await view.screenOf(a.id);
    await view.page.keyboard.down('Shift');
    await view.page.mouse.click(p.x, p.y);
    await view.page.keyboard.up('Shift');
    await paste();
    const m = await view.nextEdit(0);
    assert.ok(m.vertices.some((v) => v.name === 'A2'), 'A2 pasted');
    assert.equal(m.vertices.filter((v) => v.type === 'initial' && v.parent === rootRegion(m)).length, 1);
    await view.close();
  });

  it("offers a submachine only to a state without regions or its own points, and none only without references", async () => {
    const view = await Webview.open(machine([
      { name: 'S', type: 'state', points: [{ name: 'p', type: 'entryPoint' }] },
      { name: 'P', type: 'state', submachine: 'Payment.fsm', points: [{ name: 'retry', type: 'entryPoint' }] },
      { name: 'Q', type: 'state' },
    ], { initial: { target: 'S' } }), { machines: { 'Payment.fsm': example('Payment') } });
    const options = () => view.field('Referenced state machine').locator('option').evaluateAll((os) => os.map((o) => (o as unknown as { value: string }).value));
    await view.select(named(view.model, 'S').id);
    assert.deepEqual(await options(), ['']);
    await view.select(named(view.model, 'P').id);
    assert.deepEqual(await options(), ['Payment.fsm']);
    await view.select(named(view.model, 'Q').id);
    assert.deepEqual(await options(), ['', 'Payment.fsm']);
    await view.close();
  });

  it('draws no transition from a fork to a pseudostate, nor a second one from an entry point into a region', async () => {
    const view = await Webview.open(machine([
      { name: 'A', type: 'state', transitions: [{ type: 'external', target: 'f*' }] },
      { name: 'f*', type: 'fork', transitions: [{ type: 'external', target: 'X' }, { type: 'external', target: 'Y' }] },
      {
        name: 'C', type: 'state', points: [{ name: 'in', type: 'entryPoint', transitions: [{ type: 'local', target: 'X' }] }], regions: [
          { name: 'r1', elements: [{ name: 'X', type: 'state' }, { name: 'X2', type: 'state' }] },
          { name: 'r2', elements: [{ name: 'Y', type: 'state' }] },
        ],
      },
      { name: 'ch*', type: 'choice', transitions: [{ type: 'external', target: 'A' }] },
    ], { initial: { target: 'A' } }));
    const handle = () => view.page.locator('[data-handle="connect"]').first().boundingBox().then((b) => ({ x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 }));
    await view.select('f*');
    await view.drag(await handle(), await view.screenOf('ch*'));
    await noEdit(view, 0, 'fork to a choice');
    await view.select('C.in');
    await view.drag(await handle(), await view.screenOf('X2'));
    await noEdit(view, 0, 'a second transition into r1');
    await view.select('C.in');
    await view.drag(await handle(), await view.screenOf('Y'));
    assert.ok(leaving(await view.nextEdit(0), 'C.in').some((t) => t.target === 'Y'), 'one into r2');
    await view.close();
  });

  it("draws no transition from an entry point out of its state, from an exit point into it, or from the machine's exit point", async () => {
    const view = await Webview.open(machine([
      { name: 'A', type: 'state' },
      { name: 'C', type: 'state', points: [{ name: 'in', type: 'entryPoint' }, { name: 'out', type: 'exitPoint' }], elements: [{ name: 'X', type: 'state' }] },
    ], { initial: { target: 'A' }, points: [{ name: 'stop', type: 'exitPoint' }] }));
    const handle = () => view.page.locator('[data-handle="connect"]').first().boundingBox().then((b) => ({ x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 }));
    await view.select('C.in');
    await view.drag(await handle(), await view.screenOf('A'));
    await noEdit(view, 0, 'entry point to outside its state');
    await view.select('C.out');
    await view.drag(await handle(), await view.screenOf('X'));
    await noEdit(view, 0, 'exit point to inside its state');
    await view.select('C.in');
    await view.drag(await handle(), await view.screenOf('X'));
    assert.ok(leaving(await view.nextEdit(0), 'C.in').some((t) => t.target === 'X'), 'entry point to inside its state');
    await view.select('M.stop');
    assert.equal(await view.page.locator('[data-handle="connect"]').count(), 0, "no handle on the machine's exit point");
    await view.close();
  });

  it('offers no name to initial and history pseudostates', async () => {
    const view = await Webview.open(sample());
    await view.select(of(view.model, 'initial', rootRegion(view.model)).id);
    assert.ok(!(await labels(view)).includes('Name'), 'initial');
    await view.select(of(view.model, 'shallowHistory').id);
    assert.ok(!(await labels(view)).includes('Name'), 'history');
    await view.select(of(view.model, 'choice').id);
    assert.ok((await labels(view)).includes('Name'), 'choice');
    await view.close();
  });

  it("shows a protocol transition's guard and action, and a behavioral one's conditions, only to remove them", async () => {
    let view = await Webview.open(machine([
      { name: 'A', type: 'state', transitions: [{ type: 'external', trigger: 'go', guard: 'g()', action: 'a()', target: 'A' }, { type: 'external', trigger: 'up', target: 'A' }] },
    ], { type: 'protocol', initial: { target: 'A' } }));
    let [t, u] = leaving(view.model, 'A');
    await view.select(u.id);
    for (const hidden of ['Guard', 'Action']) assert.ok(!(await labels(view)).includes(hidden), `protocol: no ${hidden}`);
    await view.select(t.id);
    for (const shown of ['Guard', 'Action']) assert.ok((await labels(view)).includes(shown), `protocol: ${shown} shown`);
    await view.field('Action').fill('');
    await view.field('Action').press('Enter');
    assert.equal(leaving(await view.nextEdit(0), 'A')[0].action, '', 'action removed');
    await view.close();

    view = await Webview.open(machine([
      { name: 'A', type: 'state', transitions: [{ type: 'external', trigger: 'go', precondition: 'p()', target: 'A' }, { type: 'external', trigger: 'up', target: 'A' }] },
    ], { initial: { target: 'A' } }));
    [t, u] = leaving(view.model, 'A');
    await view.select(u.id);
    assert.ok(!(await labels(view)).includes('Precondition'), 'behavioral: no Precondition');
    await view.select(t.id);
    assert.ok((await labels(view)).includes('Precondition'), 'behavioral: Precondition shown');
    await view.close();
  });

  it("doesn't reconnect a transition with a trigger onto a history pseudostate, or reverse one into it", async () => {
    const view = await Webview.open(sample());
    const c1 = named(view.model, 'C1');
    const history = of(view.model, 'shallowHistory');
    const [back, tick] = leaving(view.model, c1.id);
    // C1 → A on tick, its source dragged onto the history pseudostate.
    await view.select(tick.id);
    const end = (await view.page.locator(`[data-end="${tick.id}:source"]`).first().boundingBox())!;
    await view.drag({ x: end.x + end.width / 2, y: end.y + end.height / 2 }, await view.screenOf(history.id));
    await noEdit(view, 0, 'reconnect');
    assert.ok(await view.page.locator('#toast').isHidden(), 'no message');
    // C1 → C.history on back: no Reverse.
    await view.select(back.id);
    assert.equal(await view.page.locator('#props button', { hasText: 'Reverse' }).count(), 0);
    await view.close();
  });
});
