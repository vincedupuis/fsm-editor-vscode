// Builds standalone `fsm` executables (no Node.js needed) from out/cli.js with Bun.
// The templates are not embedded: they are copied next to each executable, in
// templates/, where `fsm -t <name>` finds them.
//
// Usage: npm run build:bin [-- --target <bun-target>,...]
//   default targets: bun-linux-x64, bun-linux-arm64, bun-darwin-x64, bun-darwin-arm64, bun-windows-x64
//   --target current  builds for this machine only
// Output: dist/fsm-<version>-<os>-<arch>/fsm[.exe] + templates/*.hbs
// Uses `bun` from the PATH, or `npx bun@1` when it isn't installed.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const ALL = ['bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-x64', 'bun-darwin-arm64', 'bun-windows-x64'];

const i = process.argv.indexOf('--target');
const requested = i > 0 ? process.argv[i + 1]?.split(',') ?? [] : ALL;
const current = `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
const targets = requested.map((t) => (t === 'current' ? current : t));
for (const t of targets) {
  if (!ALL.includes(t)) {
    console.error(`Unknown target ${t}; use one of ${ALL.join(', ')} or current.`);
    process.exit(2);
  }
}

const cli = join(root, 'out/cli.js');
if (!existsSync(cli)) {
  console.error('out/cli.js is missing: run npm run compile first.');
  process.exit(1);
}

const shell = process.platform === 'win32';
const hasBun = spawnSync('bun', ['--version'], { shell, stdio: 'ignore' }).status === 0;
const bun = hasBun ? ['bun'] : ['npx', '--yes', 'bun@1'];

for (const target of targets) {
  const [, os, arch] = target.split('-');
  const dir = join(root, 'dist', `fsm-${version}-${os}-${arch}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, os === 'windows' ? 'fsm.exe' : 'fsm');
  console.log(`Building ${target} → ${exe}`);
  const r = spawnSync(bun[0], [...bun.slice(1), 'build', cli, '--compile', `--target=${target}`, '--outfile', exe], {
    cwd: root,
    shell,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error(`Bun failed for ${target}.`);
    process.exit(1);
  }
  cpSync(join(root, 'templates'), join(dir, 'templates'), { recursive: true });
}
console.log('Done: see dist/.');
