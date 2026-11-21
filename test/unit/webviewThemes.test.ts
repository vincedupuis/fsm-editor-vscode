/**
 * The diagram in VS Code's built-in themes and with the machine's real fonts, in headless Chromium (webview.ts):
 * every text and every mark the editor colors (selection, problems, the Trace Player's highlights) is measured
 * against what lies behind it (WCAG contrast ratios), and every line of text is measured inside its box. No stored
 * screenshots: fonts differ between machines, contrast and fit don't depend on them.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { readMachine } from '../../src/common';
import { FsmModel } from '../../src/model';
import { Webview, closeBrowser, example } from './webview';

after(closeBrowser);

/**
 * The variables editor.css reads, as VS Code 1.10x sets them for its default themes: the theme files' colors
 * (`extensions/theme-defaults/themes`), else the color registry's defaults for the theme's kind.
 */
const THEMES: Record<string, Record<string, string>> = {
  'Light Modern': {
    '--vscode-editor-background': '#ffffff', '--vscode-editor-foreground': '#3b3b3b', '--vscode-foreground': '#3b3b3b',
    '--vscode-editorWidget-background': '#f8f8f8', '--vscode-focusBorder': '#005fb8', '--vscode-panel-border': '#e5e5e5',
    '--vscode-editorError-foreground': '#e51400', '--vscode-editorWarning-foreground': '#bf8803', '--vscode-editorInfo-foreground': '#0063d3',
    '--vscode-charts-green': '#388a34', '--vscode-charts-orange': '#d18616', '--vscode-charts-yellow': '#bf8803',
    '--vscode-charts-blue': '#0063d3', '--vscode-charts-purple': '#652d90', '--vscode-descriptionForeground': '#3b3b3b',
  },
  'Dark Modern': {
    '--vscode-editor-background': '#1f1f1f', '--vscode-editor-foreground': '#cccccc', '--vscode-foreground': '#cccccc',
    '--vscode-editorWidget-background': '#202020', '--vscode-focusBorder': '#0078d4', '--vscode-panel-border': '#2b2b2b',
    '--vscode-editorError-foreground': '#f14c4c', '--vscode-editorWarning-foreground': '#cca700', '--vscode-editorInfo-foreground': '#59a4f9',
    '--vscode-charts-green': '#89d185', '--vscode-charts-orange': '#d18616', '--vscode-charts-yellow': '#cca700',
    '--vscode-charts-blue': '#59a4f9', '--vscode-charts-purple': '#b180d7', '--vscode-descriptionForeground': '#9d9d9d',
  },
  'Dark High Contrast': {
    '--vscode-editor-background': '#000000', '--vscode-editor-foreground': '#ffffff', '--vscode-foreground': '#ffffff',
    '--vscode-editorWidget-background': '#0c141f', '--vscode-focusBorder': '#f38518', '--vscode-panel-border': '#6fc3df',
    '--vscode-editorError-foreground': '#f48771', '--vscode-editorWarning-foreground': '#ffd370', '--vscode-editorInfo-foreground': '#59a4f9',
    '--vscode-charts-green': '#89d185', '--vscode-charts-orange': '#ab5a00', '--vscode-charts-yellow': '#ffd370',
    '--vscode-charts-blue': '#59a4f9', '--vscode-charts-purple': '#b180d7', '--vscode-descriptionForeground': 'rgba(255, 255, 255, 0.7)',
  },
  'Light High Contrast': {
    '--vscode-editor-background': '#ffffff', '--vscode-editor-foreground': '#292929', '--vscode-foreground': '#292929',
    '--vscode-editorWidget-background': '#ffffff', '--vscode-focusBorder': '#006bbd', '--vscode-panel-border': '#0f4a85',
    '--vscode-editorError-foreground': '#b5200d', '--vscode-editorWarning-foreground': '#895503', '--vscode-editorInfo-foreground': '#0063d3',
    '--vscode-charts-green': '#374e06', '--vscode-charts-orange': '#0f4a85', '--vscode-charts-yellow': '#895503',
    '--vscode-charts-blue': '#0063d3', '--vscode-charts-purple': '#652d90', '--vscode-descriptionForeground': 'rgba(41, 41, 41, 0.7)',
  },
};

/** WCAG 2.1: 4.5 for text, 3 for the lines and shapes that carry meaning (1.4.3, 1.4.11). */
const TEXT = 4.5;
const MARK = 3;

/** The body class VS Code gives a webview in each theme. */
const KIND: Record<string, string> = {
  'Light Modern': 'vscode-light',
  'Dark Modern': 'vscode-dark',
  'Dark High Contrast': 'vscode-high-contrast',
  'Light High Contrast': 'vscode-high-contrast-light',
};

interface Measure {
  what: string;
  ratio: number;
}

/**
 * In the page: the contrast of each text (against the fill of the shape it lies on, or the canvas) and of each
 * colored mark of the selected, problem and traced elements (against the canvas and the state's fill).
 */
function measure(): { texts: Measure[]; marks: Measure[] } {
  // The page's globals: the extension's tsconfig has no DOM types.
  type Element = any;
  const { document, getComputedStyle } = globalThis as any;
  const parse = (c: string): number[] | null => {
    let m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    m = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(c);
    if (m) return [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255, m[4] === undefined ? 1 : Number(m[4])];
    return null;
  };
  const over = (fg: number[], bg: number[], alpha = 1) => {
    const a = fg[3] * alpha;
    return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)).concat(1);
  };
  const lum = (c: number[]) => {
    const [r, g, b] = c.slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const canvas = parse(getComputedStyle(document.body).backgroundColor)!;
  const opacity = (el: Element) => {
    let o = 1;
    for (let e: Element | null = el; e && e.id !== 'world'; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  };
  const vertexFill = (g: Element | null) => {
    const shape = g?.querySelector(':scope > .shape');
    const f = shape && parse(getComputedStyle(shape).fill);
    return f ? over(f, canvas) : canvas;
  };
  const name = (el: Element) => {
    const g = el.closest('[data-id]');
    return `${g?.getAttribute('data-id')} ${el.getAttribute('class') ?? el.tagName}${el.textContent ? ` "${el.textContent.slice(0, 30)}"` : ''}`;
  };
  const texts: Measure[] = [];
  for (const t of document.querySelectorAll('#world text')) {
    const fill = parse(getComputedStyle(t).fill);
    if (!fill || !t.textContent?.trim()) continue;
    // A transition's label has a halo of the canvas color; a vertex's text lies on its shape.
    const bg = t.classList.contains('tlabel') ? canvas : vertexFill(t.closest('g.vertex'));
    texts.push({ what: name(t), ratio: ratio(over(fill, bg, opacity(t)), bg) });
  }
  const marks: Measure[] = [];
  const marked = '.selected, .has-error, .has-warning, .trace-active, .trace-taken';
  for (const g of document.querySelectorAll(`#world g.vertex:is(${marked}), #world g.transition:is(${marked})`)) {
    for (const el of g.querySelectorAll(':scope > .shape, :scope > .stroke, :scope > .fill, :scope > .line, :scope > .arrow')) {
      const cs = getComputedStyle(el);
      const paint = el.classList.contains('fill') ? cs.fill : cs.stroke;
      const c = parse(paint);
      if (!c) continue;
      const inner = g.classList.contains('vertex') ? vertexFill(g) : canvas;
      const r = Math.min(ratio(over(c, canvas), canvas), ratio(over(c, inner), inner));
      marks.push({ what: `${g.getAttribute('class')}: ${name(el)}`, ratio: r });
    }
  }
  return { texts, marks };
}

/** MediaPlayer with one state selected, one transition selected, problems on two elements and a trace on others. */
async function marked(view: Webview, model: FsmModel) {
  const id = (n: string) => model.vertices.find((v) => v.name === n)!.id;
  const t = model.transitions.find((x) => x.source === id('Stopped') && x.target === id('Playing'))!;
  const u = model.transitions.find((x) => x.source === id('Off'))!;
  await view.send({
    type: 'update', text: JSON.stringify(model), submachines: {}, machines: [], readonly: false,
    issues: [
      { id: id('Paused'), severity: 'error', message: 'e' },
      { id: id('Off'), severity: 'warning', message: 'w' },
      { id: u.id, severity: 'error', message: 'e' },
    ],
  });
  await view.send({
    type: 'trace',
    highlight: { instances: [{ label: 'MediaPlayer', color: 0, active: [id('On'), id('Playing')], taken: [t.id], via: [], current: [id('Playing')], event: 'play' }] },
  });
  await view.select(id('Stopped'));
}

describe('webview: themes and fonts', () => {
  for (const [theme, vars] of Object.entries(THEMES)) {
    it(`draws text, selection, problems and the trace readably in ${theme}`, async () => {
      const model = example('MediaPlayer');
      const view = await Webview.open(model, { theme: vars, themeKind: KIND[theme] });
      await marked(view, model);
      const { texts, marks } = await view.page.evaluate(measure);
      assert.ok(texts.length > 20 && marks.length > 5, `measured ${texts.length} texts and ${marks.length} marks`);
      const low = [
        ...texts.filter((m) => m.ratio < TEXT).map((m) => `text ${m.what}: ${m.ratio.toFixed(2)} < ${TEXT}`),
        ...marks.filter((m) => m.ratio < MARK).map((m) => `mark ${m.what}: ${m.ratio.toFixed(2)} < ${MARK}`),
      ];
      assert.deepEqual(low, [], 'contrast too low');
      await view.close();
    });
  }

  it('keeps every line of text inside its box with the real fonts', async () => {
    const long = readMachine(JSON.stringify({
      version: 1, name: 'M', type: 'behavioral', initial: { target: 'Busy' },
      elements: [
        {
          name: 'Busy', type: 'state', stereotype: 'Critical',
          entry: 'openTheConnectionToTheServer(); sendTheGreeting(); startTheKeepAliveTimer(); logTheStart()',
          exit: 'closeEverything()', do: 'pollTheServerForNewMessagesAndQueueThem()',
          invariant: 'isConnected() && !isShuttingDown() && hasCredentials()', defer: 'refreshTheListOfContacts, reloadTheSettings',
          transitions: [{ type: 'internal', trigger: 'pingFromTheServerWithAVeryLongName', action: 'answerThePingWithAPongRightAway()' }],
        },
        { name: 'note*', type: 'comment', text: 'A comment long enough to wrap over several lines inside its note, with a VeryLongWordThatCannotBreakAnywhereAtAll in it.' },
      ],
    }), undefined);
    if ('problems' in long) throw new Error(JSON.stringify(long.problems));
    const failed: string[] = [];
    for (const model of [long.model, example('MediaPlayer'), example('Order'), example('Payment')]) {
      const view = await Webview.open(model);
      const out = await view.page.evaluate(() => {
        const { document } = globalThis as any;
        const bad: string[] = [];
        let lines = 0;
        for (const g of document.querySelectorAll('#world g.vertex.v-state, #world g.vertex.v-comment')) {
          const shape = g.querySelector(':scope > .shape');
          if (!shape) continue;
          const b = shape.getBBox();
          // A state invariant is drawn under its state, on one line.
          for (const t of g.querySelectorAll(':scope > text:not(.invariant)')) {
            const r = t.getBBox();
            if (!t.textContent?.trim()) continue;
            lines++;
            if (r.x < b.x - 0.5 || r.x + r.width > b.x + b.width + 0.5) {
              bad.push(`${g.getAttribute('data-id')} "${t.textContent.slice(0, 40)}": ${r.x.toFixed(1)}..${(r.x + r.width).toFixed(1)} outside ${b.x}..${b.x + b.width}`);
            }
          }
        }
        return { bad, lines };
      });
      assert.ok(out.lines > 5, `${model.name}: ${out.lines} lines measured`);
      failed.push(...out.bad.map((s) => `${model.name}: ${s}`));
      await view.close();
    }
    assert.deepEqual(failed, [], 'text outside its box');
  });
});
