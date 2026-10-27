import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { cloneAnswerContent } from '../src/adapter';
import { captureCodeSources } from '../src/code-sources';
import { extractMarkdown } from '../src/extract';
import { renderPreview } from '../src/preview';

interface Ast { type: string; value?: string; lang?: string | null; children?: Ast[]; }
function find(node: Ast, type: string): Ast[] {
  return [...(node.type === type ? [node] : []), ...(node.children || []).flatMap(child => find(child, type))];
}
function capture(html: string, clone = true) {
  const page = new JSDOM(`<article>${html}</article>`);
  try {
    const root = page.window.document.querySelector('article')!;
    return extractMarkdown(clone ? cloneAnswerContent(root) : root);
  }
  finally { page.window.close(); }
}
function codes(markdown: string): Ast[] {
  return find(unified().use(remarkParse).parse(markdown) as Ast, 'code');
}
function block(id: string, content = '', dil = false): string {
  return `<div id="${id}" ${dil ? 'data-d-component="code_block"' : 'data-code-block="true" data-markdown-copy="code-block"'}>${content}</div>`;
}
const header = '<div data-markdown-copy="exclude"><div>Python</div><div data-code-block-controls="true"><button>Copy</button></div></div>';
const dilHeader = '<div><div><svg aria-hidden="true"><path d="M0 0"></path></svg>Python</div><div><button aria-label="复制"><svg aria-hidden="true"></svg></button></div></div>';

for (const attributes of ['hidden', 'aria-hidden="true"', 'inert', 'data-gpt-md-ignore', 'style="display:none"', 'style="visibility:hidden"', 'data-gpt-md-display="none"']) {
  test(`code roots and token subtrees respect ${attributes}`, () => {
    // Saved layout attributes belong to an already annotated export clone.
    const read = (html: string) => capture(html, !attributes.startsWith('data-gpt-md-display'));
    const result = read(`<pre><code data-language="text">  shown<span ${attributes}>HIDDEN_SOURCE</span>\n\tend</code></pre>`);
    assert.deepEqual(result.codeBlocks, [{ text: '  shown\n\tend', language: 'text' }]);
    assert.equal(codes(result.markdown)[0].value, '  shown\n\tend');
    assert.doesNotMatch(result.markdown, /HIDDEN_SOURCE/);
    assert.equal(read(`<pre><code ${attributes}>HIDDEN_ROOT</code></pre>`).markdown, '');
    assert.equal(read(`<div class="cm-editor"><div class="cm-content" ${attributes}><div class="cm-line">HIDDEN_CM</div></div></div>`).markdown, '');
  });
}

test('code-specific CSS facts survive detached cloning before token filtering and line grouping', () => {
  const result = capture('<style>.off{display:none}.line{display:block}</style><pre><code><span class="line">  first<span class="off">SECRET</span></span><span class="line">\tsecond</span></code></pre>');
  assert.equal(codes(result.markdown)[0].value, '  first\n\tsecond');
  assert.doesNotMatch(result.markdown, /SECRET/);
});

for (const [name, content, expected] of [
  ['DIV rows', '<div>  first</div><div><br></div><div>\tthird</div><div><br></div>', '  first\n\n\tthird\n'],
  ['explicit block SPAN rows', '<span style="display:block">first</span><span style="display:block"><br></span><span style="display:block">  third</span>', 'first\n\n  third'],
  ['nested row wrapper', '<div><div>first</div><div>second</div></div>', 'first\nsecond'],
  ['explicit CRLF separators', '<div>first</div>\r\n<div>second</div>', 'first\nsecond'],
  ['ordinary token SPANs', '<span class="line">const</span><span>  x</span>\n<span class="token">\treturn</span>', 'const  x\n\treturn'],
] as const) {
  test(`explicit code surfaces retain ${name} without guessing token classes`, () => {
    for (const html of [`<pre><code>${content}</code></pre>`, `<div data-code-block-source="true"><code>${content}</code></div>`]) {
      const result = capture(html);
      assert.equal(result.codeBlocks[0].text, expected);
      assert.equal(codes(result.markdown)[0].value, expected);
    }
  });
}

test('single-line marked source remains a block with language while surrounding prose survives', () => {
  const result = capture(block('native', `${header}<p>Before explanation</p><div><div data-code-block-source="true" data-language="python"><code>    print(42)</code></div></div><p>After explanation</p>`));
  assert.deepEqual(result.codeBlocks, [{ text: '    print(42)', language: 'python' }]);
  assert.equal(codes(result.markdown)[0].value, '    print(42)');
  assert.equal(codes(result.markdown)[0].lang, 'python');
  assert.match(result.markdown, /Before explanation/); assert.match(result.markdown, /After explanation/);
  assert.doesNotMatch(result.markdown, /Copy|MULTILINE/);
});

test('a source marker with no header preserves explicit CODE language and never borrows adjacent prose', () => {
  const result = capture('<p>Python</p><div data-code-block-source="true"><code data-language="javascript">console.log(42)</code></div>');
  assert.deepEqual(result.codeBlocks, [{ text: 'console.log(42)', language: 'javascript' }]);
  assert.match(result.markdown, /Python/);
  assert.equal(codes(result.markdown)[0].lang, 'javascript');
});

test('native marked widgets preserve their own PRE language and DIL widgets retain surrounding paragraphs', () => {
  const native = capture(block('native', `${header}<pre><code>print(42)</code></pre>`));
  assert.deepEqual(native.codeBlocks, [{ text: 'print(42)', language: 'python' }]);
  const dil = capture(block('dil', `${dilHeader}<p>Before note</p><pre class="cm-content"><code>print(42)</code></pre><p>After note</p>`, true));
  assert.deepEqual(dil.codeBlocks, [{ text: 'print(42)', language: 'python' }]);
  assert.match(dil.markdown, /Before note/); assert.match(dil.markdown, /After note/);
});

test('hidden header labels or Copy control ancestors never provide a language', () => {
  const result = capture(block('dil', '<div><div>Python</div><div hidden><button aria-label="复制"></button></div></div><pre class="cm-content"><code>print(42)</code></pre>', true));
  assert.equal(result.codeBlocks[0].language, null);
});

for (const tag of ['code', 'kbd', 'samp']) {
  test(`multiline ordinary ${tag} remains inside its paragraph with exact whitespace`, async () => {
    const result = capture(`<p>Before <${tag}>first<br>  second<br><br>\tlast</${tag}> after.</p>`);
    assert.deepEqual(result.codeBlocks, []);
    assert.equal(codes(result.markdown).length, 0);
    const rendered = await renderPreview(result.markdown);
    const page = new JSDOM(rendered.html);
    try {
      assert.equal(page.window.document.querySelectorAll('p').length, 1);
      assert.equal(page.window.document.querySelector('p > code')?.textContent, 'first\n  second\n\n\tlast');
      assert.equal(page.window.document.querySelector('p')?.textContent, 'Before first\n  second\n\n\tlast after.');
      assert.equal(page.window.document.querySelectorAll('pre').length, 0);
    } finally { page.window.close(); }
    assert.ok(result.diagnostics.some(item => item.code === 'MULTILINE_INLINE_CODE'));
  });
}

test('multiline inline code keeps CRLF trailing spaces and literal Markdown syntax after final preview parsing', async () => {
  const source = '  *literal* `tick` $x$ [link](https://example.test) & <img>  \r\n\t**next**\\path\rTAIL\n';
  const page = new JSDOM('<article><p>Before <code></code> after.</p></article>');
  try {
    const root = page.window.document.querySelector('article')!;
    root.querySelector('code')!.textContent = source;
    const result = extractMarkdown(cloneAnswerContent(root));
    const rendered = await renderPreview(result.markdown);
    const preview = new JSDOM(rendered.html);
    try {
      assert.equal(preview.window.document.querySelector('p > code')?.textContent, source);
      assert.equal(preview.window.document.querySelector('p')?.textContent, `Before ${source} after.`);
      assert.equal(preview.window.document.querySelectorAll('pre,a,strong,em,img,.katex').length, 0);
    } finally { preview.window.close(); }
  } finally { page.window.close(); }
});

test('nested code widgets are independent and never supply an outer missing source', () => {
  const inner = block('inner', `${dilHeader}<pre class="cm-content"><code>inner source</code></pre>`, true);
  const result = capture(block('outer', `<div>Python</div>${inner}`, true));
  assert.deepEqual(result.codeBlocks, [{ text: 'inner source', language: 'python' }]);
  assert.equal(codes(result.markdown).length, 1);
  assert.equal(result.diagnostics.filter(item => item.code === 'CODE_SOURCE_NOT_LOADED').length, 1);
  assert.doesNotMatch(result.markdown, /^Python/m);
});

test('own source and nested widgets both survive without swallowing their separate source', () => {
  const inner = block('inner', '<pre><code data-language="shell">echo nested</code></pre>', true);
  const result = capture(block('outer', `${dilHeader}<pre class="cm-content"><code>outer source</code></pre>${inner}`, true));
  assert.deepEqual(result.codeBlocks.map(code => code.text), ['outer source', 'echo nested']);
  assert.deepEqual(codes(result.markdown).map(code => code.value), ['outer source', 'echo nested']);
});

test('DIL code widgets with empty skeletons keep an explicit warning rather than a language title', () => {
  const result = capture(`<p>Before</p>${block('dil', `${dilHeader}<div><div></div></div>`, true)}<p>After</p>`);
  assert.match(result.markdown, /代码块尚未加载/);
  assert.doesNotMatch(result.markdown, /Python|复制/);
  assert.match(result.markdown, /Before/); assert.match(result.markdown, /After/);
  assert.deepEqual(result.codeBlocks, []);
  assert.ok(result.diagnostics.some(item => item.code === 'CODE_SOURCE_NOT_LOADED'));
});

test('DIL PRE.cm-content > CODE keeps exact source and uses only its own Copy header label', () => {
  const result = capture(`<p>Bash</p>${block('dil', `${dilHeader}<div><pre class="cm-content readonly"><code>  print(&quot;&#96;&#96;&#96;&quot;)\n\n\treturn 42\n</code></pre></div>`, true)}`);
  assert.deepEqual(result.codeBlocks, [{ text: '  print("```")\n\n\treturn 42\n', language: 'python' }]);
  assert.equal(codes(result.markdown)[0].lang, 'python');
  assert.match(result.markdown, /Bash/);
});

test('CodeMirror mixed-content wrappers retain their ordinary explanation and only export editor lines', () => {
  const result = capture('<div data-markdown-copy="code-block"><p>EXPLANATION</p><div class="cm-editor"><div class="cm-gutters">GUTTER</div><div class="cm-content" data-language="typescript"><div class="cm-line">  one</div><div class="cm-line"><br></div><div class="cm-line">\tthree</div></div></div><p>AFTER</p></div>');
  assert.match(result.markdown, /EXPLANATION/); assert.match(result.markdown, /AFTER/);
  assert.doesNotMatch(result.markdown, /GUTTER/);
  assert.deepEqual(result.codeBlocks, [{ text: '  one\n\n\tthree', language: 'typescript' }]);
});

test('visible CodeMirror virtual gaps diagnose incomplete source without inventing missing lines', () => {
  const result = capture('<div class="cm-editor"><div class="cm-content"><div class="cm-gap" style="height:900px"></div><div class="cm-line">only mounted row</div><div class="cm-gap" style="height:900px"></div></div></div>');
  assert.deepEqual(result.codeBlocks, [{ text: 'only mounted row', language: null }]);
  assert.equal(codes(result.markdown)[0].value, 'only mounted row');
  assert.equal(result.diagnostics.filter(item => item.code === 'CODE_SOURCE_INCOMPLETE').length, 1);
});

test('hidden CodeMirror gaps and hidden lines do not add missing-source warnings or blank lines', () => {
  const result = capture('<div class="cm-content"><div class="cm-gap" hidden></div><div class="cm-line">first</div><div class="cm-line" style="display:none">HIDDEN</div><div class="cm-line">second</div></div>');
  assert.deepEqual(result.codeBlocks, [{ text: 'first\nsecond', language: null }]);
  assert.deepEqual(result.diagnostics, []);
});

test('nested native sources and DIL PRE sources are saved before another source unmounts them', async () => {
  const page = new JSDOM(`<article>${block('native', `${header}<div><div data-code-block-source="true"><code>native initial</code></div></div>`)}${block('dil', `${dilHeader}<div><pre class="cm-content"><code>dil initial</code></pre></div>`, true)}${block('missing')}</article>`, { url: 'https://chatgpt.com/c/code-pipeline', pretendToBeVisual: true });
  try {
    const answer = page.window.document.querySelector('article')!;
    const native = answer.querySelector('#native')!, dil = answer.querySelector('#dil')!, missing = answer.querySelector('#missing')!;
    for (const mounted of [native, dil]) Object.assign(mounted, { scrollIntoView() { assert.fail('already mounted source was not snapshotted first'); } });
    Object.assign(missing, { scrollIntoView() {
      native.querySelector('[data-code-block-source]')!.remove(); dil.querySelector('pre')!.remove();
      missing.innerHTML = '<div data-code-block-source="true"><code>loaded final</code></div>';
    } });
    const snapshots = await captureCodeSources([answer], () => true, () => {});
    assert.deepEqual([...snapshots.keys()].map(block => block.id), ['native', 'dil', 'missing']);
    assert.deepEqual([...snapshots.values()].map(block => block.querySelector('code')!.textContent), ['native initial', 'dil initial', 'loaded final']);
    assert.deepEqual(extractMarkdown(cloneAnswerContent(answer, snapshots)).codeBlocks.map(code => code.text), ['native initial', 'dil initial', 'loaded final']);
  } finally { page.window.close(); }
});

test('a nested foreign source cannot satisfy an outer widget during snapshot preparation', async () => {
  const page = new JSDOM(`<article>${block('outer', block('inner', '<pre class="cm-content"><code>inner only</code></pre>', true), true)}</article>`, { url: 'https://chatgpt.com/c/code-pipeline', pretendToBeVisual: true });
  try {
    const answer = page.window.document.querySelector('article')!, outer = answer.querySelector('#outer')!, inner = answer.querySelector('#inner')!;
    let active = true;
    Object.assign(outer, { scrollIntoView() { active = false; } });
    const snapshots = await captureCodeSources([answer], () => active, () => {});
    assert.equal(snapshots.has(outer), false);
    assert.equal(snapshots.has(inner), true);
  } finally { page.window.close(); }
});

test('code snapshots retain CSS-derived token exclusion and row layout after sources and page styles disappear', async () => {
  const page = new JSDOM(`<style>.off{display:none}.row{display:block}</style><article>${block('native', `${header}<div data-code-block-source="true"><code><span class="row">first<span class="off">SECRET</span></span><span class="row">  second</span></code></div>`)}</article>`, { url: 'https://chatgpt.com/c/code-pipeline', pretendToBeVisual: true });
  try {
    const answer = page.window.document.querySelector('article')!;
    const snapshots = await captureCodeSources([answer], () => true, () => { assert.fail('mounted code must not scroll'); });
    answer.querySelector('[data-code-block-source]')!.remove(); page.window.document.querySelector('style')!.remove();
    const result = extractMarkdown(cloneAnswerContent(answer, snapshots));
    assert.deepEqual(result.codeBlocks, [{ text: 'first\n  second', language: 'python' }]);
    assert.doesNotMatch(result.markdown, /SECRET/);
  } finally { page.window.close(); }
});

test('nested source snapshots merge into their outer snapshot without replacing the inner source by a stale placeholder', async () => {
  const page = new JSDOM(`<article>${block('outer', `${header}<div data-code-block-source="true"><code>outer initial</code></div>${block('inner', '', true)}`)}</article>`, { url: 'https://chatgpt.com/c/code-pipeline', pretendToBeVisual: true });
  try {
    const answer = page.window.document.querySelector('article')!, inner = answer.querySelector('#inner')!;
    Object.assign(inner, { scrollIntoView() { inner.innerHTML = `${dilHeader}<pre class="cm-content"><code>inner loaded</code></pre>`; } });
    const snapshots = await captureCodeSources([answer], () => true, () => {});
    assert.equal(snapshots.size, 2);
    answer.querySelector('[data-code-block-source]')!.remove(); inner.querySelector('pre')!.remove();
    const result = extractMarkdown(cloneAnswerContent(answer, snapshots));
    assert.deepEqual(result.codeBlocks.map(code => code.text), ['outer initial', 'inner loaded']);
    assert.equal(result.diagnostics.some(item => item.code === 'CODE_SOURCE_NOT_LOADED'), false);
  } finally { page.window.close(); }
});

test('code snapshot character limits include added layout facts', async () => {
  const page = new JSDOM(`<article>${block('native', '<div data-code-block-source="true"><code></code></div>')}</article>`, { url: 'https://chatgpt.com/c/code-pipeline', pretendToBeVisual: true });
  try {
    const answer = page.window.document.querySelector('article')!, native = answer.querySelector('#native')!;
    native.querySelector('code')!.textContent = 'x'.repeat(2_000_000 - native.outerHTML.length - 10);
    assert.ok(native.outerHTML.length < 2_000_000);
    const snapshots = await captureCodeSources([answer], () => true, () => { assert.fail('a budget skip must not reveal or scroll an already mounted source'); });
    assert.equal(snapshots.size, 0, 'layout facts cannot overflow the two-million-character snapshot budget');
  } finally { page.window.close(); }
});

test('restoring a removed code source follows its original parent identity despite same-tag sibling insertion', async () => {
  for (const removeParent of [false, true]) {
    const page = new JSDOM('<article><div data-d-component="code_block"><p>Before</p><div id="source-parent"><pre><code>kept exact</code></pre></div><p>After</p></div></article>', { url: 'https://chatgpt.com/c/code-pipeline' });
    try {
      const root = page.window.document.querySelector('article')!, widget = root.firstElementChild!;
      const snapshots = await captureCodeSources([root], () => true, () => {});
      const parent = root.querySelector('#source-parent')!;
      parent.querySelector('pre')!.remove();
      const hidden = page.window.document.createElement('div'); hidden.hidden = true;
      hidden.textContent = 'HIDDEN_NEW_SIBLING'; widget.insertBefore(hidden, parent);
      if (removeParent) parent.remove();
      const result = extractMarkdown(cloneAnswerContent(root, snapshots));
      assert.deepEqual(result.codeBlocks.map(code => code.text), ['kept exact']);
      assert.doesNotMatch(result.markdown, /HIDDEN_NEW_SIBLING/);
      assert.ok(result.markdown.indexOf('Before') < result.markdown.indexOf('kept exact'));
      assert.ok(result.markdown.indexOf('After') > result.markdown.indexOf('kept exact'));
    } finally { page.window.close(); }
  }
});

test('an outer source snapshot never overwrites a newer nested widget source or newly added widget', async () => {
  const page = new JSDOM('<article><div data-d-component="code_block" id="outer"><div data-code-block-source="true"><code>outer exact</code><div data-d-component="code_block" id="inner"><pre><code>inner old</code></pre></div></div></div></article>', { url: 'https://chatgpt.com/c/code-pipeline' });
  try {
    const root = page.window.document.querySelector('article')!, inner = root.querySelector('#inner')!;
    const snapshots = await captureCodeSources([root], () => true, () => {});
    inner.querySelector('code')!.textContent = 'inner new';
    const latestInner = await captureCodeSources([inner], () => true, () => {});
    for (const [key, value] of latestInner) snapshots.set(key, value);
    const added = page.window.document.createElement('div'); added.setAttribute('data-d-component', 'code_block');
    added.innerHTML = '<pre><code>added new</code></pre>'; root.querySelector('#outer')!.append(added);
    for (const [key, value] of await captureCodeSources([added], () => true, () => {})) snapshots.set(key, value);
    inner.querySelector('pre')!.remove(); added.querySelector('pre')!.remove();
    const result = extractMarkdown(cloneAnswerContent(root, snapshots));
    assert.deepEqual(result.codeBlocks.map(code => code.text), ['outer exact', 'inner new', 'added new']);
  } finally { page.window.close(); }
});

test('a standalone CSS block code surface keeps block semantics while paragraph code keeps its phrasing owner', async () => {
  const result = capture('<div style="white-space:pre"><code style="display:block" data-language="text">first\n  second</code></div><p>Before <code style="display:block">inline\n  next</code> after.</p>');
  assert.deepEqual(result.codeBlocks, [{ text: 'first\n  second', language: 'text' }]);
  const dom = new JSDOM((await renderPreview(result.markdown)).html);
  try {
    assert.equal(dom.window.document.querySelectorAll('pre').length, 1);
    assert.equal(dom.window.document.querySelector('p > code')?.textContent, 'inline\n  next');
  } finally { dom.window.close(); }
});
