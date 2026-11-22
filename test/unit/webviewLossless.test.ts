/**
 * The webview doesn't offer what the file can't hold (media/editor.js): the fields, kinds and menu items it leaves
 * out, and the edits it refuses with a message, so that the writer never has to refuse one (`LostError`).
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
const HISTORY_ONLY = 'A transition leaving a history pseudostate holds its target and an action only.';
const ANCHOR = 'A comment cannot be attached to an initial pseudostate or to its transition.';

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

  it('refuses to attach a comment to an initial pseudostate', async () => {
    const view = await Webview.open(sample());
    await view.page.locator('[data-tool="transition"]').click();
    await view.drag(await view.screenOf(named(view.model, 'note*').id), await view.screenOf(of(view.model, 'initial', rootRegion(view.model)).id));
    await noEdit(view, 0, 'comment → initial');
    assert.equal(await toast(view), ANCHOR);
    await view.close();
  });

  it("refuses to drop an initial pseudostate into a region that has one, and leaves out Leave Parent", async () => {
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
    await view.drag(await view.screenOf(init.id), await view.toScreen(grown.x + grown.w - 40, grown.y + grown.h - 40));
    const m = await view.nextEdit(1);
    assert.equal(m.vertices.find((v) => v.id === init.id)!.parent, rootRegion(m), 'still at the top level');
    assert.equal(await toast(view), 'This region already has an initial pseudostate.');
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
    await view.select(of(view.model, 'initial', rootRegion(view.model)).id);
    const data = await view.page.evaluate(() => {
      const w = globalThis as any;
      const copy = new w.DataTransfer();
      w.document.dispatchEvent(new w.ClipboardEvent('copy', { clipboardData: copy, bubbles: true, cancelable: true }));
      const paste = new w.DataTransfer();
      paste.setData('text/plain', copy.getData('text/plain'));
      w.document.dispatchEvent(new w.ClipboardEvent('paste', { clipboardData: paste, bubbles: true, cancelable: true }));
      return copy.getData('text/plain') as string;
    });
    assert.equal(JSON.parse(data).vertices[0].type, 'initial');
    await noEdit(view, 0, 'paste');
    assert.equal(await toast(view), 'This region already has an initial pseudostate.');
    await view.close();
  });

  it("refuses a submachine for a state with entry or exit points, and none for a state with references", async () => {
    const view = await Webview.open(machine([
      { name: 'S', type: 'state', points: [{ name: 'p', type: 'entryPoint' }] },
      { name: 'P', type: 'state', submachine: 'Payment.fsm', points: [{ name: 'retry', type: 'entryPoint' }] },
    ], { initial: { target: 'S' } }), { machines: { 'Payment.fsm': example('Payment') } });
    await view.select(named(view.model, 'S').id);
    await view.field('Referenced state machine').selectOption('Payment.fsm');
    await noEdit(view, 0, 'S as a submachine state');
    assert.match((await toast(view)) ?? '', /^Remove the entry and exit points first/);
    await view.select(named(view.model, 'P').id);
    await view.field('Referenced state machine').selectOption('');
    await noEdit(view, 0, 'P without its submachine');
    assert.match((await toast(view)) ?? '', /^Remove the connection point references first/);
    await view.close();
  });

  it('refuses to reconnect or reverse a transition with a trigger onto a history pseudostate', async () => {
    const view = await Webview.open(sample());
    const c1 = named(view.model, 'C1');
    const history = of(view.model, 'shallowHistory');
    const [back, tick] = leaving(view.model, c1.id);
    // C1 → A on tick, its source dragged onto the history pseudostate.
    await view.select(tick.id);
    const end = (await view.page.locator(`[data-end="${tick.id}:source"]`).first().boundingBox())!;
    await view.drag({ x: end.x + end.width / 2, y: end.y + end.height / 2 }, await view.screenOf(history.id));
    await noEdit(view, 0, 'reconnect');
    assert.equal(await toast(view), HISTORY_ONLY);
    // C1 → C.history on back, reversed.
    await view.select(back.id);
    await view.page.locator('#props button', { hasText: 'Reverse' }).click();
    await noEdit(view, 0, 'reverse');
    assert.equal(await toast(view), 'This transition cannot be reversed.');
    await view.close();
  });
});
