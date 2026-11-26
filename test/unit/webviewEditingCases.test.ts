/**
 * The editing cases shared with the other editions: each case is a machine of the geometry fixtures and steps
 * (editing operations in the diagram's coordinates), run here with the mouse and the keyboard in the webview
 * (webview.ts), and the two files the last edit wrote. Visual Studio's and JetBrains' Core tests run the same steps
 * on their `DiagramSession` and must write the same files: `fixtures/editing` is the reference, copied there.
 * `FSM_UPDATE_EDITING=1 npm run test:unit` rewrites it. Group ids, random for a new group, are compared renamed (`plainGroups`).
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { readMachine } from '../../src/common';
import { Vertex } from '../../src/model';
import { root } from './harness';
import { Webview, closeBrowser } from './webview';

after(closeBrowser);

const GEOMETRY = join(root, 'test/unit/fixtures/geometry');

/** A layout file with its group ids, which a new group takes at random, renamed group1, group2… in order of appearance. */
export function plainGroups(layout: string): string {
  const names = new Map<string, string>();
  return layout.replace(/"group": "([^"]*)"/g, (_, g: string) => {
    if (!names.has(g)) names.set(g, `group${names.size + 1}`);
    return `"group": "${names.get(g)}"`;
  });
}
const EDITING = join(root, 'test/unit/fixtures/editing');

/** An editing operation, in the diagram's coordinates; ids are those reading the files gives (derived from names). */
type Step =
  | { op: 'select'; ids: string[] }
  | { op: 'create'; tool: string; x: number; y: number }
  | { op: 'move'; dx: number; dy: number }
  | { op: 'resize'; corner: 'nw' | 'ne' | 'sw' | 'se'; dx: number; dy: number }
  | { op: 'divider'; state: string; index: number; delta: number }
  | { op: 'connect'; source: string; target: string }
  | { op: 'delete' }
  | { op: 'waypoint'; transition: string; x: number; y: number }
  | { op: 'unwaypoint'; transition: string; index: number }
  | { op: 'label'; transition: string; text: string }
  | { op: 'kind'; transition: string; kind: 'external' | 'local' | 'internal' }
  | { op: 'straighten' | 'reverse'; transition: string }
  | { op: 'addRegion' | 'internal'; state: string }
  | { op: 'removeRegion'; state: string; index: number }
  | { op: 'layout'; state: string; layout: 'vertical' | 'horizontal' }
  | { op: 'type'; id: string; type: string }
  | { op: 'group' | 'duplicate' | 'leave' }
  | { op: 'align'; anchor: string; horizontally: boolean }
  | { op: 'color'; id: string; color: string };

export const CASES: { name: string; machine: string; steps: Step[] }[] = [
  {
    name: 'create', machine: 'MediaPlayer', steps: [
      { op: 'create', tool: 'state', x: 1200, y: 300 },
      { op: 'create', tool: 'state', x: 650, y: 470 },
      { op: 'create', tool: 'choice', x: 1200, y: 450 },
      { op: 'create', tool: 'comment', x: 1200, y: 600 },
      { op: 'create', tool: 'final', x: 1250, y: 150 },
    ],
  },
  {
    name: 'move', machine: 'MediaPlayer', steps: [
      { op: 'select', ids: ['Off'] }, { op: 'move', dx: 47, dy: 33 },
      { op: 'select', ids: ['Stereo', 'Mono'] }, { op: 'move', dx: 3, dy: 23 },
      // Into On's region.
      { op: 'select', ids: ['Fault'] }, { op: 'move', dx: 200, dy: -130 },
    ],
  },
  {
    name: 'resize', machine: 'regions', steps: [
      { op: 'select', ids: ['Stacked'] }, { op: 'resize', corner: 'se', dx: 43, dy: 27 },
      { op: 'select', ids: ['Side'] }, { op: 'resize', corner: 'nw', dx: -17, dy: -12 },
      { op: 'select', ids: ['Single'] }, { op: 'resize', corner: 'ne', dx: 31, dy: -19 },
      { op: 'select', ids: ['X1'] }, { op: 'resize', corner: 'sw', dx: -13, dy: 22 },
    ],
  },
  {
    name: 'dividers', machine: 'regions', steps: [
      { op: 'divider', state: 'Stacked', index: 0, delta: 37 },
      { op: 'divider', state: 'Side', index: 0, delta: 53 },
    ],
  },
  {
    name: 'connect', machine: 'MediaPlayer', steps: [
      { op: 'connect', source: 'Off', target: 'Fault' },
      { op: 'connect', source: 'Stopped', target: 'Stopped' },
      { op: 'connect', source: 'choice1*', target: 'Paused' },
    ],
  },
  {
    name: 'waypoints', machine: 'MediaPlayer', steps: [
      { op: 'waypoint', transition: 'Off#2', x: 175, y: 200 },
      { op: 'unwaypoint', transition: 'Paused#4', index: 0 },
      { op: 'waypoint', transition: 'HD#1', x: 945, y: 275 },
    ],
  },
  {
    name: 'transitions', machine: 'MediaPlayer', steps: [
      { op: 'label', transition: 'Stopped#1', text: 'play [ready()] / start()' },
      { op: 'kind', transition: 'Paused#2', kind: 'internal' },
      { op: 'straighten', transition: 'Paused#4' },
      { op: 'reverse', transition: 'Stereo#1' },
    ],
  },
  {
    name: 'regions', machine: 'MediaPlayer', steps: [
      { op: 'addRegion', state: 'On' },
      { op: 'layout', state: 'On', layout: 'horizontal' },
      { op: 'removeRegion', state: 'Playing', index: 1 },
      { op: 'internal', state: 'Off' },
    ],
  },
  {
    name: 'groups', machine: 'groups', steps: [
      { op: 'select', ids: ['C'] }, { op: 'group' },
      { op: 'select', ids: ['C', 'choice1*'] }, { op: 'group' },
      { op: 'select', ids: ['D'] }, { op: 'group' },
    ],
  },
  {
    name: 'duplicate', machine: 'Order', steps: [
      { op: 'select', ids: ['Payment'] }, { op: 'duplicate' },
      { op: 'select', ids: ['Cart', 'Shipped'] }, { op: 'duplicate' },
    ],
  },
  {
    name: 'delete', machine: 'MediaPlayer', steps: [
      { op: 'select', ids: ['Playing'] }, { op: 'delete' },
      { op: 'select', ids: ['Paused#3'] }, { op: 'delete' },
      { op: 'select', ids: ['comment1*'] }, { op: 'delete' },
    ],
  },
  {
    name: 'types', machine: 'MediaPlayer', steps: [
      { op: 'type', id: 'choice1*', type: 'junction' },
      { op: 'type', id: 'On.deepHistory', type: 'shallowHistory' },
    ],
  },
  {
    name: 'leave', machine: 'MediaPlayer', steps: [
      { op: 'select', ids: ['Paused'] }, { op: 'leave' },
    ],
  },
  {
    name: 'align', machine: 'MediaPlayer', steps: [
      { op: 'select', ids: ['Off', 'Fault'] }, { op: 'align', anchor: 'Off', horizontally: false },
    ],
  },
  {
    name: 'colors', machine: 'MediaPlayer', steps: [
      { op: 'color', id: 'Off', color: '#30a46c' },
      { op: 'color', id: 'Stopped#1', color: '#e5484d' },
    ],
  },
];

/** Where a vertex is grabbed: its center, or the middle of a composite state's title bar. */
const grab = (v: Vertex) => ({ x: v.x + v.w / 2, y: (v.regions ?? []).length ? v.y + 10 : v.y + v.h / 2 });

async function run(view: Webview, step: Step, selected: string[]): Promise<void> {
  const page = view.page;
  const vertex = (id: string) => {
    const v = view.model.vertices.find((x) => x.id === id);
    if (!v) throw new Error(`no vertex ${id}`);
    return v;
  };
  const center = async (selector: string) => {
    const b = await page.locator(selector).first().boundingBox();
    if (!b) throw new Error(`nothing at ${selector}`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const zoom = (await view.view()).zoom;
  const by = (p: { x: number; y: number }, dx: number, dy: number) => ({ x: p.x + dx * zoom, y: p.y + dy * zoom });
  const button = (text: string) => page.locator('#props button', { hasText: text }).first().click();
  /** An inline edit a creation or a connection opens: closed unchanged. */
  const closeInline = async () => {
    await page.waitForTimeout(30);
    if (await page.locator('.inline-edit').count()) await page.keyboard.press('Escape');
  };
  const focus = () => page.locator('#canvas').focus();
  // A press within 500 ms of the last one, at the same place, is a double-click: reveal centers each element, so
  // the next one is often where the last press was.
  await page.waitForTimeout(520);
  switch (step.op) {
    case 'select': {
      selected.splice(0, selected.length, ...step.ids);
      await view.select(step.ids[0]);
      for (const id of step.ids.slice(1)) {
        const p = await view.toScreen(grab(vertex(id)).x, grab(vertex(id)).y);
        await page.keyboard.down('Shift');
        await page.mouse.click(p.x, p.y);
        await page.keyboard.up('Shift');
      }
      return;
    }
    case 'create': {
      await page.locator(`[data-tool="${step.tool}"]`).click();
      const p = await view.toScreen(step.x, step.y);
      await page.mouse.click(p.x, p.y);
      return closeInline();
    }
    case 'move': {
      const from = await view.toScreen(grab(vertex(selected[0])).x, grab(vertex(selected[0])).y);
      return view.drag(from, by(from, step.dx, step.dy));
    }
    case 'resize': {
      const from = await center(`[data-handle="resize-${step.corner}"]`);
      return view.drag(from, by(from, step.dx, step.dy));
    }
    case 'divider': {
      const v = vertex(step.state);
      const from = await center(`[data-handle="sep:${v.id}:${step.index}"]`);
      const horizontal = v.regionLayout === 'horizontal';
      return view.drag(from, by(from, horizontal ? step.delta : 0, horizontal ? 0 : step.delta));
    }
    case 'connect': {
      await page.locator('[data-tool="transition"]').click();
      const a = await view.toScreen(grab(vertex(step.source)).x, grab(vertex(step.source)).y);
      const b = await view.toScreen(grab(vertex(step.target)).x, grab(vertex(step.target)).y);
      await view.drag(a, b);
      return closeInline();
    }
    case 'delete':
      await focus();
      return page.keyboard.press('Delete');
    case 'waypoint': {
      await view.select(step.transition);
      const p = await view.toScreen(step.x, step.y);
      await page.mouse.click(p.x, p.y);
      return page.mouse.click(p.x, p.y);
    }
    case 'unwaypoint': {
      await view.select(step.transition);
      const p = await center(`[data-wp="${step.transition}:${step.index}"]`);
      await page.mouse.click(p.x, p.y);
      return page.mouse.click(p.x, p.y);
    }
    case 'label': {
      await view.select(step.transition);
      await focus();
      await page.keyboard.press('Enter');
      await page.locator('.inline-edit').fill(step.text);
      return page.locator('.inline-edit').press('Enter');
    }
    case 'kind':
      await view.select(step.transition);
      return void (await view.field('Kind').selectOption(step.kind));
    case 'straighten':
    case 'reverse':
      await view.select(step.transition);
      return button(step.op === 'straighten' ? 'Straighten' : 'Reverse');
    case 'addRegion':
      await view.select(step.state);
      return button('+ Add region');
    case 'internal':
      await view.select(step.state);
      return button('+ Add internal transition');
    case 'removeRegion':
      await view.select(step.state);
      return page.locator('#props button[title="Remove region and its contents"]').nth(step.index).click();
    case 'layout':
      await view.select(step.state);
      return void (await view.field('Region layout').selectOption(step.layout));
    case 'type':
      await view.select(step.id);
      return void (await view.field('Kind').selectOption(step.type));
    case 'group':
      await focus();
      return page.keyboard.press('g');
    case 'duplicate':
      await focus();
      return page.keyboard.press('ControlOrMeta+d');
    case 'leave':
    case 'align': {
      const id = step.op === 'align' ? step.anchor : selected[0];
      const p = await view.toScreen(grab(vertex(id)).x, grab(vertex(id)).y);
      await page.mouse.click(p.x, p.y, { button: 'right' });
      const item = step.op === 'align' ? (step.horizontally ? 'Align Horizontally' : 'Align Vertically') : 'Leave Parent';
      return page.locator('.ctx-menu button', { hasText: item }).click();
    }
    case 'color':
      await view.select(step.id);
      await page.locator('#props .color-field .swatch-btn').first().click();
      return page.locator(`.color-pop .swatch[title="${step.color}"]`).click();
  }
}

describe('webview: editing cases shared with the other editions', () => {
  it('writes the files of the editing fixtures', async () => {
    const update = !!process.env.FSM_UPDATE_EDITING;
    const failed: string[] = [];
    for (const c of CASES) {
      const read = readMachine(readFileSync(join(GEOMETRY, `${c.machine}.fsm`), 'utf8'), readFileSync(join(GEOMETRY, `${c.machine}.fsm.layout`), 'utf8'));
      if ('problems' in read) throw new Error(`${c.machine}: ${JSON.stringify(read.problems)}`);
      const view = await Webview.open(read.model);
      await view.page.waitForTimeout(50);
      // Room around the machine for the points the steps use (a view change, no edit).
      await view.page.locator('#canvas').focus();
      await view.page.keyboard.press('ControlOrMeta+-');
      await view.page.keyboard.press('ControlOrMeta+-');
      const selected: string[] = [];
      for (const [i, step] of c.steps.entries()) {
        const n = view.edits.length;
        await run(view, step, selected);
        if (step.op === 'select') continue;
        await view.nextEdit(n).catch(() => {
          throw new Error(`${c.name}, step ${i + 1} (${step.op}): no edit${view.toasts.length ? `; ${view.toasts.at(-1)}` : ''}`);
        });
        // The edits a step makes (a double-click on a bend point: its first click commits an unmoved drag too).
        await view.page.waitForTimeout(150);
      }
      assert.deepEqual(view.errors, [], c.name);
      const files = view.files.at(-1)!;
      await view.close();
      const fixture = `${JSON.stringify({ machine: c.machine, steps: c.steps, fsm: files.model, layout: plainGroups(files.layout) }, null, 2)}\n`;
      const file = join(EDITING, `${c.name}.json`);
      if (update) writeFileSync(file, fixture);
      else if (fixture !== readFileSync(file, 'utf8').replace(/\r\n/g, '\n')) failed.push(c.name);
    }
    assert.deepEqual(failed, [], 'edited differently from the editing fixtures (FSM_UPDATE_EDITING=1 writes them)');
  });
});
