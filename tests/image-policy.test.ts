import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { extractMarkdown } from '../src/extract';
import { prepareAssets } from '../src/assets';
import { citationDecoration } from '../src/image-policy';
import { prepareIconImages } from '../src/icons';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('source favicons keep their citation link and never cause a fetch or ZIP', async () => {
  for (const graphic of [
    '<img src="https://site.test/favicon.ico" alt="Site">',
    '<img src="/backend-api/search/favicon?domain=site.test" width="16" height="16" alt="Site">',
    `<img src="${png}" width="20" height="20" alt="网站图标">`,
    `<svg data-d-component="icon" width="16" height="16"><path d="M0 0L8 8"/></svg>`,
    `<span data-d-component="icon"><svg width="16" height="16"><path d="M0 0L8 8"/></svg></span>`,
  ]) {
    const page = new JSDOM(`<main><p>Result <a href="https://site.test/article">${graphic}Reference title</a></p></main>`, { url: 'https://chatgpt.com/' });
    try {
      const root = page.window.document.querySelector('main')!;
      assert.deepEqual(await prepareIconImages(root), []);
      const result = extractMarkdown(root);
      assert.match(result.markdown, /\[Reference title\]\(https:\/\/site\.test\/article\)/);
      let fetches = 0;
      const assets = await prepareAssets(result.markdown, { fetcher: async () => { fetches++;throw Error('Should not fetch decorative sources'); } });
      assert.equal(fetches, 0); assert.equal(assets.hasImages, false); assert.deepEqual(assets.diagnostics, []);
    } finally { page.window.close(); }
  }
});

test('genuine small images and linked images survive while only citation chrome is removed', async () => {
  for (const html of [
    `<img src="${png}" width="16" height="16" alt="Small experiment">`,
    `<a href="https://site.test/full"><img src="${png}" width="16" height="16" alt="Small experiment"></a>`,
    `<a href="https://site.test/full"><img src="${png}" width="16" height="16" alt="Small experiment">Caption</a>`,
    `<a href="https://site.test/full"><img src="${png}" width="16" height="16" alt="">Experiment caption</a>`,
    `<figure><a href="https://site.test"><img src="${png}" width="16" height="16" alt="Icon study">Site</a></figure>`,
    `<div data-d-component="image"><img src="${png}" width="16" height="16" alt="Answer image"></div>`,
    `<img src="${png}" width="300" height="180" alt="Source diagram">`,
  ]) {
    const page = new JSDOM(`<main>${html}<a href="https://site.test"><img src="/favicon.ico">Citation</a></main>`, { url: 'https://chatgpt.com/' });
    try {
      const result = extractMarkdown(page.window.document.querySelector('main')!);
      const assets = await prepareAssets(result.markdown);
      assert.equal(assets.hasImages, true); assert.equal(Object.keys(assets.files).length, 1); assert.equal(assets.diagnostics.length, 0);
      assert.deepEqual([...assets.files['images/image-001.png']], [...Buffer.from(png.split(',')[1], 'base64')]);
      assert.doesNotMatch(result.markdown, /favicon\.ico/);
    } finally { page.window.close(); }
  }
});

test('small standalone diagram connectors remain meaningful graphics', () => {
  const page = new JSDOM('<main><div data-d-component="row" data-d-justify="center"><svg data-d-component="icon" width="20" height="20" aria-label="Next step"></svg></div></main>');
  try { assert.equal(citationDecoration(page.window.document.querySelector('svg')!), false); }
  finally { page.window.close(); }
});
