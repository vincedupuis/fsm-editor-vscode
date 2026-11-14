import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FsmModel } from '../../src/model';
import { decodeHref, encodeHref } from '../../src/util';
import { fromXmi, toXmi } from '../../src/xmi';
import { ModelBuilder } from './harness';

describe('XMI', () => {
  it('keeps a time trigger and an event whose ids would be the same apart', () => {
    const b = new ModelBuilder('Ids');
    b.state('A');
    b.state('B');
    b.init('A');
    b.t('A', 'B', { triggers: ['after(1s)'] });
    b.t('B', 'A', { triggers: ['after_1s_'] });
    const xmi = toXmi(b.model);
    assert.deepEqual(fromXmi(xmi).transitions.map((t) => t.triggers), [[], ['after(1s)'], ['after_1s_']]);
    const ids = [...xmi.matchAll(/xmi:id="([^"]*)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'unique xmi:ids');
  });

  it('keeps the spaces and line breaks around a comment text', () => {
    const b = new ModelBuilder('Notes');
    b.state('A');
    b.init('A');
    b.vertex('comment', 'r_root', { id: 'n1', text: '  indented\nnote\n\n', anchors: [] });
    assert.equal(fromXmi(toXmi(b.model)).vertices.find((v) => v.id === 'n1')?.text, '  indented\nnote\n\n');
  });

  it('reads CRLF line ends as line feeds, so that a CRLF file is stable across saves', () => {
    const b = new ModelBuilder('Notes');
    b.state('A');
    b.init('A');
    b.vertex('comment', 'r_root', { id: 'n1', text: 'a\nb\r', anchors: [] });
    const crlf = toXmi(b.model).replace(/\n/g, '\r\n');
    const back = fromXmi(crlf);
    // The literal line break is read as \n; the trailing \r, written as &#13;, stays.
    assert.equal(back.vertices.find((v) => v.id === 'n1')?.text, 'a\nb\r');
    assert.equal(toXmi(back), toXmi(fromXmi(toXmi(b.model))));
  });
});

describe('XMI: one save settles a file', () => {
  /** Writing `model`, reading it back and writing it again must give the same text. */
  const settles = (model: FsmModel) => {
    const text = toXmi(model);
    assert.equal(toXmi(fromXmi(text)), text);
  };

  it('for the examples', () => {
    for (const f of readdirSync('examples').filter((f) => f.endsWith('.fsm'))) {
      settles(fromXmi(readFileSync(join('examples', f), 'utf8')));
    }
  });

  it('with a label far from the origin and coordinates off the 0.1 px grid', () => {
    const b = new ModelBuilder('Far');
    b.state('A', 'r_root', { x: 24707.53, y: -15999.77, w: 140.04, h: 60.06 });
    b.state('B', 'r_root', { x: 26240.25, y: 7.55, w: 140, h: 60 });
    b.init('A');
    b.t('A', 'B', { triggers: ['go'], points: [{ x: 25500.05, y: -7600.35 }], labelOffset: { x: 12.35, y: -7.45 } });
    b.t('B', 'A', { triggers: ['back'], labelOffset: { x: -0.05, y: 0.05 } });
    settles(b.model);
  });

  it('with regions in equal parts that are not whole tenths, and sizes off the grid', () => {
    const b = new ModelBuilder('Regions');
    b.state('P', 'r_root', { x: 0, y: 0, w: 10, h: 10 }, 3);
    b.state('Q', 'r_root', { x: 200, y: 0, w: 301, h: 100, regionLayout: 'horizontal' }, 3);
    b.model.vertices.find((v) => v.id === 'Q')!.regions![0].size = 100.04;
    b.model.vertices.find((v) => v.id === 'Q')!.regions![1].size = 0.04;
    b.init('P');
    settles(b.model);
  });

  it('with a vertex of no width', () => {
    const b = new ModelBuilder('Flat');
    b.state('A', 'r_root', { x: 300, y: 200, w: 0, h: 60 });
    b.state('B', 'r_root', { x: 0, y: 0, w: 10, h: 0.04 });
    b.init('A');
    b.t('A', 'B', { labelOffset: { x: 5, y: 5 } });
    settles(b.model);
  });

  it('with vertices and transitions listed in another order than the document', () => {
    const b = new ModelBuilder('Order');
    b.t('In', 'In', { id: 't_in', triggers: ['tick'], points: [{ x: 0, y: 0 }] });
    b.vertex('entryPoint', 'C', { id: 'ep', x: 0, y: 30, w: 16, h: 16 });
    b.state('In', 'C_r0', { x: 20, y: 40 });
    b.state('C', 'r_root', { x: 0, y: 0, w: 300, h: 200, color: '#ff0000' }, 1);
    b.vertex('comment', 'r_root', { id: 'n', text: 'note', anchors: ['In', 't_in'] });
    b.init('C');
    b.t('ep', 'In');
    settles(b.model);
  });

  it('with two states sharing an id, each with an entry point', () => {
    const b = new ModelBuilder('Shared');
    b.state('S', 'r_root', { id: 's1', x: 0, y: 0 });
    b.vertex('entryPoint', 's1', { id: 'ep', x: -8, y: 20, w: 16, h: 16 });
    b.state('Dup', 'r_root', { id: 's1', x: 300, y: 0 });
    b.vertex('entryPoint', 's1', { id: 'ep', x: 292, y: 20, w: 16, h: 16 });
    b.init('s1');
    b.t('ep', 's1');
    const text = toXmi(b.model);
    settles(b.model);
    assert.equal(text.match(/xmi:id="ep"/g)?.length, 2, 'each entry point written once');
  });
});

describe('XMI: a state inside its own region', () => {
  it('fails to write it instead of recursing forever', () => {
    const b = new ModelBuilder('M');
    b.state('S', 'r_root', {}, 1);
    b.state('T', 'S_r0');
    b.model.vertices.find((v) => v.id === 'S')!.regions![0].id = 'r_root';
    assert.throws(() => toXmi(b.model), { message: "State 'S' is inside one of its own regions." });
  });
});

describe('hrefs', () => {
  it('decode as decodeURI does, keeping malformed escapes', () => {
    assert.equal(decodeHref('My%20Machine.fsm'), 'My Machine.fsm');
    assert.equal(decodeHref('caf%C3%A9.fsm'), 'café.fsm');
    assert.equal(decodeHref('a%23b%2Fc%3F'), 'a#b%2Fc?');
    assert.equal(decodeHref('caf%C3%A9%zz'), 'café%zz');
    assert.equal(decodeHref('a%E0.fsm'), 'a%E0.fsm');
    assert.equal(decodeHref('a%E0%41.fsm'), 'a%E0A.fsm');
    assert.equal(decodeHref('a%C0%80%'), 'a%C0%80%');
  });
  it('encode # and ? in file names, and decode them back', () => {
    for (const path of ['sub/a#b?c.fsm', 'My Machine.fsm', 'café 50%.fsm', 'a&b;c.fsm']) {
      const href = `${encodeHref(path)}#sm`;
      assert.equal(href.split('#').length, 2);
      assert.equal(decodeHref(href.split('#')[0]), path);
    }
    assert.equal(encodeHref('a#b?.fsm'), 'a%23b%3F.fsm');
  });
});
