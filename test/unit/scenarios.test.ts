/**
 * The IDE scenarios (test/scenarios.md, shared with the other editions) against the IDE tests (test/web/index.ts):
 * every scenario id is implemented there (`scenario('<id>', …)`) or listed under "Not applicable" for VS Code, and the
 * tests name no id the file doesn't have.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { root } from './harness';

const EDITION = 'VS Code';

it('implements every IDE scenario of test/scenarios.md', () => {
  const lines = readFileSync(join(root, 'test/scenarios.md'), 'utf8').split(/\r?\n/);
  const ids = lines.flatMap((l) => /^###\s+(\S+)\s*$/.exec(l)?.[1] ?? []);
  const start = lines.findIndex((l) => /^##\s+Not applicable\s*$/.test(l));
  const notApplicable = new Set<string>();
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    const cells = /^\|(.*)\|\s*$/.exec(line)?.[1].split('|').map((c) => c.trim());
    if (!cells || cells.length < 2 || /^-+$/.test(cells[0]) || cells[0] === 'Scenario') continue;
    if (cells[1] === EDITION) notApplicable.add(cells[0].replace(/^`(.*)`$/, '$1'));
  }
  const source = readFileSync(join(root, 'test/web/index.ts'), 'utf8');
  const implemented = new Set([...source.matchAll(/\bscenario\(\s*'([^']+)'/g)].map((m) => m[1]));

  assert.ok(ids.length, 'test/scenarios.md has scenarios');
  assert.deepEqual(ids.filter((id) => !implemented.has(id) && !notApplicable.has(id)), [], 'scenarios neither implemented in test/web/index.ts nor listed as not applicable to VS Code');
  assert.deepEqual([...implemented].filter((id) => !ids.includes(id)), [], 'ids test/web/index.ts names that test/scenarios.md does not have');
});
