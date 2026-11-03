/**
 * Runs fsm-generator (github.com/vincedupuis/fsm-generator), the code generator
 * in Rust with Jinja templates, for `.jinja` templates. Desktop only: the web
 * build replaces this module with fsmGenerator.web.ts (see esbuild.mjs), so
 * this is the one extension module besides cli.ts that may use Node modules.
 *
 * The extension bundles it in generator/<platform>/, with its templates in
 * generator/<platform>/templates.
 */
import { execFile } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export interface GeneratorResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const exe = process.platform === 'win32' ? 'fsm-generator.exe' : 'fsm-generator';

/** Platform folder name, as in fsm-generator's release archives (`fsm-generator-<version>-<platform>`). */
export function platform(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  return `${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The executable to run: the configured one, the bundled one, or one on the PATH.
 * Undefined when none is found (or the configured one doesn't exist).
 */
export function locateGenerator(extensionPath: string, configured: string): string | undefined {
  if (configured.trim()) {
    const p = configured.trim().replace(/^"|"$/g, '');
    return isFile(p) ? p : undefined;
  }
  const bundled = join(extensionPath, 'generator', platform(), exe);
  if (isFile(bundled)) return bundled;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && isFile(join(dir, exe))) return join(dir, exe);
  }
  return undefined;
}

/** Templates shipped with the executable (the .jinja files of the templates folder next to it). */
export function generatorTemplates(generator: string): string[] {
  const dir = join(dirname(generator), 'templates');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jinja'))
    .sort()
    .map((f) => join(dir, f));
}

export function runGenerator(generator: string, args: string[], cwd: string): Promise<GeneratorResult> {
  if (process.platform !== 'win32') {
    // Files unpacked from a VSIX may lose their executable bit.
    try {
      accessSync(generator, constants.X_OK);
    } catch {
      chmodSync(generator, 0o755);
    }
  }
  return new Promise((resolve, reject) => {
    execFile(generator, args, { cwd, timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error);
      resolve({ exitCode: error ? (error.code as number) : 0, stdout, stderr });
    });
  });
}
