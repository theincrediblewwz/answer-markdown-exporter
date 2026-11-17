import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { iconSymbol } from '../src/icon-symbols';
import { prepareIconImages } from '../src/icons';
import { extractMarkdown } from '../src/extract';
import { prepareAssets } from '../src/assets';

const shapes: Array<[string, string]> = [
  ['<path d="M12 5v14m-7-7 7 7 7-7"/>', '↓'],
  ['<path d="M12 19V5m-7 7 7-7 7 7"/>', '↑'],
  ['<path d="M5 12h14m-7-7 7 7-7 7"/>', '→'],
  ['<path d="M19 12H5m7-7-7 7 7 7"/>', '←'],
  ['<path d="M7 17 17 7M7 7h10v10"/>', '↗'],
  ['<path d="M7 7 17 17M7 17h10V7"/>', '↘'],
  ['<polyline points="9 6 15 12 9 18"/>', '›'],
  ['<polyline points="6 9 12 15 18 9"/>', '⌄'],
  ['<path d="m20 6-11 11-5-5"/>', '✓'],
  ['<path d="M6 6 18 18M18 6 6 18"/>', '×'],
  ['<path d="M12 4v16M4 12h16"/>', '+'],
  ['<path d="m6 9 6 6 6-6z"/>', '▼'],
  ['<path d="M19 9h-4V3H9v6H5l7 7z"/>', '↓'],
];
for (const [shape, symbol] of shapes) test(`line geometry retains ${symbol} without guessing from size`, () => {
  const page = new JSDOM(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${shape}</svg>`);
  try { assert.equal(iconSymbol(page.window.document.querySelector('svg')!), symbol); }
  finally { page.window.close(); }
});

test('unrecognized metadata does not resolve inherited JavaScript object properties as icon names', () => {
  const page = new JSDOM('<svg xmlns="http://www.w3.org/2000/svg" data-icon="constructor" viewBox="0 0 24 24">'+shapes[0][0]+'</svg>');
  try { assert.equal(iconSymbol(page.window.document.querySelector('svg')!), '↓'); }
  finally { page.window.close(); }
});

test('simple UI arrows, check marks and labelled icons retain meaning and never cause a ZIP', async () => {
  const page = new JSDOM('<main>' + shapes.map(([shape]) => `<span data-d-component="icon"><svg viewBox="0 0 24 24">${shape}</svg></span>`).join('') + '<span data-d-component="icon" aria-label="Warning"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/></svg></span><span data-d-component="icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/></svg></span></main>');
  try {
    const main = page.window.document.querySelector('main')!, before = main.innerHTML, clone = main.cloneNode(true) as Element;
    const notes = await prepareIconImages(clone);
    const result = extractMarkdown(clone); const assets = await prepareAssets(result.markdown);
    assert.equal(main.innerHTML, before); assert.equal(clone.querySelectorAll('img,svg').length, 0);
    for (const [, symbol] of shapes) assert.ok(result.markdown.includes(symbol), symbol);
    assert.match(result.markdown, /⚠/); assert.match(result.markdown, /◇/);
    assert.equal(assets.hasImages, false); assert.deepEqual(assets.files, {});
    assert.ok(notes.some(note => note.code === 'ICONS_AS_TEXT'));
    assert.ok(notes.some(note => note.code === 'ICON_NEUTRAL_TEXT'));
  } finally { page.window.close(); }
});

test('text conversion can retain more than forty arrows without a raster budget warning', async () => {
  const page = new JSDOM('<main>'+Array.from({length:80},()=>`<span data-d-component="icon"><svg viewBox="0 0 24 24">${shapes[0][0]}</svg></span>`).join('')+'</main>');
  try {
    const main=page.window.document.querySelector('main')!, notes=await prepareIconImages(main);
    assert.equal((main.textContent?.match(/↓/g)||[]).length,80);
    assert.ok(!notes.some(note=>note.code==='ICON_CONVERSION_INCOMPLETE'));
  } finally { page.window.close(); }
});
