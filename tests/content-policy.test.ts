import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { annotateLayout } from '../src/layout';
import { extractMarkdown } from '../src/extract';
import { prepareIconImages } from '../src/icons';

test('special table and list walkers use the same hidden-content boundary as ordinary prose', () => {
  const page = new JSDOM('<style>.off{display:none}</style><main><ul><li>Shown item</li><li hidden>HIDDEN_LI</li><li aria-hidden="true">HIDDEN_ARIA</li><li class="off">HIDDEN_CSS_LI</li></ul><table><tbody hidden><tr><td>HIDDEN_GROUP</td></tr></tbody><tbody><tr hidden><td>HIDDEN_ROW</td></tr><tr><th>Visible header</th><td hidden>HIDDEN_CELL</td><td class="off">HIDDEN_CSS_CELL</td><td>Shown value</td></tr></tbody></table></main>');
  try {
    const original = page.window.document.querySelector('main')!, clone = original.cloneNode(true) as Element;
    annotateLayout(original, clone);
    const result = extractMarkdown(clone);
    assert.doesNotMatch(result.markdown, /HIDDEN_/);
    assert.match(result.markdown, /Shown item/); assert.match(result.markdown, /Shown value/);
    assert.match(original.textContent!, /HIDDEN_CELL/);
  } finally { page.window.close(); }
});

test('icon replacement cannot make ignored hidden code or control content visible', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" data-d-component="icon" viewBox="0 0 24 24"><path d="M1 1L2 2"/></svg>';
  const page = new JSDOM(`<main><div hidden>${svg}</div><div aria-hidden="true">${svg}</div><div data-gpt-md-display="none">${svg}</div><pre>${svg}</pre><button>${svg}</button><p>Visible</p></main>`);
  try {
    const root = page.window.document.querySelector('main')!, before = root.innerHTML;
    assert.deepEqual(await prepareIconImages(root), []);
    assert.equal(root.innerHTML, before); assert.equal(root.querySelectorAll('img').length, 0);
  } finally { page.window.close(); }
});
