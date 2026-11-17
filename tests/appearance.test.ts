import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_APPEARANCE, normalizeAppearance } from '../src/appearance';

test('appearance defaults remain readable and invalid settings cannot inject arbitrary CSS', () => {
  assert.deepEqual(normalizeAppearance(undefined), DEFAULT_APPEARANCE);
  assert.deepEqual(normalizeAppearance({ font: 'url(https://untrusted.test)', fontSize: '99px', contentWidth: Infinity }), DEFAULT_APPEARANCE);
  assert.deepEqual(normalizeAppearance({ font: 'serif', fontSize: 10000, contentWidth: -50 }), { font: 'serif', fontSize: 28, contentWidth: 560 });
  assert.deepEqual(normalizeAppearance({ font: 'sans', fontSize: 12.9, contentWidth: 960 }), { font: 'sans', fontSize: 13, contentWidth: 960 });
});
