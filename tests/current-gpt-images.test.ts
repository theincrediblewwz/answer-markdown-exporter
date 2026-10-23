import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { extractMarkdown } from '../src/extract';
import { prepareAssets } from '../src/assets';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
function capture(html: string) {
  const page = new JSDOM(`<article>${html}</article>`, { url: 'https://chatgpt.com/' });
  try { return extractMarkdown(page.window.document.querySelector('article')!); }
  finally { page.window.close(); }
}
function imageButton(inner: string, attributes = ''): string {
  return `<button data-message-image="original" aria-haspopup="dialog" aria-label="Sample picture" ${attributes}>${inner}</button>`;
}

test('a current GPT zoom button exports its image and reaches local image bundling without button chrome', async () => {
  const result = capture(`<p>Before</p>${imageButton(`<img src="${png}" alt="Sample picture" loading="lazy">`)}<p>After</p>`);
  const tree = unified().use(remarkParse).parse(result.markdown);
  const paragraph = tree.children.find(node => node.type === 'paragraph' && node.children.some(child => child.type === 'image'));
  assert.ok(paragraph?.type === 'paragraph');
  const image = paragraph.children.find(node => node.type === 'image');
  assert.ok(image?.type === 'image');
  assert.equal(image.url, png);
  assert.equal(image.alt, 'Sample picture');
  assert.match(result.markdown, /Before/);
  assert.match(result.markdown, /After/);
  assert.doesNotMatch(result.markdown, /aria-haspopup|<button|IMAGE_NOT_LOADED/);
  const assets = await prepareAssets(result.markdown);
  assert.equal(assets.hasImages, true);
  assert.equal(Object.keys(assets.files).length, 1);
  assert.match(assets.markdown, /!\[Sample picture\]\(images\/[^)]+\.png\)/);
  assert.equal(assets.diagnostics.length, 0);
});

test('hidden and explicitly excluded image buttons or nested image containers stay excluded', () => {
  for (const attributes of ['hidden', 'aria-hidden="true"', 'data-gpt-md-ui', 'data-gpt-md-ignore', 'data-markdown-copy="exclude"']) {
    const result = capture(imageButton(`<img src="${png}" alt="Excluded image">`, attributes));
    assert.equal(result.markdown, '', attributes);
  }
  const hiddenImage = capture(imageButton(`<span hidden><img src="${png}" alt="Excluded image"></span>`));
  assert.doesNotMatch(hiddenImage.markdown, /data:image|!\[/);
  assert.ok(hiddenImage.diagnostics.some(item => item.code === 'IMAGE_NOT_LOADED'));
});

test('ordinary action buttons and incomplete image markers never export their icons or labels', () => {
  for (const attributes of ['', 'data-message-image="original"', 'aria-haspopup="dialog"', 'data-message-image="thumbnail" aria-haspopup="dialog"']) {
    const result = capture(`<button ${attributes}><img src="${png}" alt="UI icon">Copy action</button>`);
    assert.equal(result.markdown, '', attributes);
    assert.equal(result.diagnostics.length, 0);
  }
});

test('an unresolved or unsafe answer image stays explicit and cannot introduce executable resources', () => {
  const missing = capture(imageButton('<span>Loading UI</span>'));
  assert.match(missing.markdown, /图片尚未加载/);
  assert.doesNotMatch(missing.markdown, /Loading UI/);
  assert.ok(missing.diagnostics.some(item => item.code === 'IMAGE_NOT_LOADED'));
  const unsafe = capture(imageButton('<img src="javascript:alert(1)" alt="Unavailable image">'));
  assert.match(unsafe.markdown, /Unavailable image/);
  assert.doesNotMatch(unsafe.markdown, /javascript:|!\[/);
  assert.ok(unsafe.diagnostics.some(item => item.code === 'IMAGE_SOURCE_MISSING'));
});
