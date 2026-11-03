/**
 * fsmGenerator.ts for the web build (see esbuild.mjs): a web worker can't run
 * executables, so there is no fsm-generator and no Jinja template.
 */
import type { GeneratorResult } from './fsmGenerator';

export function locateGenerator(_extensionPath: string, _configured: string): string | undefined {
  return undefined;
}

export function generatorTemplates(_generator: string): string[] {
  return [];
}

export function runGenerator(_generator: string, _args: string[], _cwd: string): Promise<GeneratorResult> {
  return Promise.reject(new Error('fsm-generator does not run in VS Code for the Web.'));
}
