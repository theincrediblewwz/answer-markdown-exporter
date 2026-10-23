import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { renderPreview } from '../src/preview';

test('preview removes scripts, event handlers and executable URL schemes before insertion', async () => {
  const result = await renderPreview('<script>window.BAD=1</script>\n\n<img src="x" onerror="window.BAD=2">\n\n<a href="javascript:alert(1)" onclick="evil()">bad link</a>\n\n<svg onload="evil()"><script>evil()</script></svg>');
  const document = new JSDOM(result.html).window.document;
  assert.equal(document.querySelectorAll('script').length, 0);
  for (const node of document.querySelectorAll('*')) {
    for (const attribute of node.attributes) assert.equal(/^on/i.test(attribute.name), false);
    assert.equal(/^\s*javascript:/i.test(node.getAttribute('href') ?? ''), false);
  }
});

test('preview does not create remote image requests', async () => {
  const result = await renderPreview('![photo](https://images.example.test/track.png)\n\n<img src="https://other.example.test/pixel.gif" alt="tracking">');
  const document = new JSDOM(result.html).window.document;
  assert.equal(document.querySelectorAll('img[src],source[src],source[srcset],iframe,object').length, 0);
  assert.ok(document.body.textContent?.includes('photo') || document.querySelector('a[href="https://images.example.test/track.png"]'));
});

test('unknown math command remains visible and is diagnosed', async () => {
  const result = await renderPreview(String.raw`$$` + '\n' + String.raw`\notARealCommand{x}` + '\n$$\n');
  assert.ok(result.diagnostics.length > 0);
  assert.match(new JSDOM(result.html).window.document.body.textContent ?? '', /notARealCommand/);
});

test('untrusted TeX cannot introduce executable links through the math renderer', async () => {
  const result = await renderPreview(String.raw`$\href{javascript:alert(1)}{click}$`);
  const document = new JSDOM(result.html).window.document;
  assert.equal([...document.querySelectorAll('[href]')].some(node => /^\s*javascript:/i.test(node.getAttribute('href') ?? '')), false);
});

const capturedPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0hQAAAAASUVORK5CYII=';

test('preview renders only exact captured image mappings and leaves unmapped resources as placeholders', async () => {
  const result = await renderPreview('![saved](images/image-001.png)\n\n![not saved](https://images.example.test/other.png)\n\n<img src="https://images.example.test/captured.png" alt="captured" onerror="bad()" srcset="https://images.example.test/track.png 2x">', {
    imageAssets: { 'images/image-001.png': capturedPng, 'https://images.example.test/captured.png': capturedPng },
  });
  const document = new JSDOM(result.html).window.document;
  const images = [...document.querySelectorAll('img')];
  assert.equal(images.length, 2);
  assert.deepEqual(images.map(image => image.getAttribute('src')), [capturedPng, capturedPng]);
  assert.deepEqual(images.map(image => image.getAttribute('alt')), ['saved', 'captured']);
  assert.ok(images.every(image => !image.hasAttribute('onerror') && !image.hasAttribute('srcset')));
  assert.equal(document.querySelectorAll('img[src^="http"],source,iframe,object').length, 0);
  assert.match(document.body.textContent!, /not saved.*预览不自动加载图片/);
  assert.equal(result.diagnostics.filter(item => item.code === 'preview-images-disabled').length, 1);
});

test('image mapping rejects remote destinations, SVG and malformed data while raw data images still require capture', async () => {
  const sources = ['remote.png', 'vector.svg', 'broken.png', capturedPng];
  const markdown = sources.map((source, index) => `![image ${index}](${source})`).join('\n\n');
  const result = await renderPreview(markdown, {
    imageAssets: {
      'remote.png': 'https://images.example.test/track.png',
      'vector.svg': 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImJhZCgpIj48L3N2Zz4=',
      'broken.png': 'data:image/png;base64,<>bad',
    },
  });
  const document = new JSDOM(result.html).window.document;
  assert.equal(document.querySelectorAll('img,svg,iframe,object').length, 0);
  for (let index = 0; index < sources.length; index += 1) assert.match(document.body.textContent!, new RegExp(`image ${index}`));
});

test('captured images coexist with faithful formula sources, code indentation and GFM table alignment', async () => {
  const code = 'def square(x):\n    return x * x\n';
  const markdown = String.raw`Inline $x_{n+1}=x_n^2$.` + '\n\n$$\n' + String.raw`\sum_{i=1}^{n} i = \frac{n(n+1)}{2}` + '\n$$\n\n```python\n' + code + '```\n\n| Name | Value |\n| :--- | ---: |\n| Alpha | 12 |\n\n![saved](images/image-001.png)\n';
  const result = await renderPreview(markdown, { imageAssets: { 'images/image-001.png': capturedPng } });
  const document = new JSDOM(result.html).window.document;
  assert.deepEqual([...document.querySelectorAll('annotation[encoding="application/x-tex"]')].map(node => node.textContent), [String.raw`x_{n+1}=x_n^2`, String.raw`\sum_{i=1}^{n} i = \frac{n(n+1)}{2}`]);
  assert.equal(document.querySelector('pre code')!.textContent, code);
  assert.deepEqual([...document.querySelectorAll('table tr')].map(row => [...row.children].map(cell => cell.textContent)), [['Name', 'Value'], ['Alpha', '12']]);
  assert.equal(document.querySelector('table th:last-child')!.getAttribute('align'), 'right');
  assert.equal(document.querySelector('img')!.getAttribute('src'), capturedPng);
  assert.equal(document.querySelectorAll('.katex-error').length, 0);
  assert.deepEqual(result.diagnostics, []);
});

test('captured HTML icon images retain their explicit twenty-pixel display size', async () => {
  const result = await renderPreview('<img src="images/a.png" width="20" height="20" alt="图标">', { imageAssets: { 'images/a.png': capturedPng } });
  const document = new JSDOM(result.html).window.document;
  const image = document.querySelector('img')!;
  assert.equal(image.getAttribute('src'), capturedPng);
  assert.equal(image.getAttribute('width'), '20');
  assert.equal(image.getAttribute('height'), '20');
  assert.equal(image.getAttribute('alt'), '图标');
});
