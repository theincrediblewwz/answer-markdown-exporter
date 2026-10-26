import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { nativeMathMlAttributes, nativeMathMlTags, serializeNativeMathML } from '../src/native-mathml';

const namespace = 'http://www.w3.org/1998/Math/MathML';
function formula<T>(body: string, run: (source: Element, document: Document) => T): T {
  const page = new JSDOM(`<math xmlns="${namespace}">${body}</math>`);
  try { return run(page.window.document.querySelector('math')!, page.window.document); }
  finally { page.window.close(); }
}

function shape(source: Element): unknown {
  return {
    tag: source.localName,
    namespace: source.namespaceURI,
    attributes: [...source.attributes].filter(attribute => attribute.name !== 'xmlns').map(attribute => [attribute.name, attribute.value]),
    children: [...source.childNodes].map(node => node.nodeType === 1 ? shape(node as Element) : node.nodeValue),
  };
}

function roundTrip(source: Element): string {
  const before = source.outerHTML;
  const expected = shape(source);
  const serialized = serializeNativeMathML(source);
  assert.equal(source.outerHTML, before, 'captured page DOM must remain byte-for-byte unchanged');
  const parsed = new JSDOM(serialized);
  try {
    assert.deepEqual(shape(parsed.window.document.querySelector('math')!), expected);
    assert.equal(parsed.window.document.querySelectorAll('math').length, 1);
  } finally { parsed.window.close(); }
  return serialized;
}

test('native fractions, powers, square roots and indexed roots retain their original trees', () => {
  formula(`
    <mfrac linethickness="0.06em"><msup><mi>x</mi><mn>2</mn></msup><msqrt><mi>y</mi></msqrt></mfrac>
    <mo>+</mo><mroot><mi>z</mi><mn>3</mn></mroot>
  `, source => {
    source.setAttribute('display', 'block');
    source.setAttribute('alttext', 'x² / √y + ∛z');
    const html = roundTrip(source);
    assert.match(html, /<mfrac linethickness="0.06em"><msup>/);
    assert.match(html, /<mroot><mi>z<\/mi><mn>3<\/mn><\/mroot>/);
    assert.doesNotMatch(html, /annotation|\\frac|\\sqrt/, 'native structure must not be guessed into TeX');
  });
});

test('matrix rows, cells, spans, alignment and spacing remain mathematical structure', () => {
  formula('<mfenced open="[" close="]"><mtable columnalign="right center" rowalign="baseline" columnspacing=".5em 1em" rowspacing="0.25em" frame="solid" framespacing=".2em .3em"><mtr><mtd rowspan="2" columnspan="2"><mn>1</mn></mtd><mtd><mn>2</mn></mtd></mtr><mtr><mtd><mn>3</mn></mtd></mtr></mtable></mfenced>', source => {
    const html = roundTrip(source);
    assert.equal((html.match(/<mtr>/g) || []).length, 2);
    assert.equal((html.match(/<mtd/g) || []).length, 3);
  });
});

test('operators, limits, tensor scripts, fences and enclosures retain safe presentation attributes', () => {
  formula('<mstyle displaystyle="true" scriptlevel="+1"><menclose notation="box updiagonalstrike"><mmultiscripts><mi mathvariant="double-struck">R</mi><none></none><mn>2</mn><mprescripts></mprescripts><mn>1</mn><none></none></mmultiscripts></menclose><mspace width="-.2em" height="0px" depth="0"></mspace><munderover accent="true" accentunder="false"><mo form="prefix" largeop="true" movablelimits="true" lspace="thinmathspace" rspace="0em" maxsize="infinity">∑</mo><mi>i</mi><mi>n</mi></munderover><ms lquote="‘" rquote="’">value</ms></mstyle>', source => { roundTrip(source); });
});

test('text annotations and characters are preserved exactly without creating markup', () => {
  formula('<semantics><mi>𝑥</mi><annotation encoding="application/x-tex"></annotation></semantics><mtext></mtext>', (source, document) => {
    const tex = String.raw`  \frac{a & b}{<x>} + \text{"quoted"} ` + '\r\n\t' + '</annotation><script>alert(1)</script>';
    source.querySelector('annotation')!.append(document.createTextNode(tex));
    source.querySelector('mtext')!.textContent = '&lt; & ≤ \u2062 𝕽 " \' <img src="https://example.test/pixel">';
    source.setAttribute('aria-label', 'x < y & "value"\r\n\t');
    const html = roundTrip(source);
    const parsed = new JSDOM(html);
    try {
      assert.equal(parsed.window.document.querySelector('annotation')!.textContent, tex);
      assert.equal(parsed.window.document.querySelectorAll('script,img,a').length, 0);
      assert.match(html, /&lt;\/annotation&gt;&lt;script&gt;/);
      assert.match(html, /&#13;/);
    } finally { parsed.window.close(); }
  });
});

test('an absent namespace declaration is rebuilt on the root without mutating the source', () => {
  formula('<mi>x</mi>', source => {
    source.removeAttribute('xmlns');
    const html = roundTrip(source);
    assert.ok(html.startsWith(`<math xmlns="${namespace}">`));
    assert.equal(source.hasAttribute('xmlns'), false);
  });
});

test('named, numeric and markup-looking entities remain inert exact token text', () => {
  formula('<mtext>&lt;img src=&quot;https://example.test/pixel&quot; onerror=&quot;evil()&quot;&gt; &amp; &#x1D54A; &InvisibleTimes; &zzzUndefined;</mtext>', source => {
    const original = source.textContent;
    const html = roundTrip(source);
    const page = new JSDOM(html);
    try {
      assert.equal(page.window.document.querySelector('math')!.textContent, original);
      assert.equal(page.window.document.querySelectorAll('img,script').length, 0);
      assert.match(html, /&amp;zzzUndefined;/);
    } finally { page.window.close(); }
  });
  formula('<mi href="&#106;avascript:evil()">x</mi>', source => {
    assert.throws(() => serializeNativeMathML(source), /unsupported attribute \(href\)/);
  });
});

for (const [label, body] of [
  ['XML annotation', '<semantics><mi>x</mi><annotation-xml encoding="text/html"><img src="https://example.test/pixel" onerror="evil()"></annotation-xml></semantics>'],
  ['external glyph', '<mglyph src="https://example.test/font.svg"></mglyph>'],
  ['interactive expression', '<maction actiontype="toggle"><mi>x</mi><mi>y</mi></maction>'],
  ['unknown math', '<invented><mi>x</mi></invented>'],
  ['HTML token child', '<mtext><img src="https://example.test/pixel"></mtext>'],
  ['bare annotation', '<annotation encoding="text/plain">x</annotation>'],
  ['missing numerator', '<mfrac><mi>x</mi></mfrac>'],
  ['extra root child', '<mroot><mi>x</mi><mn>2</mn><mi>y</mi></mroot>'],
  ['unpaired tensor script', '<mmultiscripts><mi>x</mi><mi>i</mi></mmultiscripts>'],
  ['misplaced tensor marker', '<mrow><none></none></mrow>'],
  ['unknown semantic content', '<semantics><mi>x</mi><mrow><mi>y</mi></mrow></semantics>'],
  ['bare expression text', '<mrow>x+1</mrow>'],
] as const) {
  test(`unsupported ${label} fails explicitly instead of deleting math content`, () => {
    formula(body, source => { assert.throws(() => serializeNativeMathML(source), /Native MathML:/); });
  });
}

for (const [attribute, value] of [
  ['href', 'javascript:alert(1)'], ['style', 'background:url(https://example.test/track)'],
  ['onclick', 'evil()'], ['src', 'https://example.test/track'], ['class', 'outside-page-style'],
  ['toString', 'prototype-property'], ['display', 'block; background:red'],
  ['scriptlevel', '999'], ['mathsize', 'calc(100000px)'], ['mathvariant', 'url(https://example.test/font)'],
] as const) {
  test(`unapproved or invalid ${attribute} is rejected`, () => {
    formula('<mi>x</mi>', source => {
      source.setAttribute(attribute, value);
      assert.throws(() => serializeNativeMathML(source), /Native MathML:/);
    });
  });
}

test('numeric and enumerated geometry attributes have strict bounds and syntax', () => {
  for (const [tag, attribute, value] of [
    ['mspace', 'width', '1001em'], ['mspace', 'height', '-1em'], ['mspace', 'width', '1e99px'],
    ['mspace', 'width', '1em; color:red'], ['mo', 'stretchy', 'yes'],
    ['mtable', 'columnalign', 'left javascript:evil'], ['mtd', 'columnspan', '0'],
  ]) {
    formula('<mtable><mtr><mtd><mspace></mspace><mo>+</mo></mtd></mtr></mtable>', source => {
      source.querySelector(tag)!.setAttribute(attribute, value);
      assert.throws(() => serializeNativeMathML(source), /invalid .* value/);
    });
  }
});

test('HTML, foreign, prefixed and conflicting namespaces cannot masquerade as native math', () => {
  formula('<mi>x</mi>', (source, document) => {
    assert.throws(() => serializeNativeMathML(document.createElement('math')), /namespace math root/);
    source.append(document.createElementNS('http://www.w3.org/2000/svg', 'mi'));
    assert.throws(() => serializeNativeMathML(source), /unsupported element or namespace/);
    source.lastChild!.remove();
    source.append(document.createElementNS(namespace, 'evil:mi'));
    assert.throws(() => serializeNativeMathML(source), /unsupported element or namespace/);
    source.lastChild!.remove();
    source.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', 'https://example.test');
    assert.throws(() => serializeNativeMathML(source), /namespaced attribute/);
    source.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
    source.setAttribute('xmlns', 'https://example.test/not-math');
    assert.throws(() => serializeNativeMathML(source), /conflicting namespace/);
  });
});

test('invalid Unicode, comments, deep trees, excessive nodes and excessive text fail boundedly', () => {
  formula('<mtext></mtext>', (source, document) => {
    const token = source.firstElementChild!;
    for (const value of ['\u0000', '\uD800', '\uFFFE', 'x'.repeat(50_001)]) {
      token.textContent = value;
      assert.throws(() => serializeNativeMathML(source), /character/);
    }
    token.textContent = 'x';
    source.append(document.createComment('not mathematical content'));
    assert.throws(() => serializeNativeMathML(source), /unsupported node type/);
  });
  formula('<mi>x</mi>'.repeat(2_049), source => { assert.throws(() => serializeNativeMathML(source), /node limit/); });
  formula('<mrow>'.repeat(65) + '<mi>x</mi>' + '</mrow>'.repeat(65), source => { assert.throws(() => serializeNativeMathML(source), /depth limit/); });
  formula('<mi>x</mi>', source => {
    for (let index = 0; index < 25; index += 1) source.setAttribute(`data-test-${index}`, 'x');
    const before = source.outerHTML;
    assert.throws(() => serializeNativeMathML(source), /attribute limit/);
    assert.equal(source.outerHTML, before, 'rejection must also leave the captured source intact');
  });
});

test('exported HAST names retain native mathematical tags and attributes through actual raw parsing and sanitization', async () => {
  const html = formula('<mstyle displaystyle="true" scriptlevel="+1"><mfrac linethickness="0"><msup><mi mathvariant="double-struck">R</mi><mn>2</mn></msup><msqrt><mi>x</mi></msqrt></mfrac><mroot><mi>y</mi><mn>3</mn></mroot><mtable columnalign="right center" rowspacing="1em"><mtr><mtd rowspan="2" columnspan="2"><mn>1</mn></mtd></mtr><mtr><mtd><mn>2</mn></mtd></mtr></mtable><semantics><mi>z</mi><annotation encoding="text/plain">description &amp; value</annotation></semantics></mstyle>', source => {
    source.setAttribute('display', 'block');
    source.setAttribute('aria-label', 'native math');
    return serializeNativeMathML(source);
  });
  const sanitized = String(await unified()
    .use(remarkParse)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, {
      ...defaultSchema,
      tagNames: [...new Set([...(defaultSchema.tagNames ?? []), ...nativeMathMlTags])],
      attributes: { ...defaultSchema.attributes, ...nativeMathMlAttributes },
    })
    .use(rehypeStringify)
    .process(html));
  const before = new JSDOM(html);
  const after = new JSDOM(sanitized);
  try {
    assert.deepEqual(shape(after.window.document.querySelector('math')!), shape(before.window.document.querySelector('math')!));
    assert.equal(after.window.document.querySelector('mtd')!.getAttribute('rowspan'), '2');
    assert.ok(nativeMathMlAttributes.mi.includes('mathvariant'));
    assert.ok(nativeMathMlAttributes.mtable.includes('columnalign'));
    assert.ok(nativeMathMlAttributes.mtd.includes('rowSpan'));
    assert.ok(nativeMathMlAttributes.math.includes('ariaLabel'));
    assert.equal(nativeMathMlTags.includes('annotation-xml'), false);
    assert.equal(nativeMathMlTags.includes('mglyph'), false);
    assert.ok(Object.values(nativeMathMlAttributes).every(names => names.every(name => !/^(?:href|style|src|on)/i.test(name))));
  } finally { before.window.close(); after.window.close(); }
});
