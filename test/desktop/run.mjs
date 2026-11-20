// Runs the smoke test (test/web/index.ts, bundled for Node into out/test/desktop/index.js) in desktop VS Code
// (Electron, the latest stable, downloaded once into .vscode-test/), on a temporary copy of examples/ on disk.
// Usage: npm run test:desktop (on Linux without a display: xvfb-run -a npm run test:desktop)
import { runTests } from '@vscode/test-electron';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const temp = mkdtempSync(join(tmpdir(), 'fsm-editor-desktop-'));
const workspace = join(temp, 'workspace');
cpSync(join(root, 'examples'), workspace, { recursive: true });
try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'out/test/desktop/index.js'),
    // A profile of its own, without the user's extensions; the built-in ones (Git) stay.
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--user-data-dir', join(temp, 'user'), '--skip-welcome', '--skip-release-notes'],
  });
  console.log('Desktop smoke test passed.');
} catch (e) {
  console.error('Desktop smoke test failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
