import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { extractMarkdown } from '../src/extract';
import { renderPreview } from '../src/preview';
import { cloneAnswerContent } from '../src/adapter';

async function capture(html: string) {
  const page = new JSDOM(`<main>${html}</main>`);
  try {
    const result = extractMarkdown(cloneAnswerContent(page.window.document.querySelector('main')!));
    const preview = await renderPreview(result.markdown);
    return { result, preview, dom: new JSDOM(preview.html) };
  } finally { page.window.close(); }
}

test('empty visual bars retain their exact proportions, colors and fixed label columns in final Markdown and preview', async () => {
  const rows = [0, 37.5, 100].map((ratio, index) => `<div data-d-component="row" data-d-direction="row"><p data-d-component="text" data-d-has-width style="width:46px">Day ${index}</p><div data-d-component="box" style="height:16px;width:320px;background:rgb(245,245,245)"><div data-d-component="box" style="height:100%;width:${ratio}%;background:rgb(54,143,123)"></div></div><p data-d-component="text" data-d-has-width style="width:52px">Status ${index}</p></div>`).join('');
  const { result, preview, dom } = await capture(`<div data-d-component="box" data-d-has-border>${rows}</div>`);
  try {
    const document = dom.window.document;
    assert.equal(document.querySelectorAll('.gpt-md-group.gpt-md-bordered').length, 1);
    assert.equal(document.querySelectorAll('table.gpt-md-plain-row').length, 3);
    assert.deepEqual([...document.querySelectorAll('.gpt-md-meter')].map(node => node.getAttribute('data-gpt-md-ratio')), ['0', '37.5', '100']);
    assert.deepEqual([...document.querySelectorAll('.gpt-md-meter-fill')].map(node => (node as HTMLElement).style.width), ['0%', '37.5%', '100%']);
    assert.ok([...document.querySelectorAll('.gpt-md-meter-fill')].every(node => (node as HTMLElement).style.background === 'rgb(54, 143, 123)'));
    assert.deepEqual([...document.querySelectorAll('table:first-of-type td[width]')].slice(0, 2).map(node => node.getAttribute('width')), ['46', '52']);
    assert.match(result.markdown, /width:37\.5%/);
    assert.equal(preview.diagnostics.length, 0);
  } finally { dom.window.close(); }
});

test('vertical cards, centered content, badges and dividers keep their ownership without becoming quotations', async () => {
  const { result, dom } = await capture('<div data-d-component="box" data-d-has-border><div data-d-component="box" data-d-align="center" style="background:rgb(248,248,248)"><p data-d-component="text">Stage one</p><p data-d-component="text" data-d-size="xs">Detail one</p></div><div data-d-component="row" data-d-justify="center"><span>↓</span></div><div data-d-component="box" data-d-align="center" data-d-has-border><p>Stage two</p><p>Detail two</p></div></div><div data-d-component="box"><div data-d-component="row" data-d-direction="row"><p data-d-component="text" data-d-weight="medium">First step</p><div data-d-component="badge" data-color="success">Priority</div></div><div data-d-component="divider"></div><p data-d-component="text"><span data-d-component="text" data-d-inline data-d-default-strong>Second step</span></p></div>');
  try {
    const document = dom.window.document;
    const parent = document.querySelector('.gpt-md-bordered')!;
    assert.equal(parent.querySelectorAll(':scope > .gpt-md-group').length, 2);
    assert.equal(parent.querySelectorAll('.gpt-md-align-center').length, 3);
    assert.equal(document.querySelector('.gpt-md-badge-success')?.textContent, 'Priority');
    assert.equal(document.querySelectorAll('hr').length, 1);
    assert.equal(document.querySelector('strong')?.textContent, 'Second step');
    assert.equal(document.querySelectorAll('blockquote').length, 0);
    assert.doesNotMatch(result.markdown, /data-d-component|<style|<script/);
  } finally { dom.window.close(); }
});

test('rejected bar parameters cannot introduce page CSS, resources, hidden content or excessive geometry', async () => {
  for (const [ratio, color, height] of [['101', 'ffffff', '16'], ['NaN', 'ffffff', '16'], ['20', 'url(https://invalid.test/x)', '16'], ['20', '00ff00', '99999']]) {
    const preview = await renderPreview(`<div class="gpt-md-meter" data-gpt-md-ratio="${ratio}" data-gpt-md-bar-color="${color}" data-gpt-md-bar-height="${height}" style="position:fixed;background:url(https://invalid.test/x)"><img src="https://invalid.test/tracker.png"></div>`);
    const dom = new JSDOM(preview.html);
    try {
      assert.equal(dom.window.document.querySelectorAll('img,[style],.gpt-md-meter').length, 0);
      assert.ok(preview.diagnostics.some(item => item.code === 'bar-preview-rejected'));
    } finally { dom.window.close(); }
  }
});

test('code subtree layout facts are captured before detaching and hidden line fragments stay excluded', async () => {
  const { result, dom } = await capture('<style>.source .secret{display:none}.source .line{display:block}</style><pre class="source"><code><span class="line">one</span><span class="line"><span class="secret">HIDDEN</span>  two</span></code></pre>');
  try {
    assert.deepEqual(result.codeBlocks.map(code => code.text), ['one\n  two']);
    assert.doesNotMatch(result.markdown, /HIDDEN/);
    assert.equal(dom.window.document.querySelector('pre code')?.textContent?.trimEnd(), 'one\n  two');
  } finally { dom.window.close(); }
});

test('alignment alone keeps a card wrapper while hidden paragraph content never reappears', async () => {
  const { result, dom } = await capture('<div data-d-component="box" data-d-align="center"><p>Centered visible</p><p style="visibility:hidden">HIDDEN_PARAGRAPH</p></div>');
  try {
    assert.equal(dom.window.document.querySelector('.gpt-md-align-center p')?.textContent, 'Centered visible');
    assert.doesNotMatch(result.markdown, /HIDDEN_PARAGRAPH/);
  } finally { dom.window.close(); }
});

test('badges keep nested labels together and retain independent code blocks without invalid inline markup', async () => {
  const { result, dom } = await capture('<div data-d-component="badge"><div><p>Journal</p><p><strong>+1</strong></p></div></div><div data-d-component="badge"><pre><code>  keep_indent()</code></pre></div>');
  try {
    const document = dom.window.document;
    assert.equal(document.querySelector('.gpt-md-badge')?.textContent, 'Journal +1');
    assert.equal(document.querySelector('.gpt-md-badge strong')?.textContent, '+1');
    assert.equal(document.querySelectorAll('.gpt-md-badge p,.gpt-md-badge pre').length, 0);
    assert.deepEqual(result.codeBlocks.map(block => block.text), ['  keep_indent()']);
    assert.ok(document.querySelector('.gpt-md-group pre code')?.textContent?.startsWith('  keep_indent()'));
  } finally { dom.window.close(); }
});
