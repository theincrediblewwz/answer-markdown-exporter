import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { extractMarkdown } from '../src/extract';
import { renderPreview } from '../src/preview';

function capture(html: string, formulas: Array<{ selector: string; tex: string; display?: boolean }> = []) {
  const page = new JSDOM(`<article>${html}</article>`);
  try {
    for (const item of formulas) {
      const formula = page.window.document.createElement('span');
      formula.setAttribute('data-math-source', item.tex);
      if (item.display) formula.setAttribute('data-math-display', 'true');
      formula.textContent = 'rendered formula';
      page.window.document.querySelector(item.selector)!.append(formula);
    }
    return extractMarkdown(page.window.document.querySelector('article')!);
  } finally { page.window.close(); }
}

function annotations(document: Document): string[] {
  return [...document.querySelectorAll('annotation[encoding="application/x-tex"]')].map(node => node.textContent || '');
}

test('a pipe-containing table retains native math, exact TeX, emphasis and every column for external readers', async () => {
  const sources = [String.raw`c_r \asymp \alpha`, String.raw`|\varepsilon| \asymp \alpha^3`, String.raw`\|v\|_2`];
  const result = capture('<table><thead><tr><th>Item</th><th id="scale">Scale </th><th>Meaning</th></tr></thead><tbody><tr><td><strong>Sample</strong></td><td id="value">Before </td><td id="norm">After </td></tr></tbody></table>', [
    { selector: '#scale', tex: sources[0] }, { selector: '#value', tex: sources[1] }, { selector: '#norm', tex: sources[2] },
  ]);
  const external = new JSDOM(result.markdown);
  try {
    assert.deepEqual([...external.window.document.querySelectorAll('tr')].map(row => row.children.length), [3, 3]);
    assert.equal(external.window.document.querySelectorAll('math').length, 3);
    assert.ok([...external.window.document.querySelectorAll('math')].every(math => math.namespaceURI === 'http://www.w3.org/1998/Math/MathML'));
    assert.deepEqual(annotations(external.window.document), sources);
    assert.equal(external.window.document.querySelector('td strong')?.textContent, 'Sample');
    assert.match(external.window.document.querySelector('#value')?.textContent || external.window.document.querySelector('tbody td:nth-child(2)')!.textContent!, /Before/);
    assert.equal(external.window.document.querySelectorAll('code.math-inline,code.math-display').length, 0, 'valid table formulae must not depend on a reader-specific code-class convention');
    assert.deepEqual(result.formulas.map(item => item.rawSource), sources);
  } finally { external.window.close(); }

  const preview = new JSDOM((await renderPreview(result.markdown)).html);
  try {
    assert.deepEqual(annotations(preview.window.document), sources, 'the local preview must render each captured formula once');
    assert.equal(preview.window.document.querySelectorAll('.katex-error').length, 0);
    assert.deepEqual([...preview.window.document.querySelectorAll('tr')].map(row => row.children.length), [3, 3]);
  } finally { preview.window.close(); }
});

test('multiple formulae in one HTML table cell remain separate and code-looking TeX remains code', async () => {
  const page = new JSDOM('<article><table><tr><th colspan="2">Values</th></tr><tr><td id="formulas">First </td><td><code>|literal| + \\alpha</code></td></tr></table></article>');
  const sources = [String.raw`|a|`, String.raw`\frac{p}{q}`];
  try {
    const cell = page.window.document.querySelector('#formulas')!;
    for (const [index, source] of sources.entries()) {
      if (index) cell.append(page.window.document.createTextNode(' and '));
      const math = page.window.document.createElement('span');
      math.setAttribute('data-math-source', source);cell.append(math);
    }
    const result = extractMarkdown(page.window.document.querySelector('article')!);
    const preview = new JSDOM((await renderPreview(result.markdown)).html);
    try {
      assert.deepEqual(annotations(preview.window.document), sources);
      assert.equal(preview.window.document.querySelectorAll('math').length, 2);
      assert.equal(preview.window.document.querySelector('table td:last-child code')?.textContent, String.raw`|literal| + \alpha`);
      assert.match(preview.window.document.querySelector('table td')!.textContent!, /First[\s\S]* and /);
      assert.equal(result.formulas.length, 2);
    } finally { preview.window.close(); }
  } finally { page.window.close(); }
});

test('complex table groups, merged cells and multiline display formula source survive export and preview', async () => {
  const source = String.raw`\begin{aligned}a&=b\\` + '\n  ' + String.raw`c&=d\end{aligned}`;
  const result = capture('<table><thead><tr><th colspan="2">Merged heading</th></tr></thead><tbody><tr><td rowspan="2">Group</td><td id="formula"></td></tr><tr><td>Second row</td></tr></tbody><tfoot><tr><td colspan="2">Foot</td></tr></tfoot></table>', [{ selector: '#formula', tex: source, display: true }]);
  for (const html of [result.markdown, (await renderPreview(result.markdown)).html]) {
    const page = new JSDOM(html);
    try {
      assert.deepEqual([...page.window.document.querySelector('table')!.children].map(node => node.tagName), ['THEAD', 'TBODY', 'TFOOT']);
      assert.equal(page.window.document.querySelector('th')?.getAttribute('colspan'), '2');
      assert.equal(page.window.document.querySelector('tbody td')?.getAttribute('rowspan'), '2');
      assert.equal(page.window.document.querySelector('tfoot td')?.getAttribute('colspan'), '2');
      assert.equal(page.window.document.querySelector('math')?.getAttribute('display'), 'block');
      assert.deepEqual(annotations(page.window.document), [source]);
      assert.equal(page.window.document.querySelectorAll('.katex-error').length, 0);
    } finally { page.window.close(); }
  }
  assert.equal(result.formulas[0].rawSource, source);
});

test('ordinary pipe-free table formulae stay editable GFM instead of expanding to MathML', async () => {
  const source = String.raw`x_{n+1}=x_n^2`;
  const result = capture('<table><thead><tr><th>Formula</th><th>Meaning</th></tr></thead><tbody><tr><td id="formula"></td><td>Iteration</td></tr></tbody></table>', [{ selector: '#formula', tex: source }]);
  assert.match(result.markdown, /\| Formula\s+\| Meaning/);
  assert.ok(result.markdown.includes(`$${source}$`));
  assert.doesNotMatch(result.markdown, /<table|<math/);
  const page = new JSDOM((await renderPreview(result.markdown)).html);
  try { assert.deepEqual(annotations(page.window.document), [source]); }
  finally { page.window.close(); }
});

for (const [label, source] of [
  ['unknown command', String.raw`\notARealCommand{|x|}`],
  ['oversized source', '|x|' + 'x'.repeat(20_001)],
] as const) {
  test(`an HTML table with ${label} keeps its exact source and explains the rendering fallback`, () => {
    const result = capture('<table><tr><th colspan="2">Values</th></tr><tr><td id="formula"></td><td>Meaning</td></tr></table>', [{ selector: '#formula', tex: source }]);
    const page = new JSDOM(result.markdown);
    try {
      assert.equal(result.formulas[0].rawSource, source);
      assert.equal(page.window.document.querySelector('td code')?.textContent, source);
      assert.ok(result.diagnostics.some(item => item.code === 'TABLE_HTML_FALLBACK'));
      assert.ok(result.diagnostics.some(item => item.code === 'TABLE_MATH_SOURCE_FALLBACK' && item.severity === 'warning'), 'table fallback alone does not explain an unrendered formula');
      assert.equal(page.window.document.querySelectorAll('script,img,iframe').length, 0);
    } finally { page.window.close(); }
  });
}

test('MathML preview recovery discards untrusted visual markup and applies existing TeX and resource protections', async () => {
  const source = String.raw`x+\href{javascript:alert(1)}{click}`;
  const markdown = `<table><tr><td><math display="inline" onclick="evil()"><semantics><mrow><mtext>UNTRUSTED_VISUAL</mtext><mglyph src="https://images.example.test/track.png" onload="evil()"></mglyph></mrow><annotation encoding="application/x-tex">${source}</annotation><annotation-xml encoding="text/html"><script>evil()</script><img src="https://images.example.test/pixel.png" onerror="evil()"></annotation-xml></semantics></math></td></tr></table>`;
  const result = await renderPreview(markdown);
  const page = new JSDOM(result.html);
  try {
    assert.equal(page.window.document.querySelectorAll('script,mglyph,annotation-xml,img[src],iframe,object,embed').length, 0);
    assert.doesNotMatch(page.window.document.body.textContent || '', /UNTRUSTED_VISUAL/);
    for (const node of page.window.document.querySelectorAll('*')) {
      for (const attribute of node.attributes) assert.equal(/^on/i.test(attribute.name), false);
      assert.equal(/^\s*javascript:/i.test(node.getAttribute('href') || ''), false);
    }
  } finally { page.window.close(); }
});

test('oversized MathML annotations do not bypass the preview formula length limit', async () => {
  const source = 'x'.repeat(20_001);
  const result = await renderPreview(`<table><tr><td><math><semantics><mi>x</mi><annotation encoding="application/x-tex">${source}</annotation></semantics></math></td></tr></table>`);
  const page = new JSDOM(result.html);
  try {
    assert.equal(page.window.document.querySelectorAll('.katex').length, 0);
    assert.equal(page.window.document.querySelector('code')?.textContent, source);
    assert.ok(result.diagnostics.some(item => item.code === 'formula-preview-size'));
  } finally { page.window.close(); }
});
