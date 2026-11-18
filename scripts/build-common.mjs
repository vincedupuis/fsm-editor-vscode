// Builds fsm-editor-common (../fsm-editor-common, Rust) as WebAssembly and copies it into the extension, with
// fsm-cli's templates (../fsm-cli), the JSON Schemas the text view checks files against and the interface's cases:
// common/common.wasm, common/templates/*.jinja, common/schemas/*.schema.json (fsm-cli's fsm.schema.json for .fsm
// files, fsm-editor-common's fsm-layout.schema.json and api.schema.json) and common/api-cases (the unit tests replay
// them; not packaged). The workflows download them from fsm-editor-common's GitHub release instead
// (FSM_COMMON_VERSION in .github/workflows/release.yml).
//
// Usage: npm run build:common
// Needs Rust with the wasm32-unknown-unknown target (rustup target add wasm32-unknown-unknown). Uses `cargo` from
// the PATH, or else from ~/.cargo/bin.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const common = resolve(root, '../fsm-editor-common');
const cli = resolve(root, '../fsm-cli');
for (const [dir, repo] of [
  [common, 'fsm-editor-common'],
  [cli, 'fsm-cli'],
]) {
  if (!existsSync(join(dir, 'Cargo.toml'))) {
    console.error(`No ${repo} in ${dir}: check out https://github.com/vincedupuis/${repo} next to this repo.`);
    process.exit(1);
  }
}

const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const onPath = spawnSync(exe, ['--version'], { stdio: 'ignore' }).status === 0;
const cargo = onPath ? exe : join(homedir(), '.cargo', 'bin', exe);
const args = ['rustc', '--lib', '--crate-type', 'cdylib', '--profile', 'wasm', '--target', 'wasm32-unknown-unknown', '--locked'];
console.log(`${cargo} ${args.join(' ')}  (in ${common})`);
const r = spawnSync(cargo, args, { cwd: common, stdio: 'inherit' });
if (r.error || r.status !== 0) {
  console.error(r.error ? `Cannot run cargo: ${r.error.message}` : 'The WebAssembly build failed.');
  process.exit(1);
}

const out = join(root, 'common');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'templates'), { recursive: true });
copyFileSync(join(common, 'target/wasm32-unknown-unknown/wasm/fsm_editor_common.wasm'), join(out, 'common.wasm'));
for (const f of readdirSync(join(cli, 'templates')).filter((f) => f.endsWith('.jinja'))) {
  copyFileSync(join(cli, 'templates', f), join(out, 'templates', f));
}
mkdirSync(join(out, 'schemas'));
for (const dir of [join(cli, 'schemas'), join(common, 'schemas')]) {
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) copyFileSync(join(dir, f), join(out, 'schemas', f));
}
cpSync(join(common, 'api-cases'), join(out, 'api-cases'), { recursive: true });
console.log(`Done: ${out}`);
