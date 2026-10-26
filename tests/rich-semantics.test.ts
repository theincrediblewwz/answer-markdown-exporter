import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeStringify from 'rehype-stringify';
import { extractMarkdown } from '../src/extract';
import { renderPreview } from '../src/preview';

// These examples are independently authored semantic cases, not captured chats.
// Read the actual serialized Markdown with a standard HTML-capable GFM reader
// as well as the product preview; no implementation-specific Markdown golden.
async function roundTrips(html: string, verify: (document: Document, reader: string) => void): Promise<void> {
  const source = new JSDOM(`<article>${html}</article>`, { url: 'https://chat.example.test/conversation/semantic-case' });
  try {
    const result = extractMarkdown(source.window.document.querySelector('article')!);
    const portable = String(await unified().use(remarkParse).use(remarkGfm)
      .use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw).use(rehypeStringify).process(result.markdown));
    const preview = await renderPreview(result.markdown);
    for (const [reader, output] of [['portable Markdown reader', portable], ['local preview', preview.html]]) {
      const page = new JSDOM(output);
      try { verify(page.window.document, reader); } finally { page.window.close(); }
    }
  } finally { source.window.close(); }
}

function texts(nodes: Iterable<Element>): string[] {
  return [...nodes].map(node => node.textContent?.trim() || '');
}

function visibleLines(root: Element): string[] {
  const blocks = /^(?:P|DIV|SECTION|ARTICLE|BLOCKQUOTE|LI|DT|DD|H[1-6])$/;
  const read = (node: Node): string => {
    if (node.nodeType === 3) return (node.nodeValue || '').replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const element = node as Element;
    if (element.tagName === 'BR') return '\n';
    const content = [...element.childNodes].map(read).join('');
    return blocks.test(element.tagName) ? `\n${content}\n` : content;
  };
  return read(root).split('\n').map(line => line.trim()).filter(Boolean);
}

function assertLocalReferences(document: Document, reader: string): void {
  const anchors = [...document.querySelectorAll('a[href]')];
  assert.equal(anchors.length, 2, reader);
  const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(ids.length, 2, reader);
  assert.equal(new Set(ids).size, 2, reader);
  for (const id of ids) {
    assert.ok(!['constructor', '__proto__', 'location', 'name'].includes(id), `${reader}: IDs need a safe namespace`);
  }
  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') || '';
    assert.ok(href.startsWith('#'), `${reader}: same-document links must remain fragments`);
    const target = document.getElementById(decodeURIComponent(href.slice(1)));
    assert.ok(target, `${reader}: every fragment must resolve to its retained target`);
    if (reader === 'local preview') {
      assert.ok(!anchor.hasAttribute('target') || anchor.getAttribute('target') === '_self', 'footnote links must navigate within the preview');
    }
  }
  assert.equal(document.querySelectorAll('a[name]').length, 0, 'legacy names must not expose DOM-clobbering names');
}

test('list-item quotations and following annotations remain sibling blocks after Markdown readback', async () => {
  await roundTrips('<ol><li><p>Review the observation.</p><blockquote><p>The copper leaf turned green.</p></blockquote><p>Annotation: moisture explains the change.</p></li><li><p>Check the next sample.</p></li></ol>', (document, reader) => {
    const first = document.querySelector('ol > li');
    assert.ok(first, reader);
    const quote = first.querySelector(':scope > blockquote');
    assert.ok(quote, `${reader}: retain a quote inside its list item`);
    assert.equal(quote.textContent?.trim(), 'The copper leaf turned green.', reader);
    assert.equal(quote.nextElementSibling?.tagName, 'P', `${reader}: the annotation must remain outside the quote`);
    assert.equal(quote.nextElementSibling?.textContent?.trim(), 'Annotation: moisture explains the change.', reader);
    assert.deepEqual(texts(document.querySelectorAll('ol > li:last-child')), ['Check the next sample.'], reader);
  });
});

test('simple tables retain body row headers and scope instead of demoting them to data', async () => {
  await roundTrips('<table><thead><tr><th scope="col">Sensor</th><th scope="col">Reading</th></tr></thead><tbody><tr><th scope="row">North</th><td>17</td></tr><tr><th scope="row">South</th><td>23</td></tr></tbody></table>', (document, reader) => {
    assert.deepEqual(texts(document.querySelectorAll('thead th')), ['Sensor', 'Reading'], reader);
    assert.deepEqual(texts(document.querySelectorAll('tbody th[scope="row"]')), ['North', 'South'], reader);
    assert.equal(document.querySelectorAll('thead th[scope="col"]').length, 2, reader);
    assert.deepEqual(texts(document.querySelectorAll('tbody td')), ['17', '23'], reader);
  });
});

test('a table without a header keeps every data row as data on export and preview', async () => {
  await roundTrips('<table><tbody><tr><td>Birch</td><td>8</td></tr><tr><td>Elm</td><td>13</td></tr></tbody></table>', (document, reader) => {
    assert.equal(document.querySelectorAll('th,thead').length, 0, `${reader}: data must not be promoted into column headings`);
    assert.deepEqual([...document.querySelectorAll('tr')].map(row => texts(row.children)), [['Birch', '8'], ['Elm', '13']], reader);
    assert.equal(document.querySelectorAll('td').length, 4, reader);
  });
});

test('ruby without fallback parentheses retains its base-to-reading relationships', async () => {
  await roundTrips('<p>Read <ruby>森<rt>もり</rt></ruby> and <ruby>川<rt>かわ</rt></ruby> separately.</p>', (document, reader) => {
    const ruby = [...document.querySelectorAll('ruby')];
    assert.equal(ruby.length, 2, `${reader}: base and reading must remain structurally distinguishable`);
    assert.deepEqual(ruby.map(node => {
      const base = node.cloneNode(true) as Element;
      base.querySelectorAll('rt,rp').forEach(child => child.remove());
      return [base.textContent, node.querySelector('rt')?.textContent];
    }), [['森', 'もり'], ['川', 'かわ']], reader);
    assert.match(document.body.textContent || '', /Read[\s\S]*separately\./, reader);
  });
});

test('direction and bidi isolation survive while invalid direction values are rejected', async () => {
  await roundTrips('<p dir="rtl">مرحبا <bdi dir="auto">ref-29</bdi></p><p dir="ltr">West <span dir="auto">mix</span></p><p dir="sideways">Invalid direction</p>', (document, reader) => {
    assert.equal(document.querySelector('[dir="rtl"]')?.textContent?.trim(), 'مرحبا ref-29', reader);
    assert.match(document.querySelector('[dir="ltr"]')?.textContent || '', /West/, reader);
    assert.equal(document.querySelector('bdi[dir="auto"]')?.textContent, 'ref-29', reader);
    assert.equal(document.querySelector('span[dir="auto"]')?.textContent, 'mix', reader);
    assert.ok([...document.querySelectorAll('[dir]')].every(node => ['rtl', 'ltr', 'auto'].includes(node.getAttribute('dir') || '')), reader);
  });
  const raw = new JSDOM((await renderPreview('<p dir="sideways">bad</p><bdi dir="auto" onclick="bad()">safe</bdi>')).html);
  try {
    assert.equal(raw.window.document.querySelector('[dir="sideways"]'), null);
    assert.equal(raw.window.document.querySelector('bdi[dir="auto"]')?.textContent, 'safe');
    assert.equal(raw.window.document.querySelector('[onclick]'), null);
  } finally { raw.window.close(); }
});

test('same-document footnote targets and backlinks survive with safe IDs and local preview navigation', async () => {
  await roundTrips('<p id="constructor">A detail<a href="#__proto__">[1]</a></p><p id="__proto__">Evidence note <a href="#constructor">return</a></p>', assertLocalReferences);
});

test('raw Markdown HTML preview namespaces dangerous anchor IDs and rewrites matching fragments together', async () => {
  const page = new JSDOM((await renderPreview('<p id="constructor">A detail<a href="#__proto__">[1]</a></p>\n\n<p id="__proto__">Evidence note <a href="#constructor">return</a></p>')).html);
  try { assertLocalReferences(page.window.document, 'local preview'); } finally { page.window.close(); }
});

test('explicit block spans, pre-line whitespace and explicit BR preserve visible poetry lines', async () => {
  await roundTrips('<section><p><span style="display:block">Rain reaches the sill.</span><span style="display: block">Tea warms the room.</span></p><p style="white-space:pre-line">One lantern\nTwo windows\nThree quiet steps</p><p>Before dawn<br>After dusk</p></section>', (document, reader) => {
    assert.deepEqual(visibleLines(document.body), ['Rain reaches the sill.', 'Tea warms the room.', 'One lantern', 'Two windows', 'Three quiet steps', 'Before dawn', 'After dusk'], reader);
  });
});

test('definition-list groups and mark insertion deletion semantics survive the complete round trip', async () => {
  await roundTrips('<dl><dt>Drift</dt><dt>Offset</dt><dd><p>A shared definition with <mark>emphasis</mark>.</p></dd><dt>Revision</dt><dd><p>Replace <del>old wording</del> with <ins>new wording</ins>.</p></dd><dd><p>A second explanation.</p></dd></dl>', (document, reader) => {
    const list = document.querySelector('dl');
    assert.ok(list, reader);
    assert.deepEqual([...list.children].map(node => node.tagName), ['DT', 'DT', 'DD', 'DT', 'DD', 'DD'], reader);
    assert.deepEqual(texts(list.querySelectorAll(':scope > dt')), ['Drift', 'Offset', 'Revision'], reader);
    assert.equal(list.querySelector('dd mark')?.textContent, 'emphasis', reader);
    assert.equal(list.querySelector('dd del')?.textContent, 'old wording', reader);
    assert.equal(list.querySelector('dd ins')?.textContent, 'new wording', reader);
  });
});

test('nested lists quotes definitions direction and row-header tables preserve their ownership together', async () => {
  await roundTrips('<ul><li><p>Outer case</p><blockquote><p dir="rtl">النهر <bdi dir="auto">N-4</bdi></p><dl><dt><ruby>岸<rt>きし</rt></ruby></dt><dd><p><mark>River bank</mark></p><ol><li><p>Inner case</p><blockquote><p>Water rose.</p></blockquote><p>Inner annotation.</p></li></ol></dd></dl></blockquote><p>Outer annotation.</p><table><tbody><tr><th scope="row">Level</th><td><ins>High</ins></td></tr></tbody></table></li></ul>', (document, reader) => {
    const outer = document.querySelector('ul > li');
    assert.ok(outer, reader);
    const outerQuote = outer.querySelector(':scope > blockquote');
    assert.ok(outerQuote, reader);
    assert.equal(outerQuote.nextElementSibling?.textContent?.trim(), 'Outer annotation.', reader);
    const inner = outerQuote.querySelector('dl > dd > ol > li');
    assert.ok(inner, `${reader}: the inner list belongs to the definition`);
    assert.equal(inner.querySelector(':scope > blockquote')?.textContent?.trim(), 'Water rose.', reader);
    assert.equal(inner.querySelector(':scope > blockquote')?.nextElementSibling?.textContent?.trim(), 'Inner annotation.', reader);
    assert.equal(outerQuote.querySelector('p[dir="rtl"] bdi[dir="auto"]')?.textContent, 'N-4', reader);
    assert.equal(outerQuote.querySelector('dt ruby rt')?.textContent, 'きし', reader);
    assert.equal(outerQuote.querySelector('dd mark')?.textContent, 'River bank', reader);
    assert.equal(outer.querySelector(':scope > table tbody th[scope="row"]')?.textContent, 'Level', reader);
    assert.equal(outer.querySelector(':scope > table tbody td ins')?.textContent, 'High', reader);
  });
});
