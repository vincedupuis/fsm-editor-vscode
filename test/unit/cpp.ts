/**
 * Test helpers for the Boost.SML template (templates/sml.hbs): generate C++ for
 * machines, compile it with a driver that records what the machines call, and
 * run scripts against it.
 *
 * The driver reads one command per line: `start`, `startAt <point>`, `resume`,
 * `stop`, `listen` (record the listener's calls as `@finished`, `@exit <point>`),
 * `e <event>`, `set <condition> 0|1`, `fire` (every pending timer), `done
 * <activity>`, `clear` (forget the calls so far), and queries that print one
 * line: `take` (calls since the last take or clear), `active`, `pending`
 * (delays of the pending timers), `finished`, `terminated`. A C++ exception
 * prints `throw: <what>`, expected as `command => throw: <what>`.
 *
 * Needs a C++17 compiler (CXX, or c++/clang++/g++; MSVC's cl on Windows) and
 * the Boost.SML header: SML_INCLUDE names its folder, otherwise it is
 * downloaded once into node_modules/.cache. Without them the tests are
 * skipped, except in CI (the CI environment variable is set), where they fail.
 * FSM_EXE_RUNNER runs the driver through another program, such as wine for
 * MSVC under Wine.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { generate, GenerateHost } from '../../src/codegen/generate';
import { parseTemplate } from '../../src/codegen/render';
import { FsmModel } from '../../src/model';
import { toXmi } from '../../src/xmi';
import { root } from './harness';

export const SML_VERSION = '1.2.0';

export interface Toolchain {
  cxx: string;
  /** MSVC's cl, which takes other options than GCC and Clang. */
  msvc: boolean;
  include: string;
}

const isMsvc = (cxx: string) => /(^|[\\/])cl(\.exe)?$/i.test(cxx);

/** Compiles `unit`.cpp in `dir`, warnings being errors; Boost.SML's own warnings are left out with MSVC. */
function compileArgs(tools: Toolchain, unit: string): string[] {
  if (tools.msvc) {
    return ['/nologo', '/std:c++17', '/W4', '/WX', '/EHsc', '/permissive-', '/utf-8', '/external:W0', `/external:I${tools.include}`, '/c', `${unit}.cpp`, `/Fo${unit}.obj`];
  }
  return ['-std=c++17', '-Wall', '-Wextra', '-Wpedantic', '-Werror', '-I', tools.include, '-c', `${unit}.cpp`, '-o', `${unit}.o`];
}

/** The C++ compiler and the folder holding boost/sml.hpp, or why the tests can't run. */
export async function toolchain(): Promise<Toolchain | string> {
  const candidates = process.env.CXX ? [process.env.CXX] : process.platform === 'win32' ? ['cl', 'c++', 'clang++', 'g++'] : ['c++', 'clang++', 'g++'];
  // cl has no --version: it shows its banner when run alone.
  const found = (c: string) => (isMsvc(c) ? !spawnSync(c, [], { stdio: 'ignore' }).error : spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0);
  const cxx = candidates.find(found);
  if (!cxx) return 'no C++ compiler (set CXX)';
  const msvc = isMsvc(cxx);
  if (process.env.SML_INCLUDE) {
    return existsSync(join(process.env.SML_INCLUDE, 'boost/sml.hpp')) ? { cxx, msvc, include: process.env.SML_INCLUDE } : `no boost/sml.hpp in SML_INCLUDE=${process.env.SML_INCLUDE}`;
  }
  const include = join(root, 'node_modules/.cache', `boost-sml-${SML_VERSION}`);
  const header = join(include, 'boost/sml.hpp');
  if (!existsSync(header)) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/boost-ext/sml/v${SML_VERSION}/include/boost/sml.hpp`);
      if (!res.ok) return `cannot download Boost.SML: HTTP ${res.status}`;
      mkdirSync(dirname(header), { recursive: true });
      writeFileSync(header, await res.text());
    } catch (e) {
      return `cannot download Boost.SML (${e instanceof Error ? e.message : e}); set SML_INCLUDE`;
    }
  }
  return { cxx, msvc, include };
}

export interface Case {
  /** File name → model or XMI text. Every one is generated. */
  machines: Record<string, FsmModel | string>;
}

/** Generates the SML code of `files`, as files of `dir`, and returns the warnings. */
export async function generateSml(machines: Record<string, FsmModel | string>, dir?: string): Promise<{ files: Map<string, string>; warnings: string[] }> {
  const sources = new Map<string, string>();
  for (const [name, m] of Object.entries(machines)) sources.set(`/m/${name}`, typeof m === 'string' ? m : toXmi(m));
  const host: GenerateHost = {
    readFile: async (p) => {
      const text = sources.get(p);
      if (text === undefined) throw new Error('not found');
      return text;
    },
    resolve: (from, href) => `${from.slice(0, from.lastIndexOf('/'))}/${decodeURI(href)}`,
    display: (p) => p.slice(3),
  };
  const template = parseTemplate(readFileSync(join(root, 'templates/sml.hbs'), 'utf8'));
  const result = await generate([...sources.keys()], template, host);
  const files = new Map(result.files.map((f) => [f.path, f.content]));
  if (dir) for (const [path, content] of files) writeFileSync(join(dir, path), content);
  return { files, warnings: result.issues.filter((i) => i.severity === 'warning').map((i) => i.message) };
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} failed:\n${out}`))));
  });
}

/** Compiles `cases` with the driver; returns the executable. Each .cpp is compiled on its own, in parallel. */
export async function build(cases: Case[], tools: Toolchain): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'fsm-sml-'));
  const all = new Map<string, string>();
  for (const c of cases) for (const [path, content] of (await generateSml(c.machines, dir)).files) all.set(path, content);
  const machines = [...all.keys()].filter((p) => p.endsWith('.cpp')).map((p) => p.slice(0, -4));
  writeFileSync(join(dir, 'driver.cpp'), driver(machines, all));
  const units = [...machines, 'driver'];
  const pool = Math.max(2, Math.min(8, units.length));
  const queue = [...units];
  await Promise.all(
    Array.from({ length: pool }, async () => {
      for (let u = queue.shift(); u; u = queue.shift()) await run(tools.cxx, compileArgs(tools, u), dir);
    }),
  );
  const exe = join(dir, tools.msvc ? 'driver.exe' : 'driver');
  if (tools.msvc) await run(tools.cxx, ['/nologo', ...units.map((u) => `${u}.obj`), '/Fedriver.exe'], dir);
  else await run(tools.cxx, [...units.map((u) => `${u}.o`), '-o', exe], dir);
  return exe;
}

/**
 * Runs `script` on machine `name`. Steps are commands, or `query => expected`; returns the expected and actual
 * outputs of the queries, to compare with assert.deepEqual.
 */
export function play(exe: string, name: string, script: string[]): { actual: string[]; expected: string[] } {
  const steps = script.map((s) => s.split(' => '));
  const runner = process.env.FSM_EXE_RUNNER;
  const input = steps.map((s) => s[0]).join('\n') + '\n';
  const r = runner ? spawnSync(runner, [exe, name], { input, encoding: 'utf8' }) : spawnSync(exe, [name], { input, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`driver ${name} failed (${r.status}): ${r.stderr}`);
  const actual = r.stdout.split('\n').filter((l) => l !== '').map((l) => l.trimEnd());
  const expected = steps.filter((s) => s.length > 1).map((s) => (s[1].startsWith('throw: ') ? s[1] : `${s[0]}: ${s[1]}`.trimEnd()));
  return { actual, expected };
}

// ------------------------------------------------------------------ driver

/** The names of the members of an enum class or the methods of an interface, read from a generated header. */
function enumValues(header: string, name: string): string[] {
  const m = new RegExp(`enum class ${name} \\{([^}]*)\\}`).exec(header);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function driver(machines: string[], files: Map<string, string>): string {
  const out: string[] = [
    '// Test driver: records what the machines call, and runs scripts read from stdin.',
    ...machines.map((m) => `#include "${m}.h"`),
    '#include <cstdint>',
    '#include <cstdlib>',
    '#include <exception>',
    '#include <functional>',
    '#include <iostream>',
    '#include <map>',
    '#include <sstream>',
    '#include <string>',
    '#include <vector>',
    '',
    'struct Log {',
    '    std::vector<std::string> calls;',
    '    std::map<std::string, bool> conditions;',
    '    std::map<std::uint64_t, std::pair<long long, std::function<void()>>> timers;',
    '    std::uint64_t next = 1;',
    '    void call(const std::string& name) { calls.push_back(name); }',
    '    bool condition(const std::string& prefix, const std::string& name) { call(prefix + name); return conditions[name]; }',
    '};',
    '',
    ...(files.has('FsmTimers.h')
      ? [
          '#include "FsmTimers.h"',
          '',
          '/// Timers that fire when the script says so.',
          'struct FakeTimers final : FsmTimers {',
          '    explicit FakeTimers(Log& log) : log(log) {}',
          '    Log& log;',
          '    Id startTimer(std::chrono::milliseconds delay, std::function<void()> fire) override {',
          '        log.timers[log.next] = {delay.count(), std::move(fire)};',
          '        return log.next++;',
          '    }',
          '    void cancelTimer(Id timer) override { log.timers.erase(timer); }',
          '};',
          '',
        ]
      : []),
    'static std::string join(const std::vector<std::string>& list) {',
    '    std::string s;',
    '    for (const auto& x : list) s += (s.empty() ? "" : ",") + x;',
    '    return s;',
    '}',
    '',
  ];
  // Recorders, submachines first (their recorders are members of their parents').
  const actionsOf = (m: string) => files.get(`${m}Actions.h`) ?? '';
  const order: string[] = [];
  const visit = (m: string) => {
    if (order.includes(m)) return;
    for (const sub of actionsOf(m).matchAll(/virtual (\w+)Actions& submachine\w+\(\) = 0;/g)) visit(sub[1]);
    order.push(m);
  };
  machines.forEach(visit);
  for (const m of order) {
    const h = actionsOf(m);
    out.push(`struct ${m}Recorder final : ${m}Actions {`);
    out.push(`    ${m}Recorder(Log& log, std::string prefix) : log(log), prefix(std::move(prefix)) {}`);
    out.push('    Log& log;', '    std::string prefix;');
    for (const [, name] of h.matchAll(/virtual void (\w+)\(\) = 0;/g)) out.push(`    void ${name}() override { log.call(prefix + "${name}"); }`);
    for (const [, name] of h.matchAll(/virtual bool (\w+)\(\) = 0;/g)) out.push(`    bool ${name}() override { return log.condition(prefix, "${name}"); }`);
    if (h.includes('onConstraintViolation(')) {
      out.push(`    void onConstraintViolation(${m}Constraint kind, const char* element) override {`);
      out.push(`        log.call(std::string("!") + (kind == ${m}Constraint::invariant ? "invariant" : kind == ${m}Constraint::precondition ? "precondition" : "postcondition") + ": " + element);`);
      out.push('    }');
    }
    for (const [, sub, state] of h.matchAll(/virtual (\w+)Actions& submachine(\w+)\(\) = 0;/g)) {
      out.push(`    ${sub}Recorder sub${state}{log, prefix + "${state}."};`);
      out.push(`    ${sub}Actions& submachine${state}() override { return sub${state}; }`);
    }
    out.push('};', '');
  }
  // A runner per machine.
  for (const m of machines) {
    const h = files.get(`${m}.h`) ?? '';
    const ev = files.get(`${m}Events.h`) ?? '';
    const states = enumValues(h, `${m}State`);
    const exits = enumValues(h, `${m}ExitPoint`);
    out.push(`struct ${m}Listener final : ${m}::Listener {`);
    out.push('    explicit ' + `${m}Listener(Log& log) : log(log) {}`, '    Log& log;');
    out.push('    void onFinished() override { log.call("@finished"); }');
    if (exits.length) {
      out.push(`    void onExitPoint(${m}ExitPoint point) override {`);
      out.push(`        static const char* const names[] = {${exits.map((e) => `"${e}"`).join(', ')}};`);
      out.push('        log.call(std::string("@exit ") + names[static_cast<int>(point)]);', '    }');
    }
    out.push('};', '');
    out.push(`static void run${m}() {`);
    const timed = h.includes('FsmTimers& timers);');
    out.push('    Log log;', `    ${m}Recorder actions(log, "");`);
    if (timed) out.push('    FakeTimers timers(log);', `    ${m} machine(actions, timers);`);
    else out.push(`    ${m} machine(actions);`);
    out.push(`    ${m}Listener listener(log);`);
    out.push(`    static const char* const states[] = {${states.map((s) => `"${s}"`).join(', ')}${states.length ? '' : '""'}};`);
    out.push('    std::string line;');
    out.push('    while (std::getline(std::cin, line)) {');
    out.push('        std::istringstream in(line);', '        std::string cmd, arg, value;', '        in >> cmd >> arg >> value;');
    out.push('        try {');
    out.push('            if (cmd == "start") machine.startMachine();');
    for (const p of enumValues(h, `${m}EntryPoint`)) out.push(`            else if (cmd == "startAt" && arg == "${p}") machine.startMachineAt(${m}EntryPoint::${p});`);
    out.push('            else if (cmd == "resume") machine.resumeMachine();');
    out.push('            else if (cmd == "stop") machine.stopMachine();');
    out.push('            else if (cmd == "listen") machine.setListener(&listener);');
    for (const [, name] of ev.matchAll(/virtual void (\w+)\(\) = 0;/g)) out.push(`            else if (cmd == "e" && arg == "${name}") machine.${name}();`);
    for (const a of enumValues(ev, `${m}Activity`)) out.push(`            else if (cmd == "done" && arg == "${a}") machine.activityDone(${m}Activity::${a});`);
    out.push('            else if (cmd == "set") log.conditions[arg] = value == "1";');
    out.push('            else if (cmd == "fire") {');
    out.push('                auto timers = log.timers;', '                log.timers.clear();', '                for (auto& t : timers) t.second.second();', '            }');
    out.push('            else if (cmd == "take") { std::cout << "take: " << join(log.calls) << "\\n"; log.calls.clear(); }');
    out.push('            else if (cmd == "clear") log.calls.clear();');
    out.push('            else if (cmd == "active") {');
    out.push('                std::vector<std::string> names;', '                for (auto s : machine.activeStates()) names.push_back(states[static_cast<int>(s)]);');
    out.push('                std::cout << "active: " << join(names) << "\\n";', '            }');
    out.push('            else if (cmd == "pending") {');
    out.push('                std::vector<std::string> delays;', '                for (auto& t : log.timers) delays.push_back(std::to_string(t.second.first));');
    out.push('                std::cout << "pending: " << join(delays) << "\\n";', '            }');
    out.push('            else if (cmd == "finished") std::cout << "finished: " << machine.isFinished() << "\\n";');
    out.push('            else if (cmd == "terminated") std::cout << "terminated: " << machine.isTerminated() << "\\n";');
    out.push('            else { std::cerr << "unknown command: " << line << "\\n"; std::exit(3); }');
    out.push('        } catch (const std::exception& e) {', '            std::cout << "throw: " << e.what() << "\\n";', '        }');
    out.push('    }', '}', '');
  }
  out.push('int main(int argc, char** argv) {', '    const std::string name = argc > 1 ? argv[1] : "";');
  for (const m of machines) out.push(`    if (name == "${m}") { run${m}(); return 0; }`);
  out.push('    std::cerr << "unknown machine " << name << "\\n";', '    return 2;', '}', '');
  return out.join('\n');
}
