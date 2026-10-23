import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import type { PageDiagnostics } from '../src/diagnostics';

const source = await build({
  entryPoints: [fileURLToPath(new URL('../src/popup.ts', import.meta.url))],
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome120',
}).then(result => result.outputFiles[0].text);

const safeReport: PageDiagnostics = {
  version: 'test-version', host: 'chatgpt.com', readyState: 'complete',
  answerCount: 2, controlCount: 2, visibleControlCount: 2,
  selectorCounts: { '[data-message-author-role="assistant"]': 2 }, error: null,
};

async function withPopup(
  reply: () => Promise<PageDiagnostics>,
  run: (page: JSDOM, calls: { queries: unknown[]; messages: unknown[]; copies: string[] }) => Promise<void>,
): Promise<void> {
  const errors: string[] = [];
  const console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(String(error)));
  const page = new JSDOM('<!doctype html><p id="status"></p><pre id="details"></pre><button id="retry">重新检测</button><button id="copy" disabled>复制检测信息</button>', {
    url: 'chrome-extension://popup-test/popup.html', runScripts: 'outside-only', virtualConsole: console,
  });
  const calls = { queries: [] as unknown[], messages: [] as unknown[], copies: [] as string[] };
  Object.defineProperty(page.window, 'chrome', { value: {
    tabs: {
      query: async (options: unknown) => { calls.queries.push(options); return [{ id: 73 }]; },
      sendMessage: async (tabId: number, message: unknown) => { calls.messages.push({ tabId, message }); return reply(); },
    },
  } });
  Object.defineProperty(page.window.navigator, 'clipboard', { value: {
    writeText: async (value: string) => { calls.copies.push(value); },
  } });
  try {
    page.window.eval(source);
    await eventually(() => !page.window.document.querySelector<HTMLButtonElement>('#retry')!.disabled);
    await run(page, calls);
    assert.deepEqual(errors, [], 'popup must not throw unhandled errors');
  } finally { page.window.close(); }
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'popup did not finish its asynchronous update');
}

function status(page: JSDOM): string { return page.window.document.querySelector('#status')!.textContent!; }

test('popup reports a missing content-script response and leaves diagnostic copying disabled', async () => {
  await withPopup(async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); }, async page => {
    assert.match(status(page), /页面脚本未响应/);
    assert.equal(page.window.document.querySelector('#details')!.textContent, '');
    assert.equal(page.window.document.querySelector<HTMLButtonElement>('#copy')!.disabled, true);
  });
});

test('popup distinguishes a running script with no recognized answers', async () => {
  await withPopup(async () => ({ ...safeReport, answerCount: 0, controlCount: 0, visibleControlCount: 0 }), async page => {
    assert.match(status(page), /脚本已运行，但未识别到回答/);
    assert.equal(page.window.document.querySelector<HTMLButtonElement>('#copy')!.disabled, false);
  });
});

test('popup can find the active tab by ID without access to its URL and displays answer and control totals', async () => {
  await withPopup(async () => safeReport, async (page, calls) => {
    assert.match(status(page), /已识别 2 条回答，已生成 2 组导出按钮/);
    assert.deepEqual(calls.queries.map(value => JSON.parse(JSON.stringify(value))), [{ active: true, currentWindow: true }]);
    assert.deepEqual(calls.messages.map(value => JSON.parse(JSON.stringify(value))), [{ tabId: 73, message: { type: 'gpt-md:diagnostics', rescan: true } }]);
  });
});

test('popup distinguishes answers that were recognized but did not receive controls', async () => {
  await withPopup(async () => ({ ...safeReport, controlCount: 0, visibleControlCount: 0 }), async page => {
    assert.match(status(page), /识别到 2 条回答，但按钮尚未生成/);
  });
});

test('popup surfaces a scan error while preserving the diagnostic details for feedback', async () => {
  await withPopup(async () => ({ ...safeReport, error: 'TypeError: scan failed' }), async page => {
    assert.match(status(page), /页面脚本运行出错/);
    assert.match(page.window.document.querySelector('#details')!.textContent!, /TypeError: scan failed/);
  });
});

test('retry requests a fresh rescan and replaces an earlier failed result', async () => {
  let attempt = 0;
  await withPopup(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('not ready');
    return safeReport;
  }, async (page, calls) => {
    assert.match(status(page), /页面脚本未响应/);
    page.window.document.querySelector<HTMLButtonElement>('#retry')!.click();
    await eventually(() => !page.window.document.querySelector<HTMLButtonElement>('#retry')!.disabled);
    assert.match(status(page), /已生成 2 组导出按钮/);
    assert.equal(calls.messages.length, 2);
    for (const item of calls.messages) assert.equal((item as { message: { rescan: boolean } }).message.rescan, true);
  });
});

test('copying diagnostics copies only the received safe report without adding a page URL or message text', async () => {
  await withPopup(async () => safeReport, async (page, calls) => {
    page.window.document.querySelector<HTMLButtonElement>('#copy')!.click();
    await eventually(() => calls.copies.length === 1);
    assert.deepEqual(JSON.parse(calls.copies[0]), safeReport);
    assert.equal(calls.copies[0], page.window.document.querySelector('#details')!.textContent);
    assert.ok(!calls.copies[0].includes('chrome-extension://') && !calls.copies[0].includes('/c/'));
    await eventually(() => page.window.document.querySelector('#copy')!.textContent === '已复制检测信息');
  });
});
