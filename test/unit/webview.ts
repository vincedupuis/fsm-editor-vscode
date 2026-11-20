/**
 * The diagram editor's webview (media/editor.js, media/editor.css) in headless Chromium (Playwright's, which
 * `npm install` brings for the web test), without VS Code: `acquireVsCodeApi` is a stub, and a host in this
 * process answers the webview's messages as src/fsmEditorProvider.ts does, through fsm-editor-common (an edit is
 * written and read back, its model sent back as an update; the grammar's checks; validation).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Browser, Page, chromium } from 'playwright';
import { LostError, checkText, readMachine, validate, writeMachine } from '../../src/common';
import { FsmModel } from '../../src/model';
import { root } from './harness';

const HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>FSM Editor</title></head>
<body>
  <div id="app" data-panels='{"toolbox":true,"props":true}'>
    <div id="toolbar"></div>
    <div id="main">
      <aside id="toolbox-pane" class="side left"><div class="side-head"><span>Toolbox</span></div><div id="toolbox"></div></aside>
      <div id="canvas-wrap">
        <svg id="canvas" tabindex="0"><g id="world"></g></svg>
        <div id="problems" hidden></div>
        <div id="toast" hidden><span id="toast-text"></span><button id="toast-close" title="Close" aria-label="Close">×</button></div>
        <div id="parse-error" hidden></div>
      </div>
      <aside id="props-pane" class="side right"><div class="side-head"><span>Properties</span></div><div id="props" class="props"></div></aside>
    </div>
    <div id="statusbar"></div>
  </div>
</body>
</html>`;

/** VS Code's theme variables the stylesheet reads, so that the page looks like a light theme. */
const THEME = `:root { --vscode-font-family: sans-serif; --vscode-font-size: 13px; --vscode-editor-background: #fff;
  --vscode-foreground: #333; --vscode-editor-foreground: #333; --vscode-sideBar-background: #f3f3f3;
  --vscode-panel-border: #ccc; --vscode-focusBorder: #0078d4; --vscode-button-background: #0078d4;
  --vscode-button-foreground: #fff; --vscode-input-background: #fff; --vscode-input-foreground: #333;
  --vscode-input-border: #ccc; --vscode-errorForeground: #e51400; }`;

let browser: Browser | undefined;

/** The browser shared by the tests of a file; `closeBrowser()` in its `after`. */
async function launch(): Promise<Browser> {
  browser ??= await chromium.launch();
  return browser;
}

export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = undefined;
}

export interface OpenOptions {
  readonly?: boolean;
  /** Text measured as Visual Studio's and JetBrains' Core estimate it (6.6 px a character), not with the font:
   * the drawing doesn't depend on the machine's fonts, and can be compared with theirs. */
  estimateText?: boolean;
  width?: number;
  height?: number;
}

export class Webview {
  /** Every message the webview posted, in order. */
  readonly posted: any[] = [];
  /** The model texts the webview sent as edits, as written and read back. */
  readonly edits: FsmModel[] = [];
  /** The toasts the host sent (an edit the format can't hold). */
  readonly toasts: string[] = [];
  private text: string;
  private exports = 0;

  private constructor(
    readonly page: Page,
    model: FsmModel,
    private readonly readonly: boolean,
  ) {
    this.text = JSON.stringify(model);
  }

  static async open(model: FsmModel, opts: OpenOptions = {}): Promise<Webview> {
    const page = await (await launch()).newPage({ viewport: { width: opts.width ?? 1400, height: opts.height ?? 900 } });
    const view = new Webview(page, model, !!opts.readonly);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.exposeFunction('__host', (msg: any) => view.onMessage(msg));
    await page.setContent(HTML);
    await page.addStyleTag({ content: THEME });
    await page.addStyleTag({ path: join(root, 'media/editor.css') });
    await page.addScriptTag({
      content: `window.acquireVsCodeApi = () => { let state; return { postMessage: (m) => window.__host(m),
        getState: () => state, setState: (s) => { state = s; } }; };`,
    });
    if (opts.estimateText) {
      await page.addScriptTag({ content: `CanvasRenderingContext2D.prototype.measureText = function (t) { return { width: String(t).length * 6.6 }; };` });
    }
    await page.addScriptTag({ path: join(root, 'media/editor.js') });
    await page.waitForSelector('#world g.vertex', { timeout: 10000 }).catch(() => undefined);
    if (errors.length) throw new Error(`the webview failed: ${errors.join('; ')}`);
    view.errors = errors;
    return view;
  }

  /** Script errors of the page since it opened. */
  errors: string[] = [];

  /** The model the webview shows, as the host last sent it. */
  get model(): FsmModel {
    return JSON.parse(this.text);
  }

  async close(): Promise<void> {
    await this.page.close();
  }

  /** A message to the webview, as the extension posts it. */
  async send(msg: unknown): Promise<void> {
    await this.page.evaluate((m) => (globalThis as any).postMessage(m, '*'), msg as any);
  }

  private update(): Promise<void> {
    let issues: unknown[] = [];
    try {
      issues = validate(this.model);
    } catch {
      // as the provider: an update without issues
    }
    return this.send({ type: 'update', text: this.text, issues, submachines: {}, machines: [], readonly: this.readonly });
  }

  private async onMessage(msg: any): Promise<void> {
    this.posted.push(msg);
    switch (msg?.type) {
      case 'ready':
        await this.update();
        break;
      case 'edit': {
        try {
          const written = writeMachine(JSON.parse(msg.text));
          const read = readMachine(written.modelText, written.layoutText);
          if ('problems' in read) throw new Error(JSON.stringify(read.problems));
          this.text = JSON.stringify(read.model);
          this.edits.push(read.model);
        } catch (e) {
          const message = e instanceof LostError ? e.message : `the edit can't be written: ${(e as Error).message}`;
          this.toasts.push(message);
          await this.send({ type: 'toast', message });
        }
        await this.update();
        break;
      }
      case 'checkText': {
        let result: unknown;
        try {
          result = checkText(String(msg.kind), String(msg.text ?? ''), !!msg.allowElse);
        } catch (e) {
          result = { ok: false, error: (e as Error).message };
        }
        await this.send({ type: 'checkedText', requestId: msg.requestId, result });
        break;
      }
    }
  }

  /** Waits until `probe` holds (polled), else fails with `what`. */
  async until(what: string, probe: () => boolean, timeoutMs = 5000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!probe()) {
      if (Date.now() > end) throw new Error(`timed out: ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Waits for the next edit after `count` edits, and gives its model. */
  async nextEdit(count = this.edits.length): Promise<FsmModel> {
    await this.until('an edit', () => this.edits.length > count);
    await this.page.waitForTimeout(50); // the update rendered
    return this.edits[this.edits.length - 1];
  }

  /** The SVG export, as Export as SVG asks the webview for it. */
  async svg(): Promise<string> {
    const requestId = ++this.exports;
    await this.send({ type: 'requestSvg', requestId });
    await this.until('the SVG export', () => this.posted.some((m) => m.type === 'svg' && m.requestId === requestId));
    return this.posted.find((m) => m.type === 'svg' && m.requestId === requestId).svg;
  }

  /** Screen position of a model point (its center when given a vertex id). */
  async screenOf(id: string): Promise<{ x: number; y: number }> {
    const box = await this.page.locator(`#world g.vertex[data-id="${id}"]`).first().boundingBox();
    if (!box) throw new Error(`no vertex ${id} on screen`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
}

/** A machine of the examples folder, read as the extension reads it. */
export function example(name: string): FsmModel {
  const r = readMachine(readFileSync(join(root, 'examples', `${name}.fsm`), 'utf8'), readFileSync(join(root, 'examples', `${name}.fsm.layout`), 'utf8'));
  if ('problems' in r) throw new Error(JSON.stringify(r.problems));
  return r.model;
}
