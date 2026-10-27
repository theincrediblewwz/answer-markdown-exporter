import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { extractMarkdown } from '../src/extract';
import { renderPreview } from '../src/preview';

interface AstNode {
  type: string;
  value?: string;
  lang?: string;
  children?: AstNode[];
  [key: string]: unknown;
}

function root(html: string): Element {
  return new JSDOM(`<article>${html}</article>`).window.document.querySelector('article')!;
}

function tree(markdown: string): AstNode {
  return unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown) as unknown as AstNode;
}

function find(node: AstNode, type: string): AstNode[] {
  return [...(node.type === type ? [node] : []), ...(node.children ?? []).flatMap(child => find(child, type))];
}

function mathValues(markdown: string): string[] {
  const ast = tree(markdown);
  return [...find(ast, 'math'), ...find(ast, 'inlineMath')].map(node => node.value!);
}

function formula(tex: string, display = false): Element {
  const node = root('<span></span>').firstElementChild!;
  node.setAttribute('data-math-source', tex);
  if (display) node.classList.add('katex-display');
  node.textContent = 'rendered formula';
  return node;
}

test('formula source survives capture and final Markdown round trip without Unicode or whitespace rewriting', () => {
  const tex = String.raw`x − y  + \frac{a}{b}` + '\n' + String.raw`  + \begin{aligned}p&=q\\r&=s\end{aligned}`;
  const result = extractMarkdown(formula(tex, true));
  assert.equal(result.formulas.length, 1);
  assert.equal(result.formulas[0].rawSource, tex);
  assert.equal(result.formulas[0].tex, tex);
  assert.deepEqual(mathValues(result.markdown), [tex]);
  assert.equal(result.markdown.includes('−'), true);
});

test('KaTeX annotation and visual siblings produce one formula', () => {
  const tex = String.raw`\frac{x_1}{y^2}`;
  const node = root('<p>答案：<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex"></annotation></semantics></math></span><span class="katex-html" aria-hidden="true">VISUAL_DUPLICATE</span></span>。</p>');
  node.querySelector('annotation')!.textContent = tex;
  const result = extractMarkdown(node);
  assert.equal(result.formulas.length, 1);
  assert.equal(result.formulas[0].sourceKind, 'annotation');
  assert.deepEqual(mathValues(result.markdown), [tex]);
  assert.equal(result.markdown.includes('VISUAL_DUPLICATE'), false);
});

test('source attribute takes priority and conflicting source evidence is diagnosed', () => {
  const node = root('<span data-math-source="a+b"><span class="katex"><math><semantics><annotation encoding="application/x-tex">a-b</annotation></semantics></math><span class="katex-html">a+b</span></span></span>');
  const result = extractMarkdown(node);
  assert.equal(result.formulas.length, 1);
  assert.equal(result.formulas[0].rawSource, 'a+b');
  assert.deepEqual(mathValues(result.markdown), ['a+b']);
  assert.ok(result.diagnostics.length > 0, 'a source conflict must not be silent');
});

test('missing math source is visible and aria-label is not promoted to LaTeX', () => {
  const result = extractMarkdown(root('<p><span role="math" aria-label="x plus y"><span>x+y</span></span></p>'));
  assert.equal(result.formulas.some(item => item.sourceKind !== 'missing'), false);
  assert.deepEqual(mathValues(result.markdown), []);
  assert.match(result.markdown, /x\+y/);
  assert.ok(result.diagnostics.length > 0);
});

test('zero is a valid formula source', () => {
  const result = extractMarkdown(formula('0'));
  assert.deepEqual(mathValues(result.markdown), ['0']);
});

test('literal currency and dollars in ordinary prose are not reclassified as math', () => {
  const result = extractMarkdown(root('<p>Price $5 and $10; literal dollars remain text.</p>'));
  assert.deepEqual(mathValues(result.markdown), []);
  const text = find(tree(result.markdown), 'text').map(node => node.value).join('');
  assert.match(text, /Price \$5 and \$10/);
});

test('code block language, indentation, blank lines and internal fences survive final Markdown parsing', () => {
  const source = 'const amount = "$5";\n\n  // fence: ````\n  console.log(amount);';
  const node = root('<pre><div><button>Copy code</button></div><code class="language-javascript"></code></pre>');
  node.querySelector('code')!.textContent = source;
  const result = extractMarkdown(node);
  const codes = find(tree(result.markdown), 'code');
  assert.equal(codes.length, 1);
  assert.equal(codes[0].value, source);
  assert.equal(codes[0].lang, 'javascript');
  assert.equal(result.codeBlocks[0].text, source);
  assert.equal(result.markdown.includes('Copy code'), false);
});

test('inline code containing a backtick remains one literal code span', () => {
  const node = root('<p>Run <code></code> now.</p>');
  node.querySelector('code')!.textContent = 'a`b $x$';
  const result = extractMarkdown(node);
  assert.deepEqual(find(tree(result.markdown), 'inlineCode').map(item => item.value), ['a`b $x$']);
  assert.deepEqual(mathValues(result.markdown), []);
});

test('code trailing blank lines remain in the final file rather than only the capture record', () => {
  const source = 'first line\n\n';
  const node = root('<pre><code class="language-text"></code></pre>');
  node.querySelector('code')!.textContent = source;
  const result = extractMarkdown(node);
  assert.equal(result.codeBlocks[0].text, source);
  assert.equal(find(tree(result.markdown), 'code')[0].value, source);
});

test('CodeMirror answer blocks preserve lines and fences in the final Markdown without toolbar or gutter duplication', () => {
  const lines = ['const price = "$5";', '  console.log("````");', '', '    return price;', ''];
  const source = lines.join('\n');
  const node = root('<div data-markdown-copy="code-block"><div role="toolbar"><span>Wrong language label</span><button>Copy code</button></div><div class="cm-editor"><div class="cm-gutters">GUTTER_ONLY 1 2 3 4</div><div class="cm-scroller"><div class="cm-content" data-language="typescript"><div class="cm-line"></div><div class="cm-line"></div><div class="cm-line"><br></div><div class="cm-line"></div><div class="cm-line"><br></div><span class="cm-placeholder">PLACEHOLDER_ONLY</span></div></div></div></div>');
  const domLines = node.querySelectorAll('.cm-line');
  domLines[0].textContent = lines[0];
  domLines[1].textContent = lines[1];
  domLines[3].textContent = lines[3];
  const result = extractMarkdown(node);
  assert.equal(result.codeBlocks.length, 1, 'one CodeMirror block must not become several duplicate exports');
  assert.equal(result.codeBlocks[0].text, source);
  const codes = find(tree(result.markdown), 'code');
  assert.equal(codes.length, 1);
  assert.equal(codes[0].value, source);
  assert.equal(codes[0].lang, 'typescript');
  assert.doesNotMatch(result.markdown, /Wrong language label|Copy code|GUTTER_ONLY|PLACEHOLDER_ONLY/);
});

test('headings, nested lists and blockquotes preserve their hierarchy', () => {
  const result = extractMarkdown(root('<h2>主题</h2><ol start="3"><li>第一项<ul><li>子项</li></ul></li><li>第二项</li></ol><blockquote><p>引用内容</p></blockquote>'));
  const ast = tree(result.markdown);
  assert.equal(find(ast, 'heading')[0].depth, 2);
  const lists = find(ast, 'list');
  assert.equal(lists.length, 2);
  assert.equal(lists[0].ordered, true);
  assert.equal(lists[0].start, 3);
  assert.equal(lists[1].ordered, false);
  assert.equal(find(ast, 'blockquote').length, 1);
});

test('a parent list item does not inherit the checked state of a nested task', () => {
  const result = extractMarkdown(root('<ul><li>Parent group<ul><li><input type="checkbox" checked>Completed child</li><li><input type="checkbox">Pending child</li></ul></li><li>Other group</li></ul>'));
  const items = find(tree(result.markdown), 'listItem');
  assert.deepEqual(items.map(item => item.checked), [null, true, false, null]);
  assert.match(result.markdown, /- Parent group/);
});

test('complex HTML tables retain nested tables and every nested cell boundary', async () => {
  const result = extractMarkdown(root('<table><tr><th>Outer name</th><th>Details</th></tr><tr><td>One</td><td><table><thead><tr><th align="left">A</th><th align="right">B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></td></tr></table>'));
  assert.ok(result.diagnostics.some(note => note.code === 'TABLE_HTML_FALLBACK'));
  for (const html of [result.markdown, (await renderPreview(result.markdown)).html]) {
    const page = new JSDOM(html);
    try {
      assert.equal(page.window.document.querySelectorAll('table').length, 2);
      const nested = page.window.document.querySelector('table table')!;
      assert.deepEqual([...nested.querySelectorAll('tr')].map(row => [...row.children].map(cell => cell.textContent)), [['A', 'B'], ['1', '2']]);
      assert.equal(nested.querySelector('th:last-child')?.getAttribute('align'), 'right');
    } finally { page.window.close(); }
  }
});

test('complex HTML tables preserve explicit header groups for pagination without inventing them', async () => {
  for (const header of ['<thead><tr><th colspan="2">Repeat this header</th></tr></thead>', '<tr><th colspan="2">Ordinary first row</th></tr>']) {
    const result = extractMarkdown(root(`<table>${header}<tbody><tr><td>A</td><td>B</td></tr></tbody></table>`));
    const expectedHeaders = header.startsWith('<thead>') ? 1 : 0;
    for (const html of [result.markdown, (await renderPreview(result.markdown)).html]) {
      const page = new JSDOM(html);
      try {
        const table = page.window.document.querySelector('table')!;
        assert.equal(table.querySelectorAll(':scope > thead').length, expectedHeaders);
        assert.equal(table.rows.length, 2);
        assert.equal(table.querySelector('th')?.getAttribute('colspan'), '2');
      } finally { page.window.close(); }
    }
  }
});

test('multiple table header and body groups and footers keep their source ownership and order', async () => {
  const result = extractMarkdown(root('<table><thead><tr><th>Head A</th><th>Value A</th></tr></thead><thead><tr><th>Head B</th><th>Value B</th></tr></thead><tbody><tr><td>Body A</td><td>1</td></tr></tbody><tbody><tr><td>Body B</td><td>2</td></tr></tbody><tfoot><tr><td>Foot A</td><td>3</td></tr></tfoot><tfoot><tr><td>Foot B</td><td>4</td></tr></tfoot></table>'));
  assert.ok(result.diagnostics.some(note => note.code === 'TABLE_HTML_FALLBACK'));
  for (const html of [result.markdown, (await renderPreview(result.markdown)).html]) {
    const page = new JSDOM(html);
    try {
      const table = page.window.document.querySelector('table')!;
      assert.deepEqual([...table.children].map(group => [group.tagName.toLowerCase(), group.querySelector('tr')?.firstElementChild?.textContent]), [
        ['thead', 'Head A'], ['thead', 'Head B'], ['tbody', 'Body A'], ['tbody', 'Body B'], ['tfoot', 'Foot A'], ['tfoot', 'Foot B'],
      ]);
    } finally { page.window.close(); }
  }
});

test('an explicit footer or a two-row header cannot be flattened to one GFM header row', async () => {
  for (const content of [
    '<thead><tr><th>Heading A</th></tr><tr><th>Heading B</th></tr></thead><tbody><tr><td>Body</td></tr></tbody>',
    '<tbody><tr><td>Body</td></tr></tbody><tfoot><tr><td>Footer</td></tr></tfoot>',
  ]) {
    const result = extractMarkdown(root(`<table>${content}</table>`));
    assert.ok(result.diagnostics.some(note => note.code === 'TABLE_HTML_FALLBACK'));
    const page = new JSDOM((await renderPreview(result.markdown)).html);
    try {
      const table = page.window.document.querySelector('table')!;
      assert.equal(table.querySelectorAll(':scope > thead > tr').length, content.includes('<thead>') ? 2 : 0);
      assert.equal(table.querySelectorAll(':scope > tfoot > tr').length, content.includes('<tfoot>') ? 1 : 0);
      assert.equal(table.querySelector('tbody td')?.textContent, 'Body');
    } finally { page.window.close(); }
  }
});

test('nested table headers never become header groups of the surrounding complex table', async () => {
  const result = extractMarkdown(root('<table><tbody><tr><td colspan="2">Outer first row</td></tr><tr><td>Details</td><td><table><thead><tr><th>Inner heading</th></tr></thead><tbody><tr><td>Inner value</td></tr></tbody></table></td></tr></tbody></table>'));
  for (const html of [result.markdown, (await renderPreview(result.markdown)).html]) {
    const page = new JSDOM(html);
    try {
      const outer = page.window.document.querySelector('table')!;
      const inner = outer.querySelector('table')!;
      assert.equal(outer.querySelectorAll(':scope > thead').length, 0);
      assert.equal(outer.querySelectorAll(':scope > tbody > tr').length, 2);
      assert.equal(inner.querySelectorAll(':scope > thead > tr').length, 1);
      assert.equal(inner.querySelector('tbody td')?.textContent, 'Inner value');
    } finally { page.window.close(); }
  }
});

test('task lists inside complex HTML tables retain checked and unchecked states', async () => {
  const result = extractMarkdown(root('<table><tr><th colspan="2">Tasks</th></tr><tr><td><ul><li><input type="checkbox" checked>Done</li><li><input type="checkbox">Pending</li></ul></td><td>Other text</td></tr></table>'));
  assert.ok(result.diagnostics.some(note => note.code === 'TABLE_HTML_FALLBACK'));
  for (const html of [result.markdown, (await renderPreview(result.markdown)).html]) {
    const page = new JSDOM(html);
    try {
      const inputs = [...page.window.document.querySelectorAll<HTMLInputElement>('table input[type="checkbox"]')];
      assert.deepEqual(inputs.map(input => input.checked), [true, false]);
      assert.ok(inputs.every(input => input.disabled));
      assert.match(page.window.document.body.textContent || '', /Done.*Pending/s);
    } finally { page.window.close(); }
  }
});

test('literal BR line breaks preserve block code and retain multiline inline code inside its paragraph', async () => {
  const source = 'def sample():\n    value = 1\n\n    return value\n';
  const result = extractMarkdown(root('<pre><code class="language-python"><span>def sample():</span><br>    value = 1<br><br>    return value<br></code></pre>'));
  assert.deepEqual(result.codeBlocks, [{ text: source, language: 'python' }]);
  assert.equal(find(tree(result.markdown), 'code')[0].value, source);
  const inline = extractMarkdown(root('<p>Before <code>first<br>  second</code> after.</p>'));
  assert.deepEqual(inline.codeBlocks, []);
  assert.equal(find(tree(inline.markdown), 'code').length, 0, 'line breaks cannot promote a paragraph child into a separate block');
  const preview = await renderPreview(inline.markdown);
  const page = new JSDOM(preview.html);
  try {
    assert.equal(page.window.document.querySelectorAll('p').length, 1);
    assert.equal(page.window.document.querySelector('p > code')?.textContent, 'first\n  second');
    assert.equal(page.window.document.querySelector('p')?.textContent, 'Before first\n  second after.');
    assert.equal(page.window.document.querySelectorAll('pre').length, 0);
  } finally { page.window.close(); }
  assert.ok(inline.diagnostics.some(note => note.code === 'MULTILINE_INLINE_CODE'));
});

test('GFM table preserves cell boundaries when text contains pipes and line breaks', () => {
  const result = extractMarkdown(root('<table><thead><tr><th>名称</th><th>说明</th></tr></thead><tbody><tr><td>中文内容</td><td>a | b<br>next line</td></tr></tbody></table>'));
  const tables = find(tree(result.markdown), 'table');
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].children!.map(row => row.children!.length), [2, 2]);
  assert.match(result.markdown, /中文内容/);
  assert.equal(result.markdown.includes('\u2060'), false, 'must not inject a WORD JOINER for wrapping');
  assert.match(result.markdown, /next line/);
});

test('table math with pipe, backslash and dollar round trips without corrupting columns or TeX', async () => {
  const tex = String.raw`a|b + \alpha + \text{cost \$5}`;
  const node = root('<table><thead><tr><th>公式</th><th>说明</th></tr></thead><tbody><tr><td></td><td>literal | pipe</td></tr></tbody></table>');
  node.querySelector('tbody td')!.appendChild(formula(tex));
  const result = extractMarkdown(node);
  const tables = find(tree(result.markdown), 'table');
  if (tables.length) {
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0].children!.map(row => row.children!.length), [2, 2]);
    assert.deepEqual(mathValues(result.markdown), [tex]);
  } else {
    const html = new JSDOM(result.markdown).window.document;
    const table = html.querySelector('table');
    assert.ok(table, 'an unrepresentable GFM table must retain its structure via explicit HTML fallback');
    assert.deepEqual([...table.rows].map(row => row.cells.length), [2, 2]);
    assert.ok(table.textContent?.includes(tex), 'HTML fallback must retain the original TeX');
    assert.ok(result.diagnostics.length > 0);
    const preview = new JSDOM((await renderPreview(result.markdown)).html).window.document;
    assert.equal(preview.querySelector('annotation[encoding="application/x-tex"]')?.textContent, tex);
  }
});

test('complex table degrades explicitly without discarding block formula source', () => {
  const tex = String.raw`\begin{matrix}a&b\\c&d\end{matrix}`;
  const node = root('<table><tr><th colspan="2">合并表头</th></tr><tr><td>说明</td><td></td></tr></table>');
  node.querySelectorAll('td')[1].appendChild(formula(tex, true));
  const result = extractMarkdown(node);
  assert.ok(result.diagnostics.length > 0, 'complex table conversion needs a visible diagnostic');
  assert.equal(result.formulas[0].rawSource, tex);
  const htmlText = new JSDOM(result.markdown).window.document.body.textContent ?? '';
  assert.ok(result.markdown.includes(tex) || mathValues(result.markdown).includes(tex) || htmlText.includes(tex));
  assert.match(result.markdown, /合并表头/);
});

test('page controls and extension UI never become exported answer text', () => {
  const result = extractMarkdown(root('<p>Keep this answer.</p><button>Copy</button><div data-gpt-md-ui><button>下载 Markdown</button><p>UI_ONLY</p></div><script>alert("SCRIPT_ONLY")</script><style>.STYLE_ONLY{}</style>'));
  assert.match(result.markdown, /Keep this answer/);
  assert.doesNotMatch(result.markdown, /Copy|UI_ONLY|SCRIPT_ONLY|STYLE_ONLY|下载 Markdown/);
});

test('image reference remains in Markdown without embedding a fetched resource', () => {
  const result = extractMarkdown(root('<p><img src="https://images.example.test/photo.png" alt="示例图片"></p>'));
  assert.match(result.markdown, /https:\/\/images\.example\.test\/photo\.png/);
  assert.match(result.markdown, /示例图片/);
  assert.doesNotMatch(result.markdown, /data:image\//);
});

test('preview renders the final Markdown formula with its source annotation', async () => {
  const tex = String.raw`\frac{a}{b} + \alpha`;
  const exported = extractMarkdown(formula(tex, true));
  const result = await renderPreview(exported.markdown);
  const document = new JSDOM(result.html).window.document;
  assert.ok(document.querySelector('.katex'), 'the actual Markdown preview must render KaTeX');
  assert.equal(document.querySelector('annotation[encoding="application/x-tex"]')?.textContent, tex);
});
