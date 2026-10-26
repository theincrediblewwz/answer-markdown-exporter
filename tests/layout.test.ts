import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { annotateLayout } from '../src/layout';
import { extractMarkdown } from '../src/extract';
import { renderPreview } from '../src/preview';

async function capture(html: string) {
  const page = new JSDOM(`<main>${html}</main>`);
  try {
    const original = page.window.document.querySelector('main')!;
    const copy = original.cloneNode(true) as Element; annotateLayout(original, copy);
    const result = extractMarkdown(copy);
    return { result, document: new JSDOM((await renderPreview(result.markdown)).html).window.document };
  } finally { page.window.close(); }
}

test('horizontal cards keep date/status pairs and connecting content in one row', async () => {
  const { result, document } = await capture('<section data-d-component="row" data-d-direction="row"><div data-d-component="box"><p>Day A</p><p>Prefix</p></div><span data-d-component="icon" aria-label="next">→</span><div data-d-component="box" style="background-color:rgba(30,140,100,.15)"><p>Day B</p><p>Test</p></div></section>');
  const cells = [...document.querySelectorAll('table.gpt-md-layout>tbody>tr>td')];
  assert.equal(cells.length, 3); assert.match(cells[0].textContent!, /Day A.*Prefix/); assert.match(cells[2].textContent!, /Day B.*Test/);
  assert.ok(cells[1].classList.contains('gpt-md-connector')); assert.ok(cells[2].classList.contains('gpt-md-highlight'));
  assert.equal(document.querySelectorAll('script,[style]').length, 0);
  assert.match(result.markdown, /<table/);
});

test('grid tracks, multiple rows and CSS visual order retain grouped content', async () => {
  const { document } = await capture('<div style="display:grid;grid-template-columns:repeat(2,1fr)"><section style="order:2"><h3>Second</h3><p>B</p></section><section style="order:1"><h3>First</h3><p>A</p></section><section style="order:3"><h3>Third</h3><p>C</p></section></div>');
  const rows = [...document.querySelectorAll('table.gpt-md-layout>tbody>tr')];
  assert.deepEqual(rows.map(row => [...row.children].map(cell => cell.textContent)), [['FirstA', 'SecondB'], ['ThirdC', '']]);
});

test('reverse flex, nested layout and inline mathematical sources coexist', async () => {
  const { result, document } = await capture('<div style="display:flex;flex-direction:row-reverse"><section><p>Left <span data-math-source="x^2">x2</span></p></section><section><p>Right</p><div data-d-component="row" data-d-direction="row"><div><p>One</p></div><div><p>Two</p></div></div></section></div>');
  const cells = document.querySelector('table.gpt-md-layout>tbody>tr')!.children;
  assert.match(cells[0].textContent!, /Right/); assert.match(cells[1].textContent!, /Left/);
  assert.equal(result.formulas.length, 1); assert.equal(result.formulas[0].tex, 'x^2');
  assert.equal(document.querySelectorAll('table.gpt-md-layout').length, 2);
});

test('stylesheet-only poem line breaks are captured before the source clone detaches', async () => {
  const { document } = await capture('<style>.verse span{display:block}</style><p class="verse"><span>One line</span><span>Two lines</span><span>Three lines</span></p>');
  assert.equal(document.querySelectorAll('br').length, 2);
});

test('merged answers receive separate anchor namespaces and retain matching targets', async () => {
  const page = new JSDOM('<main><p id="note">N</p><p><a href="#note">Ref</a></p></main>');
  try {
    const root = page.window.document.querySelector('main')!;
    const first = extractMarkdown(root, { idPrefix: 'one' }); const second = extractMarkdown(root, { idPrefix: 'two' });
    const output = new JSDOM((await renderPreview(first.markdown + '\n---\n\n' + second.markdown)).html).window.document;
    const ids = [...output.querySelectorAll('[id]')].map(node => node.id);
    assert.equal(new Set(ids).size, 2);
    for (const link of output.querySelectorAll('a[href]')) assert.ok(output.getElementById(link.getAttribute('href')!.slice(1)));
  } finally { page.window.close(); }
});
