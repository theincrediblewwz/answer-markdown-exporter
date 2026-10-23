import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { answerElements, answerContent, answerKey, generationState, isGenerating } from '../src/adapter';
import { extractMarkdown } from '../src/extract';

function withPage(html: string, run: (document: Document) => void): void {
  const page = new JSDOM(html, { url: 'https://chatgpt.com/c/fixture' });
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: page.window.document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: page.window });
  try {
    run(page.window.document);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    page.window.close();
  }
}

test('only actual assistant messages get actions, excluding user messages and extension-owned UI', () => {
  withPage('<div data-message-author-role="user" data-message-id="u1">Question</div><div data-message-author-role="assistant" data-message-id="a1">Answer</div><aside data-gpt-md-ui><div data-message-author-role="assistant" data-message-id="ui">Preview copy</div></aside>', () => {
    assert.deepEqual(answerElements().map(answerKey), ['a1']);
  });
});

test('nested assistant wrappers do not give one visible answer duplicate action groups', () => {
  withPage('<main><div data-message-author-role="assistant" data-message-id="outer"><section><div data-message-author-role="assistant" data-message-id="inner">One answer</div></section></div><div data-message-author-role="assistant" data-message-id="next">Another answer</div></main>', () => {
    assert.deepEqual(answerElements().map(answerKey), ['outer', 'next']);
  });
});

test('an answer split across Markdown fragments exports every fragment and code block', () => {
  withPage('<div data-message-author-role="assistant"><div class="markdown"><p>First fragment.</p></div><div class="markdown"><p>Second fragment.</p><pre><code class="language-js">console.log(42);</code></pre></div></div>', () => {
    const result = extractMarkdown(answerContent(answerElements()[0]));
    assert.match(result.markdown, /First fragment/);
    assert.match(result.markdown, /Second fragment/);
    assert.equal(result.codeBlocks[0].text, 'console.log(42);');
  });
});

test('message identity survives wrapper changes and takes priority over its containing turn identity', () => {
  withPage('<article data-turn-id="turn-1"><section><div data-message-author-role="assistant" data-message-id="message-1">Answer</div></section></article>', document => {
    const answer = answerElements()[0];
    assert.equal(answerKey(answer), 'message-1');
    const wrapper = document.createElement('section');
    answer.replaceWith(wrapper);
    wrapper.appendChild(answer);
    assert.equal(answerKey(answer), 'message-1');
  });
});

test('turn identity is available when the page does not expose a message ID', () => {
  withPage('<article data-turn-id="turn-fallback"><div><div data-message-author-role="assistant">Answer</div></div></article>', () => {
    assert.equal(answerKey(answerElements()[0]), 'turn-fallback');
  });
});

test('an unidentified answer does not acquire an invented persistent identity', () => {
  withPage('<div data-message-author-role="assistant">Answer</div>', () => {
    assert.equal(answerKey(answerElements()[0]), '');
  });
});

test('a global Stop generating control disables only the latest assistant answer', () => {
  withPage('<article><div data-message-author-role="assistant" data-message-id="old">Earlier answer</div></article><article><div data-message-author-role="user">Follow-up</div></article><article><div data-message-author-role="assistant" data-message-id="new">New answer</div></article><button data-testid="stop-button">Stop</button><aside data-gpt-md-ui><div data-message-author-role="assistant">Preview</div></aside>', () => {
    const answers = answerElements();
    const state = generationState(answers);
    assert.equal(state.stop, true);
    assert.equal(answerKey(state.last!), 'new');
    assert.deepEqual(answers.map(answer => isGenerating(answer, state)), [false, true]);
  });
});

test('local streaming state prevents export even without a global Stop control', () => {
  withPage('<article aria-busy="true"><div data-message-author-role="assistant" data-message-id="aria">Working</div></article><article><div data-message-author-role="assistant" data-message-id="attribute"><section data-streaming="true">Working</section></div></article><article><div data-message-author-role="assistant" data-message-id="class"><span class="result-streaming">Working</span></div></article><article><div data-message-author-role="assistant" data-message-id="done">Complete</div></article>', () => {
    const answers = answerElements();
    const state = generationState(answers);
    assert.equal(state.stop, false);
    assert.deepEqual(answers.map(answer => isGenerating(answer, state)), [true, true, true, false]);
  });
});

test('a standalone answer with its own streaming attribute is treated as incomplete', () => {
  withPage('<div data-message-author-role="assistant" data-streaming="true">Working</div>', () => {
    assert.equal(isGenerating(answerElements()[0]), true);
  });
});

test('removing Stop and local streaming markers makes a completed answer available on the next scan', () => {
  withPage('<article data-streaming="true"><div data-message-author-role="assistant">Answer</div></article><button aria-label="Stop generating">Stop</button>', document => {
    const answer = answerElements()[0];
    assert.equal(isGenerating(answer), true);
    document.querySelector('button')!.remove();
    document.querySelector('article')!.removeAttribute('data-streaming');
    assert.equal(generationState().stop, false);
    assert.equal(isGenerating(answer), false);
  });
});

test('current GPT Markdown roots are recognized without legacy author roles or markdown classes', () => {
  // Keep the observed transcript semantics while omitting layout classes and hydration comments.
  withPage('<main data-slot="conversation"><ol><li data-message-role="user"><p>Question</p></li><li data-message-role="assistant" data-message-complete><h6>ChatGPT说</h6><div><div><div id="answer" data-assistant-markdown data-assistant-markdown-root><div aria-busy="false"><section><p data-d-component="text">First fragment.</p><p data-d-component="text">Second fragment.</p></section></div></div></div></div><div data-assistant-message-actions><button aria-label="复制回复">Native action</button></div></li></ol></main>', document => {
    assert.equal(document.querySelector('[data-message-author-role]'), null);
    assert.equal(document.querySelector('.markdown'), null);
    const answers = answerElements();
    assert.equal(answers.length, 1);
    assert.equal(answers[0], document.querySelector('#answer'));
    const result = extractMarkdown(answerContent(answers[0]));
    assert.match(result.markdown, /First fragment/);
    assert.match(result.markdown, /Second fragment/);
    assert.doesNotMatch(result.markdown, /Question|Native action|ChatGPT说/);
  });
});

test('a current Markdown root nested inside a legacy assistant wrapper is one answer', () => {
  withPage('<main><div id="legacy" data-message-author-role="assistant" data-message-id="legacy"><div data-assistant-markdown data-assistant-markdown-root><p>One answer</p></div></div><li data-message-role="assistant"><div id="current" data-assistant-markdown data-assistant-markdown-root><p>Another answer</p></div></li></main>', document => {
    assert.deepEqual(answerElements(), [document.querySelector('#legacy'), document.querySelector('#current')]);
  });
});

test('current Markdown roots in extension-owned UI remain excluded', () => {
  withPage('<main><div id="actual" data-assistant-markdown data-assistant-markdown-root><p>Actual answer</p></div></main><aside data-gpt-md-ui="preview"><div data-assistant-markdown data-assistant-markdown-root><p>Preview content</p></div><div data-message-author-role="assistant"><div data-assistant-markdown data-assistant-markdown-root>Legacy preview wrapper</div></div></aside>', document => {
    assert.deepEqual(answerElements(), [document.querySelector('#actual')]);
  });
});

test('a current GPT Markdown root follows its own and descendant streaming state', () => {
  withPage('<main><ol><li data-message-role="assistant"><div data-assistant-markdown data-assistant-markdown-root class="result-streaming"><div id="body" aria-busy="false"><section><p data-d-component="text">Answer in progress</p></section></div></div></li></ol></main>', document => {
    const answer = answerElements()[0];
    assert.ok(answer, 'the current Markdown root must be discovered');
    assert.equal(isGenerating(answer), true);
    answer.classList.remove('result-streaming');
    assert.equal(isGenerating(answer), false);
    document.querySelector('#body')!.setAttribute('aria-busy', 'true');
    assert.equal(isGenerating(answer), true);
    document.querySelector('#body')!.setAttribute('aria-busy', 'false');
    assert.equal(isGenerating(answer), false);
  });
});

test('current GPT answer identity uses its assistant transcript item ID before the turn fallback', () => {
  withPage('<main><ol data-turn-id="turn-fallback"><li id="current-message" data-message-role="assistant" data-message-complete><div><div data-assistant-markdown data-assistant-markdown-root><p>Answer</p></div></div></li></ol></main>', () => {
    const answer = answerElements()[0];
    assert.equal(answerKey(answer), 'current-message');
    answer.setAttribute('data-message-id', 'explicit-message');
    assert.equal(answerKey(answer), 'explicit-message');
    answer.removeAttribute('data-message-id');
    assert.equal(answerKey(answer), 'current-message');
  });
});

test('busy state on a current GPT assistant transcript item affects only its answer', () => {
  withPage('<main><ol><li data-message-role="assistant" aria-busy="true"><div data-assistant-markdown data-assistant-markdown-root><p>Working answer</p></div></li><li data-message-role="assistant" data-message-complete><div data-assistant-markdown data-assistant-markdown-root><p>Completed answer</p></div></li></ol></main>', document => {
    const answers = answerElements();
    assert.equal(answers.length, 2);
    assert.deepEqual(answers.map(answer => isGenerating(answer)), [true, false]);
    document.querySelector('li[aria-busy]')!.setAttribute('aria-busy', 'false');
    assert.deepEqual(answers.map(answer => isGenerating(answer)), [false, false]);
  });
});

// Live diagnostics confirm these markers, but do not establish their DOM hierarchy.
// These fixtures exercise single-root and synthetic nesting boundaries only.
const diagnosedMarkers = [
  { name: 'conversation role', assistant: 'data-conversation-role="assistant"', user: 'data-conversation-role="user"' },
  { name: 'Markdown text style', assistant: 'data-markdown-text-style="assistant-message"', user: 'data-markdown-text-style="user-message"' },
  { name: 'search unit key', assistant: 'data-chatgpt-search-unit-key="unit:assistant"', user: 'data-chatgpt-search-unit-key="unit:user"' },
];

for (const marker of diagnosedMarkers) {
  test(`a diagnosed ${marker.name} root excludes user/UI content and exports every fragment`, () => {
    withPage(`<main><div ${marker.user}><p>Private question</p></div><div id="answer" ${marker.assistant}><section><p>First fragment.</p></section><section><p>Second fragment.</p><pre><code class="language-js">const n = 3;</code></pre><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody><tr><td>Last row</td><td>Retained</td></tr></tbody></table></section></div></main><aside data-gpt-md-ui="preview"><div ${marker.assistant}><p>Preview copy</p></div></aside>`, document => {
      const answers = answerElements();
      assert.deepEqual(answers, [document.querySelector('#answer')]);
      const result = extractMarkdown(answerContent(answers[0]));
      assert.match(result.markdown, /First fragment/);
      assert.match(result.markdown, /Second fragment/);
      assert.match(result.markdown, /Last row/);
      assert.match(result.markdown, /Retained/);
      assert.equal(result.codeBlocks[0].text, 'const n = 3;');
      assert.doesNotMatch(result.markdown, /Private question|Preview copy/);
    });
  });
}

test('diagnosed markers on possible nested wrappers or one node do not duplicate answers', () => {
  for (let outer = 0; outer < diagnosedMarkers.length; outer += 1) {
    const first = diagnosedMarkers[outer].assistant;
    const second = diagnosedMarkers[(outer + 1) % diagnosedMarkers.length].assistant;
    const third = diagnosedMarkers[(outer + 2) % diagnosedMarkers.length].assistant;
    withPage(`<main><div id="nested" ${first}><div ${second}><section ${third}><p>One nested answer</p></section></div></div><div id="combined" ${first} ${second} ${third}><p>One combined answer</p></div></main>`, document => {
      assert.deepEqual(answerElements(), [document.querySelector('#nested'), document.querySelector('#combined')]);
    });
  }
});

test('a diagnosed search unit key supplies identity without entering exported Markdown', () => {
  withPage('<main><div data-chatgpt-search-unit-key="private-unit:assistant"><p>Answer text only.</p></div></main>', () => {
    const answer = answerElements()[0];
    assert.ok(answer);
    assert.equal(answerKey(answer), 'private-unit:assistant');
    assert.doesNotMatch(extractMarkdown(answerContent(answer)).markdown, /private-unit/);
    answer.setAttribute('data-message-id', 'explicit-message');
    assert.equal(answerKey(answer), 'explicit-message');
  });
});

test('busy state on a diagnosed conversation root stays local and clears when completed', () => {
  withPage('<main><section id="working" data-conversation-role="assistant" aria-busy="true"><div data-markdown-text-style="assistant-message"><p>Working answer</p></div></section><section data-conversation-role="assistant"><div data-markdown-text-style="assistant-message"><p>Completed answer</p></div></section></main>', document => {
    const answers = answerElements();
    assert.equal(answers.length, 2);
    assert.deepEqual(answers.map(answer => isGenerating(answer)), [true, false]);
    document.querySelector('#working')!.setAttribute('aria-busy', 'false');
    assert.deepEqual(answers.map(answer => isGenerating(answer)), [false, false]);
  });
});
