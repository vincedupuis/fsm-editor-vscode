import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GenerateHost, generate } from '../../src/codegen/generate';
import { parseTemplate } from '../../src/codegen/render';
import { FsmModel } from '../../src/model';
import { sha256 } from '../../src/sha256';
import { fromXmi, modelHash, toXmi } from '../../src/xmi';
import { ModelBuilder, root } from './harness';

const stored = (xmi: string) => /<modelHash value="([0-9a-f]{16})"\/>/.exec(xmi)?.[1];

function machine(): FsmModel {
  const b = new ModelBuilder('Hash');
  b.state('A', 'r_root', { entry: 'a()' });
  b.state('B', 'r_root', { x: 200, w: 300, h: 200 }, 2);
  b.state('C', 'B_r0');
  b.init('C', 'B_r0');
  b.init('A');
  b.t('A', 'B', { triggers: ['go'], guard: 'ok()' });
  b.t('B', 'A', { triggers: ['after(1s)'], effect: 'e()' });
  b.vertex('comment', 'r_root', { id: 'n1', text: 'a <note> & "quotes"', anchors: ['A'] });
  b.model.documentation = 'Doc';
  return fromXmi(toXmi(b.model));
}

describe('sha256', () => {
  it('gives the FIPS 180-4 test vectors', () => {
    assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('hashes the UTF-8 bytes, across block boundaries', () => {
    for (const s of ['é', '日本語', '🙂', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'é'.repeat(100), 'y'.repeat(1000)]) {
      assert.equal(sha256(s), createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s.slice(0, 10)));
    }
  });
});

describe('model hash', () => {
  it('is stored at the end of the file and computed again from it', () => {
    const xmi = toXmi(machine());
    assert.match(xmi, /<xmi:Extension extender="FSM Editor">\n {4}<modelHash value="[0-9a-f]{16}"\/>\n {2}<\/xmi:Extension>\n<\/xmi:XMI>\n$/);
    assert.equal(stored(xmi), modelHash(xmi));
    assert.equal(toXmi(fromXmi(xmi)), xmi);
  });

  it('ignores the layout: positions, sizes, routes, labels, colors, groups and region layout', () => {
    const base = machine();
    const hash = stored(toXmi(base));
    const changes: [string, (m: FsmModel) => void][] = [
      ['position', (m) => (m.vertices[0].x += 50)],
      ['size', (m) => (m.vertices.find((v) => v.name === 'B')!.w += 40)],
      ['bend point', (m) => (m.transitions[0].points = [{ x: 10, y: 400 }])],
      ['label', (m) => (m.transitions[0].labelOffset = { x: 5, y: -20 })],
      ['color', (m) => ((m.vertices[0].color = '#ff0000'), (m.transitions[0].itemColors = { guard: '#00ff00' }))],
      ['region layout', (m) => (m.vertices.find((v) => v.name === 'B')!.regionLayout = 'horizontal')],
      ['region size', (m) => (m.vertices.find((v) => v.name === 'B')!.regions![0].size = 30)],
      ['note size', (m) => (m.vertices.find((v) => v.id === 'n1')!.h = 200)],
    ];
    for (const [what, change] of changes) {
      const m = structuredClone(base);
      change(m);
      const xmi = toXmi(m);
      assert.notEqual(xmi, toXmi(base), what);
      assert.equal(stored(xmi), hash, what);
    }
  });

  it('changes with the model', () => {
    const base = machine();
    const hashes = new Set([stored(toXmi(base))]);
    const changes: [string, (m: FsmModel) => void][] = [
      ['name', (m) => (m.vertices.find((v) => v.name === 'A')!.name = 'A2')],
      ['entry', (m) => (m.vertices.find((v) => v.name === 'A')!.entry = 'b()')],
      ['guard', (m) => (m.transitions[0].guard = '!ok()')],
      ['trigger', (m) => (m.transitions[0].triggers = ['go', 'run'])],
      ['transition kind', (m) => (m.transitions[1].kind = 'local')],
      ['stereotype', (m) => (m.vertices.find((v) => v.name === 'A')!.stereotype = 'Critical')],
      ['note', (m) => (m.vertices.find((v) => v.id === 'n1')!.text = 'other')],
      ['documentation', (m) => (m.documentation = 'Other doc')],
      ['machine name', (m) => (m.name = 'Hash2')],
    ];
    for (const [what, change] of changes) {
      const m = structuredClone(base);
      change(m);
      const hash = stored(toXmi(m));
      assert.ok(!hashes.has(hash), what);
      hashes.add(hash);
    }
  });

  it('ignores the formatting: line ends, indentation, namespace prefixes and the stored hash', () => {
    const xmi = toXmi(machine());
    const hash = modelHash(xmi);
    assert.equal(modelHash(xmi.replace(/\n/g, '\r\n')), hash);
    assert.equal(modelHash(xmi.replace(/>\n\s*</g, '><')), hash);
    assert.equal(modelHash(xmi.replace(/\buml:/g, 'u:').replace('xmlns:uml=', 'xmlns:u=')), hash);
    assert.equal(modelHash(xmi.replace(/<xmi:Extension extender="FSM Editor">\s*<modelHash[^>]*>\s*<\/xmi:Extension>/, '')), hash);
    assert.equal(modelHash(xmi.replace(/value="[0-9a-f]{16}"/, 'value="0000000000000000"')), hash);
  });
});

describe('model hash in generated code', () => {
  it('heads every file of a machine with the hash of its own file', async () => {
    const files = new Map(['Order.fsm', 'Payment.fsm'].map((f) => [`/m/${f}`, readFileSync(join(root, 'examples', f), 'utf8')]));
    const host: GenerateHost = {
      readFile: async (p) => files.get(p) ?? Promise.reject(new Error('not found')),
      resolve: (from, href) => `${from.slice(0, from.lastIndexOf('/'))}/${decodeURI(href)}`,
      display: (p) => p.slice(3),
    };
    const template = parseTemplate(readFileSync(join(root, 'templates/ts.hbs'), 'utf8'));
    const result = await generate(['/m/Order.fsm', '/m/Payment.fsm'], template, host);
    assert.equal(result.files.length, 4);
    for (const f of result.files) {
      const source = f.path.startsWith('Order') ? 'Order.fsm' : 'Payment.fsm';
      const hash = modelHash(files.get(`/m/${source}`)!);
      assert.ok(f.content.startsWith(`// Generated by FSM Editor from ${source} (model hash ${hash}).\n`), f.path);
    }
  });
});
