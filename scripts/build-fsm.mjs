// Builds the code generator, fsm-cli (../fsm-cli, Rust), as WebAssembly and copies it into the extension with its
// templates: fsm/fsm.wasm and fsm/templates/*.jinja. The release workflow downloads them from fsm-cli's GitHub
// release instead (FSM_CLI_VERSION in .github/workflows/release.yml).
//
// Usage: npm run build:fsm
// Needs Rust with the wasm32-unknown-unknown target (rustup target add wasm32-unknown-unknown). Uses `cargo` from
// the PATH, or else from ~/.cargo/bin.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const cli = resolve(root, '../fsm-cli');
if (!existsSync(join(cli, 'Cargo.toml'))) {
  console.error(`No fsm-cli in ${cli}: check out https://github.com/vincedupuis/fsm-cli next to this repo.`);
  process.exit(1);
}

const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const onPath = spawnSync(exe, ['--version'], { stdio: 'ignore' }).status === 0;
const cargo = onPath ? exe : join(homedir(), '.cargo', 'bin', exe);
const args = ['rustc', '--lib', '--crate-type', 'cdylib', '--profile', 'wasm', '--target', 'wasm32-unknown-unknown', '--locked'];
console.log(`${cargo} ${args.join(' ')}  (in ${cli})`);
const r = spawnSync(cargo, args, { cwd: cli, stdio: 'inherit' });
if (r.error || r.status !== 0) {
  console.error(r.error ? `Cannot run cargo: ${r.error.message}` : 'The WebAssembly build failed.');
  process.exit(1);
}

const out = join(root, 'fsm');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'templates'), { recursive: true });
copyFileSync(join(cli, 'target/wasm32-unknown-unknown/wasm/fsm_cli.wasm'), join(out, 'fsm.wasm'));
for (const f of readdirSync(join(cli, 'templates')).filter((f) => f.endsWith('.jinja'))) {
  copyFileSync(join(cli, 'templates', f), join(out, 'templates', f));
}
console.log(`Done: ${out}`);
