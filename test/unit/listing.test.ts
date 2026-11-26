/**
 * The Marketplace listing, checked before a release builds the VSIX: what vsce and the Marketplace refuse or show
 * broken (the icon, the number of keywords, the README's images and links), and a name the Visual Studio edition's
 * listing doesn't use (both are on the Visual Studio Marketplace; checked when ../fsm-editor-vs is beside this repo).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { root } from './harness';

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** GitHub's anchor of a heading: lowercase, punctuation dropped, spaces as hyphens. */
const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

/** The problems of the links and images of a Markdown file: relative targets must exist, and their anchors (its own too). */
function brokenLinks(file: string): string[] {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  const out: string[] = [];
  for (const m of text.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<img [^>]*src="([^"]+)"/g)) {
    const image = m[1] === '!' || !!m[3];
    const target = m[2] ?? m[3];
    if (/^https?:/.test(target)) {
      // vsce refuses images over http and SVG images (but for badges of known services).
      if (image && !target.startsWith('https:')) out.push(`${target}: an image over http`);
      continue;
    }
    if (target.startsWith('mailto:')) continue;
    const [path, anchor] = target.split('#');
    const resolved = path ? join(dirname(file), decodeURIComponent(path)) : file;
    if (!existsSync(resolved)) {
      out.push(`${target}: no such file`);
      continue;
    }
    if (image && /\.svg$/i.test(path)) out.push(`${target}: an SVG image`);
    if (anchor && /\.md$/.test(resolved)) {
      const headings = [...readFileSync(resolved, 'utf8').matchAll(/^#+\s+(.*)$/gm)].map((h) => slug(h[1]));
      if (!headings.includes(anchor)) out.push(`${target}: no heading #${anchor}`);
    }
  }
  return out;
}

describe('Marketplace listing', () => {
  it('has a name, a description and categories', () => {
    for (const k of ['name', 'displayName', 'description', 'publisher', 'version']) assert.ok(String(pkg[k] ?? '').trim(), `package.json has a ${k}`);
    assert.ok(Array.isArray(pkg.categories) && pkg.categories.length, 'categories');
    assert.ok(/^https:\/\/github\.com\//.test(pkg.repository?.url ?? ''), 'a GitHub repository, for the README\'s relative links');
  });

  it('has a PNG icon of at least 128×128 pixels', () => {
    const file = join(root, pkg.icon);
    assert.ok(existsSync(file), `${pkg.icon} exists`);
    const png = readFileSync(file);
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG', 'a PNG (vsce refuses an SVG icon)');
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    assert.ok(w >= 128 && h >= 128, `${w}×${h}`);
  });

  it('has at most 30 keywords (vsce refuses more)', () => {
    assert.ok(pkg.keywords.length <= 30, `${pkg.keywords.length} keywords`);
    for (const k of pkg.keywords) assert.ok(String(k).trim(), 'no empty keyword');
  });

  it("has a README whose links and images resolve", () => {
    assert.deepEqual(brokenLinks(join(root, 'README.md')), []);
    for (const doc of ['docs/CODEGEN.md', 'docs/REFERENCE.md', 'docs/UML-CONFORMANCE.md']) assert.deepEqual(brokenLinks(join(root, doc)), [], doc);
  });

  it("has a name the Visual Studio edition's listing doesn't use", (t) => {
    const manifest = join(root, '../fsm-editor-vs/src/FsmEditor.Vsix/source.extension.vsixmanifest');
    if (!existsSync(manifest)) return t.skip('../fsm-editor-vs is not beside this repo');
    const vs = /<DisplayName>([^<]*)<\/DisplayName>/.exec(readFileSync(manifest, 'utf8'))?.[1];
    assert.ok(vs, 'the Visual Studio edition has a DisplayName');
    assert.notEqual(pkg.displayName.trim().toLowerCase(), vs.trim().toLowerCase());
  });
});
