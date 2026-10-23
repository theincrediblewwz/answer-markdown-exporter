import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { prepareIconImages, sanitizedIconSvg } from '../src/icons';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1cAAAAASUVORK5CYII=';
const svg = (body: string, attributes = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${attributes}>${body}</svg>`;

function documentFor(html: string): Document { return new JSDOM(`<main>${html}</main>`).window.document; }

function fakeRaster(document: Document, decode: () => Promise<void> = async () => {}) {
  const view = document.defaultView!;
  const blobs: Blob[] = []; const revoked: string[] = []; const draws: number[][] = [];
  Object.defineProperty(view.URL, 'createObjectURL', { value: (blob: Blob) => { blobs.push(blob); return `blob:local-icon-${blobs.length}`; } });
  Object.defineProperty(view.URL, 'revokeObjectURL', { value: (url: string) => { revoked.push(url); } });
  Object.defineProperty(view, 'Image', { value: class { src = ''; decode = decode; } });
  Object.defineProperty(view.HTMLCanvasElement.prototype, 'getContext', { value: () => ({ drawImage: (_image: unknown, ...coordinates: number[]) => { draws.push(coordinates); } }) });
  Object.defineProperty(view.HTMLCanvasElement.prototype, 'toDataURL', { value: () => png });
  return { blobs, revoked, draws };
}

test('safe icons are rebuilt from geometry, with normalized currentColor and no page styles or metadata', () => {
  const document = documentFor(svg('<title>Diagram</title><g transform="translate(1, 2) rotate(30)"><path d="M1 2L3 4Z" fill-rule="evenodd"/><circle cx="12" cy="12" r="4" stroke="currentColor"/></g>', 'width="1em" height="1em" fill="currentColor" style="color:red; background:url(https://ignored.invalid/image.png)" class="page-style" data-secret="private"'));
  const result = sanitizedIconSvg(document.querySelector('svg')!);
  const clean = new JSDOM(result, { contentType: 'image/svg+xml' }).window.document.documentElement;
  assert.equal(clean.getAttribute('fill'), '#334155');
  assert.equal(clean.getAttribute('width'), '80'); assert.equal(clean.getAttribute('height'), '80');
  assert.equal(clean.getAttribute('viewBox'), '0 0 24 24');
  assert.equal(clean.querySelector('circle')!.getAttribute('stroke'), '#334155');
  assert.equal(clean.querySelector('g')!.getAttribute('transform'), 'translate(1, 2) rotate(30)');
  assert.doesNotMatch(result, /style=|class=|data-secret|private|https:|<title/);
  assert.deepEqual([...clean.querySelectorAll('*')].map(element => element.localName), ['g', 'path', 'circle']);
});

for (const body of [
  '<script>bad()</script>', '<foreignObject><div>bad</div></foreignObject>', '<use href="#shape"/>',
  '<image href="https://images.example.test/pixel.png"/>', '<style>path{fill:red}</style>',
  '<path d="M0 0L1 1" onload="bad()"/>', '<path d="M0 0L1 1" fill="url(#paint)"/>',
  '<path d="M0 0L1 1" href="https://images.example.test/a.svg"/>',
]) {
  test(`icon geometry construction rejects ${body.match(/<([\w]+)/)![1]} with active or external content`, () => {
    const document = documentFor(svg(body));
    assert.throws(() => sanitizedIconSvg(document.querySelector('svg')!));
  });
}

test('overlong and excessively nested geometry are rejected before rasterization', () => {
  const oversized = documentFor(svg(`<path d="M${'1 '.repeat(10_100)}"/>`));
  assert.throws(() => sanitizedIconSvg(oversized.querySelector('svg')!), /长度限制/);
  const excessive = documentFor(svg('<g>'.repeat(501) + '<path d="M0 0"/>' + '</g>'.repeat(501)));
  assert.throws(() => sanitizedIconSvg(excessive.querySelector('svg')!), /非几何/);
});

test('cloned standalone SVG icons become 20px local PNGs without changing the live page', async () => {
  const document = documentFor(svg('<title>Network</title><path d="M0 0L7 7"/>', 'data-d-component="icon" fill="currentColor"'));
  const live = document.querySelector('main')!;
  const clone = live.cloneNode(true) as Element;
  const runtime = fakeRaster(document);
  const result = await prepareIconImages(clone);
  assert.equal(live.querySelectorAll('svg').length, 1); assert.equal(live.querySelectorAll('img').length, 0);
  assert.equal(clone.querySelectorAll('svg').length, 0);
  const image = clone.querySelector('span[data-d-component="icon"] img[data-gpt-md-icon-image]')!;
  assert.equal(image.getAttribute('src'), png); assert.equal(image.getAttribute('alt'), 'Network');
  assert.equal(image.getAttribute('width'), '20'); assert.equal(image.getAttribute('height'), '20');
  assert.deepEqual(runtime.draws, [[0, 0, 80, 80]]);
  assert.equal(runtime.blobs.length, 1); assert.equal(runtime.blobs[0].type, 'image/svg+xml');
  assert.deepEqual(runtime.revoked, ['blob:local-icon-1']);
  assert.equal(result[0].code, 'ICONS_AS_IMAGES');
});

test('decorative link icons are excluded, and equivalent independent icons share one raster result', async () => {
  const shape = svg('<path d="M0 0L8 8"/>');
  const document = documentFor(`<span data-d-component="icon" aria-label="Map">${shape}</span><span data-d-component="icon">${shape}</span><span data-d-component="pressable" role="link"><span data-d-component="icon">${shape}</span></span>`);
  const runtime = fakeRaster(document);
  const result = await prepareIconImages(document.querySelector('main')!);
  assert.equal(document.querySelectorAll('img[data-gpt-md-icon-image]').length, 2);
  assert.equal(document.querySelector('[role="link"] svg') !== null, true);
  assert.equal(runtime.blobs.length, 1);
  assert.match(result[0].message, /2 个图标/);
  assert.equal(document.querySelector('img')!.getAttribute('alt'), 'Map');
});

test('conversion failure keeps the source icon and records a warning', async () => {
  const document = documentFor(`<span data-d-component="icon">${svg('<path d="M0 0L9 9"/>')}</span>`);
  const runtime = fakeRaster(document, async () => { throw new Error('Synthetic decode failure'); });
  const result = await prepareIconImages(document.querySelector('main')!);
  assert.equal(document.querySelectorAll('svg').length, 1); assert.equal(document.querySelectorAll('img').length, 0);
  assert.equal(result[0].code, 'ICON_CONVERSION_INCOMPLETE');
  assert.equal(runtime.revoked.length, 1);
});

test('cancellation during image decoding leaves the clone unchanged and releases the local Blob', async () => {
  const document = documentFor(`<span data-d-component="icon">${svg('<path d="M0 0L10 10"/>')}</span>`);
  const runtime = fakeRaster(document, () => new Promise(() => {}));
  const controller = new AbortController();
  const pending = prepareIconImages(document.querySelector('main')!, { signal: controller.signal });
  controller.abort(); await pending;
  assert.equal(document.querySelectorAll('svg').length, 1); assert.equal(document.querySelectorAll('img').length, 0);
  assert.equal(runtime.revoked.length, 1);
});

test('icon decoding has a bounded two-second timeout', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const document = documentFor(`<span data-d-component="icon">${svg('<path d="M0 0L11 11"/>')}</span>`);
  const runtime = fakeRaster(document, () => new Promise(() => {}));
  const pending = prepareIconImages(document.querySelector('main')!);
  context.mock.timers.tick(2_000);
  const result = await pending;
  assert.equal(document.querySelectorAll('img').length, 0);
  assert.equal(result[0].code, 'ICON_CONVERSION_INCOMPLETE');
  assert.equal(runtime.revoked.length, 1);
});

test('the entire icon conversion pass stops after six seconds', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const document = documentFor(Array.from({ length: 4 }, (_, index) => `<span data-d-component="icon">${svg(`<path d="M0 0L${index + 200} 19"/>`)}</span>`).join(''));
  const runtime = fakeRaster(document, () => new Promise(() => {}));
  const pending = prepareIconImages(document.querySelector('main')!);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    context.mock.timers.tick(2_000);
    for (let step = 0; step < 6; step += 1) await Promise.resolve();
  }
  const result = await pending;
  assert.equal(runtime.blobs.length, 3, 'the fourth icon must not start after the total time budget is exhausted');
  assert.equal(runtime.revoked.length, 3);
  assert.equal(document.querySelectorAll('img').length, 0);
  assert.equal(result[0].code, 'ICON_CONVERSION_INCOMPLETE');
});

test('no more than forty icons are processed in one export', async () => {
  const document = documentFor(Array.from({ length: 41 }, (_, index) => `<span data-d-component="icon">${svg(`<path d="M0 0L${index + 100} 12"/>`)}</span>`).join(''));
  const runtime = fakeRaster(document);
  const result = await prepareIconImages(document.querySelector('main')!);
  assert.equal(document.querySelectorAll('img').length, 40); assert.equal(document.querySelectorAll('svg').length, 1);
  assert.equal(runtime.blobs.length, 40);
  assert.ok(result.some(item => item.code === 'ICON_CONVERSION_INCOMPLETE'));
});
