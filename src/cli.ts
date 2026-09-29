/**
 * Command-line interface: `fsm <files...> --template <template>`. The only
 * code that uses Node.js modules; the pipeline itself is in src/codegen.
 *
 * Bundled by esbuild.mjs into out/cli.js, which scripts/build-bin.mjs turns
 * into standalone executables with Bun.
 */
import { existsSync, promises as fs, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { FileIssue, GenerateError, GenerateHost, generate } from './codegen/generate';
import { TemplateError, parseTemplate } from './codegen/render';

declare const FSM_VERSION: string;

const USAGE = `Usage: fsm <files...> --template <template> [--out <folder>] [options]

Generates code from UML state machines (.fsm files) with a Handlebars template.
The machines are validated first: nothing is generated when they have errors.
Machines used by submachine states are read and validated, but only the
given files are generated. Files can be glob patterns; quote them ("models/**/*.fsm") so every shell
passes them through unchanged.

Options:
  -t, --template <file>  Template (.hbs). A bare name such as "ts" means
                         templates/<name>.hbs next to this program.
  -o, --out <folder>     Output folder (default: the current folder).
  -h, --help             Show this help.
  -v, --version          Show the version.

Exit codes: 0 success, 1 errors in the state machines or the template, 2 bad usage.`;

class UsageError extends Error {}

interface Args {
  files: string[];
  template?: string;
  out: string;
}

function parseArgs(argv: string[]): Args | 'help' | 'version' {
  const args: Args = { files: [], out: '.' };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-')) throw new UsageError(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    switch (flag) {
      case '-h':
      case '--help':
        return 'help';
      case '-v':
      case '--version':
        return 'version';
      case '-t':
      case '--template':
        args.template = inline ?? value(i++, flag);
        break;
      case '-o':
      case '--out':
        args.out = inline ?? value(i++, flag);
        break;
      default:
        if (a.startsWith('-') && a !== '-') throw new UsageError(`Unknown option ${a}.`);
        args.files.push(a);
    }
  }
  if (!args.files.length && !args.template) return 'help';
  if (!args.files.length) throw new UsageError('No .fsm files given.');
  if (!args.template) throw new UsageError('Missing --template.');
  return args;
}

// ------------------------------------------------------------------ files

const slash = (p: string) => p.replace(/\\/g, '/');
const display = (p: string) => {
  const rel = path.relative(process.cwd(), p);
  return slash(rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p);
};

/** Expands glob patterns (`*`, `?`, `**`) ourselves: PowerShell and cmd don't. */
export function expandGlob(pattern: string): string[] {
  const p = slash(pattern);
  if (!/[*?[]/.test(p)) return [path.resolve(p)];
  const parts = p.split('/');
  const first = parts.findIndex((s) => /[*?[]/.test(s));
  const base = parts.slice(0, first).join('/') || (p.startsWith('/') ? '/' : '.');
  const rest = parts.slice(first).join('/');
  const re = new RegExp(`^${globToRegex(rest)}$`);
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full, r);
      else if (re.test(r)) out.push(path.resolve(full));
    }
  };
  walk(path.resolve(base), '');
  return out.sort();
}

function globToRegex(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end < 0) re += '\\[';
      else {
        re += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return re;
}

function sources(patterns: string[]): string[] {
  const files: string[] = [];
  for (const p of patterns) {
    const found = expandGlob(p);
    if (!found.length) throw new UsageError(`No files match '${p}'.`);
    for (const f of found) if (!files.includes(f)) files.push(f);
  }
  return files;
}

/** The template file: a path, or a bare name looked up in the templates folders next to the program. */
function templatePath(name: string): string {
  if (/[\\/]/.test(name) || /\.hbs$/i.test(name) || existsSync(name)) return path.resolve(name);
  const dirs = [path.dirname(process.execPath), __dirname, path.join(__dirname, '..')].map((d) => path.join(d, 'templates'));
  for (const d of dirs) {
    const f = path.join(d, `${name}.hbs`);
    if (existsSync(f)) return f;
  }
  throw new UsageError(`Template '${name}' not found (looked for ${name}.hbs in ${dirs.map(slash).join(', ')}).`);
}

const host: GenerateHost = {
  readFile: (p) => fs.readFile(p, 'utf8'),
  resolve: (from, href) => path.resolve(path.dirname(from), decodeURI(href)),
  display,
};

// ------------------------------------------------------------------ reporting

async function lineOf(file: string, id: string): Promise<number> {
  if (!id) return 1;
  try {
    const text = await fs.readFile(path.resolve(file), 'utf8');
    const i = text.indexOf(`xmi:id="${id}"`);
    return i < 0 ? 1 : text.slice(0, i).split('\n').length;
  } catch {
    return 1;
  }
}

/** `file:line: severity: message`, the format editors and CI problem matchers understand. */
async function report(issues: FileIssue[]): Promise<void> {
  for (const i of issues) {
    process.stderr.write(`${i.file}:${await lineOf(i.file, i.id)}: ${i.severity}: ${i.message}\n`);
  }
}

// ------------------------------------------------------------------ generating

async function run(args: Args): Promise<number> {
  const tplFile = templatePath(args.template!);
  let template;
  try {
    template = parseTemplate(await fs.readFile(tplFile, 'utf8'));
  } catch (e) {
    if (e instanceof TemplateError) throw new TemplateError(`${display(tplFile)}: ${e.message}`);
    throw new UsageError(`Cannot read the template ${display(tplFile)}.`);
  }
  let result;
  try {
    result = await generate(sources(args.files), template, host);
  } catch (e) {
    if (e instanceof GenerateError) await report(e.issues);
    if (e instanceof TemplateError) throw new TemplateError(`${display(tplFile)}: ${e.message}`);
    throw e;
  }
  await report(result.issues);
  const out = path.resolve(args.out);
  for (const f of result.files) {
    const target = path.join(out, ...f.path.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, f.content, 'utf8');
    process.stdout.write(`wrote ${display(target)}\n`);
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args === 'help') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (args === 'version') {
      process.stdout.write(`${typeof FSM_VERSION === 'string' ? FSM_VERSION : 'dev'}\n`);
      return 0;
    }
    return await run(args);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`fsm: ${e.message}\nRun 'fsm --help' for usage.\n`);
      return 2;
    }
    process.stderr.write(`fsm: ${e instanceof Error ? e.message : e}\n`);
    return 1;
  }
}

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
