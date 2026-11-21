// Install smoke test: packages the extension (vsce), installs the VSIX into a new extensions folder of desktop
// VS Code (the latest stable, downloaded by @vscode/test-electron), and runs the smoke test (test/web/index.ts, as
// out/test/desktop/index.js) against the installed extension, on a copy of examples/. The extension under test is the
// installed one: test/install/runner is an empty extension that only hosts the tests.
// Usage: npm run test:install (on Linux without a display: xvfb-run -a npm run test:install)
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const temp = mkdtempSync(join(tmpdir(), 'fsm-editor-install-'));
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
};
try {
  const vsix = join(temp, 'fsm-editor.vsix');
  run('npx', ['@vscode/vsce', 'package', '--no-dependencies', '-o', vsix]);
  const vscodePath = await downloadAndUnzipVSCode('stable');
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodePath);
  const extensions = join(temp, 'extensions');
  const user = join(temp, 'user');
  run(cli, [...cliArgs, '--extensions-dir', extensions, '--user-data-dir', user, '--install-extension', vsix]);
  const workspace = join(temp, 'workspace');
  cpSync(join(root, 'examples'), workspace, { recursive: true });
  await runTests({
    vscodeExecutablePath: vscodePath,
    extensionDevelopmentPath: join(root, 'test/install/runner'),
    extensionTestsPath: join(root, 'out/test/desktop/index.js'),
    launchArgs: [workspace, '--extensions-dir', extensions, '--user-data-dir', user, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
  });
  console.log('Install smoke test passed.');
} catch (e) {
  console.error('Install smoke test failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
