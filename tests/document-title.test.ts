import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { cleanDocumentTitle, suggestDocumentTitle } from '../src/document-title';

function suggested(html: string): string {
  const dom = new JSDOM(`<main>${html}</main>`);
  try { return suggestDocumentTitle(dom.window.document.querySelector('main')!, new Date(2026, 10, 17, 12, 34, 56)); }
  finally { dom.window.close(); }
}
test('PDF titles use any real heading instead of requiring an h1', () => {
  for (const level of [1, 2, 3, 4, 5, 6]) assert.equal(suggested(`<p>Introduction</p><h${level}>实验结果与下一步</h${level}>`), '实验结果与下一步');
  assert.equal(suggested('<blockquote><h1>Quoted title</h1></blockquote><h2>Actual title</h2>'), 'Actual title');
  assert.equal(suggested('<h4>ChatGPT 说：</h4><p>正文摘要可作为文件名。</p>'), '正文摘要可作为文件名。');
});
test('paragraph and list summaries name answers with no heading; empty/code-only exports use a dated name', () => {
  assert.equal(suggested('<p>这是一份没有标题的结果。</p>'), '这是一份没有标题的结果。');
  assert.equal(suggested('<ul><li>第一项建议</li></ul>'), '第一项建议');
  assert.equal(suggested('<pre><code># code is not a document heading</code></pre>'), 'GPT回答-20261117-123456');
});
test('filenames remove path separators, extensions, control characters and Windows reserved device names', () => {
  assert.equal(cleanDocumentTitle('  实验: A/B\\C?*.pdf  '), '实验 A B C');
  assert.equal(cleanDocumentTitle('CON.pdf'), '_CON');
  assert.equal(cleanDocumentTitle('LPT1.results.pdf'), '_LPT1.results');
  assert.equal(cleanDocumentTitle('../'), '');
  assert.equal(cleanDocumentTitle('A\u202eB\u0000C'), 'A B C');
  assert.equal(Array.from(cleanDocumentTitle('😀'.repeat(100))).length, 80);
});
test('math titles read one annotation rather than duplicated KaTeX display and accessibility text', () => {
  assert.equal(suggested('<h2>公式 <span class="katex"><span class="katex-mathml"><math><semantics><mi>E</mi><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span><span aria-hidden="true">duplicate</span></span></h2>'), '公式 E=mc^2');
});
