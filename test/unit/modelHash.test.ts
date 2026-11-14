import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FsmModel } from '../../src/model';
import { fromXmi, toXmi } from '../../src/xmi';
import { ModelBuilder, bundled, generate, root } from './harness';

/** The model hashes of files (name → text), as fsm-cli computes them (`machine.modelHash` in templates). */
async function hashes(files: Record<string, string>): Promise<Record<string, string>> {
  const r = await generate(files, '{% filter file(machine.name ~ ".hash") %}{{ machine.modelHash }}{% endfilter %}');
  for (const f of r.files) {
    assert.equal(f.modelHash, f.content);
    assert.match(f.content, /^[0-9a-f]{16}$/);
  }
  return Object.fromEntries(r.files.map((f) => [f.source, f.content]));
}

const hashOf = async (xmi: string) => (await hashes({ 'Hash.fsm': xmi }))['Hash.fsm'];

function machine(): FsmModel {
  const b = new ModelBuilder('Hash');
  b.state('A', 'r_root', { entry: 'a()' });
  b.state('B', 'r_root', { x: 200, w: 300, h: 200 }, 2);
  b.state('C', 'B_r0');
  b.init('C', 'B_r0');
  b.init('A');
  b.t('A', 'B', { triggers: ['go'], guard: 'ok()' });
  b.t('B', 'A', { triggers: ['after(1s)'], effect: 'e()' });
  b.t('A', 'A', { triggers: ['tick'] });
  b.vertex('comment', 'r_root', { id: 'n1', text: 'a <note> & "quotes"', anchors: ['A'] });
  b.model.documentation = 'Doc';
  return fromXmi(toXmi(b.model));
}

/** The transition A -go-> B. */
const go = (m: FsmModel) => m.transitions.find((t) => t.triggers.includes('go'))!;

/** The line earlier versions wrote at the end of the file. */
const withHashLine = (xmi: string, hash: string) =>
  xmi.replace(/<\/xmi:XMI>\n$/, `  <xmi:Extension extender="FSM Editor">\n    <modelHash value="${hash}"/>\n  </xmi:Extension>\n</xmi:XMI>\n`);

describe('model hash', () => {
  it('is not stored in the file; a file that has it loads as before and is saved without it', () => {
    const xmi = toXmi(machine());
    assert.doesNotMatch(xmi, /modelHash/);
    assert.match(xmi, /<\/umldi:UMLStateMachineDiagram>\n<\/xmi:XMI>\n$/);
    const old = withHashLine(xmi, '0123456789abcdef');
    assert.deepEqual(fromXmi(old), fromXmi(xmi));
    assert.equal(toXmi(fromXmi(old)), xmi);
  });

  it('ignores the layout: positions, sizes, routes, labels, colors, groups and region layout', async () => {
    const base = machine();
    const hash = await hashOf(toXmi(base));
    const changes: [string, (m: FsmModel) => void][] = [
      ['position', (m) => (m.vertices[0].x += 50)],
      ['size', (m) => (m.vertices.find((v) => v.name === 'B')!.w += 40)],
      ['bend point', (m) => (go(m).points = [{ x: 10, y: 400 }])],
      ['label', (m) => (go(m).labelOffset = { x: 5, y: -20 })],
      ['color', (m) => ((m.vertices[0].color = '#ff0000'), (go(m).itemColors = { guard: '#00ff00' }))],
      ['region layout', (m) => (m.vertices.find((v) => v.name === 'B')!.regionLayout = 'horizontal')],
      ['region size', (m) => (m.vertices.find((v) => v.name === 'B')!.regions![0].size = 30)],
      ['note size', (m) => (m.vertices.find((v) => v.id === 'n1')!.h = 200)],
    ];
    for (const [what, change] of changes) {
      const m = structuredClone(base);
      change(m);
      const xmi = toXmi(m);
      assert.notEqual(xmi, toXmi(base), what);
      assert.equal(await hashOf(xmi), hash, what);
    }
  });

  it('changes with the model', async () => {
    const base = machine();
    const hashes = new Set([await hashOf(toXmi(base))]);
    const changes: [string, (m: FsmModel) => void][] = [
      ['name', (m) => (m.vertices.find((v) => v.name === 'A')!.name = 'A2')],
      ['entry', (m) => (m.vertices.find((v) => v.name === 'A')!.entry = 'b()')],
      ['guard', (m) => (go(m).guard = '!ok()')],
      ['trigger', (m) => (go(m).triggers = ['go', 'run'])],
      ['transition kind', (m) => (m.transitions.find((t) => t.triggers.includes('tick'))!.kind = 'internal')],
      ['stereotype', (m) => (m.vertices.find((v) => v.name === 'A')!.stereotype = 'Critical')],
      ['note', (m) => (m.vertices.find((v) => v.id === 'n1')!.text = 'other')],
      ['documentation', (m) => (m.documentation = 'Other doc')],
      ['machine name', (m) => (m.name = 'Hash2')],
    ];
    for (const [what, change] of changes) {
      const m = structuredClone(base);
      change(m);
      const hash = await hashOf(toXmi(m));
      assert.ok(!hashes.has(hash), what);
      hashes.add(hash);
    }
  });

  it('ignores the formatting: line ends, indentation, namespace prefixes and a stored hash', async () => {
    const xmi = toXmi(machine());
    const hash = await hashOf(xmi);
    assert.equal(await hashOf(xmi.replace(/\n/g, '\r\n')), hash);
    assert.equal(await hashOf(xmi.replace(/>\n\s*</g, '><')), hash);
    assert.equal(await hashOf(xmi.replace(/\buml:/g, 'u:').replace('xmlns:uml=', 'xmlns:u=')), hash);
    assert.equal(await hashOf(withHashLine(xmi, hash)), hash);
    assert.equal(await hashOf(withHashLine(xmi, '0000000000000000')), hash);
  });
});

describe('model hash in generated code', () => {
  it('heads every file of a machine with the hash of its own file', async () => {
    const files = Object.fromEntries(['Order.fsm', 'Payment.fsm'].map((f) => [f, readFileSync(join(root, 'examples', f), 'utf8')]));
    const result = await generate(files, bundled('ts'), 'ts.jinja');
    const hashOfFile = await hashes(files);
    assert.equal(result.files.length, 4);
    for (const f of result.files) {
      const source = f.path.startsWith('Order') ? 'Order.fsm' : 'Payment.fsm';
      const hash = hashOfFile[source];
      assert.equal(f.source, source);
      assert.equal(f.modelHash, hash);
      assert.ok(f.content.startsWith(`// Generated by FSM Editor from ${source} (model hash ${hash}).\n`), f.path);
    }
  });
});
