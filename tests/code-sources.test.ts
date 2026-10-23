import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { answerBodyElements, cloneAnswerContent } from '../src/adapter';
import { captureCodeSources } from '../src/code-sources';

const selector = '[data-code-block="true"][data-markdown-copy="code-block"]';
const sourceSelector = '[data-code-block-source="true"]';
function block(id: string): string {
  return `<div id="${id}" data-code-block="true" data-markdown-copy="code-block"><div data-markdown-copy="exclude"><div>Python</div><div data-code-block-controls="true"><button>Copy</button></div></div><div style="height:100px"></div></div>`;
}
function mount(element: Element, value: string): void {
  element.querySelector(sourceSelector)?.remove();
  const container = element.ownerDocument.createElement('div');
  container.setAttribute('data-code-block-source', 'true');
  const code = element.ownerDocument.createElement('code');
  code.textContent = value;
  container.append(code);
  element.append(container);
}
function page(html: string): JSDOM {
  return new JSDOM(`<main id="scroll"><article id="answer">${html}</article></main>`, { url: 'https://chatgpt.com/c/code-fixture', pretendToBeVisual: true });
}
function values(root: Element): string[] {
  return Array.from(root.querySelectorAll('code')).map(code => code.textContent || '');
}

test('mutually virtualized code blocks are captured individually and remain exact after restoring scroll', async () => {
  const fixture = page(block('one') + block('two'));
  try {
    const document = fixture.window.document;
    const answer = document.querySelector('#answer')!;
    const scroller = document.querySelector('#scroll')!;
    const one = document.querySelector('#one')!;
    const two = document.querySelector('#two')!;
    scroller.scrollTop = 24; scroller.scrollLeft = 7;
    const scrolls: string[] = [];
    Object.assign(one, { scrollIntoView() { scrolls.push('one'); scroller.scrollTop = 400; mount(one, 'alpha\n    a = 1\n\n    return a'); two.querySelector(sourceSelector)?.remove(); } });
    Object.assign(two, { scrollIntoView() { scrolls.push('two'); scroller.scrollTop = 800; one.querySelector(sourceSelector)?.remove(); mount(two, 'beta\n    b = 2'); } });
    let restored = 0;
    Object.assign(scroller, { scrollTo(position: ScrollToOptions) {
      restored += 1;
      scroller.scrollTop = position.top!; scroller.scrollLeft = position.left!;
      two.querySelector(sourceSelector)?.remove();
      mount(one, 'REMOUNTED live source');
    } });
    let frames = 0;
    const requestFrame = fixture.window.requestAnimationFrame.bind(fixture.window);
    fixture.window.requestAnimationFrame = callback => { frames += 1; return requestFrame(callback); };
    let preparing = 0;
    const snapshots = await captureCodeSources([answer], () => true, () => { preparing += 1; });
    assert.deepEqual(scrolls, ['one', 'two']);
    assert.equal(preparing, 1);
    assert.equal(restored, 1);
    assert.equal(scroller.scrollTop, 24); assert.equal(scroller.scrollLeft, 7);
    assert.equal(frames, 2);
    assert.equal(snapshots.size, 2);
    assert.ok([...snapshots.values()].every(snapshot => !snapshot.isConnected));
    assert.deepEqual(values(cloneAnswerContent(answer, snapshots)), ['alpha\n    a = 1\n\n    return a', 'beta\n    b = 2']);
    assert.deepEqual(values(answer), ['REMOUNTED live source'], 'cloning must not rewrite the live answer');
  } finally { fixture.window.close(); }
});

test('already mounted sources are saved before scrolling can unmount them', async () => {
  const fixture = page(block('one') + block('two'));
  try {
    const answer = fixture.window.document.querySelector('#answer')!;
    const one = answer.querySelector('#one')!;
    const two = answer.querySelector('#two')!;
    mount(one, 'first source');
    Object.assign(one, { scrollIntoView() { assert.fail('a mounted source must not be scrolled'); } });
    Object.assign(two, { scrollIntoView() { one.querySelector(sourceSelector)?.remove(); mount(two, 'second source'); } });
    const snapshots = await captureCodeSources([answer], () => true, () => {});
    assert.equal(snapshots.size, 2);
    assert.deepEqual(values(cloneAnswerContent(answer, snapshots)), ['first source', 'second source']);
  } finally { fixture.window.close(); }
});

test('an answer with existing source requires no scrolling or preparation state', async () => {
  const fixture = page(block('one'));
  try {
    const answer = fixture.window.document.querySelector('#answer')!;
    const one = answer.querySelector('#one')!;
    mount(one, '    stable\n\nsource');
    Object.assign(one, { scrollIntoView() { assert.fail('unexpected scroll'); } });
    const snapshots = await captureCodeSources([answer, answer], () => true, () => { assert.fail('unexpected preparing state'); });
    assert.equal(snapshots.size, 1);
    assert.equal(snapshots.get(one)?.querySelector('code')?.textContent, '    stable\n\nsource');
  } finally { fixture.window.close(); }
});

for (const reason of ['cancelled', 'navigated'] as const) {
  test(`a ${reason} export stops capturing without restoring old scroll positions`, async () => {
    const fixture = page(block('one'));
    try {
      const answer = fixture.window.document.querySelector('#answer')!;
      const one = answer.querySelector('#one')!;
      const scroller = fixture.window.document.querySelector('#scroll')!;
      scroller.scrollTop = 12;
      let active = true;
      Object.assign(scroller, { scrollTo() { assert.fail('an obsolete page position must not be restored'); } });
      Object.assign(one, { scrollIntoView() {
        scroller.scrollTop = 999;
        if (reason === 'cancelled') active = false;
        else fixture.window.history.pushState({}, '', '/c/another-conversation');
        mount(one, 'obsolete source');
      } });
      const snapshots = await captureCodeSources([answer], () => active, () => {});
      assert.equal(snapshots.size, 0);
      assert.equal(scroller.scrollTop, 999);
    } finally { fixture.window.close(); }
  });
}

test('hidden, reasoning and extension-owned code blocks are never captured', async () => {
  const fixture = page(block('visible') + `<section hidden>${block('hidden')}</section><section style="display:none">${block('css')}</section><section aria-hidden="true">${block('aria')}</section><section data-gpt-md-ui>${block('ui')}</section><section data-message-channel="analysis">${block('thought')}</section>`);
  try {
    const answer = fixture.window.document.querySelector('#answer')!;
    for (const item of answer.querySelectorAll(selector)) mount(item, item.id);
    const snapshots = await captureCodeSources([answer], () => true, () => { assert.fail('hidden sources must not require preparation'); });
    assert.deepEqual([...snapshots.keys()].map(item => item.id), ['visible']);
  } finally { fixture.window.close(); }
});

test('explicitly hidden or ignored mounted source content is not captured or revealed by scrolling', async () => {
  const fixture = page(block('hidden-source') + block('hidden-code') + block('ignored-source'));
  try {
    const answer = fixture.window.document.querySelector('#answer')!;
    for (const item of answer.querySelectorAll(selector)) {
      mount(item, 'hidden source');
      Object.assign(item, { scrollIntoView() { assert.fail('an intentionally hidden mounted source must not be revealed'); } });
    }
    answer.querySelector('#hidden-source ' + sourceSelector)!.setAttribute('hidden', '');
    answer.querySelector('#hidden-code code')!.setAttribute('aria-hidden', 'true');
    answer.querySelector('#ignored-source ' + sourceSelector)!.setAttribute('data-gpt-md-ignore', '');
    const snapshots = await captureCodeSources([answer], () => true, () => { assert.fail('hidden mounted sources must not enter preparation'); });
    assert.equal(snapshots.size, 0);
  } finally { fixture.window.close(); }
});

test('snapshot replacement stays inside actual sibling answer bodies and does not import tools or thoughts', async () => {
  const fixture = new JSDOM(`<article data-message-role="assistant" id="message"><h4 data-conversation-role="assistant">ChatGPT says</h4><aside data-message-type="reasoning"><div data-assistant-markdown-root>${block('thought')}</div></aside><div data-assistant-markdown-root id="body-one">${block('one')}</div><aside data-tool-output>${block('tool')}</aside><div data-assistant-markdown-root id="body-two">${block('two')}</div></article>`, { url: 'https://chatgpt.com/c/code-fixture', pretendToBeVisual: true });
  try {
    const answer = fixture.window.document.querySelector('#message')!;
    for (const item of answer.querySelectorAll(selector)) mount(item, item.id);
    assert.deepEqual(answerBodyElements(answer).map(body => body.id), ['body-one', 'body-two']);
    const snapshots = await captureCodeSources([answer], () => true, () => {});
    assert.deepEqual([...snapshots.keys()].map(item => item.id), ['one', 'two']);
    const tool = answer.querySelector('#tool')!;
    snapshots.set(tool, tool.cloneNode(true) as Element);
    answer.querySelector('#one')!.querySelector(sourceSelector)?.remove();
    answer.querySelector('#two')!.querySelector(sourceSelector)?.remove();
    const cloned = cloneAnswerContent(answer, snapshots);
    assert.deepEqual(values(cloned), ['one', 'two']);
    assert.equal(cloned.querySelectorAll('#tool,#thought,h4').length, 0);
  } finally { fixture.window.close(); }
});

test('capture caps blocks at one hundred and skips snapshots exceeding the aggregate character budget', async () => {
  const fixture = page(Array.from({ length: 101 }, (_, index) => block('block-' + index)).join(''));
  try {
    const answer = fixture.window.document.querySelector('#answer')!;
    for (const item of answer.querySelectorAll(selector)) mount(item, 'small source');
    const snapshots = await captureCodeSources([answer], () => true, () => {});
    assert.equal(snapshots.size, 100);
    assert.equal(snapshots.has(answer.querySelector('#block-100')!), false);
    mount(answer.querySelector('#block-0')!, 'x'.repeat(2_000_001));
    const bounded = await captureCodeSources([answer], () => true, () => {});
    assert.equal(bounded.has(answer.querySelector('#block-0')!), false);
    assert.ok([...bounded.values()].reduce((total, snapshot) => total + snapshot.outerHTML.length, 0) <= 2_000_000);
  } finally { fixture.window.close(); }
});

test('separately valid large sources cannot together exceed the two-million-character snapshot budget', async () => {
  const fixture = page(block('one') + block('two') + block('three'));
  try {
    const answer = fixture.window.document.querySelector('#answer')!;
    mount(answer.querySelector('#one')!, 'a'.repeat(1_100_000));
    mount(answer.querySelector('#two')!, 'b'.repeat(1_100_000));
    mount(answer.querySelector('#three')!, 'small final source');
    const snapshots = await captureCodeSources([answer], () => true, () => {});
    assert.deepEqual([...snapshots.keys()].map(item => item.id), ['one', 'three']);
    assert.ok([...snapshots.values()].reduce((total, snapshot) => total + snapshot.outerHTML.length, 0) <= 2_000_000);
  } finally { fixture.window.close(); }
});

test('the shared deadline prevents another missing code block from starting after twelve seconds', async () => {
  const fixture = page(block('one') + block('two'));
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const answer = fixture.window.document.querySelector('#answer')!;
    Object.assign(answer.querySelector('#one')!, { scrollIntoView() { now += 12_000; } });
    Object.assign(answer.querySelector('#two')!, { scrollIntoView() { assert.fail('the total deadline has expired'); } });
    const snapshots = await captureCodeSources([answer], () => true, () => {});
    assert.equal(snapshots.size, 0);
  } finally { Date.now = originalNow; fixture.window.close(); }
});
