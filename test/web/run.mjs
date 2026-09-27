// Runs the browser smoke test (test/web/index.ts) in VS Code for the Web with
// Chromium, on a temporary copy of examples/. Usage: npm run test:web
import { runTests } from '@vscode/test-web';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const workspace = mkdtempSync(join(tmpdir(), 'fsm-editor-web-'));
cpSync(join(root, 'examples'), workspace, { recursive: true });
try {
  await runTests({
    browserType: 'chromium',
    headless: true,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'out/test/web/index.js'),
    folderPath: workspace,
    quality: 'stable',
  });
  console.log('Browser smoke test passed.');
} catch (e) {
  console.error('Browser smoke test failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
