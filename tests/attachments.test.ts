import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { extractMarkdown } from '../src/extract';
import { renderPreview } from '../src/preview';

interface AstNode { type: string; value?: string; children?: AstNode[]; }
function parsed(markdown: string): AstNode {
  return unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown) as unknown as AstNode;
}
function find(node: AstNode, type: string): AstNode[] {
  return [...(node.type === type ? [node] : []), ...(node.children ?? []).flatMap(child => find(child, type))];
}
function capture(html: string) {
  const page = new JSDOM(`<article>${html}</article>`, { url: 'https://chatgpt.com/c/fixture' });
  try { return extractMarkdown(page.window.document.querySelector('article')!); }
  finally { page.window.close(); }
}

test('account attribution and explicit excluded controls do not become answer content', () => {
  const result = capture('<h4 data-conversation-role="assistant" tabindex="-1">ChatGPT 说：</h4><h4 data-d-component="title">Keep the author heading</h4><div data-markdown-copy="contents"><p>Answer content.</p><span data-markdown-copy="exclude">CONTROL_ONLY</span></div>');
  assert.doesNotMatch(result.markdown, /ChatGPT|CONTROL_ONLY/);
  assert.match(result.markdown, /Keep the author heading/);
  assert.match(result.markdown, /Answer content/);
});

test('a bordered D card retains its grouping and separate caption without copying page markup', async () => {
  const result = capture('<div data-d-component="box" data-d-has-border><div data-d-component="row"><div data-d-component="box"><p data-d-component="text">Research file</p><p data-d-component="text">HTML document</p></div></div><p data-d-component="text">A short description.</p><span data-d-component="caption">File: <code data-d-component="code">sample.html</code></span></div>');
  const ast = parsed(result.markdown);
  assert.equal(find(ast, 'blockquote').length, 0, 'a visual card is not quoted prose');
  assert.match(result.markdown, /gpt-md-group gpt-md-bordered/);
  assert.doesNotMatch(result.markdown, /data-d-component|oIb9lq/);
  const preview = new JSDOM((await renderPreview(result.markdown)).html);
  try { assert.equal(preview.window.document.querySelectorAll('.gpt-md-bordered p').length, 4); }
  finally { preview.window.close(); }
});

test('an account renderer link without href keeps its label and reports an unavailable target', () => {
  const result = capture('<p><span data-d-component="box" data-d-inline><span data-d-component="pressable" role="link" aria-label="Open Sample download"><span data-d-component="text">Sample download<svg data-d-component="icon"><path d="M0 0"></path></svg></span></span></span></p>');
  assert.match(result.markdown, /Sample download/);
  assert.equal(find(parsed(result.markdown), 'link').length, 0);
  assert.doesNotMatch(result.markdown, /\[svg|\[图标\]|Open Sample/);
  assert.deepEqual(result.diagnostics.map(note => note.code), ['LINK_TARGET_UNAVAILABLE']);
});

test('a D link needs an explicit safe href and never promotes sandbox or script targets', () => {
  const good = capture('<span data-d-component="pressable" role="link" href="https://files.example.test/sample.html">Sample</span>');
  assert.equal(find(parsed(good.markdown), 'link').length, 1);
  for (const href of ['sandbox:/mnt/data/sample.html', 'javascript:alert(1)']) {
    const bad = capture(`<span data-d-component="pressable" role="link" href="${href}">Sample</span>`);
    assert.equal(find(parsed(bad.markdown), 'link').length, 0);
    assert.ok(bad.diagnostics.some(note => note.code === 'LINK_TARGET_UNAVAILABLE'));
  }
});

test('block links retain their card paragraphs and an explicit known destination', async () => {
  for (const html of [
    '<a href="https://files.example.test/archive.zip"><div><p>Research archive</p><p>About 3 MB</p></div></a>',
    '<span data-d-component="pressable" role="link" href="https://files.example.test/archive.zip"><div data-d-component="box"><p>Research archive</p><p>About 3 MB</p></div></span>',
  ]) {
    const result = capture(html);
    const ast = parsed(result.markdown);
    const links = find(ast, 'link') as Array<AstNode & { url: string }>;
    assert.deepEqual(links.map(link => link.url), ['https://files.example.test/archive.zip']);
    assert.match(result.markdown, /Research archive\n\nAbout 3 MB/);
    assert.equal(result.diagnostics.some(note => note.code === 'LINK_TARGET_UNAVAILABLE'), false);
    const preview = new JSDOM((await renderPreview(result.markdown)).html);
    try { assert.equal(preview.window.document.querySelector('a')?.getAttribute('href'), 'https://files.example.test/archive.zip'); }
    finally { preview.window.close(); }
  }
});

test('D table wrappers preserve every cell and inline Span fragments remain contiguous', () => {
  const result = capture('<div data-d-component="table"><table><thead><tr data-d-component="table-row"><th data-d-component="table-cell">File</th><th>Type</th></tr></thead><tbody><tr data-d-component="table-row"><td data-d-component="table-cell"><span data-d-component="text">sam</span><span data-d-component="text">ple.html</span></td><td><span data-d-component="box" data-d-inline><span data-d-component="text">HTML</span></span></td></tr><tr data-d-component="table-row"><td>other.md</td><td>Markdown</td></tr></tbody></table></div>');
  const tables = find(parsed(result.markdown), 'table');
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].children?.map(row => row.children?.length), [2, 2, 2]);
  assert.match(result.markdown, /sample\.html/);
  assert.doesNotMatch(result.markdown, /sam ple/);
});

test('D icons preserve accessible labels and mark unlabelled positions without copying SVG', () => {
  const result = capture('<p><svg data-d-component="icon" aria-label="Available"><path d="M0 0"></path></svg>Option</p><p><svg data-d-component="icon"><path d="M0 0"></path></svg>Another option</p>');
  assert.match(result.markdown, /图标：Available/);
  assert.match(result.markdown, /图标.*Another option/);
  assert.doesNotMatch(result.markdown, /<svg|M0 0|svg 内容未导出/);
  assert.ok(result.diagnostics.some(note => note.code === 'ICON_LABEL_UNAVAILABLE'));
});

test('an unresolved D image is explicit while a revealed IMG does not get a duplicate missing warning', () => {
  const missing = capture('<div data-d-component="image"><div data-d-image-loading data-d-component="loading-block"></div></div>');
  assert.match(missing.markdown, /图片尚未加载/);
  assert.equal(missing.diagnostics.filter(note => note.code === 'IMAGE_NOT_LOADED').length, 1);
  const loaded = capture('<div data-d-component="image"><img src="data:image/png;base64,AAAA" alt="Sample chart"><div data-d-image-loading data-d-component="loading-block"></div></div>');
  assert.equal(find(parsed(loaded.markdown), 'image').length, 1);
  assert.equal(loaded.diagnostics.some(note => note.code === 'IMAGE_NOT_LOADED'), false);
});

test('complex table HTML retains a controlled IMG instead of reducing it to a text link', () => {
  const result = capture('<table><tr><th colspan="2">Chart</th></tr><tr><td><img src="https://images.example.test/chart.png" alt="A &quot;chart&quot;" onerror="bad()"></td><td>Caption</td></tr></table>');
  const page = new JSDOM(result.markdown);
  try {
    const image = page.window.document.querySelector('table img');
    assert.ok(image);
    assert.equal(image.getAttribute('src'), 'https://images.example.test/chart.png');
    assert.equal(image.getAttribute('alt'), 'A "chart"');
    assert.equal(image.hasAttribute('onerror'), false);
    assert.equal(page.window.document.querySelectorAll('table a').length, 0);
  } finally { page.window.close(); }
});

test('complex table HTML preserves only safe alignment together with merged-cell structure', async () => {
  const result = capture('<table><tr><th colspan="2" align="center">Merged heading</th></tr><tr><td style="text-align:right">Aligned value</td><td align="left">Description</td></tr><tr><td align="unsafe&quot; onclick=&quot;bad()">Untrusted alignment</td><td>Other value</td></tr></table>');
  const page = new JSDOM((await renderPreview(result.markdown)).html);
  try {
    assert.equal(page.window.document.querySelector('th')?.getAttribute('colspan'), '2');
    assert.equal(page.window.document.querySelector('th')?.getAttribute('align'), 'center');
    const cells = page.window.document.querySelectorAll('td');
    assert.equal(cells[0].getAttribute('align'), 'right');
    assert.equal(cells[1].getAttribute('align'), 'left');
    assert.equal(cells[2].hasAttribute('align'), false);
    assert.equal(page.window.document.querySelectorAll('[onclick]').length, 0);
  } finally { page.window.close(); }
});

test('a rendered code block inside a D box keeps code priority and its language', () => {
  const result = capture('<div data-d-component="box"><span data-message-content-controls><button>Copy code</button></span><span>python</span><pre><code>def sample():\n    return 1</code></pre></div>');
  assert.deepEqual(result.codeBlocks, [{ text: 'def sample():\n    return 1', language: 'python' }]);
  assert.equal(find(parsed(result.markdown), 'paragraph').length, 0);
});

function attachment(name: string, kind: string): string {
  // Only the observed renderer structure is reproduced; these names are synthetic.
  return `<span><button type="button" aria-label="打开 ${name} 的预览"></button><span><svg aria-hidden="true"><path d="M0 0"></path></svg><span><span title="${name}">${name}</span><span><span>${kind}</span><span data-markdown-copy="exclude">打开文件</span></span></span><span><span><span><button type="button" aria-label="下载文件"></button></span></span></span></span></span>`;
}

test('native attachment cards become separate Markdown file rows with explicit unavailable entry targets', async () => {
  const result = capture(`<p>Available files.</p><div id="synthetic-files">${attachment('sample_a.html', 'HTML')}${attachment('sample_b.html', 'HTML')}${attachment('sample_c.md', 'Markdown')}</div>`);
  const tables = find(parsed(result.markdown), 'table');
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].children?.map(row => row.children?.map(cell => find(cell, 'text').map(node => node.value).join(''))), [
    ['文件', '类型', '入口'], ['sample_a.html', 'HTML', '请在原对话打开'], ['sample_b.html', 'HTML', '请在原对话打开'], ['sample_c.md', 'Markdown', '请在原对话打开'],
  ]);
  assert.equal(find(parsed(result.markdown), 'link').length, 0);
  assert.ok(result.diagnostics.some(note => note.code === 'ATTACHMENT_LINK_UNAVAILABLE'));
  const preview = new JSDOM((await renderPreview(result.markdown)).html);
  try { assert.equal(preview.window.document.querySelectorAll('table tbody tr').length, 3); }
  finally { preview.window.close(); }
});

test('a filename tooltip and text beside prose do not become attachment cards without the preview/download structure', () => {
  const result = capture('<div><span><span title="ordinary.html">ordinary.html</span><span><span>HTML</span><span>explained in prose</span></span></span></div>');
  assert.equal(find(parsed(result.markdown), 'table').length, 0);
  assert.match(result.markdown, /ordinary\.html/);
  assert.equal(result.diagnostics.some(note => note.code === 'ATTACHMENT_LINK_UNAVAILABLE'), false);
});

const iconPng = 'data:image/png;base64,iVBORw0KGgo=';
function rasterIcon(alt = 'Status'): string {
  return `<span data-d-component="icon"><img data-gpt-md-icon-image src="${iconPng}" alt="${alt}" width="999" height="999" onerror="bad()"></span>`;
}

test('a controlled rasterized D icon becomes a fixed-size safe inline PNG image', () => {
  const result = capture(`<p>${rasterIcon('A &quot;status&quot;')}Ready</p>`);
  const ast = parsed(result.markdown);
  assert.equal(find(ast, 'paragraph').length, 1);
  const markup = find(ast, 'html').map(node => node.value).join('');
  const page = new JSDOM(markup);
  try {
    const image = page.window.document.querySelector('img')!;
    assert.equal(image.getAttribute('src'), iconPng);
    assert.equal(image.getAttribute('alt'), 'A "status"');
    assert.equal(image.getAttribute('width'), '20');
    assert.equal(image.getAttribute('height'), '20');
    assert.deepEqual([...image.attributes].map(attribute => attribute.name).sort(), ['alt', 'height', 'src', 'width']);
    assert.equal(result.diagnostics.some(note => note.code === 'ICON_LABEL_UNAVAILABLE'), false);
  } finally { page.window.close(); }
});

test('a controlled icon marker does not permit SVG, remote URLs or malformed data sources', () => {
  for (const src of ['data:image/svg+xml;base64,PHN2Zz4=', 'https://images.example.test/icon.png', 'data:image/png;base64,AAAA!']) {
    const result = capture(`<span data-d-component="icon"><img data-gpt-md-icon-image src="${src}" alt="Untrusted"></span>`);
    assert.equal(find(parsed(result.markdown), 'html').length, 0);
    assert.equal(find(parsed(result.markdown), 'image').length, 0);
    assert.ok(result.diagnostics.some(note => note.code === 'ICON_LABEL_UNAVAILABLE'));
  }
});

test('a compact D icon and text row remains one paragraph while native heading depth survives', () => {
  const result = capture(`<div data-d-component="row">${rasterIcon()}<p data-d-component="text">Ready status</p></div><div data-d-component="row">${rasterIcon()}<h3 data-d-component="title">Section status</h3></div>`);
  const ast = parsed(result.markdown);
  assert.equal(find(ast, 'paragraph').length, 1);
  const paragraph = find(ast, 'paragraph')[0];
  assert.equal(paragraph.children?.filter(node => node.type === 'html').length, 1);
  assert.equal(paragraph.children?.filter(node => node.type === 'text').map(node => node.value).join(''), 'Ready status');
  const heading = find(ast, 'heading')[0] as AstNode & { depth: number };
  assert.equal(heading.depth, 3);
  assert.equal(heading.children?.filter(node => node.type === 'html').length, 1);
});

test('complex or bordered D rows retain their block boundaries instead of flattening into a compact row', () => {
  const complex = capture(`<div data-d-component="row">${rasterIcon()}<div data-d-component="box"><p data-d-component="text">First paragraph</p><p data-d-component="text">Second paragraph</p></div></div>`);
  const complexAst = parsed(complex.markdown);
  assert.equal(complexAst.children?.length, 3);
  assert.equal(find(complexAst, 'paragraph').length, 2);
  const bordered = capture(`<div data-d-component="row" data-d-has-border>${rasterIcon()}<p data-d-component="text">Separate text block</p></div>`);
  const borderedAst = parsed(bordered.markdown);
  assert.equal(borderedAst.children?.length, 2);
  assert.equal(find(borderedAst, 'paragraph').length, 1);
});

test('ordinary images and simple tables remain native Markdown nodes with raster icon support enabled', () => {
  const result = capture('<p><img src="https://images.example.test/chart.png" alt="Chart" width="120"></p><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody><tr><td>First</td><td>Retained</td></tr></tbody></table>');
  const ast = parsed(result.markdown);
  assert.equal(find(ast, 'image').length, 1);
  assert.equal(find(ast, 'table').length, 1);
  assert.equal(find(ast, 'html').length, 0);
});

test('the account math display flag keeps a one-line formula in display mode without relying on newlines', () => {
  const result = capture('<span data-math-source="x^2" data-math-display="true">Visual formula</span>');
  assert.equal(result.formulas[0].display, true);
  assert.equal(find(parsed(result.markdown), 'math')[0].value, 'x^2');
  assert.equal(find(parsed(result.markdown), 'inlineMath').length, 0);
  assert.equal(result.diagnostics.some(note => note.code === 'MATH_MULTILINE_DISPLAY'), false);
});

test('an explicit false math display flag remains inline and can override only a nested MathML hint', () => {
  for (const inner of ['', '<math display="block"><semantics></semantics></math>']) {
    const result = capture(`<p>Inline <span data-math-source="x^2" data-math-display="false">${inner}</span> formula.</p>`);
    assert.equal(result.formulas[0].display, false);
    assert.equal(find(parsed(result.markdown), 'inlineMath')[0].value, 'x^2');
    assert.equal(find(parsed(result.markdown), 'math').length, 0);
  }
});

test('a nested MathML block is a display hint when no mode is explicitly declared', () => {
  const result = capture('<span data-math-source="x^2"><math display="block"><semantics></semantics></math></span>');
  assert.equal(result.formulas[0].display, true);
  assert.equal(find(parsed(result.markdown), 'math')[0].value, 'x^2');
});

test('a false account flag cannot undo an actual display wrapper or the existing mode attribute priority', () => {
  for (const attributes of ['class="katex-display"', 'data-display="true"', 'data-math-type="block"']) {
    const result = capture(`<span data-math-source="x^2" data-math-display="false" ${attributes}>Visual formula</span>`);
    assert.equal(result.formulas[0].display, true);
    assert.equal(find(parsed(result.markdown), 'math')[0].value, 'x^2');
  }
});
