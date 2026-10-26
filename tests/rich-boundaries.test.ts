import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeStringify from 'rehype-stringify';
import type { Element as HastElement, Root, RootContent } from 'hast';
import type { ExportResult } from '../src/types';
import { extractMarkdown } from '../src/extract';
import { renderPreview } from '../src/preview';

// Independent synthetic boundary cases. Inspect the actual exported Markdown,
// including its CommonMark HTML-block rules, rather than capture records alone.
const reader = unified().use(remarkParse).use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw);

async function readMarkdown(markdown: string): Promise<Root> {
  return await reader.run(reader.parse(markdown)) as Root;
}

function elements(node: Root | RootContent, tagName: string): HastElement[] {
  return [
    ...(node.type === 'element' && node.tagName === tagName ? [node] : []),
    ...('children' in node ? node.children.flatMap(child => elements(child, tagName)) : []),
  ];
}

function text(node: Root | RootContent): string {
  return node.type === 'text' ? node.value : 'children' in node ? node.children.map(text).join('') : '';
}

function capture(html: string, prepare?: (document: Document) => void): ExportResult {
  const page = new JSDOM(`<article>${html}</article>`, { url: 'https://chat.example.test/conversation/boundaries' });
  try {
    prepare?.(page.window.document);
    return extractMarkdown(page.window.document.querySelector('article')!);
  } finally { page.window.close(); }
}

async function documents(result: ExportResult, verify: (document: Document, source: string) => void): Promise<void> {
  const portable = String(await unified().use(remarkParse).use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw).use(rehypeStringify).process(result.markdown));
  const preview = await renderPreview(result.markdown);
  for (const [name, html] of [['CommonMark HTML reader', portable], ['local preview', preview.html]]) {
    const page = new JSDOM(html);
    try { verify(page.window.document, name); } finally { page.window.close(); }
  }
}

test('definition lists exclude hidden terms definitions and hidden wrapper descendants', async () => {
  const result = capture('<dl><dt>Visible term</dt><dd>Visible definition</dd><dt hidden>HIDDEN_DIRECT_TERM</dt><dd aria-hidden="true">HIDDEN_DIRECT_DEFINITION</dd><dt style="display:none">HIDDEN_STYLE_TERM</dt><div hidden><dt>HIDDEN_WRAPPED_TERM</dt><dd>HIDDEN_WRAPPED_DEFINITION</dd></div><div style="display:none"><dt>HIDDEN_STYLE_WRAPPER</dt><dd>HIDDEN_STYLE_DESCRIPTION</dd></div><div><dt>Second term</dt><dd>Second definition</dd></div></dl>');
  assert.doesNotMatch(result.markdown, /HIDDEN_/);
  await documents(result, (document, source) => {
    assert.deepEqual([...document.querySelectorAll('dl dt')].map(node => node.textContent), ['Visible term', 'Second term'], source);
    assert.deepEqual([...document.querySelectorAll('dl dd')].map(node => node.textContent), ['Visible definition', 'Second definition'], source);
    assert.doesNotMatch(document.body.textContent || '', /HIDDEN_/, source);
  });
});

test('table section row and cell targets keep their direction and paired fragment links', async () => {
  const result = capture('<p><a href="#body">Body</a> <a href="#row">Row</a> <a href="#label">Label</a> <a href="#value">Value</a></p><table><tbody id="body" dir="rtl"><tr id="row" dir="ltr"><th id="label" dir="auto" scope="row">Station</th><td id="value" dir="rtl">شرق</td></tr></tbody></table>');
  await documents(result, (document, source) => {
    const expected = [
      ['Body', 'TBODY', 'rtl'], ['Row', 'TR', 'ltr'], ['Label', 'TH', 'auto'], ['Value', 'TD', 'rtl'],
    ];
    for (const [label, tag, direction] of expected) {
      const link = [...document.querySelectorAll('a[href]')].find(node => node.textContent === label);
      assert.ok(link, `${source}: ${label} link retained`);
      const href = link.getAttribute('href') || '';
      assert.ok(href.startsWith('#'), `${source}: ${label} remains a local reference`);
      const target = document.getElementById(decodeURIComponent(href.slice(1)));
      assert.equal(target?.tagName, tag, `${source}: the ID belongs to the original table structure`);
      assert.equal(target?.getAttribute('dir'), direction, `${source}: direction belongs to its original table element`);
    }
    assert.equal(document.querySelector('th')?.getAttribute('scope'), 'row', source);
    const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
    assert.equal(new Set(ids).size, ids.length, `${source}: no duplicate target IDs`);
  });
});

test('list-item direction stays on each list item including nested list items', async () => {
  const result = capture('<ol><li dir="rtl"><p>شرقي</p><ul><li dir="auto">nested-42</li></ul></li><li dir="ltr">Western</li></ol>');
  await documents(result, (document, source) => {
    assert.equal(document.querySelector('ol > li')?.getAttribute('dir'), 'rtl', source);
    assert.equal(document.querySelector('ol > li ul > li')?.getAttribute('dir'), 'auto', source);
    assert.equal(document.querySelector('ol > li:last-child')?.getAttribute('dir'), 'ltr', source);
    assert.match(document.querySelector('ol > li')?.textContent || '', /شرقي[\s\S]*nested-42/, source);
  });
});

test('empty and whitespace-only TeX annotations do not replace real native fraction and power trees', async () => {
  for (const annotation of ['', ' \n\t  ']) {
    const result = capture('<p><math><semantics><mfrac><msup><mi>q</mi><mn>3</mn></msup><mi>r</mi></mfrac><annotation encoding="application/x-tex"></annotation></semantics></math></p>', document => {
      document.querySelector('annotation')!.textContent = annotation;
    });
    await documents(result, (document, source) => {
      assert.equal(document.querySelectorAll('math').length, 1, source);
      assert.equal(document.querySelectorAll('mfrac > msup').length, 1, `${source}: retain numerator power structure`);
      assert.deepEqual([...document.querySelector('mfrac')!.children].map(node => node.localName), ['msup', 'mi'], source);
      assert.equal(document.querySelector('msup > mi')?.textContent, 'q', source);
      assert.equal(document.querySelector('msup > mn')?.textContent, '3', source);
      assert.equal(document.querySelector('mfrac > mi')?.textContent, 'r', source);
    });
  }
});

test('layout HTML code with blank lines backticks backslashes CR and LF survives actual CommonMark readback exactly', async () => {
  const code = 'header\r\n\n```typescript\nconst path = "C:\\drafts\\next";\r\n\n``````\n  \\command{a & b < c>}\rTAIL\n\n';
  const result = capture('<section style="display:flex;flex-direction:row"><div><p>Code card</p><pre><code class="language-text"></code></pre></div><div><p>Adjacent card</p></div></section>', document => {
    document.querySelector('pre code')!.textContent = code;
  });
  const ast = await readMarkdown(result.markdown);
  const codes = elements(ast, 'code');
  assert.equal(codes.length, 1, 'HTML blank lines must not end the layout block and create extra code blocks');
  assert.equal(text(codes[0]), code, 'the final Markdown reader must recover every source character');
  assert.equal(text(ast).includes('Adjacent card'), true, 'the following layout card must remain outside the code');
  assert.equal(elements(ast, 'table').length, 1, 'the code remains inside the portable layout');
  assert.equal(result.codeBlocks[0]?.text, code);
});

test('multiple multiline TeX annotations with blank lines remain exact inside one table cell after CommonMark readback', async () => {
  const tex = [
    '\\begin{aligned}\na&=b\\\\\n\nc&=d\n\\end{aligned}',
    '\\frac{x}{y}\r\n\n  + \\sqrt{z}',
  ];
  const result = capture('<table><tbody><tr><td colspan="2"><span data-math-source=""></span><span data-math-source=""></span></td></tr></tbody></table>', document => {
    [...document.querySelectorAll('[data-math-source]')].forEach((node, index) => node.setAttribute('data-math-source', tex[index]));
  });
  const ast = await readMarkdown(result.markdown);
  assert.equal(elements(ast, 'table').length, 1);
  assert.equal(elements(ast, 'td').length, 1);
  assert.deepEqual(elements(ast, 'annotation').map(text), tex, 'blank lines and mixed CR/LF must remain source, not Markdown block boundaries');
});

test('explicit numeric grid row and column placement follows visual order rather than reversed DOM order', async () => {
  const result = capture('<section style="display:grid;grid-template-columns:1fr 1fr"><div style="grid-column:2;grid-row:2">Delta</div><div style="grid-column:1;grid-row:2">Gamma</div><div style="grid-column:2;grid-row:1">Beta</div><div style="grid-column:1;grid-row:1">Alpha</div></section>');
  await documents(result, (document, source) => {
    const rows = [...document.querySelectorAll('table tr')].map(row => [...row.children].map(cell => cell.textContent?.trim()));
    assert.deepEqual(rows, [['Alpha', 'Beta'], ['Gamma', 'Delta']], source);
  });
});

test('a simple explicit grid span keeps the wide cell before the following visual row', async () => {
  const result = capture('<section style="display:grid;grid-template-columns:1fr 1fr"><div style="grid-column:2;grid-row:2">Right below</div><div style="grid-column:1 / span 2;grid-row:1">Wide heading</div><div style="grid-column:1;grid-row:2">Left below</div></section>');
  await documents(result, (document, source) => {
    const rows = [...document.querySelectorAll('table tr')];
    assert.deepEqual(rows.map(row => [...row.children].map(cell => cell.textContent?.trim())), [['Wide heading'], ['Left below', 'Right below']], source);
    assert.equal(rows[0].firstElementChild?.getAttribute('colspan'), '2', source);
  });
});

test('unsupported named grid placement preserves text and explicitly diagnoses the layout limitation', async () => {
  const result = capture('<section style="display:grid;grid-template-columns:[left] 1fr [middle] 1fr [right]"><div style="grid-column:middle / right;grid-row:1">Named right</div><div style="grid-column:left / middle;grid-row:1">Named left</div></section>');
  assert.ok(result.diagnostics.some(item => item.severity === 'warning' && /(?:grid|网格|布局)/i.test(item.message)), 'an unsupported named grid cannot silently claim visual preservation');
  const ast = await readMarkdown(result.markdown);
  assert.match(text(ast), /Named right/);
  assert.match(text(ast), /Named left/);
});

test('rejected native MathML over fifty thousand characters keeps the complete XML source including its tail', async () => {
  const tail = 'SYNTHETIC_MATHML_TAIL_7JQ';
  let expected = '';
  const result = capture('<math display="block"><mtext></mtext></math>', document => {
    document.querySelector('mtext')!.textContent = 'v'.repeat(50_100) + tail;
    expected = document.querySelector('math')!.outerHTML;
  });
  assert.ok(result.diagnostics.some(item => item.severity === 'warning'), 'unsupported native math must be visible in diagnostics');
  const codes = elements(await readMarkdown(result.markdown), 'code');
  assert.equal(codes.length, 1, 'retain rejected XML as one inert source block');
  const recovered = text(codes[0]);
  assert.ok(recovered === expected || recovered === expected + '\n', 'recover the complete XML; a fenced block may add its conventional terminal line ending');
  assert.ok(text(codes[0]).includes(tail), 'the rejected source tail must not disappear');
});

test('rejected native math above the source budget fails explicitly instead of exporting a truncated success', () => {
  const page = new JSDOM('<article><math display="block"><mtext></mtext></math></article>');
  try {
    const original = 'SYNTHETIC_START\n' + 'x'.repeat(2_100_000) + '\nSYNTHETIC_END';
    page.window.document.querySelector('mtext')!.textContent = original;
    assert.throws(() => extractMarkdown(page.window.document.querySelector('article')!), 'a rejected over-budget answer must not look like a successful partial file');
    assert.equal(page.window.document.querySelector('mtext')!.textContent, original, 'rejection must leave the source untouched');
  } finally { page.window.close(); }
});
