import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { strFromU8, unzipSync } from 'fflate';
import type { PageDiagnostics } from '../src/diagnostics';

const bundledContent = build({
  entryPoints: [fileURLToPath(new URL('../src/content.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  loader: { '.css': 'text' },
  legalComments: 'none',
}).then(result => result.outputFiles[0].text);

type MessageListener = (message: unknown, sender: unknown, respond: (response: unknown) => void) => unknown;
type ControllerWindow = { __gptMarkdownControls?: { destroy(): void; diagnostics(): PageDiagnostics } };

async function withController(
  html: string,
  run: (page: JSDOM, assertHealthy: () => void, requestDiagnostics: (rescan?: boolean) => PageDiagnostics) => Promise<void>,
  prepare?: (document: Document) => void,
): Promise<void> {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(String(error)));
  virtualConsole.on('error', (...args: unknown[]) => errors.push(args.map(String).join(' ')));
  const page = new JSDOM(`<!doctype html><body>${html}</body>`, {
    url: 'https://chatgpt.com/c/injection-fixture',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const listeners = new Set<MessageListener>();
  Object.defineProperty(page.window, 'chrome', {
    value: {
      runtime: {
        id: 'injection-test',
        getURL: (path: string) => `chrome-extension://injection-test/${path}`,
        getManifest: () => ({ version: 'test' }),
        onMessage: {
          addListener: (listener: MessageListener) => listeners.add(listener),
          removeListener: (listener: MessageListener) => listeners.delete(listener),
          hasListener: (listener: MessageListener) => listeners.has(listener),
        },
      },
    },
  });
  page.window.addEventListener('error', event => errors.push(String(event.error ?? event.message)));
  page.window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
  const assertHealthy = () => {
    assert.deepEqual(errors, [], 'content initialization and scheduled scans must not throw or log errors');
    const controller = (page.window as unknown as ControllerWindow).__gptMarkdownControls;
    if (controller) assert.equal(controller.diagnostics().error, null, 'scheduled scans must not hide a controller error');
  };
  const requestDiagnostics = (rescan = false): PageDiagnostics => {
    assert.equal(listeners.size, 1, 'one active content controller must register one message listener');
    let response: unknown;
    for (const listener of listeners) listener({ type: 'gpt-md:diagnostics', rescan }, { id: 'injection-test' }, value => { response = value; });
    assert.ok(response && typeof response === 'object', 'the content listener must return diagnostics');
    return response as PageDiagnostics;
  };
  try {
    prepare?.(page.window.document);
    assert.doesNotThrow(() => page.window.eval(source), 'content bundle must initialize');
    assertHealthy();
    assert.ok((page.window as unknown as ControllerWindow).__gptMarkdownControls, 'content controller must be initialized');
    await run(page, assertHealthy, requestDiagnostics);
    await settle(page);
    assertHealthy();
  } finally {
    (page.window as unknown as ControllerWindow).__gptMarkdownControls?.destroy();
    page.window.close();
  }
}

const source = await bundledContent;

function controls(page: JSDOM): HTMLElement[] {
  return Array.from(page.window.document.querySelectorAll<HTMLElement>('[data-gpt-md-ui="controls"]'));
}

function buttons(page: JSDOM): HTMLButtonElement[] {
  return Array.from(controls(page)[0]?.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? []);
}

async function settle(page: JSDOM): Promise<void> {
  await new Promise<void>(resolve => page.window.requestAnimationFrame(() => page.window.requestAnimationFrame(() => resolve())));
}

async function eventually(predicate: () => boolean, assertHealthy: () => void, message: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) {
    assertHealthy();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assertHealthy();
  assert.ok(predicate(), message);
}

function assertOneButtonGroup(page: JSDOM): void {
  assert.equal(controls(page).length, 1, 'one answer must have exactly one export group');
  assert.deepEqual(buttons(page).map(button => button.textContent), ['下载 Markdown', '复制', '预览', '导出 PDF']);
}

function mockDialogs(document: Document, opened?: (dialog: HTMLDialogElement) => void): void {
  Object.defineProperty(document.defaultView!.HTMLDialogElement.prototype, 'showModal', { value: function(this: HTMLDialogElement) { this.open = true; opened?.(this); } });
  Object.defineProperty(document.defaultView!.HTMLDialogElement.prototype, 'close', { value: function(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new document.defaultView!.Event('close')); } });
}

function previewClose(page: JSDOM): HTMLButtonElement {
  const preview = page.window.document.querySelector('[data-gpt-md-ui="preview"]')!;
  return [...preview.shadowRoot!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '关闭')!;
}

test('a role added after initialization discovers an existing completed answer', async () => {
  await withController('<main><div id="answer">Completed answer</div></main>', async (page, assertHealthy) => {
    assert.equal(controls(page).length, 0);
    page.window.document.querySelector('#answer')!.setAttribute('data-message-author-role', 'assistant');
    await eventually(() => controls(page).length === 1, assertHealthy, 'adding only the assistant role must create export controls');
    assertOneButtonGroup(page);
  });
});

test('updating an existing empty text node discovers answer content without a child-list change', async () => {
  await withController('<main><div id="answer" data-message-author-role="assistant"></div></main>', async (page, assertHealthy) => {
    assert.equal(controls(page).length, 0);
    const text = page.window.document.querySelector('#answer')!.firstChild as Text;
    text.data = 'Completed answer';
    await eventually(() => controls(page).length === 1, assertHealthy, 'changing only Text.data must create export controls');
    text.data += ' with another streamed chunk';
    await settle(page);
    assertOneButtonGroup(page);
  }, document => {
    document.querySelector('#answer')!.appendChild(document.createTextNode(''));
  });
});

test('repeated scheduled scans preserve a single existing export group', async () => {
  await withController('<main><div data-message-author-role="assistant">Completed answer</div></main>', async (page, assertHealthy) => {
    assertOneButtonGroup(page);
    const original = controls(page)[0];
    for (let scan = 0; scan < 4; scan += 1) {
      page.window.dispatchEvent(new page.window.PopStateEvent('popstate'));
      await settle(page);
      assertHealthy();
      assertOneButtonGroup(page);
      assert.equal(controls(page)[0], original, 'rescanning must retain the existing controls');
    }
  });
});

test('removing the streaming class mounts export controls without unrelated DOM changes', async () => {
  await withController('<article><div data-message-author-role="assistant"><span id="stream" class="result-streaming">Answer in progress</span></div></article>', async (page, assertHealthy) => {
    await settle(page);
    assert.equal(controls(page).length, 0, 'streaming answers must not mount export controls');
    page.window.document.querySelector('#stream')!.classList.remove('result-streaming');
    await eventually(() => buttons(page).length === 4 && buttons(page).every(button => !button.disabled), assertHealthy, 'removing only the streaming class must restore export actions');
    assertOneButtonGroup(page);
    assert.equal(controls(page)[0].shadowRoot!.querySelector('[role="status"]')!.textContent, '');
  });
});

test('diagnostic messages report counts, repair controls, and exclude conversation text and URLs', async () => {
  await withController('<main><div data-message-author-role="user">private-question-text</div><div data-message-author-role="assistant">private-answer-text <a href="https://private.example/secret-link">Reference</a></div></main>', async (page, assertHealthy, requestDiagnostics) => {
    page.window.history.replaceState({}, '', '/c/private-conversation?secret=private-url#private-fragment');
    const diagnostic = requestDiagnostics(true);
    assert.equal(diagnostic.answerCount, 1);
    assert.equal(diagnostic.controlCount, 1);
    assert.equal(diagnostic.error, null);
    assert.equal(diagnostic.host, 'chatgpt.com');
    assert.equal(typeof diagnostic.version, 'string');
    assert.equal(typeof diagnostic.visibleControlCount, 'number');
    assert.equal(diagnostic.selectorCounts['[data-message-author-role="assistant"]'], 1);
    assert.deepEqual(Object.keys(diagnostic).sort(), ['answerCount', 'controlCount', 'error', 'host', 'readyState', 'selectorCounts', 'version', 'visibleControlCount'].sort());
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-question-text|private-answer-text|private\.example|secret-link|private-conversation|private-url|private-fragment/);

    const removed = controls(page)[0];
    removed.remove();
    const repaired = requestDiagnostics(true);
    assert.equal(repaired.answerCount, 1);
    assert.equal(repaired.controlCount, 1);
    assert.equal(repaired.error, null);
    assertOneButtonGroup(page);
    assert.notEqual(controls(page)[0], removed);

    assert.doesNotThrow(() => page.window.eval(source), 'manual reinjection must replace the prior controller safely');
    assertHealthy();
    assert.equal(requestDiagnostics(true).controlCount, 1);
    assertOneButtonGroup(page);
  });
});

test('current GPT semantic answer roots mount controls without legacy author roles or markdown classes', async () => {
  await withController('<main data-slot="conversation"><ol><li data-message-role="user"><p>Question</p></li><li data-message-role="assistant" data-message-complete><div><div><div id="answer" data-assistant-markdown data-assistant-markdown-root><div aria-busy="false"><section><p data-d-component="text">Completed answer</p></section></div></div></div></div><div data-assistant-message-actions role="group"><button aria-label="复制回复">Native action</button></div></li></ol></main>', async (page, _assertHealthy, requestDiagnostics) => {
    assert.equal(page.window.document.querySelector('[data-message-author-role]'), null);
    assert.equal(page.window.document.querySelector('.markdown'), null);
    assertOneButtonGroup(page);
    assert.equal(controls(page)[0].previousElementSibling, page.window.document.querySelector('#answer'));
    assert.ok(buttons(page).every(button => !button.disabled));
    assert.equal(requestDiagnostics().answerCount, 1);
    assert.equal(requestDiagnostics().controlCount, 1);
  });
});

test('legacy wrappers containing current roots and extension previews produce only one control group', async () => {
  await withController('<main><div data-message-author-role="assistant"><div data-assistant-markdown data-assistant-markdown-root><p>One completed answer</p></div></div></main><aside data-gpt-md-ui="preview"><div data-assistant-markdown data-assistant-markdown-root><p>Preview copy</p></div></aside>', async (page, _assertHealthy, requestDiagnostics) => {
    await settle(page);
    assertOneButtonGroup(page);
    assert.equal(controls(page)[0].previousElementSibling, page.window.document.querySelector('[data-message-author-role="assistant"]'));
    assert.equal(page.window.document.querySelector('aside [data-gpt-md-ui="controls"]'), null);
    assert.equal(requestDiagnostics().answerCount, 1);
  });
});

test('current GPT roots remove and restore controls as streaming and busy states change', async () => {
  await withController('<main><ol><li data-message-role="assistant"><div data-assistant-markdown data-assistant-markdown-root class="result-streaming"><div id="body" aria-busy="false"><section><p data-d-component="text">Answer in progress</p></section></div></div></li></ol></main>', async (page, assertHealthy) => {
    await settle(page);
    assert.equal(controls(page).length, 0);
    page.window.document.querySelector('[data-assistant-markdown-root]')!.classList.remove('result-streaming');
    await eventually(() => buttons(page).length === 4 && buttons(page).every(button => !button.disabled), assertHealthy, 'removing the current root streaming class must enable export');
    page.window.document.querySelector('#body')!.setAttribute('aria-busy', 'true');
    await eventually(() => controls(page).length === 0, assertHealthy, 'a busy descendant must remove export controls');
    page.window.document.querySelector('#body')!.setAttribute('aria-busy', 'false');
    await eventually(() => buttons(page).length === 4 && buttons(page).every(button => !button.disabled), assertHealthy, 'a completed descendant must restore export controls');
    assertOneButtonGroup(page);
  });
});

for (const attribute of ['data-assistant-markdown-root', 'data-assistant-markdown']) {
  test(`adding ${attribute} after initialization discovers a current GPT answer`, async () => {
    await withController('<main><ol><li data-message-role="assistant"><div id="answer"><div aria-busy="false"><section><p data-d-component="text">Completed answer</p></section></div></div></li></ol></main>', async (page, assertHealthy, requestDiagnostics) => {
      await settle(page);
      assert.equal(controls(page).length, 0, 'the transcript item alone is not the Markdown body');
      page.window.document.querySelector('#answer')!.setAttribute(attribute, '');
      await eventually(() => controls(page).length === 1, assertHealthy, `adding only ${attribute} must create controls`);
      await settle(page);
      assertOneButtonGroup(page);
      assert.equal(requestDiagnostics().answerCount, 1);
    });
  });
}

test('busy state on the current GPT transcript item prevents controls until the item completes', async () => {
  await withController('<main><ol><li id="current-message" data-message-role="assistant" aria-busy="true"><div><div data-assistant-markdown data-assistant-markdown-root><div aria-busy="false"><section><p data-d-component="text">Answer in progress</p></section></div></div></div></li></ol></main>', async (page, assertHealthy) => {
    await settle(page);
    assert.equal(controls(page).length, 0, 'a busy transcript item must not have export controls');
    page.window.document.querySelector('#current-message')!.setAttribute('aria-busy', 'false');
    await eventually(() => buttons(page).length === 4 && buttons(page).every(button => !button.disabled), assertHealthy, 'completing the transcript item must restore export actions');
    assertOneButtonGroup(page);
  });
});

// The live page reported these attributes, not their ancestor relationships.
// Keep these as synthetic attribute-order and nesting boundary fixtures.
const diagnosedAttributes = [
  { name: 'data-conversation-role', assistant: 'assistant', user: 'user' },
  { name: 'data-markdown-text-style', assistant: 'assistant-message', user: 'user-message' },
  { name: 'data-chatgpt-search-unit-key', assistant: 'unit:assistant', user: 'unit:user' },
];

for (const attribute of diagnosedAttributes) {
  test(`adding diagnosed ${attribute.name} later creates one group and excludes the user root`, async () => {
    await withController(`<main><div ${attribute.name}="${attribute.user}"><p>Question</p></div><div id="answer"><section><p>First fragment.</p></section><section><p>Second fragment.</p></section></div></main>`, async (page, assertHealthy, requestDiagnostics) => {
      await settle(page);
      assert.equal(controls(page).length, 0);
      page.window.document.querySelector('#answer')!.setAttribute(attribute.name, attribute.assistant);
      await eventually(() => controls(page).length === 1, assertHealthy, `adding only ${attribute.name} must discover the assistant answer`);
      await settle(page);
      assertOneButtonGroup(page);
      assert.equal(controls(page)[0].previousElementSibling, page.window.document.querySelector('#answer'));
      assert.equal(requestDiagnostics().answerCount, 1);
      assert.ok(buttons(page).every(button => !button.disabled));
    });
  });
}

test('possibly nested diagnosed assistant markers and extension previews produce one group', async () => {
  await withController('<main><div data-conversation-role="user"><p>Question</p></div><section id="answer" data-conversation-role="assistant"><div data-markdown-text-style="assistant-message"><div data-chatgpt-search-unit-key="unit:assistant"><p>Completed answer</p></div></div></section></main><aside data-gpt-md-ui="preview"><div data-conversation-role="assistant"><div data-markdown-text-style="assistant-message" data-chatgpt-search-unit-key="preview:assistant">Preview copy</div></div></aside>', async (page, _assertHealthy, requestDiagnostics) => {
    await settle(page);
    assertOneButtonGroup(page);
    assert.equal(controls(page)[0].previousElementSibling, page.window.document.querySelector('#answer'));
    assert.equal(requestDiagnostics().answerCount, 1);
    assert.equal(page.window.document.querySelector('aside [data-gpt-md-ui="controls"]'), null);
    page.window.dispatchEvent(new page.window.PopStateEvent('popstate'));
    await settle(page);
    assertOneButtonGroup(page);
  });
});

test('a diagnosed conversation root recovers from local busy state without disabling another answer', async () => {
  await withController('<main><section id="working" data-conversation-role="assistant" aria-busy="true"><div data-markdown-text-style="assistant-message"><p>Working answer</p></div></section><section data-conversation-role="assistant"><div data-chatgpt-search-unit-key="completed:assistant"><p>Completed answer</p></div></section></main>', async (page, assertHealthy) => {
    await settle(page);
    assert.equal(controls(page).length, 1);
    assert.notEqual(controls(page)[0].previousElementSibling, page.window.document.querySelector('#working'));
    const completedButtons = buttons(page);
    assert.equal(completedButtons.length, 4);
    assert.ok(completedButtons.every(button => !button.disabled));
    page.window.document.querySelector('#working')!.setAttribute('aria-busy', 'false');
    await eventually(() => controls(page).length === 2 && buttons(page).every(button => !button.disabled), assertHealthy, 'completing the diagnosed conversation root must restore its actions');
    assert.equal(controls(page).length, 2);
    assert.ok(completedButtons.every(button => !button.disabled));
  });
});

test('expanding thoughts on a completed modern answer preserves its single export group', async () => {
  await withController('<main><section data-turn-key="turn"><div data-talvt-turn-state="complete"><details open><summary>Thoughts</summary><div id="thoughts"></div></details><div id="final" data-chatgpt-search-unit-key="reply:assistant"><h4 data-conversation-role="assistant">Assistant says:</h4><div data-markdown-text-style="assistant-message"><p>Final answer</p></div></div></div></section></main>', async (page, assertHealthy) => {
    assertOneButtonGroup(page);
    const original = controls(page)[0];
    for (let chunk = 0; chunk < 6; chunk++) {
      const stage = page.window.document.createElement('div');
      stage.setAttribute('data-markdown-text-style', 'assistant-message');
      stage.setAttribute('data-markdown-text-tone', 'secondary');
      stage.textContent = `Intermediate stage ${chunk}`;
      page.window.document.querySelector('#thoughts')!.append(stage);
      await settle(page);
      assertHealthy();
      assertOneButtonGroup(page);
      assert.equal(controls(page)[0], original);
      assert.equal(original.previousElementSibling, page.window.document.querySelector('#final'));
    }
  });
});

test('modern streamed chunks mount no controls until only the turn completion attribute changes', async () => {
  await withController('<main><section id="turn" data-talvt-turn-state="streaming"><div id="stages"></div><div data-chatgpt-search-unit-key="reply:assistant"><p id="body">First chunk</p></div></section></main>', async (page, assertHealthy) => {
    assert.equal(controls(page).length, 0, 'a pending modern answer without Stop is still incomplete');
    for (let chunk = 0; chunk < 4; chunk++) {
      const stage = page.window.document.createElement('div');
      stage.setAttribute('data-markdown-text-style', 'assistant-message');
      stage.textContent = `Stage ${chunk}`;
      page.window.document.querySelector('#stages')!.append(stage);
      page.window.document.querySelector('#body')!.textContent += ` chunk ${chunk}`;
      await settle(page);
      assert.equal(controls(page).length, 0);
    }
    page.window.document.querySelector('#turn')!.setAttribute('data-talvt-turn-state', 'complete');
    await eventually(() => controls(page).length === 1, assertHealthy, 'completion attribute alone must mount the final actions');
    assertOneButtonGroup(page);
    assert.ok(buttons(page).every(button => !button.disabled));
  });
});

test('a new thoughts-only generation keeps an older completed answer usable', async () => {
  await withController('<main><section data-talvt-turn-state="complete"><div id="old" data-chatgpt-search-unit-key="old:assistant">Older completed answer</div></section><section data-talvt-turn-state="thinking"><div data-markdown-text-style="assistant-message" data-markdown-text-tone="secondary">Thinking without final output</div></section></main><button data-testid="stop-button">Stop</button>', async (page, assertHealthy) => {
    await settle(page);
    assertHealthy();
    assertOneButtonGroup(page);
    assert.equal(controls(page)[0].previousElementSibling, page.window.document.querySelector('#old'));
    assert.ok(buttons(page).every(button => !button.disabled));
    page.window.document.querySelector('[data-testid="stop-button"]')!.remove();
    await settle(page);
    assertOneButtonGroup(page);
    assert.ok(buttons(page).every(button => !button.disabled));
  });
});

test('regenerating a completed modern answer removes old controls and mounts one fresh group on completion', async () => {
  await withController('<main><section id="turn" data-talvt-turn-state="complete"><div id="final" data-chatgpt-search-unit-key="reply:assistant"><p>First completed output</p></div></section></main>', async (page, assertHealthy) => {
    const original = controls(page)[0];
    page.window.document.querySelector('#turn')!.setAttribute('data-talvt-turn-state', 'streaming');
    await eventually(() => controls(page).length === 0, assertHealthy, 'restarting generation must remove the old group');
    assert.equal(original.isConnected, false);
    page.window.document.querySelector('#final p')!.textContent = 'Regenerated final output';
    await settle(page);
    assert.equal(controls(page).length, 0);
    page.window.document.querySelector('#turn')!.setAttribute('data-talvt-turn-state', 'complete');
    await eventually(() => controls(page).length === 1, assertHealthy, 'finishing regeneration must mount one group');
    assertOneButtonGroup(page);
    assert.notEqual(controls(page)[0], original);
  });
});

test('outer turn busy state prevents controls despite an inner conversation role wrapper', async () => {
  await withController('<article id="turn" aria-busy="true"><section data-conversation-role="assistant"><div data-assistant-markdown-root>Answer in progress</div></section></article>', async (page, assertHealthy) => {
    assert.equal(controls(page).length, 0);
    page.window.document.querySelector('#turn')!.setAttribute('aria-busy', 'false');
    await eventually(() => controls(page).length === 1, assertHealthy, 'clearing the outer busy state must enable export');
    assertOneButtonGroup(page);
  });
});

test('one copied answer preserves sibling Markdown fragments and excludes transcript reasoning and native actions', async () => {
  let copied = '';
  await withController('<main><ol><li id="message" data-message-role="assistant" data-message-complete><h6>Assistant says:</h6><div data-assistant-markdown-root><p>First body fragment</p></div><aside data-message-channel="analysis"><div data-assistant-markdown-root>Private reasoning</div></aside><div data-assistant-markdown><pre><code class="language-python">if ready:\n    run()\n</code></pre><p>Last body fragment</p></div><div data-assistant-message-actions><button>Copy native action</button></div></li></ol></main>', async (page, assertHealthy) => {
    assertOneButtonGroup(page);
    buttons(page).find(button => button.textContent === '复制')!.click();
    await eventually(() => copied.length > 0, assertHealthy, 'copy must export the combined body fragments');
    assert.match(copied, /First body fragment/);
    assert.match(copied, /Last body fragment/);
    assert.match(copied, /if ready:\n    run\(\)/);
    assert.doesNotMatch(copied, /Assistant says|Private reasoning|Copy native action/);
  }, document => {
    Object.defineProperty(document.defaultView!.navigator, 'clipboard', { value: { writeText: async (value: string) => { copied = value; } } });
  });
});

test('preparing an image keeps all actions disabled through rescans and restores them after PDF preparation', async () => {
  let rejectImage: (reason: Error) => void = () => {};
  let fetchCount = 0;
  const printRequests: unknown[] = [];
  const imageResponse = new Promise<Response>((_resolve, reject) => { rejectImage = reject; });
  await withController('<main><div id="answer" data-message-author-role="assistant"><p>Completed answer</p><img src="https://images.example.test/sample.png" alt="sample"></div></main>', async (page, assertHealthy, requestDiagnostics) => {
    buttons(page).find(button => button.textContent === '导出 PDF')!.click();
    await eventually(() => fetchCount === 1, assertHealthy, 'PDF must wait for the image preparation to begin');
    assert.ok(buttons(page).every(button => button.disabled), 'image preparation must disable every action');
    requestDiagnostics(true);
    await settle(page);
    assert.ok(buttons(page).every(button => button.disabled), 'a rescan must not re-enable actions while image preparation is pending');
    buttons(page).find(button => button.textContent === '导出 PDF')!.click();
    assert.equal(fetchCount, 1, 'a disabled action must not start another preparation');
    assert.equal(printRequests.length, 0, 'printing must wait for image preparation');

    rejectImage(new Error('Synthetic image fetch failure'));
    await eventually(() => printRequests.length === 1 && buttons(page).every(button => !button.disabled), assertHealthy, 'an unavailable image must leave an actionable PDF request and restore the controls');
    const request = printRequests[0] as { type: string; markdown: string; diagnostics: unknown[] };
    assert.equal(request.type, 'gpt-md:print-request');
    assert.match(request.markdown, /Completed answer/);
    assert.ok(request.diagnostics.length > 0, 'an image failure must be disclosed in the export request');
    assert.match(controls(page)[0].shadowRoot!.querySelector('[role="status"]')!.textContent!, /PDF/);
    assertOneButtonGroup(page);
  }, document => {
    const view = document.defaultView!;
    Object.defineProperty(view, 'fetch', { value: () => { fetchCount += 1; return imageResponse; } });
    const runtime = (view as unknown as { chrome: { runtime: { sendMessage?: (message: unknown) => Promise<unknown> } } }).chrome.runtime;
    runtime.sendMessage = async message => { printRequests.push(message); return { ok: true }; };
  });
});

test('copy remains pending until the clipboard write finishes', async () => {
  let finishCopy: () => void = () => {};
  let copyCount = 0;
  const clipboardWrite = new Promise<void>(resolve => { finishCopy = resolve; });
  await withController('<main><div data-message-author-role="assistant"><p>Copied answer</p></div></main>', async (page, assertHealthy, requestDiagnostics) => {
    buttons(page).find(button => button.textContent === '复制')!.click();
    await eventually(() => copyCount === 1, assertHealthy, 'the copy action must reach the clipboard');
    requestDiagnostics(true);
    assert.ok(buttons(page).every(button => button.disabled), 'actions must remain disabled during the clipboard write');
    buttons(page).find(button => button.textContent === '复制')!.click();
    assert.equal(copyCount, 1);
    finishCopy();
    await eventually(() => buttons(page).every(button => !button.disabled), assertHealthy, 'finishing the clipboard write must restore actions');
    assert.match(controls(page)[0].shadowRoot!.querySelector('[role="status"]')!.textContent!, /已复制/);
  }, document => {
    Object.defineProperty(document.defaultView!.navigator, 'clipboard', { value: { writeText: () => { copyCount += 1; return clipboardWrite; } } });
  });
});

test('export reveals a lazy image before extraction and restores ancestor scroll positions', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0hQAAAAASUVORK5CYII=';
  let copied = '';
  let reveals = 0;
  await withController('<main id="scroller"><div data-message-author-role="assistant"><p>Image answer</p><div id="image" data-d-component="image"><span data-d-image-loading>Loading</span></div></div></main>', async (page, assertHealthy) => {
    const scroller = page.window.document.querySelector('#scroller')!;
    buttons(page).find(button => button.textContent === '复制')!.click();
    assert.match(controls(page)[0].shadowRoot!.querySelector('[role="status"]')!.textContent!, /加载.*图片/);
    await eventually(() => copied.length > 0 && buttons(page).every(button => !button.disabled), assertHealthy, 'the lazily inserted image must be captured before copying');
    assert.match(copied, /images\/image-001\.png/);
    assert.equal(reveals, 1);
    assert.equal(scroller.scrollTop, 73);
    assert.equal(scroller.scrollLeft, 19);
    buttons(page).find(button => button.textContent === '复制')!.click();
    await eventually(() => buttons(page).every(button => !button.disabled), assertHealthy, 'a second copy with an existing IMG must finish');
    assert.equal(reveals, 1, 'an image already exposed in the page must not cause another scroll');
  }, document => {
    const scroller = document.querySelector('#scroller')!;
    scroller.scrollTop = 73; scroller.scrollLeft = 19;
    const image = document.querySelector('#image')!;
    Object.defineProperty(image, 'scrollIntoView', { value: () => {
      reveals += 1; scroller.scrollTop = 300; scroller.scrollLeft = 81;
      setTimeout(() => { const img = document.createElement('img'); img.src = png; img.alt = 'diagram'; image.replaceChildren(img); }, 20);
    } });
    Object.defineProperty(document.defaultView!, 'fetch', { value: () => { throw new Error('Embedded image must not be fetched'); } });
    Object.defineProperty(document.defaultView!.navigator, 'clipboard', { value: { writeText: async (markdown: string) => { copied = markdown; } } });
  });
});

test('navigating while a lazy image is loading cancels the export without restoring the old scroll', async () => {
  let copyCount = 0;
  let reveals = 0;
  await withController('<main id="scroller"><div data-message-author-role="assistant"><p>Old answer</p><div id="image" data-d-component="image"><span data-d-image-loading>Loading</span></div></div></main>', async (page, assertHealthy) => {
    buttons(page).find(button => button.textContent === '复制')!.click();
    await eventually(() => reveals === 1, assertHealthy, 'the image placeholder must be exposed before navigation');
    page.window.history.replaceState({}, '', '/c/new-conversation');
    page.window.dispatchEvent(new page.window.PopStateEvent('popstate'));
    await new Promise(resolve => setTimeout(resolve, 150));
    assertHealthy();
    assert.equal(copyCount, 0, 'navigation must cancel a stale clipboard side effect');
    assert.equal(page.window.document.querySelector('#scroller')!.scrollTop, 300, 'an old operation must not restore scroll in another conversation');
    assert.ok(buttons(page).every(button => !button.disabled), 'a cancelled action must leave the retained controls usable');
    assert.equal(controls(page)[0].shadowRoot!.querySelector('[role="status"]')!.textContent, '', 'a cancelled action must not leave an inactive loading message');
  }, document => {
    const scroller = document.querySelector('#scroller')!;
    scroller.scrollTop = 73;
    Object.defineProperty(document.querySelector('#image')!, 'scrollIntoView', { value: () => { reveals += 1; scroller.scrollTop = 300; } });
    Object.defineProperty(document.defaultView!.navigator, 'clipboard', { value: { writeText: async () => { copyCount += 1; } } });
  });
});

test('failed image preparation is retried on a later export', async () => {
  let fetchCount = 0;
  let printCount = 0;
  await withController('<main><div data-message-author-role="assistant"><p>Retry image</p><img src="https://images.example.test/retry.png" alt="retry"></div></main>', async (page, assertHealthy) => {
    for (const expected of [1, 2]) {
      buttons(page).find(button => button.textContent === '导出 PDF')!.click();
      await eventually(() => printCount === expected && buttons(page).every(button => !button.disabled), assertHealthy, 'each completed export must allow a subsequent image retry');
      assert.equal(fetchCount, expected, 'an unavailable image must not be held permanently in the preparation cache');
    }
  }, document => {
    Object.defineProperty(document.defaultView!, 'fetch', { value: async () => { fetchCount += 1; throw new Error('Synthetic temporary failure'); } });
    const runtime = (document.defaultView as unknown as { chrome: { runtime: { sendMessage?: (message: unknown) => Promise<unknown> } } }).chrome.runtime;
    runtime.sendMessage = async () => { printCount += 1; return { ok: true }; };
  });
});

test('a selected export disables tray actions until the PDF request finishes', async () => {
  let finishPrint: (value: { ok: boolean }) => void = () => {};
  const requests: unknown[] = [];
  const printResponse = new Promise<{ ok: boolean }>(resolve => { finishPrint = resolve; });
  await withController('<main><div data-message-author-role="assistant"><p>First answer</p></div><div data-message-author-role="assistant"><p>Second answer</p></div></main>', async (page, assertHealthy) => {
    for (const group of controls(page)) {
      const checkbox = group.shadowRoot!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      checkbox.checked = true; checkbox.dispatchEvent(new page.window.Event('change'));
    }
    const tray = page.window.document.querySelector('[data-gpt-md-ui="selection"]')!;
    const actions = [...tray.shadowRoot!.querySelectorAll<HTMLButtonElement>('button')];
    actions.find(action => action.textContent === '导出 PDF')!.click();
    await eventually(() => requests.length === 1, assertHealthy, 'the selected export must reach the PDF service');
    assert.ok(actions.every(action => action.disabled));
    actions.find(action => action.textContent === '导出 PDF')!.click();
    assert.equal(requests.length, 1, 'a second click must not open another print page');
    const request = requests[0] as { markdown: string };
    assert.match(request.markdown, /First answer[\s\S]*Second answer/);
    finishPrint({ ok: true });
    await eventually(() => actions.every(action => !action.disabled), assertHealthy, 'finishing the PDF request must restore all tray actions');
  }, document => {
    const runtime = (document.defaultView as unknown as { chrome: { runtime: { sendMessage?: (message: unknown) => Promise<unknown> } } }).chrome.runtime;
    runtime.sendMessage = message => { requests.push(message); return printResponse; };
  });
});

test('a selected answer becoming busy cancels a PDF export still preparing images', async () => {
  let failImage: (reason: Error) => void = () => {};
  let fetchCount = 0;
  let printCount = 0;
  const imageResponse = new Promise<Response>((_resolve, reject) => { failImage = reject; });
  await withController('<main><div id="answer" data-message-author-role="assistant"><p>Selected answer</p><img src="https://images.example.test/selected.png" alt="sample"></div></main>', async (page, assertHealthy) => {
    const checkbox = controls(page)[0].shadowRoot!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    checkbox.checked = true; checkbox.dispatchEvent(new page.window.Event('change'));
    const tray = page.window.document.querySelector('[data-gpt-md-ui="selection"]')!;
    const actions = [...tray.shadowRoot!.querySelectorAll<HTMLButtonElement>('button')];
    actions.find(action => action.textContent === '导出 PDF')!.click();
    await eventually(() => fetchCount === 1, assertHealthy, 'the selected export must wait for its image');
    page.window.document.querySelector('#answer')!.setAttribute('aria-busy', 'true');
    failImage(new Error('Synthetic temporary failure'));
    await eventually(() => actions.every(action => !action.disabled), assertHealthy, 'a cancelled selected export must release its pending state');
    assert.equal(printCount, 0, 'an answer that starts generating during preparation must not be exported');
    assert.equal(tray.shadowRoot!.querySelector('[role="status"]')!.textContent, '', 'a cancelled selected action must clear only its transient preparation status');
  }, document => {
    Object.defineProperty(document.defaultView!, 'fetch', { value: () => { fetchCount += 1; return imageResponse; } });
    const runtime = (document.defaultView as unknown as { chrome: { runtime: { sendMessage?: (message: unknown) => Promise<unknown> } } }).chrome.runtime;
    runtime.sendMessage = async () => { printCount += 1; return { ok: true }; };
  });
});

test('a downloaded ZIP includes extraction explanations alongside image failures', async () => {
  let archive: Blob | undefined;
  await withController('<main><div data-message-author-role="assistant"><p>Download answer</p><span data-d-component="pressable" role="link"><span>Open attachment</span></span><img src="https://images.example.test/zip.png" alt="sample"></div></main>', async (page, assertHealthy) => {
    buttons(page).find(button => button.textContent === '下载 Markdown')!.click();
    await eventually(() => !!archive, assertHealthy, 'download must produce a ZIP Blob');
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new page.window.FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(archive!);
    });
    const files = unzipSync(bytes);
    const notes = strFromU8(files['EXPORT-NOTES.md']);
    assert.match(notes, /^# 导出说明/);
    assert.match(notes, /交互入口没有可确认的可移植链接/);
    assert.match(notes, /图片引用无法读取/);
  }, document => {
    const view = document.defaultView!;
    Object.defineProperty(view, 'fetch', { value: async () => { throw new Error('Synthetic image failure'); } });
    Object.defineProperty(view.URL, 'createObjectURL', { value: (blob: Blob) => { archive = blob; return 'blob:local-download'; } });
    Object.defineProperty(view.URL, 'revokeObjectURL', { value: () => {} });
    Object.defineProperty(view.HTMLAnchorElement.prototype, 'click', { value: () => {} });
  });
});

test('changing an answer while its image is preparing cancels the stale export and allows a fresh retry', async () => {
  let failImage: (reason: Error) => void = () => {};
  let fetchCount = 0;
  const requests: { markdown: string }[] = [];
  const delayedImage = new Promise<Response>((_resolve, reject) => { failImage = reject; });
  await withController('<main><div id="answer" data-message-author-role="assistant" data-message-id="same"><p>Old snapshot</p><img src="https://images.example.test/change.png" alt="sample"></div></main>', async (page, assertHealthy) => {
    buttons(page).find(button => button.textContent === '导出 PDF')!.click();
    await eventually(() => fetchCount === 1, assertHealthy, 'the first snapshot must wait for its image');
    page.window.document.querySelector('#answer p')!.textContent = 'Updated answer';
    failImage(new Error('Controlled image failure'));
    await eventually(() => buttons(page).every(button => !button.disabled), assertHealthy, 'the changed snapshot must release its pending state');
    assert.equal(requests.length, 0, 'an obsolete snapshot must not open a PDF with a success status');
    assert.equal(controls(page)[0].shadowRoot!.querySelector('[role="status"]')!.textContent, '');
    buttons(page).find(button => button.textContent === '导出 PDF')!.click();
    await eventually(() => requests.length === 1, assertHealthy, 'a later click must capture the updated answer');
    assert.match(requests[0].markdown, /Updated answer/);
    assert.doesNotMatch(requests[0].markdown, /Old snapshot/);
  }, document => {
    Object.defineProperty(document.defaultView!, 'fetch', { value: () => { fetchCount++; return delayedImage; } });
    const runtime = (document.defaultView as unknown as { chrome: { runtime: { sendMessage?: (message: unknown) => Promise<unknown> } } }).chrome.runtime;
    runtime.sendMessage = async message => { requests.push(message as { markdown: string });return { ok: true }; };
  });
});

test('a selected answer that begins and finishes generating during image preparation invalidates its snapshot', async () => {
  let failImage: (reason: Error) => void = () => {};
  let fetchCount = 0;
  let printCount = 0;
  const delayedImage = new Promise<Response>((_resolve, reject) => { failImage = reject; });
  await withController('<main><div id="answer" data-message-author-role="assistant"><p>Same text after regeneration</p><img src="https://images.example.test/regenerate.png" alt="sample"></div></main>', async (page, assertHealthy) => {
    const checkbox = controls(page)[0].shadowRoot!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    checkbox.checked = true;checkbox.dispatchEvent(new page.window.Event('change'));
    const tray = page.window.document.querySelector('[data-gpt-md-ui="selection"]')!;
    const actions = [...tray.shadowRoot!.querySelectorAll<HTMLButtonElement>('button')];
    actions.find(action => action.textContent === '导出 PDF')!.click();
    await eventually(() => fetchCount === 1, assertHealthy, 'the selection must wait for image preparation');
    const answer = page.window.document.querySelector('#answer')!;
    answer.setAttribute('aria-busy', 'true');answer.removeAttribute('aria-busy');
    failImage(new Error('Controlled image failure'));
    await eventually(() => actions.every(action => !action.disabled), assertHealthy, 'an ended generation must still cancel the earlier snapshot');
    assert.equal(printCount, 0, 'checking only the final non-busy state must not revive a stale export');
    assert.equal(tray.shadowRoot!.querySelector('[role="status"]')!.textContent, '');
  }, document => {
    Object.defineProperty(document.defaultView!, 'fetch', { value: () => { fetchCount++;return delayedImage; } });
    const runtime = (document.defaultView as unknown as { chrome: { runtime: { sendMessage?: (message: unknown) => Promise<unknown> } } }).chrome.runtime;
    runtime.sendMessage = async () => { printCount++;return { ok: true }; };
  });
});

test('unrelated answer changes do not cancel an active snapshot', async () => {
  let failImage: (reason: Error) => void = () => {};
  let fetchCount = 0;
  let printCount = 0;
  const delayedImage = new Promise<Response>((_resolve, reject) => { failImage = reject; });
  await withController('<main><div data-message-author-role="assistant"><p>Export this answer</p><img src="https://images.example.test/selected.png" alt="sample"></div><div id="other" data-message-author-role="assistant"><p>Unrelated answer</p></div></main>', async (page, assertHealthy) => {
    buttons(page).find(button => button.textContent === '导出 PDF')!.click();
    await eventually(() => fetchCount === 1, assertHealthy, 'the selected snapshot must wait for its image');
    page.window.document.querySelector('#other p')!.textContent = 'Unrelated change';
    failImage(new Error('Controlled image failure'));
    await eventually(() => printCount === 1 && buttons(page).every(button => !button.disabled), assertHealthy, 'only mutations affecting the captured answers may cancel the export');
  }, document => {
    Object.defineProperty(document.defaultView!, 'fetch', { value: () => { fetchCount++;return delayedImage; } });
    const runtime = (document.defaultView as unknown as { chrome: { runtime: { sendMessage?: (message: unknown) => Promise<unknown> } } }).chrome.runtime;
    runtime.sendMessage = async () => { printCount++;return { ok: true }; };
  });
});

test('completed and reopened previews leave a finished status after closing without overwriting a later action', async () => {
  await withController('<main><div data-message-author-role="assistant"><p>Preview answer</p></div></main>', async (page, assertHealthy, requestDiagnostics) => {
    const status = controls(page)[0].shadowRoot!.querySelector('[role="status"]')!;
    buttons(page).find(button => button.textContent === '预览')!.click();
    await eventually(() => status.textContent === 'Markdown 预览已生成' && buttons(page).every(button => !button.disabled), assertHealthy, 'rendering a preview must finish its preparation status');
    const oldClose = previewClose(page);
    oldClose.click();
    assert.equal(page.window.document.querySelector('[data-gpt-md-ui="preview"]'), null);
    assert.equal(status.textContent, 'Markdown 预览已生成');
    requestDiagnostics(true);
    assert.equal(status.textContent, 'Markdown 预览已生成', 'rescanning must retain the completed status');

    buttons(page).find(button => button.textContent === '预览')!.click();
    await eventually(() => !!page.window.document.querySelector('[data-gpt-md-ui="preview"]') && buttons(page).every(button => !button.disabled), assertHealthy, 'a preview must be reopenable');
    assert.equal(page.window.document.querySelectorAll('[data-gpt-md-ui="preview"]').length, 1);
    buttons(page).find(button => button.textContent === '复制')!.click();
    await eventually(() => status.textContent === 'Markdown 已复制', assertHealthy, 'a later action must keep its own completion status');
    oldClose.click(); previewClose(page).click();
    assert.equal(status.textContent, 'Markdown 已复制', 'closing old previews must not overwrite a later action result');
  }, document => {
    mockDialogs(document);
    Object.defineProperty(document.defaultView!.navigator, 'clipboard', { value: { writeText: async () => {} } });
  });
});

test('selected previews finish their preparation status and remain finished after closing', async () => {
  await withController('<main><div data-message-author-role="assistant"><p>First preview</p></div><div data-message-author-role="assistant"><p>Second preview</p></div></main>', async (page, assertHealthy) => {
    for (const group of controls(page)) {
      const checkbox = group.shadowRoot!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      checkbox.checked = true; checkbox.dispatchEvent(new page.window.Event('change'));
    }
    const tray = page.window.document.querySelector('[data-gpt-md-ui="selection"]')!;
    const actions = [...tray.shadowRoot!.querySelectorAll<HTMLButtonElement>('button')];
    const status = tray.shadowRoot!.querySelector('[role="status"]')!;
    actions.find(action => action.textContent === '预览')!.click();
    await eventually(() => status.textContent === '所选回答的 Markdown 预览已生成' && actions.every(action => !action.disabled), assertHealthy, 'a selected preview must finish its status');
    previewClose(page).click();
    assert.equal(status.textContent, '所选回答的 Markdown 预览已生成');
    assert.equal(page.window.document.querySelector('[data-gpt-md-ui="preview"]'), null);
  }, document => mockDialogs(document));
});

test('closing a preview before rendering finishes leaves a closed status instead of a success or loading message', async () => {
  await withController('<main><div data-message-author-role="assistant"><p>Close early</p></div></main>', async (page, assertHealthy) => {
    buttons(page).find(button => button.textContent === '预览')!.click();
    const status = controls(page)[0].shadowRoot!.querySelector('[role="status"]')!;
    await eventually(() => buttons(page).every(button => !button.disabled), assertHealthy, 'closing early must release the action');
    assert.equal(status.textContent, '预览已关闭');
    assert.equal(page.window.document.querySelector('[data-gpt-md-ui="preview"]'), null);
  }, document => mockDialogs(document, dialog => {
    const close = [...(dialog.getRootNode() as ShadowRoot).querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '关闭')!;
    close.click();
  }));
});

test('preview errors retain the error status when controls are restored and rescanned', async () => {
  await withController('<main><div data-message-author-role="assistant"><p>Preview error</p></div></main>', async (page, assertHealthy, requestDiagnostics) => {
    buttons(page).find(button => button.textContent === '预览')!.click();
    const status = controls(page)[0].shadowRoot!.querySelector('[role="status"]')!;
    await eventually(() => buttons(page).every(button => !button.disabled), assertHealthy, 'a failed preview must restore controls');
    assert.match(status.textContent!, /Synthetic preview opening error/);
    const failure = status.textContent;
    requestDiagnostics(true);
    assert.equal(status.textContent, failure);
  }, document => {
    Object.defineProperty(document.defaultView!.HTMLDialogElement.prototype, 'showModal', { value: () => { throw new Error('Synthetic preview opening error'); } });
  });
});

test('a copy failure keeps its recovery message when the fallback preview renders and closes', async () => {
  await withController('<main><div data-message-author-role="assistant"><p>Copy fallback</p></div></main>', async (page, assertHealthy) => {
    buttons(page).find(button => button.textContent === '复制')!.click();
    const status = controls(page)[0].shadowRoot!.querySelector('[role="status"]')!;
    await eventually(() => !!page.window.document.querySelector('[data-gpt-md-ui="preview"]') && buttons(page).every(button => !button.disabled), assertHealthy, 'copy failure must open a usable fallback preview');
    assert.match(status.textContent!, /复制被浏览器阻止/);
    const message = status.textContent;
    previewClose(page).click();
    assert.equal(status.textContent, message, 'preview completion must not replace the recovery reason with generic success');
  }, document => {
    mockDialogs(document);
    Object.defineProperty(document.defaultView!.navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Synthetic clipboard denial'); } } });
  });
});
