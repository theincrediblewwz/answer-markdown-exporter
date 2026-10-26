import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { prepareDiagramImages, sanitizedDiagramSvg } from '../src/diagrams';
import { extractMarkdown } from '../src/extract';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1cAAAAASUVORK5CYII=';
const svg = (body: string, attributes = 'viewBox="0 0 640 320"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;
function documentFor(html: string): Document { return new JSDOM(`<main>${html}</main>`).window.document; }
function sanitize(body: string, attributes?: string) {
  const document = documentFor(svg(body, attributes));
  return sanitizedDiagramSvg(document.querySelector('svg')!);
}

function fakeRaster(document: Document, decode: () => Promise<void> = async () => {}) {
  const view = document.defaultView!;
  const blobs: Blob[] = []; const revoked: string[] = []; const draws: number[][] = []; const sizes: number[][] = [];
  const images: { src: string }[] = [];
  Object.defineProperty(view.URL, 'createObjectURL', { value: (blob: Blob) => { blobs.push(blob); return `blob:local-diagram-${blobs.length}`; } });
  Object.defineProperty(view.URL, 'revokeObjectURL', { value: (url: string) => { revoked.push(url); } });
  Object.defineProperty(view, 'Image', { value: class { src = ''; decode = decode; constructor() { images.push(this); } } });
  Object.defineProperty(view.HTMLCanvasElement.prototype, 'getContext', { value: function (this: HTMLCanvasElement) { sizes.push([this.width, this.height]); return { drawImage: (_image: unknown, ...coordinates: number[]) => { draws.push(coordinates); } }; } });
  Object.defineProperty(view.HTMLCanvasElement.prototype, 'toDataURL', { value: () => png });
  return { blobs, revoked, draws, sizes, images };
}

test('diagram SVG is independently rebuilt with text, fixed drawing styles, transforms and a rectangular viewport', () => {
  const result = sanitize('<title>合成路线</title><desc>两站之间的路线</desc><g style="fill:#246;stroke-width:2;font-size:18px;position:fixed" transform="translate(2,3) rotate(15)"><path d="M0 0L40 20"/><text x="10" y="20">起点<tspan dx="5" font-weight="bold">终点</tspan></text></g>', 'viewBox="-10 -20 640 320" class="page-theme" data-private="do not copy"');
  const clean = new JSDOM(result.svg, { contentType: 'image/svg+xml' }).window.document.documentElement;
  assert.deepEqual([result.width, result.height, result.pixelWidth, result.pixelHeight], [640, 320, 1280, 640]);
  assert.equal(result.alt, '合成路线；两站之间的路线');
  assert.equal(clean.getAttribute('viewBox'), '-10 -20 640 320');
  assert.equal(clean.querySelector('g')!.getAttribute('fill'), '#246');
  assert.equal(clean.querySelector('g')!.getAttribute('font-size'), '18px');
  assert.equal(clean.querySelector('g')!.getAttribute('transform'), 'translate(2,3) rotate(15)');
  assert.equal(clean.querySelector('text')!.textContent, '起点终点');
  assert.doesNotMatch(result.svg, /class=|style=|data-private|do not copy|position/);
});

test('resource IDs are remapped and validated for marker, pattern, gradients and clipping', () => {
  const result = sanitize('<defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8"/></marker><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#abc"/></pattern><linearGradient id="paint"><stop offset="0%" stop-color="#fff"/><stop offset="100%" stop-color="#000"/></linearGradient><radialGradient id="spot"><stop offset="1" stop-color="#abc"/></radialGradient><clipPath id="clip"><rect width="300" height="100"/></clipPath></defs><rect width="200" height="100" fill="url(#hatch)" clip-path="url(#clip)"/><path d="M1 2L30 40" stroke="url(#paint)" marker-end="url(#arrow)"/><circle r="5" fill="url(#spot)"/>');
  assert.doesNotMatch(result.svg, /id="(?:arrow|hatch|paint|spot|clip)"|url\(#(?:arrow|hatch|paint|spot|clip)\)/);
  assert.match(result.svg, /marker-end="url\(#gpt-md-diagram-1\)"/);
  assert.match(result.svg, /patternTransform="rotate\(45\)"/);
  assert.match(result.svg, /clip-path="url\(#gpt-md-diagram-5\)"/);
  assert.match(result.svg, /stop-color="#fff"/);
});

test('inline drawing styles override attributes and obsolete resource references without depending on attribute order', () => {
  const result = sanitize('<rect style="fill:red;stroke:#abc !important" fill="url(#not-used)" stroke="blue" width="40" height="20"/>');
  const clean = new JSDOM(result.svg, { contentType: 'image/svg+xml' }).window.document.querySelector('rect')!;
  assert.equal(clean.getAttribute('fill'), 'red'); assert.equal(clean.getAttribute('stroke'), '#abc');
  assert.doesNotMatch(result.svg, /not-used/);
});

test('line breaks and ordinary SVG whitespace are accepted in geometry and drawing styles', () => {
  const result = sanitize('<path d="M0 0\nL40 20" style="\nfill:none;\nstroke:#123;\n"/>');
  assert.match(result.svg, /stroke="#123"/);
});

for (const body of [
  '<script>bad()</script>', '<foreignObject><div>bad</div></foreignObject>', '<use href="#shape"/>',
  '<image href="https://example.invalid/a.png"/>', '<style>text{fill:red}</style>',
  '<animate attributeName="x" values="0;5"/>', '<set attributeName="fill" to="red"/>',
  '<path d="M0 0L1 1" onload="bad()"/>', '<path d="M0 0L1 1" href="#anything"/>',
  '<path d="M0 0L1 1" fill="url(https://example.invalid/paint)"/>',
  '<path d="M0 0L1 1" style="background-image:url(https://example.invalid/a.png)"/>',
  '<path d="M0 0L1 1" style="fill:var(--unsafe)"/>',
  '<path d="M0 0L1 1" style="fill:u\\72l(#paint)"/>',
  '<path d="M0 0L1 1" filter="url(#effect)"/>',
  '<svg viewBox="0 0 10 10"><text>nested viewport</text></svg>',
]) {
  test(`unsafe or unsupported diagram semantics are rejected: ${body.slice(0, 72)}`, () => {
    assert.throws(() => sanitize(body));
  });
}

test('dangling, duplicate, wrong-kind and cyclic resource references fail closed', () => {
  for (const body of [
    '<path d="M0 0L1 1" fill="url(#missing)"/>',
    '<defs><pattern id="repeat"/><pattern id="repeat"/></defs>',
    '<defs><clipPath id="clip"><circle r="5"/></clipPath></defs><rect fill="url(#clip)"/>',
    '<defs><pattern id="a" width="10" height="10"><rect fill="url(#a)"/></pattern></defs><rect fill="url(#a)"/>',
    '<defs><pattern id="a"><rect fill="url(#b)"/></pattern><pattern id="b"><rect fill="url(#a)"/></pattern></defs>',
  ]) assert.throws(() => sanitize(body));
});

test('explicit dimensions, viewBox-only and a single dimension retain their respective proportions', () => {
  assert.deepEqual(((value) => [value.width, value.height])(sanitize('<rect width="400" height="100"/>', 'width="400px" height="100px"')), [400, 100]);
  assert.deepEqual(((value) => [value.width, value.height])(sanitize('<rect width="400" height="100"/>', 'width="500" viewBox="0 0 400 100"')), [500, 125]);
  const portrait = sanitize('<rect width="200" height="800"/>', 'viewBox="0 0 200 800"');
  assert.deepEqual([portrait.width, portrait.height, portrait.pixelWidth, portrait.pixelHeight], [200, 800, 400, 1600]);
  const large = sanitize('<rect width="9000" height="6000"/>', 'viewBox="0 0 9000 6000"');
  assert.ok(large.pixelWidth * large.pixelHeight <= 4_000_000);
  assert.ok(Math.abs(large.width / large.height - 1.5) < .001);
  for (const dimensions of ['', 'viewBox="0 0 0 10"', 'width="-1" height="10"', 'viewBox="0 0 1 1000000"']) assert.throws(() => sanitize('<path d="M0 0"/>', dimensions));
});

test('accessible labels prefer aria-label, then title/description, then meaningful diagram text', () => {
  assert.equal(sanitize('<title>Title</title><text x="0" y="10">Rendered label</text>', 'viewBox="0 0 120 60" aria-label="Accessible caption"').alt, 'Accessible caption');
  assert.equal(sanitize('<text x="0" y="10">Alpha</text><text x="0" y="20">Beta</text>').alt, 'Alpha；Beta');
  assert.equal(sanitize('<circle r="5"/>').alt, 'SVG 图表');
});

test('character, node, depth and numeric limits are enforced before drawing', () => {
  assert.throws(() => sanitize(`<text>${'a'.repeat(250_001)}</text>`));
  assert.throws(() => sanitize('<circle r="1"/>'.repeat(3_001)));
  assert.throws(() => sanitize('<g>'.repeat(33) + '<path d="M0 0"/>' + '</g>'.repeat(33)));
  assert.throws(() => sanitize('<path d="M1e999 0L10 20"/>'));
  assert.throws(() => sanitize('<path d="M0 0" transform="translate(1,2,3)"/>'));
});

test('only the clone changes, PNG keeps a diagram marker, dimensions and accessible alt', async () => {
  const document = documentFor(svg('<title>Clone diagram 1</title><text x="0" y="20">Two to one</text>'));
  const live = document.querySelector('main')!; const clone = live.cloneNode(true) as Element;
  const runtime = fakeRaster(document);
  const result = await prepareDiagramImages(clone);
  assert.equal(live.querySelectorAll('svg').length, 1); assert.equal(live.querySelectorAll('img').length, 0);
  const image = clone.querySelector('img[data-gpt-md-diagram-image]')!;
  assert.equal(image.getAttribute('src'), png); assert.equal(image.getAttribute('alt'), 'Clone diagram 1');
  assert.deepEqual([image.getAttribute('width'), image.getAttribute('height')], ['640', '320']);
  assert.deepEqual(runtime.draws, [[0, 0, 1280, 640]]); assert.equal(runtime.blobs[0].type, 'image/svg+xml');
  assert.deepEqual(runtime.revoked, ['blob:local-diagram-1']); assert.equal(runtime.images[0].src, '');
  assert.equal(result[0].code, 'DIAGRAMS_AS_IMAGES');
});

test('data SVG images decode from UTF-8 URI or base64 without any fetch', async () => {
  const source = svg('<title>Local SVG 2</title><text x="1" y="20">中文标签</text>', 'viewBox="0 0 360 120"');
  const document = documentFor(`<img alt="外层图题" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}"><img src="data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}">`);
  const runtime = fakeRaster(document);
  Object.defineProperty(document.defaultView, 'fetch', { value: () => { throw new Error('must never fetch'); } });
  const result = await prepareDiagramImages(document.querySelector('main')!);
  const images = document.querySelectorAll('img[data-gpt-md-diagram-image]');
  assert.equal(images.length, 2); assert.equal(images[0].getAttribute('alt'), '外层图题'); assert.equal(images[1].getAttribute('alt'), 'Local SVG 2');
  assert.equal(runtime.blobs.length, 1, 'identical normalized SVGs share one local PNG');
  assert.equal(result[0].code, 'DIAGRAMS_AS_IMAGES');
});

test('SVG data URLs reject active input and XML entity declarations and preserve a textual fallback', async () => {
  const malicious = '<!DOCTYPE svg [<!ENTITY local SYSTEM "file:///private">]>' + svg('<text>&local;</text>');
  const document = documentFor(`<img alt="Unsafe local source" src="data:image/svg+xml,${encodeURIComponent(malicious)}">${svg('<title>Safe title survives</title><script>never copy me</script><text>Readable label survives</text>')}`);
  const runtime = fakeRaster(document);
  const result = await prepareDiagramImages(document.querySelector('main')!);
  assert.equal(runtime.blobs.length, 0);
  assert.equal(document.querySelectorAll('[data-gpt-md-diagram-fallback]').length, 2);
  assert.match(document.querySelector('main')!.textContent!, /Unsafe local source/);
  assert.match(document.querySelector('main')!.textContent!, /Safe title survives；Readable label survives/);
  assert.doesNotMatch(document.querySelector('main')!.textContent!, /never copy me/);
  assert.equal(result[0].code, 'DIAGRAM_CONVERSION_INCOMPLETE');
});

test('component icons, MathML and KaTeX SVG stay outside the diagram pass', async () => {
  const document = documentFor(`<span data-d-component="icon">${svg('<path d="M0 0"/>')}</span><span class="katex">${svg('<path d="M0 0"/>')}</span><math><svg><path d="M0 0"/></svg></math>`);
  const runtime = fakeRaster(document);
  assert.deepEqual(await prepareDiagramImages(document.querySelector('main')!), []);
  assert.equal(runtime.blobs.length, 0); assert.equal(document.querySelectorAll('svg').length, 3);
});

test('hidden graphics stay unchanged and cannot become visible images or Markdown content', async () => {
  const document = documentFor(svg('<title>HIDDEN_ROOT_TITLE</title><text>HIDDEN_ROOT_TEXT</text>', 'hidden aria-hidden="true" viewBox="0 0 120 60"')
    + `<div hidden>${svg('<title>HIDDEN_PARENT_TITLE</title>')}</div><div aria-hidden="true">${svg('<title>ARIA_PARENT_TITLE</title>')}</div><p>Visible answer</p>`);
  const source = document.querySelector('main')!; const before = source.innerHTML; const clone = source.cloneNode(true) as Element;
  const cloneBefore = clone.innerHTML; const runtime = fakeRaster(document);
  assert.deepEqual(await prepareDiagramImages(clone), []);
  assert.equal(runtime.blobs.length, 0); assert.equal(clone.innerHTML, cloneBefore); assert.equal(source.innerHTML, before);
  assert.equal(clone.querySelectorAll('img').length, 0);
  assert.doesNotMatch(extractMarkdown(clone).markdown, /HIDDEN_|ARIA_PARENT/);
  assert.match(extractMarkdown(clone).markdown, /Visible answer/);
});

test('controls, extension UI, excluded answer regions and code never contribute diagram candidates', async () => {
  const scopes = [
    '<button>', '<textarea>', '<select>', '<div data-gpt-md-ui>', '<div data-gpt-md-ignore>',
    '<div data-message-content-controls>', '<div data-markdown-copy="exclude">', '<div role="toolbar">', '<pre>', '<code>',
  ];
  const body = '<input type="image" src="data:image/svg+xml,%3Csvg%2F%3E">' + scopes.map((open, index) => `${open}${svg(`<title>Ignored scope ${index}</title>`)}</${open.match(/^<([\w]+)/)![1]}>`).join('');
  const document = documentFor(body); const source = document.querySelector('main')!; const clone = source.cloneNode(true) as Element;
  const before = clone.innerHTML; const runtime = fakeRaster(document);
  await prepareDiagramImages(clone);
  assert.equal(clone.querySelector('button')!.innerHTML, source.querySelector('button')!.innerHTML);
  for (const selector of ['textarea', 'select', '[data-gpt-md-ui]', '[data-gpt-md-ignore]', '[data-message-content-controls]', '[data-markdown-copy="exclude"]', '[role="toolbar"]', 'pre', 'code']) assert.equal(clone.querySelector(selector)!.innerHTML, source.querySelector(selector)!.innerHTML);
  assert.equal(runtime.blobs.length, 0); assert.equal(clone.querySelectorAll('img[data-gpt-md-diagram-image]').length, 0);
  assert.equal(source.innerHTML, before); assert.equal(clone.innerHTML, before);
});

test('recorded or inline hidden layout and a connected stylesheet prevent graphic conversion', async () => {
  const document = documentFor(`<style>.css-hidden{display:none}</style>${svg('<title>Connected CSS hidden</title>', 'viewBox="0 0 120 60" class="css-hidden"')}`);
  const runtime = fakeRaster(document);
  assert.deepEqual(await prepareDiagramImages(document.querySelector('main')!), []); assert.equal(runtime.blobs.length, 0);
  const other = documentFor(`<div data-gpt-md-display="none">${svg('<title>Recorded hidden</title>')}</div><div data-gpt-md-visibility="hidden">${svg('<title>Recorded invisible</title>')}</div>${svg('<title>Inline hidden</title>', 'viewBox="0 0 120 60" style="display:none"')}`);
  const clone = other.querySelector('main')!.cloneNode(true) as Element; const before = clone.innerHTML; const otherRuntime = fakeRaster(other);
  assert.deepEqual(await prepareDiagramImages(clone), []); assert.equal(otherRuntime.blobs.length, 0); assert.equal(clone.innerHTML, before);
});

test('original-image zoom buttons allow their actual IMG while excluding all SVG and canvas chrome', async () => {
  const local = encodeURIComponent(svg('<title>Actual original image</title><text>Visible content</text>', 'viewBox="0 0 220 110"'));
  const document = documentFor(`<button data-message-image="original" aria-haspopup="dialog" aria-label="Button control label">${svg('<title>Hidden zoom chrome</title>', 'hidden viewBox="0 0 120 60"')}${svg('<title>Visible zoom chrome</title>')}<canvas aria-label="Control canvas"></canvas><img alt="Actual image alt" src="data:image/svg+xml,${local}"></button>`);
  const source = document.querySelector('main')!; const clone = source.cloneNode(true) as Element; const runtime = fakeRaster(document);
  await prepareDiagramImages(clone);
  assert.equal(runtime.blobs.length, 1); assert.equal(clone.querySelectorAll('svg').length, 2); assert.equal(clone.querySelectorAll('canvas').length, 1);
  assert.equal(clone.querySelector('img')!.getAttribute('alt'), 'Actual image alt');
  assert.doesNotMatch(extractMarkdown(clone).markdown, /zoom chrome|Control canvas|Button control label/);
  assert.equal(source.querySelectorAll('[data-gpt-md-diagram-image]').length, 0);
});

test('a failed actual image in a zoom button preserves its own original alt as extracted text', async () => {
  const local = encodeURIComponent(svg('<title>Rejected image title</title><foreignObject/>'));
  const document = documentFor(`<button data-message-image="original" aria-haspopup="dialog" aria-label="Do not substitute chrome"><img alt="Original alt survives" src="data:image/svg+xml,${local}"></button>`);
  const runtime = fakeRaster(document); const root = document.querySelector('main')!;
  await prepareDiagramImages(root);
  assert.equal(runtime.blobs.length, 0); assert.match(extractMarkdown(root).markdown, /Original alt survives/);
  assert.doesNotMatch(extractMarkdown(root).markdown, /Do not substitute chrome/);
});

test('hidden children of visible SVG never reappear after rebuilding or textual fallback', async () => {
  const body = '<title>Public diagram title</title><g hidden><text>SECRET_GEOMETRY_LABEL</text></g><text aria-hidden="true">SECRET_ARIA_LABEL</text><text style="display:none">SECRET_STYLE_LABEL</text><text x="0" y="20">Public visible label</text>';
  const clean = sanitize(body); assert.doesNotMatch(clean.svg, /SECRET_/); assert.doesNotMatch(clean.alt, /SECRET_/);
  const document = documentFor(svg(body + '<foreignObject/>')); fakeRaster(document);
  await prepareDiagramImages(document.querySelector('main')!);
  assert.doesNotMatch(document.querySelector('main')!.textContent!, /SECRET_/);
  assert.match(document.querySelector('main')!.textContent!, /Public visible label/);
});

test('remote SVG and canvas are explicitly diagnosed without network or pixel reads', async () => {
  const document = documentFor('<img src="https://example.invalid/chart.svg" alt="Remote diagram"><canvas aria-label="Canvas diagram">Fallback data</canvas><img src="https://example.invalid/photo.png">');
  const runtime = fakeRaster(document);
  const result = await prepareDiagramImages(document.querySelector('main')!);
  assert.equal(runtime.blobs.length, 0); assert.equal(runtime.draws.length, 0);
  assert.equal(document.querySelector('img')!.getAttribute('src'), 'https://example.invalid/chart.svg');
  assert.match(document.querySelector('main')!.textContent!, /Canvas diagram/);
  assert.match(result[0].message, /远程 SVG 或 Canvas/);
});

test('abort during decode leaves the source unchanged and revokes the Blob', async () => {
  const document = documentFor(svg('<title>Abort diagram 3</title><path d="M0 0L1 1"/>'));
  const runtime = fakeRaster(document, () => new Promise(() => {})); const controller = new AbortController();
  const pending = prepareDiagramImages(document.querySelector('main')!, { signal: controller.signal });
  controller.abort(); const result = await pending;
  assert.equal(document.querySelectorAll('svg').length, 1); assert.equal(document.querySelectorAll('img').length, 0);
  assert.equal(runtime.revoked.length, 1); assert.equal(runtime.images[0].src, '');
  assert.equal(result[0].code, 'DIAGRAM_CONVERSION_ABORTED');
});

test('pre-cancelled and stale captures do not start rasterization or mutate the clone', async () => {
  for (const options of [{ signal: AbortSignal.abort() }, { current: () => false }]) {
    const document = documentFor(svg('<title>Stale diagram 4</title><rect width="10" height="10"/>'));
    const runtime = fakeRaster(document);
    const result = await prepareDiagramImages(document.querySelector('main')!, options);
    assert.equal(runtime.blobs.length, 0); assert.equal(document.querySelectorAll('svg').length, 1);
    assert.equal(result[0].code, 'DIAGRAM_CONVERSION_ABORTED');
  }
});

test('a capture becoming stale during decode releases resources without replacement', async () => {
  const document = documentFor(svg('<title>Becomes stale diagram 5</title><rect width="10" height="10"/>'));
  let current = true;
  const runtime = fakeRaster(document, async () => { current = false; });
  const result = await prepareDiagramImages(document.querySelector('main')!, { current: () => current });
  assert.equal(document.querySelectorAll('svg').length, 1); assert.equal(runtime.revoked.length, 1);
  assert.equal(result[0].code, 'DIAGRAM_CONVERSION_ABORTED');
});

test('failed decoding and PNG encoding still release the temporary Blob and preserve text', async () => {
  for (const mode of ['decode', 'encode']) {
    const document = documentFor(svg(`<title>Failure diagram 6 ${mode}</title><text x="1" y="10">Visible information</text>`));
    const runtime = fakeRaster(document, async () => { if (mode === 'decode') throw new Error('Synthetic failure'); });
    if (mode === 'encode') Object.defineProperty(document.defaultView!.HTMLCanvasElement.prototype, 'toDataURL', { value: () => { throw new Error('Synthetic taint'); } });
    const result = await prepareDiagramImages(document.querySelector('main')!);
    assert.equal(runtime.revoked.length, 1); assert.equal(document.querySelectorAll('img').length, 0);
    assert.match(document.querySelector('main')!.textContent!, /Visible information/);
    assert.equal(result[0].code, 'DIAGRAM_CONVERSION_INCOMPLETE');
  }
});

test('per-diagram decode timeout is bounded to two seconds', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const document = documentFor(svg('<title>Timeout diagram 7</title><rect width="10" height="10"/>'));
  const runtime = fakeRaster(document, () => new Promise(() => {}));
  const pending = prepareDiagramImages(document.querySelector('main')!);
  context.mock.timers.tick(2_000);
  const result = await pending;
  assert.equal(runtime.revoked.length, 1); assert.match(result[0].message, /时间上限/);
});

test('the total conversion deadline prevents a fifth two-second decode attempt', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const document = documentFor(Array.from({ length: 6 }, (_, index) => svg(`<title>Total timeout ${index}</title><path d="M0 0L${index + 20} 10"/>`)).join(''));
  const runtime = fakeRaster(document, () => new Promise(() => {}));
  const pending = prepareDiagramImages(document.querySelector('main')!);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    context.mock.timers.tick(2_000);
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  }
  const result = await pending;
  assert.equal(runtime.blobs.length, 4); assert.equal(runtime.revoked.length, 4);
  assert.match(result[0].message, /时间上限/);
  assert.equal(document.querySelectorAll('svg').length, 0);
  assert.match(extractMarkdown(document.querySelector('main')!).markdown, /Total timeout 4/);
  assert.match(extractMarkdown(document.querySelector('main')!).markdown, /Total timeout 5/);
});

test('count and total pixel budgets bound conversion and report remaining sources', async () => {
  const small = documentFor(Array.from({ length: 21 }, (_, index) => svg(`<title>Count diagram ${index}</title><circle r="2"/>`, 'viewBox="0 0 100 50"')).join(''));
  const smallRuntime = fakeRaster(small);
  const countResult = await prepareDiagramImages(small.querySelector('main')!);
  assert.equal(small.querySelectorAll('img').length, 20); assert.equal(smallRuntime.blobs.length, 20);
  assert.ok(countResult.some(item => item.code === 'DIAGRAM_CONVERSION_INCOMPLETE'));
  assert.equal(small.querySelectorAll('svg').length, 0);
  assert.match(extractMarkdown(small.querySelector('main')!).markdown, /Count diagram 20/);
  const large = documentFor(Array.from({ length: 7 }, (_, index) => svg(`<title>Pixel budget diagram ${index}</title><rect width="1200" height="1200"/>`, 'viewBox="0 0 1200 1200"')).join(''));
  const largeRuntime = fakeRaster(large);
  const pixelResult = await prepareDiagramImages(large.querySelector('main')!);
  assert.equal(largeRuntime.blobs.length, 4);
  assert.ok(largeRuntime.sizes.reduce((sum, [width, height]) => sum + width * height, 0) <= 16_000_000);
  assert.ok(pixelResult.some(item => /像素预算/.test(item.message)));
});

test('graphics beyond the conversion count retain SVG titles, data-image alt and canvas labels as text', async () => {
  const preceding = Array.from({ length: 20 }, (_, index) => svg(`<title>Remainder prefix ${index}</title><circle r="1"/>`, 'viewBox="0 0 80 40"')).join('');
  const local = encodeURIComponent(svg('<title>Small data SVG title survives</title><text>Small data SVG text survives</text>'));
  const document = documentFor(preceding + svg('<title>Twenty first title survives</title><text>Twenty first text survives</text>')
    + `<img alt="Unprocessed original alt survives" src="data:image/svg+xml,${local}"><img src="data:image/svg+xml,${local}"><canvas aria-label="Unprocessed canvas label survives"></canvas>`);
  const source = document.querySelector('main')!; const before = source.innerHTML; const clone = source.cloneNode(true) as Element; const runtime = fakeRaster(document);
  const diagnostics = await prepareDiagramImages(clone);
  assert.equal(runtime.blobs.length, 20); assert.equal(clone.querySelectorAll('svg,canvas').length, 0);
  const markdown = extractMarkdown(clone).markdown;
  for (const label of ['Twenty first title survives', 'Twenty first text survives', 'Unprocessed original alt survives', 'Small data SVG title survives', 'Small data SVG text survives', 'Unprocessed canvas label survives']) assert.ok(markdown.includes(label), label);
  assert.equal(source.innerHTML, before); assert.ok(diagnostics.some(item => item.code === 'DIAGRAM_CONVERSION_INCOMPLETE'));
});

test('the remainder label scan never traverses an oversized SVG or parses a large data SVG', async () => {
  const preceding = Array.from({ length: 20 }, (_, index) => svg(`<title>Bounded remainder prefix ${index}</title><circle r="1"/>`, 'viewBox="0 0 80 40"')).join('');
  const document = documentFor(preceding + svg('<title>Bounded remainder title survives</title>' + '<g><text>Bounded detail</text></g>'.repeat(300))
    + `<img alt="Large original alt survives" src="data:image/svg+xml,${'x'.repeat(20_000)}">`);
  const root = document.querySelector('main')!; const lastSvg = root.querySelectorAll('svg')[20];
  Object.defineProperty(lastSvg.querySelectorAll('g')[100], 'childNodes', { get: () => { throw new Error('unbounded remainder traversal'); } });
  Object.defineProperty(document.defaultView!, 'DOMParser', { value: class { constructor() { throw new Error('must not parse large data SVG remainder'); } } });
  const runtime = fakeRaster(document); await prepareDiagramImages(root);
  assert.equal(runtime.blobs.length, 20);
  const markdown = extractMarkdown(root).markdown;
  assert.match(markdown, /Bounded remainder title survives/); assert.match(markdown, /Large original alt survives/);
});

test('cancellation does not start text fallback for unprocessed visible graphics', async () => {
  const document = documentFor(Array.from({ length: 23 }, (_, index) => svg(`<title>Cancelled remainder ${index}</title><circle r="1"/>`)).join(''));
  const root = document.querySelector('main')!; const before = root.innerHTML; const runtime = fakeRaster(document, () => new Promise(() => {}));
  const controller = new AbortController(); const pending = prepareDiagramImages(root, { signal: controller.signal });
  controller.abort(); const diagnostics = await pending;
  assert.equal(root.innerHTML, before); assert.equal(root.querySelectorAll('[data-gpt-md-diagram-fallback]').length, 0);
  assert.equal(runtime.blobs.length, 1); assert.equal(runtime.revoked.length, 1);
  assert.ok(diagnostics.some(item => item.code === 'DIAGRAM_CONVERSION_ABORTED'));
});

test('the aggregate SVG character budget stops otherwise individually valid diagrams', async () => {
  const document = documentFor(Array.from({ length: 6 }, (_, index) => svg(`<title>Character budget ${index}</title><text x="1" y="20">${'x'.repeat(200_000)}</text>`, 'viewBox="0 0 100 50"')).join(''));
  const runtime = fakeRaster(document);
  const result = await prepareDiagramImages(document.querySelector('main')!);
  assert.equal(runtime.blobs.length, 4); assert.equal(document.querySelectorAll('img').length, 4);
  assert.equal(document.querySelectorAll('[data-gpt-md-diagram-fallback]').length, 2);
  assert.ok(result.some(item => item.code === 'DIAGRAM_CONVERSION_INCOMPLETE' && /长度/.test(item.message)));
});

test('the PNG cache evicts older entries instead of growing with every export', async () => {
  const source = svg('<title>Cache eviction diagram 99</title><circle r="3"/>', 'viewBox="0 0 100 50"');
  const first = documentFor(source); const firstRuntime = fakeRaster(first);
  await prepareDiagramImages(first.querySelector('main')!); assert.equal(firstRuntime.blobs.length, 1);
  const overflow = documentFor(Array.from({ length: 17 }, (_, index) => svg(`<title>Cache overflow ${index}</title><path d="M0 0L${index + 100} 50"/>`, 'viewBox="0 0 100 50"')).join(''));
  fakeRaster(overflow); await prepareDiagramImages(overflow.querySelector('main')!);
  const again = documentFor(source); const againRuntime = fakeRaster(again);
  await prepareDiagramImages(again.querySelector('main')!); assert.equal(againRuntime.blobs.length, 1);
});
