/**
 * The Trace Player's UI in headless Chromium: its panel (media/tracePlayer.js), driven with the `state` messages
 * src/trace/player.ts posts, and the highlights the diagram editor (media/editor.js) draws for the `trace` message.
 * What the player computes (formats, replay) is trace.test.ts's.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Page } from 'playwright';
import { root } from './harness';
import { Webview, closeBrowser, example, launch } from './webview';

after(closeBrowser);

/** The panel with a stub host recording what it posts. */
async function openPanel(): Promise<{ page: Page; posted: any[]; state: (s: object) => Promise<void> }> {
  const page = await (await launch()).newPage({ viewport: { width: 700, height: 500 } });
  const posted: any[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.exposeFunction('__host', (m: any) => posted.push(m));
  await page.setContent('<!DOCTYPE html><html><head></head><body><div id="player"></div></body></html>');
  await page.addStyleTag({ path: join(root, 'media/tracePlayer.css') });
  await page.addScriptTag({ content: 'window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__host(m) });' });
  await page.addScriptTag({ path: join(root, 'media/tracePlayer.js') });
  if (errors.length) throw new Error(errors.join('; '));
  const state = async (s: object) => {
    await page.evaluate((m) => (globalThis as any).postMessage(m, '*'), { ...base, ...s } as any);
    await page.waitForTimeout(30);
  };
  return { page, posted, state };
}

/** A `state` message as the player posts it: two traces, five records, the cursor on the third. */
const base = {
  type: 'state',
  traces: [
    { name: 'a.log', path: '/logs/a.log', format: 'fsm', needsMachine: false, machine: '', records: 3, error: '' },
    { name: 'b.log', path: '/logs/b.log', format: 'fsm', needsMachine: true, machine: '', records: 2, error: '' },
  ],
  formats: ['fsm', 'custom'],
  count: 5,
  cursor: 2,
  time: '12:00:00.300',
  live: false,
  canFollow: true,
  playing: false,
  speed: 1,
  rows: [0, 1, 2, 3, 4].map((i) => ({
    index: i, time: `12:00:00.${i}00`, trace: i % 2, machine: 'MediaPlayer', color: 0,
    kind: ['enter', 'event', 'transition', 'exit', 'enter'][i], name: `r${i}`, resolved: i !== 4,
  })),
  problems: [],
};

const button = (page: Page, title: string) => page.locator(`button[title="${title}"]`);

describe('Trace Player panel', () => {
  it('offers Open Log… before any trace', async () => {
    const { page, posted, state } = await openPanel();
    assert.deepEqual(posted, [{ type: 'ready' }]);
    await state({ traces: [], count: 0, cursor: -1, rows: [] });
    await page.locator('button', { hasText: 'Open Log…' }).click();
    assert.deepEqual(posted.at(-1), { type: 'open' });
    await page.close();
  });

  it('shows the traces, the position and the records around the cursor', async () => {
    const { page, state } = await openPanel();
    await state({});
    assert.equal(await page.locator('.pos').textContent(), '3 / 5 · 12:00:00.300');
    assert.deepEqual(await page.locator('.trace .name').allTextContents(), ['a.log', 'b.log']);
    assert.deepEqual(await page.locator('.trace .muted').allTextContents(), ['3 records', '2 records']);
    assert.equal(await page.locator('tr').count(), 5);
    assert.equal(await page.locator('tr.current .what').textContent(), 'r2');
    assert.equal(await page.locator('tr.future').count(), 2);
    assert.equal(await page.locator('tr.unresolved .what').textContent(), 'r4');
    assert.equal(await page.locator('.slider').inputValue(), '2');
    assert.equal(await page.locator('.slider').getAttribute('max'), '4');
    // The second trace names no machine: its button asks for one.
    assert.equal(await page.locator('.btn.machine').textContent(), 'Choose machine…');
    await state({ problems: ['line 3: no state Foo'], traces: [{ ...base.traces[0], error: 'cannot read' }] });
    assert.equal(await page.locator('.problems').textContent(), '⚠ line 3: no state Foo');
    assert.equal(await page.locator('.trace.error .muted').textContent(), 'cannot read');
    await page.close();
  });

  it('plays, pauses, steps, seeks and goes live through its host', async () => {
    const { page, posted, state } = await openPanel();
    await state({});
    const last = () => posted.at(-1);
    await button(page, 'First record').click();
    assert.deepEqual(last(), { type: 'first' });
    await button(page, 'Previous record').click();
    assert.deepEqual(last(), { type: 'step', delta: -1 });
    await button(page, 'Next record').click();
    assert.deepEqual(last(), { type: 'step', delta: 1 });
    await button(page, 'Play from here (from the start at the end)').click();
    assert.deepEqual(last(), { type: 'play' });
    await state({ playing: true });
    await button(page, 'Pause').click();
    assert.deepEqual(last(), { type: 'pause' });
    await page.locator('tr', { hasText: 'r4' }).click();
    assert.deepEqual(last(), { type: 'seek', index: 4 });
    await page.locator('.slider').fill('1');
    assert.deepEqual(last(), { type: 'seek', index: 1 });
    await button(page, 'Follow the last record as the files grow').click();
    assert.deepEqual(last(), { type: 'live' });
    await page.locator('select[title="Playing speed"]').selectOption('5');
    assert.deepEqual(last(), { type: 'speed', speed: 5 });
    await page.locator('select[title="Format of the lines"]').nth(1).selectOption('custom');
    assert.deepEqual(last(), { type: 'format', trace: 1, format: 'custom' });
    await page.locator('.btn.machine').click();
    assert.deepEqual(last(), { type: 'machine', trace: 1 });
    await page.locator('.btn.close').first().click();
    assert.deepEqual(last(), { type: 'close', trace: 0 });
    await page.locator('button', { hasText: 'Open Log…' }).click();
    assert.deepEqual(last(), { type: 'open' });
    await page.close();
  });

  it('disables what does nothing at the ends, and without records', async () => {
    const { page, state } = await openPanel();
    const disabled = (title: string) => button(page, title).isDisabled();
    await state({ cursor: -1 });
    assert.ok(await disabled('Previous record'), 'nothing before the start');
    assert.ok(!(await disabled('Next record')));
    await state({ cursor: 4 });
    assert.ok(await disabled('Next record'), 'nothing after the end');
    assert.ok(!(await disabled('Previous record')));
    await state({ count: 0, cursor: -1, rows: [], time: '' });
    assert.equal(await page.locator('.pos').textContent(), 'No records yet');
    assert.ok(await disabled('First record'));
    assert.ok(await disabled('Play from here (from the start at the end)'));
    assert.ok(await page.locator('.slider').isDisabled());
    await state({ canFollow: false, live: false });
    assert.equal(await button(page, 'Follow the last record as the files grow').count(), 0, 'no Live where logs cannot be followed (web)');
    await state({ live: true });
    assert.ok(await button(page, 'Follow the last record as the files grow').evaluate((b) => b.classList.contains('on')));
    await page.close();
  });
});

describe('Trace Player highlights in the diagram', () => {
  it('marks the active states, the transitions taken and the current record, per instance', async () => {
    const model = example('MediaPlayer');
    const view = await Webview.open(model);
    const id = (name: string) => model.vertices.find((v) => v.name === name)!.id;
    const t = model.transitions.find((x) => x.source === id('Stopped') && x.target === id('Playing'))!;
    const classes = (sel: string) => view.page.locator(`#world [data-id="${sel}"]`).first().getAttribute('class').then((c) => (c ?? '').split(' '));
    const instance = (color: number, active: string[], extra: object = {}) => ({ label: `MediaPlayer#${color}`, color, active, taken: [], via: [], current: [], ...extra });
    await view.send({ type: 'trace', highlight: { instances: [instance(0, [id('On'), id('Playing')], { taken: [t.id], current: [id('Playing')], event: 'play' })] } });
    await view.page.waitForTimeout(50);
    assert.ok((await classes(id('Playing'))).includes('trace-active'));
    assert.ok((await classes(id('Playing'))).includes('trace-current'));
    assert.ok((await classes(id('Playing'))).includes('trace-c0'));
    assert.ok(!(await classes(id('Stopped'))).includes('trace-active'));
    assert.ok((await classes(t.id)).includes('trace-taken'));
    assert.match((await view.page.locator('.trace-status').textContent()) ?? '', /event play/);
    // A second instance in Stopped: its color, and a dot per instance on the state both have active.
    await view.send({ type: 'trace', highlight: { instances: [instance(0, [id('On'), id('Playing')]), instance(1, [id('On'), id('Stopped')])] } });
    await view.page.waitForTimeout(50);
    assert.ok((await classes(id('Stopped'))).includes('trace-c1'));
    assert.equal(await view.page.locator('#world .trace-dot').count(), 2, 'two dots on On');
    // The export shows no trace.
    assert.doesNotMatch(await view.svg(), /trace-/);
    await view.send({ type: 'trace', highlight: null });
    await view.page.waitForTimeout(50);
    assert.equal(await view.page.locator('#world .trace-active').count(), 0, 'cleared');
    assert.equal(await view.page.locator('.trace-status').count(), 0);
    assert.equal(view.edits.length, 0, 'a highlight is no edit');
    await view.close();
  });
});
