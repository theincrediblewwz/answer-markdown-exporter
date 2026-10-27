import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { renderPreview } from '../src/preview';

test('math language fences and raw HTML code stay literal while explicit formula syntax still renders', async () => {
  const source = String.raw`\frac{a}{b} + <tag> & "$x$"`;
  const preview = await renderPreview('```math\n' + source + '\n```\n\n<pre><code class="language-math">a &lt; b</code></pre>\n\n$y^2$\n\n$$\nz^3\n$$\n');
  const dom = new JSDOM(preview.html);
  try {
    const document = dom.window.document;
    assert.deepEqual([...document.querySelectorAll('pre code')].map(node => node.textContent), [source + '\n', 'a < b']);
    assert.ok([...document.querySelectorAll('pre code')].every(node => node.classList.contains('language-math')));
    assert.deepEqual([...document.querySelectorAll('annotation[encoding="application/x-tex"]')].map(node => node.textContent), ['y^2', 'z^3']);
    assert.equal(document.querySelectorAll('tag,script,.katex-error').length, 0);
    assert.deepEqual(preview.diagnostics, []);
  } finally { dom.window.close(); }
});
