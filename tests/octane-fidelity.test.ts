import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { extractMarkdown } from '../src/extract';

interface AstNode { type: string; value?: string; lang?: string; children?: AstNode[]; }

function parsed(markdown: string): AstNode {
  return unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown) as unknown as AstNode;
}
function find(node: AstNode, type: string): AstNode[] {
  return [...(node.type === type ? [node] : []), ...(node.children ?? []).flatMap(child => find(child, type))];
}
function withAnswer(html: string, run: (answer: Element) => void): void {
  const page = new JSDOM(`<main><div data-assistant-markdown data-assistant-markdown-root>${html}</div></main>`);
  try { run(page.window.document.querySelector('[data-assistant-markdown-root]')!); }
  finally { page.window.close(); }
}
function codeContainer(codeClass = ''): string {
  return `<div><span data-message-content-controls><button aria-label="复制密码"><svg><use href="#copy"></use></svg></button></span><span>python</span><pre><code${codeClass}></code></pre></div>`;
}

test('the current GPT code header becomes a fence language without becoming answer prose', () => {
  withAnswer(codeContainer(), answer => {
    const source = 'def greet(name):\n    marker = "```"\n    print(f"hello, {name}")';
    const code = answer.querySelector('code')!;
    // Real GPT uses highlighted spans and a text newline in a separate span.
    for (const [index, line] of source.split('\n').entries()) {
      if (index) { const newline = answer.ownerDocument.createElement('span'); newline.textContent = '\n'; code.append(newline); }
      const token = answer.ownerDocument.createElement('span'); token.textContent = line; code.append(token);
    }
    const result = extractMarkdown(answer);
    assert.deepEqual(result.codeBlocks, [{ text: source, language: 'python' }]);
    const ast = parsed(result.markdown);
    const codes = find(ast, 'code');
    assert.equal(codes.length, 1);
    assert.equal(codes[0].lang, 'python');
    assert.equal(codes[0].value, source);
    assert.equal(find(ast, 'paragraph').length, 0);
    assert.doesNotMatch(result.markdown, /复制密码|#copy/);
    assert.deepEqual(result.diagnostics, []);
  });
});

test('an explicit code language takes priority over a visual code-header label', () => {
  withAnswer(codeContainer(' class="language-text"'), answer => {
    answer.querySelector('code')!.textContent = 'literal source';
    const result = extractMarkdown(answer);
    assert.equal(result.codeBlocks[0].language, 'text');
    assert.equal(find(parsed(result.markdown), 'code')[0].lang, 'text');
  });
});

test('a language-looking span next to ordinary code remains prose without the GPT control marker', () => {
  withAnswer('<div><span>python</span><pre><code>literal source</code></pre></div>', answer => {
    const result = extractMarkdown(answer);
    const ast = parsed(result.markdown);
    assert.equal(result.codeBlocks[0].language, null);
    assert.equal(find(ast, 'paragraph')[0].children?.[0].value, 'python');
  });
});

test('an extra paragraph prevents a code-containing section from being collapsed into a code block', () => {
  withAnswer('<div><span data-message-content-controls></span><p>Keep this explanation.</p><span>python</span><pre><code>literal source</code></pre></div>', answer => {
    const result = extractMarkdown(answer);
    assert.match(result.markdown, /Keep this explanation/);
    assert.equal(result.codeBlocks.length, 1);
  });
});

test('current GPT math components preserve TeX annotation, aligned newlines and display mode exactly once', () => {
  withAnswer('<p>行内公式：<span data-d-component="math" dir="ltr"><span><span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>a</mi><mo>−</mo></mrow><annotation encoding="application/x-tex"></annotation></semantics></math></span><span class="katex-html" aria-hidden="true">VISUAL_ONLY_INLINE</span></span></span></span></p><div data-d-component="math" data-d-block dir="ltr"><span><span class="katex-display"><span class="katex"><span class="katex-mathml"><math display="block"><semantics><annotation encoding="application/x-tex"></annotation></semantics></math></span><span class="katex-html" aria-hidden="true">VISUAL_ONLY_BLOCK</span></span></span></span></div><a hidden></a>', answer => {
    const sources = [String.raw`a-b+\alpha`, String.raw`\begin{aligned}` + '\n' + String.raw`x &= y+1 \\` + '\n' + String.raw`z &= 2` + '\n' + String.raw`\end{aligned}`];
    answer.querySelectorAll('annotation').forEach((annotation, index) => { annotation.textContent = sources[index]; });
    const result = extractMarkdown(answer);
    assert.deepEqual(result.formulas.map(formula => [formula.rawSource, formula.display, formula.sourceKind]), [[sources[0], false, 'annotation'], [sources[1], true, 'annotation']]);
    const ast = parsed(result.markdown);
    assert.deepEqual(find(ast, 'inlineMath').map(node => node.value), [sources[0]]);
    assert.deepEqual(find(ast, 'math').map(node => node.value), [sources[1]]);
    assert.doesNotMatch(result.markdown, /VISUAL_ONLY|a−/);
    assert.deepEqual(result.diagnostics, []);
  });
});

test('current GPT table wrappers keep all cells, emoji and a literal pipe through Markdown parsing', () => {
  withAnswer('<div data-d-component="table"><table><thead><tr><th>项目</th><th>内容</th></tr></thead><tbody><tr><td>中文</td><td>保真 🧪</td></tr><tr><td>数学</td><td>行内公式 x^2</td></tr><tr><td>符号</td><td>A|B</td></tr></tbody></table></div>', answer => {
    const result = extractMarkdown(answer);
    const tables = find(parsed(result.markdown), 'table');
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0].children?.map(row => row.children?.map(cell => find(cell, 'text').map(node => node.value).join(''))), [['项目', '内容'], ['中文', '保真 🧪'], ['数学', '行内公式 x^2'], ['符号', 'A|B']]);
    assert.deepEqual(result.diagnostics, []);
  });
});
