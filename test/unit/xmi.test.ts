import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
