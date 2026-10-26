import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { renderPreview } from '../src/preview';

test('preview retains validated native powers fractions roots and matrix structure without inferring TeX', async () => {
  const markup = '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block" aria-label="native expression"><mfrac linethickness="0"><msup><mi mathvariant="double-struck">R</mi><mn>2</mn></msup><msqrt><mi>x</mi></msqrt></mfrac><mroot><mi>y</mi><mn>3</mn></mroot><mfenced open="[" close="]"><mtable columnalign="right center" rowspacing=".5em"><mtr><mtd rowspan="2" columnspan="2"><mn>1</mn></mtd><mtd><mn>2</mn></mtd></mtr><mtr><mtd><mn>3</mn></mtd></mtr></mtable></mfenced></math>';
  const result = await renderPreview(markup);
  const page = new JSDOM(result.html);
  try {
    assert.deepEqual([...page.window.document.querySelectorAll('math *')].map(node => node.localName), ['mfrac', 'msup', 'mi', 'mn', 'msqrt', 'mi', 'mroot', 'mi', 'mn', 'mfenced', 'mtable', 'mtr', 'mtd', 'mn', 'mtd', 'mn', 'mtr', 'mtd', 'mn']);
    assert.equal(page.window.document.querySelector('math')!.getAttribute('aria-label'), 'native expression');
    assert.equal(page.window.document.querySelector('mi')!.getAttribute('mathvariant'), 'double-struck');
    assert.equal(page.window.document.querySelector('mfrac')!.getAttribute('linethickness'), '0');
    assert.equal(page.window.document.querySelector('mtable')!.getAttribute('columnalign'), 'right center');
    assert.equal(page.window.document.querySelector('mtd')!.getAttribute('rowspan'), '2');
    assert.equal(page.window.document.querySelector('mfenced')!.getAttribute('open'), '[');
    assert.ok([...page.window.document.querySelectorAll('math,math *')].every(node => node.namespaceURI === 'http://www.w3.org/1998/Math/MathML'));
    assert.equal(page.window.document.querySelectorAll('.katex,annotation,code').length, 0);
    assert.deepEqual(result.diagnostics, []);
  } finally { page.window.close(); }
});

for (const [label, markup] of [
  ['link', '<math href="https://example.test/pixel"><mi>x</mi></math>'],
  ['entity link', '<math><mi href="&#106;avascript:evil()">x</mi></math>'],
  ['CSS', '<math style="background:url(https://example.test/pixel)"><mi>x</mi></math>'],
  ['event', '<math><mi onclick="evil()">x</mi></math>'],
  ['unsafe XML annotation', '<math><semantics><mi>x</mi><annotation-xml encoding="text/html"><img src="https://example.test/pixel"></annotation-xml></semantics></math>'],
  ['HTML integration point', '<math><mtext><img src="https://example.test/pixel" onerror="evil()"></mtext></math>'],
  ['external glyph', '<math><mglyph src="https://example.test/pixel"></mglyph></math>'],
  ['invalid arity', '<math><msup><mi>x</mi></msup></math>'],
  ['invalid alignment', '<math><mtable columnalign="left evil"><mtr><mtd><mi>x</mi></mtd></mtr></mtable></math>'],
  ['invalid geometry', '<math><mspace width="1e99em"></mspace></math>'],
  ['conflicting namespace', '<math xmlns="https://example.test/not-math"><mi>x</mi></math>'],
  ['orphan math child', '<mfrac><mi>x</mi><mn>2</mn></mfrac>'],
] as const) {
  test(`preview fails closed for native MathML ${label}`, async () => {
    const result = await renderPreview(markup);
    const page = new JSDOM(result.html);
    try {
      assert.equal(page.window.document.querySelectorAll('math,mfrac,msup,mglyph,annotation-xml,img,script,style,[href],[src],[style],[onclick],[onerror]').length, 0);
      assert.match(page.window.document.body.textContent || '', /原生 MathML 无法安全预览/);
      assert.ok(result.diagnostics.some(item => item.code === 'native-mathml-preview-rejected'));
    } finally { page.window.close(); }
  });
}

test('preview rejects native math tree and text limits using the shared serializer policy', async () => {
  for (const markup of [
    `<math>${'<mrow>'.repeat(65)}<mi>x</mi>${'</mrow>'.repeat(65)}</math>`,
    `<math>${'<mi>x</mi>'.repeat(2_049)}</math>`,
    `<math><mtext>${'x'.repeat(50_001)}</mtext></math>`,
  ]) {
    const result = await renderPreview(markup);
    const page = new JSDOM(result.html);
    try {
      assert.equal(page.window.document.querySelector('math'), null);
      assert.ok(result.diagnostics.some(item => item.code === 'native-mathml-preview-rejected'));
    } finally { page.window.close(); }
  }
});

test('safe exact TeX recovery discards the visual tree and retains existing bounded KaTeX rendering', async () => {
  const source = String.raw`\frac{a}{b}+\color{red}{x}`;
  const result = await renderPreview(`<math style="font-size:999px"><semantics><mpadded width="999999em"><mtext>UNTRUSTED_VISUAL</mtext></mpadded><annotation encoding="application/x-tex">${source}</annotation><annotation-xml><script>evil()</script></annotation-xml></semantics></math>`);
  const page = new JSDOM(result.html);
  try {
    assert.equal(page.window.document.querySelectorAll('.katex').length, 1);
    assert.equal(page.window.document.querySelector('annotation[encoding="application/x-tex"]')?.textContent, source);
    assert.doesNotMatch(page.window.document.body.textContent || '', /UNTRUSTED_VISUAL/);
    assert.equal(page.window.document.querySelectorAll('script,annotation-xml').length, 0);
    assert.equal(result.diagnostics.some(item => item.code === 'native-mathml-preview-rejected'), false);
  } finally { page.window.close(); }
});

test('a markup-bearing TeX annotation cannot use plain-text recovery to bypass native validation', async () => {
  const result = await renderPreview('<math><semantics><mi>x</mi><annotation encoding="application/x-tex"><mi>x</mi></annotation></semantics></math>');
  assert.ok(result.diagnostics.some(item => item.code === 'native-mathml-preview-rejected'));
  assert.doesNotMatch(result.html, /class="katex|<math/);
});

test('preview preserves ruby definitions mark bidi and constrained direction and table scope', async () => {
  const result = await renderPreview('<div dir="rtl"><ruby>森<rp>(</rp><rt>もり</rt><rp>)</rp></ruby><bdi dir="auto">A-3</bdi><span dir="ltr">West</span></div><p dir="sideways">bad direction</p><dl><dt>Word</dt><dd><mark>Meaning</mark></dd></dl><table><tr><th scope="row">Safe</th><th scope="bad">Bad</th></tr></table>');
  const page = new JSDOM(result.html);
  try {
    assert.equal(page.window.document.querySelector('ruby rt')?.textContent, 'もり');
    assert.equal(page.window.document.querySelectorAll('ruby rp').length, 2);
    assert.equal(page.window.document.querySelector('dl dt')?.textContent, 'Word');
    assert.equal(page.window.document.querySelector('dd mark')?.textContent, 'Meaning');
    assert.equal(page.window.document.querySelector('bdi[dir="auto"]')?.textContent, 'A-3');
    assert.equal(page.window.document.querySelector('div[dir="rtl"] span[dir="ltr"]')?.textContent, 'West');
    assert.equal(page.window.document.querySelector('[dir="sideways"],[scope="bad"]'), null);
    assert.equal(page.window.document.querySelector('th[scope="row"]')?.textContent, 'Safe');
  } finally { page.window.close(); }
});

test('layout classes are constrained to generated table and cell names and page styles are discarded', async () => {
  const result = await renderPreview('<table class="gpt-md-layout arbitrary" style="position:fixed"><tr><td class="gpt-md-card unwanted" style="display:none">Card</td><td class="gpt-md-connector">→</td><th class="gpt-md-card">Header</th></tr></table><div class="gpt-md-layout" style="background:url(https://example.test/pixel)">Text</div>');
  const page = new JSDOM(result.html);
  try {
    assert.equal(page.window.document.querySelector('table')!.className, 'gpt-md-layout');
    assert.deepEqual([...page.window.document.querySelectorAll('td')].map(node => node.className), ['gpt-md-card', 'gpt-md-connector']);
    assert.equal(page.window.document.querySelector('th')!.hasAttribute('class'), false);
    assert.equal(page.window.document.querySelector('div')!.hasAttribute('class'), false);
    assert.equal(page.window.document.querySelector('[style]'), null);
  } finally { page.window.close(); }
});

test('clobber-prefixed local anchors resolve together while unmatched fragments remain local and external links stay hardened', async () => {
  const result = await renderPreview('<p id="constructor">Target</p><p id="字 句">Unicode target</p><a href="#constructor" target="_blank">first</a><a href="#%E5%AD%97%20%E5%8F%A5">unicode</a><a href="#missing">missing</a><a href="#%XX">malformed</a><a href="https://example.test/path">external</a>');
  const page = new JSDOM(result.html);
  try {
    const document = page.window.document;
    const anchors = [...document.querySelectorAll('a')];
    assert.equal(document.querySelector('[id="constructor"]'), null);
    for (const anchor of anchors.slice(0, 2)) {
      const href = anchor.getAttribute('href')!;
      assert.ok(document.getElementById(decodeURIComponent(href.slice(1))));
      assert.equal(anchor.hasAttribute('target'), false);
    }
    assert.equal(anchors[2].getAttribute('href'), '#missing');
    assert.equal(anchors[3].getAttribute('href'), '#%XX');
    assert.equal(anchors[2].hasAttribute('target'), false);
    assert.equal(anchors[3].hasAttribute('target'), false);
    assert.equal(anchors[4].getAttribute('target'), '_blank');
    assert.equal(anchors[4].getAttribute('rel'), 'noopener noreferrer');
    assert.equal(anchors[4].getAttribute('referrerpolicy'), 'no-referrer');
  } finally { page.window.close(); }
});
