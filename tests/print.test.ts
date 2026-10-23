import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createPrintBroker, PRINT_LIMITS, PRINT_SESSION_LIFETIME_MS, safeRasterDataUri, type PrintPayload } from '../src/background';
import { prepareAssets } from '../src/assets';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgV8AAAAASUVORK5CYII=';
const extensionId = 'print-unit-test';
const token = '00000000-0000-4000-8000-000000000001';
const pageURL = `chrome-extension://${extensionId}/print.html#${token}`;
const contentSender: chrome.runtime.MessageSender = { id: extensionId, frameId: 0, url: 'https://chatgpt.com/c/unit-test', tab: { id: 9 } as chrome.tabs.Tab };
const printSender = (value = token): chrome.runtime.MessageSender => ({ id: extensionId, frameId: 0, url: `chrome-extension://${extensionId}/print.html#${value}` });
const request = (extra = {}) => ({ type: 'gpt-md:print-request', markdown: '# Print test\n\n  unchanged text\n', ...extra });

function broker() {
  const state = { now: 1000, serial: 0, urls: [] as string[], failOpen: false, timers: new Set<() => void>() };
  const instance = createPrintBroker({
    extensionId, getURL: path => `chrome-extension://${extensionId}/${path}`,
    now: () => state.now,
    randomUUID: () => `00000000-0000-4000-8000-${String(++state.serial).padStart(12, '0')}`,
    openTab: async url => { if (state.failOpen) throw new Error('browser failed');state.urls.push(url); },
    schedule: callback => { state.timers.add(callback);return callback; },
    cancel: timer => { state.timers.delete(timer as () => void); },
  });
  const send = (message: unknown, sender = contentSender): Promise<any> => new Promise(resolve => { instance.onMessage(message, sender, resolve); });
  return { ...instance, state, send };
}

test('print broker only accepts its own GPT top-frame content sender', async () => {
  const instance = broker();
  try {
    for (const sender of [
      { ...contentSender, id: 'another-extension' },
      { ...contentSender, frameId: 1 },
      { ...contentSender, tab: undefined },
      { ...contentSender, url: 'https://chatgpt.com.evil.example/' },
      { ...contentSender, url: 'http://chatgpt.com/' },
      { ...contentSender, url: pageURL },
    ]) assert.equal((await instance.send(request(), sender)).ok, false);
    assert.deepEqual(instance.state.urls, []);
    assert.equal((await instance.send(request())).ok, true);
    assert.equal(instance.state.urls[0], pageURL);
    assert.equal(instance.state.timers.size, 1);
  } finally { instance.dispose(); }
});

test('print payload remains exact and reloadable from only the matching local print page', async () => {
  const instance = broker();
  const markdown = '# 标题\n\n```python\n\tif value:\n    print(value)\n\n```\n';
  const diagnostics = [{ code: 'sample', severity: 'info', message: 'Test note' }];
  try {
    assert.equal((await instance.send(request({ markdown, imageAssets: { 'https://example.test/a.png': image, 'images/a.png': image }, diagnostics }))).ok, true);
    const message = { type: 'gpt-md:print-payload', token };
    for (const sender of [contentSender, { ...printSender(), id: 'another-extension' }, { ...printSender(), url: `chrome-extension://other/print.html#${token}` }, { ...printSender(), url: `chrome-extension://${extensionId}/popup.html#${token}` }, { ...printSender(), frameId: 1 }, printSender('00000000-0000-4000-8000-000000000099')]) assert.equal((await instance.send(message, sender)).ok, false);
    for (let read = 0; read < 2; read++) {
      const reply = await instance.send(message, printSender());
      assert.equal(reply.ok, true);
      assert.equal(reply.payload.markdown, markdown);
      assert.equal(reply.payload.imageAssets['images/a.png'], image);
      assert.equal(reply.payload.imageAssets['https://example.test/a.png'], image);
      assert.deepEqual(reply.payload.diagnostics, diagnostics);
    }
  } finally { instance.dispose(); }
});

test('print payload expires at two minutes and invalid or missing tokens expose no payload', async () => {
  const instance = broker();
  try {
    await instance.send(request());
    for (const value of ['', '../secret', '<script>', '00000000-0000-4000-8000-000000000099']) assert.equal((await instance.send({ type: 'gpt-md:print-payload', token: value }, printSender(value))).ok, false);
    instance.state.now += PRINT_SESSION_LIFETIME_MS - 1;
    assert.equal((await instance.send({ type: 'gpt-md:print-payload', token }, printSender())).ok, true);
    instance.state.now += 1;
    assert.equal((await instance.send({ type: 'gpt-md:print-payload', token }, printSender())).ok, false);
    assert.equal(instance.state.timers.size, 0);
  } finally { instance.dispose(); }
});

test('print broker limits content, safe image formats, diagnostics and concurrent sessions', async () => {
  const instance = broker();
  try {
    const invalidAssets = ['https://example.test/remote.png', 'data:image/svg+xml;base64,' + btoa('<svg/>'), 'data:image/png;base64,' + btoa('<svg/>'), 'data:image/png;base64,not-valid-encoding'];
    for (const value of invalidAssets) assert.equal((await instance.send(request({ imageAssets: { sample: value } }))).ok, false);
    assert.equal((await instance.send(request({ markdown: 'x'.repeat(PRINT_LIMITS.markdownCharacters + 1) }))).ok, false);
    assert.equal((await instance.send(request({ imageAssets: Object.fromEntries(Array.from({ length: PRINT_LIMITS.imageKeys + 1 }, (_, index) => [`images/${index}.png`, image])) }))).ok, false);
    assert.equal((await instance.send(request({ diagnostics: [{ code: 'bad', severity: 'error', message: 'invalid severity' }] }))).ok, false);
    assert.equal((await instance.send(request({ diagnostics: Array(PRINT_LIMITS.diagnostics + 1).fill({ code: 'x', severity: 'info', message: 'x' }) }))).ok, false);
    assert.deepEqual(instance.state.urls, []);
    for (let count = 0; count < PRINT_LIMITS.sessions; count++) assert.equal((await instance.send(request())).ok, true);
    assert.equal((await instance.send(request())).ok, false);
    instance.state.now += PRINT_SESSION_LIFETIME_MS;
    assert.equal((await instance.send(request())).ok, true);
  } finally { instance.dispose(); }
});

test('image aliases count as one raster asset and unsafe or oversized data URIs are rejected', async () => {
  assert.equal(safeRasterDataUri(image), true);
  assert.equal(safeRasterDataUri('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='), true);
  assert.equal(safeRasterDataUri('data:image/jpeg;base64,' + btoa('\xff\xd8\xff\x00')), true);
  assert.equal(safeRasterDataUri('data:image/webp;base64,' + btoa('RIFF0000WEBP')), true);
  assert.equal(safeRasterDataUri('data:image/svg+xml;base64,' + btoa('<svg/>')), false);
  assert.equal(safeRasterDataUri('data:image/png;base64,' + 'A'.repeat(PRINT_LIMITS.imageUriCharacters)), false);
  const instance = broker();
  try {
    const aliases = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`images/alias-${index}.png`, image]));
    assert.equal((await instance.send(request({ imageAssets: aliases }))).ok, true, '60 source/relative aliases for the same raster fit the 30-image limit');
    const unique = Object.fromEntries(Array.from({ length: PRINT_LIMITS.imageCount + 1 }, (_, index) => [`images/unique-${index}.png`, 'data:image/png;base64,' + btoa(atob(image.split(',')[1]) + String.fromCharCode(index))]));
    assert.equal((await instance.send(request({ imageAssets: unique }))).ok, false, '31 unique rasters exceed the image limit even though the key count is allowed');
  } finally { instance.dispose(); }
});

test('unique image totals and aggregate in-memory print cache are bounded', async () => {
  const instance = broker();
  const base64Prefix = image.split(',')[1].slice(0, 64);
  const sizedImage = (characters: number, differentiator: string): string => 'data:image/png;base64,' + base64Prefix + differentiator + 'A'.repeat(characters - 68);
  try {
    const overTotal = Object.fromEntries(['AAAA', 'AQAA', 'AgAA'].map((part, index) => [`images/${index}.png`, sizedImage(11_000_000, part)]));
    assert.equal((await instance.send(request({ imageAssets: overTotal }))).ok, false, 'three individually allowed images must still obey the combined size limit');
    const nearTotal = Object.fromEntries(['AAAA', 'AQAA', 'AgAA'].map((part, index) => [`images/${index}.png`, sizedImage(10_666_500, part)]));
    const largeRequest = request({ markdown: 'x'.repeat(PRINT_LIMITS.markdownCharacters), imageAssets: nearTotal });
    assert.equal((await instance.send(largeRequest)).ok, true);
    assert.equal((await instance.send(largeRequest)).ok, false, 'a second large session must not exceed the overall in-memory cache');
  } finally { instance.dispose(); }
});

test('large captured image bundles are downgraded before reaching the PDF broker', async () => {
  // Exercise byte accounting, not decoder validity: the PNG prefix and padding
  // reproduce the former gap between binary MiB and decimal character limits.
  const bytes = new Uint8Array(8 * 1024 * 1024 - 1024);
  bytes.set(Buffer.from(image.split(',')[1], 'base64'));
  let serial = 0;
  const prepared = await prepareAssets('![one](https://images.example/1.png)\n\n![two](https://images.example/2.png)\n\n![three](https://images.example/3.png)', {
    fetcher: (async () => { const unique = bytes.slice();unique[unique.length - 1] = ++serial;return new Response(unique, { headers: { 'content-type': 'image/png' } }); }) as typeof fetch,
  });
  assert.equal(Object.keys(prepared.files).length, 2);
  assert.equal(prepared.diagnostics[0].code, 'IMAGE_TOTAL_LIMIT');
  const instance = broker();
  try {
    const imageAssets = Object.fromEntries(Object.entries(prepared.imageAssets).filter(([key]) => key.startsWith('images/')));
    assert.equal((await instance.send(request({ markdown: prepared.markdown, imageAssets, diagnostics: prepared.diagnostics }))).ok, true);
  } finally { instance.dispose(); }
});

test('failed tab creation discards its in-memory print session and timer', async () => {
  const instance = broker();
  try {
    instance.state.failOpen = true;
    assert.equal((await instance.send(request())).ok, false);
    assert.equal(instance.state.timers.size, 0);
    instance.state.failOpen = false;
    for (let count = 0; count < PRINT_LIMITS.sessions; count++) assert.equal((await instance.send(request())).ok, true);
  } finally { instance.dispose(); }
});

const printBundle = build({
  entryPoints: [fileURLToPath(new URL('../src/print.ts', import.meta.url))], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome120', loader: { '.css': 'text' },
  plugins: [{ name: 'print-render-contract', setup(builder) {
    builder.onResolve({ filter: /^\.\/preview$/ }, args => args.importer.endsWith('/src/print.ts') || args.importer.endsWith('\\src\\print.ts') ? { path: 'render-contract', namespace: 'print-contract' } : null);
    builder.onLoad({ filter: /.*/, namespace: 'print-contract' }, () => ({ contents: 'export async function renderPreview(markdown, options) { globalThis.__printRenderInputs = {markdown, options}; return globalThis.__printRenderResult; }', loader: 'js' }));
  } }],
}).then(result => result.outputFiles[0].text);

async function eventually(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 1500;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'print page did not complete its expected state transition');
}

async function withPrintPage(options: {
  url?: string; payload?: PrintPayload; error?: string; html?: string; fonts?: Promise<unknown>; imageDecode?: () => Promise<void>;
}, run: (page: JSDOM, state: { prints: number; requests: unknown[]; decodes: number }) => Promise<void>): Promise<void> {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();virtualConsole.on('jsdomError', error => errors.push(String(error)));
  const page = new JSDOM('<!doctype html><head></head><body></body>', { url: options.url || pageURL, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const state = { prints: 0, requests: [] as unknown[], decodes: 0 };
  // JSDOM treats extension schemes as opaque; Chromium gives its own pages storage.
  const storage = new Map<string, string>();
  Object.defineProperty(page.window, 'sessionStorage', { value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } } });
  Object.assign(page.window, {
    chrome: { runtime: { getURL: (path: string) => `chrome-extension://${extensionId}/${path}`, sendMessage: async (message: unknown) => { state.requests.push(message);return options.error ? { ok: false, error: options.error } : { ok: true, payload: options.payload || { markdown: '# Test', imageAssets: {}, diagnostics: [] } }; } } },
    __printRenderResult: { html: options.html || '<h1>Print test</h1><pre><code>  indented\n\n</code></pre><table><thead><tr><th>Title</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table>', diagnostics: [] },
    print: () => { state.prints++; },
  });
  Object.defineProperty(page.window.document, 'fonts', { value: { ready: options.fonts || Promise.resolve() } });
  page.window.HTMLImageElement.prototype.decode = async function () { state.decodes++;await (options.imageDecode?.() || Promise.resolve()); };
  try { page.window.eval(await printBundle);await run(page, state);assert.deepEqual(errors, []); }
  finally { page.window.close(); }
}

test('print page renders final Markdown with its assets, keeps table/code structure and auto-prints once', async () => {
  const payload: PrintPayload = { markdown: '# Exact source\n\n    keep indentation\n', imageAssets: { 'images/a.png': image }, diagnostics: [{ code: 'note', severity: 'info', message: 'Export note' }] };
  await withPrintPage({ payload }, async (page, state) => {
    await eventually(() => state.prints === 1);
    const inputs = (page.window as unknown as { __printRenderInputs: { markdown: string; options: { imageAssets: Record<string, string> } } }).__printRenderInputs;
    assert.equal(inputs.markdown, payload.markdown);
    assert.deepEqual(JSON.parse(JSON.stringify(inputs.options.imageAssets)), payload.imageAssets);
    assert.equal(page.window.document.querySelector('#print-content pre code')!.textContent, '  indented\n\n');
    assert.equal(page.window.document.querySelectorAll('#print-content table tbody tr').length, 1);
    assert.match(page.window.document.querySelector('#print-diagnostics')!.textContent!, /Export note/);
    const css = page.window.document.querySelector('style')!.textContent!;
    assert.match(css, /@page\{size:A4/);assert.match(css, /table-header-group/);assert.match(css, /white-space:pre-wrap/);
    assert.match(css, /chrome-extension:\/\/print-unit-test\/vendor\/katex\/fonts\//);
    assert.doesNotMatch(css, /url\(["']?https?:/);
    page.window.eval(await printBundle);
    await eventually(() => !page.window.document.querySelector<HTMLButtonElement>('#print-tools button')!.disabled);
    assert.equal(state.prints, 1, 'reinitializing the same token must not auto-print twice');
    page.window.document.querySelector<HTMLButtonElement>('#print-tools button')!.click();
    assert.equal(state.prints, 2, 'the manual print button remains available for retry');
  });
});

test('print page waits for fonts and approved image decoding before automatic print', async () => {
  let readyFonts!: () => void;let readyImage!: () => void;
  const fonts = new Promise<void>(resolve => { readyFonts = resolve; });
  const decoded = new Promise<void>(resolve => { readyImage = resolve; });
  await withPrintPage({ fonts, payload: { markdown: '![test](images/a.png)', imageAssets: { 'images/a.png': image }, diagnostics: [] }, html: `<p><img src="${image}" srcset="https://should-not-load.example/a.png 2x" alt="test"></p>`, imageDecode: () => decoded }, async (page, state) => {
    await eventually(() => !!page.window.document.querySelector('#print-content img'));
    assert.equal(state.prints, 0);assert.equal(state.decodes, 0);
    assert.equal(page.window.document.querySelector('img')!.getAttribute('srcset'), null);
    readyFonts();await eventually(() => state.decodes === 1);assert.equal(state.prints, 0);
    readyImage();await eventually(() => state.prints === 1);
  });
});

test('failed image decoding pauses automatic printing and leaves a manual recovery action', async () => {
  await withPrintPage({ payload: { markdown: '![test](images/a.png)', imageAssets: { 'images/a.png': image }, diagnostics: [] }, html: `<p><img src="${image}" alt="test"></p>`, imageDecode: async () => { throw new Error('decode failed'); } }, async (page, state) => {
    await eventually(() => page.window.document.querySelector('#print-status')!.textContent!.includes('暂停自动打印'));
    assert.equal(state.prints, 0);
    assert.match(page.window.document.querySelector('#print-diagnostics')!.textContent!, /未能完整解码/);
    const button = page.window.document.querySelector<HTMLButtonElement>('#print-tools button')!;
    assert.equal(button.disabled, false);
    button.click();assert.equal(state.prints, 1);
  });
});

test('print page removes unapproved image resources before inserting its printable DOM', async () => {
  await withPrintPage({ html: `<h1>Assets</h1><img src="https://should-not-load.example/a.png"><img src="${image}"><iframe src="https://should-not-load.example/frame"></iframe>` }, async (page, state) => {
    await eventually(() => state.prints === 1);
    assert.equal(page.window.document.querySelectorAll('#print-content img, #print-content iframe, #print-content [srcset]').length, 0);
    assert.match(page.window.document.querySelector('#print-diagnostics')!.textContent!, /2 张图片/);
  });
});

test('invalid print tokens and broker failures show safe text and never auto-print', async () => {
  await withPrintPage({ url: `chrome-extension://${extensionId}/print.html#invalid` }, async (page, state) => {
    await eventually(() => page.window.document.querySelector('#print-status')!.textContent!.includes('无效'));
    assert.equal(state.requests.length, 0);assert.equal(state.prints, 0);
  });
  await withPrintPage({ error: '<img src=x onerror=evil()> expired' }, async (page, state) => {
    await eventually(() => page.window.document.querySelector('#print-status')!.textContent!.includes('expired'));
    assert.equal(page.window.document.querySelector('#print-status img'), null);
    assert.equal(state.prints, 0);
  });
});
