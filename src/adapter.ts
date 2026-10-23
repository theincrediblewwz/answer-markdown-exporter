export const UI_ATTRIBUTE = 'data-gpt-md-ui';
// Both forms are observed GPT response roots: the message-role layout and the
// newer server-rendered transcript's explicit assistant Markdown container.
export const ANSWER_SELECTOR = '[data-message-author-role="assistant"], [data-assistant-markdown-root], [data-assistant-markdown], [data-conversation-role="assistant"], [data-markdown-text-style="assistant-message"], [data-chatgpt-search-unit-key$=":assistant"]';
const MESSAGE_SELECTOR = '[data-message-author-role="assistant"], [data-assistant-markdown-root], [data-assistant-markdown], [data-chatgpt-search-unit-key$=":assistant"]';
const OMIT_SELECTOR = `[${UI_ATTRIBUTE}], [data-message-channel="analysis"], [data-message-channel="commentary"], [data-message-type="reasoning"], [data-testid="thinking"], [data-testid="reasoning"]`;
const BUSY_SELECTOR = '[aria-busy="true"], [data-streaming="true"], .result-streaming';

function candidates(root: ParentNode): Element[] {
  const found = Array.from(root.querySelectorAll(ANSWER_SELECTOR)).filter(el => !el.closest(OMIT_SELECTOR) && !/^H[1-6]$/.test(el.tagName));
  const eligible = found.filter(el => {
    // In the current transcript, expanding thoughts reveals many Markdown roots
    // in the same turn. Only the actual message has a durable message marker.
    const turn = el.closest('[data-talvt-turn-state]');
    return !turn || el.matches(MESSAGE_SELECTOR) || !!el.closest(MESSAGE_SELECTOR) || !!el.querySelector(MESSAGE_SELECTOR);
  });
  const eligibleSet = new Set(eligible);
  return eligible.filter(el => {
    for (let parent = el.parentElement; parent; parent = parent.parentElement) if (eligibleSet.has(parent)) return false;
    return true;
  });
}

function turnOwner(answer: Element): Element {
  return answer.closest('[data-talvt-turn-state]')
    || answer.closest('article, [data-testid^="conversation-turn-"]')
    || answer.closest('[data-message-role="assistant"], [data-turn-id], [data-turn-key]') || answer;
}

export function answerElements(root: ParentNode = document): Element[] {
  const found = candidates(root);
  const messageGroups = new Map<Element, Element[]>();
  for (const body of found) {
    const message = body.closest('[data-message-role="assistant"]');
    if (!message) continue;
    const bodies = messageGroups.get(message) || [];
    bodies.push(body); messageGroups.set(message, bodies);
  }
  const messageRoots = new Set([...messageGroups].filter(([, bodies]) => bodies.length > 1 && bodies.every(body => body.matches('[data-assistant-markdown-root], [data-assistant-markdown]'))).map(([message]) => message));
  const groups = new Map<Element, Element[]>();
  for (const body of found) {
    const message = body.closest('[data-message-role="assistant"]');
    const answer = message && messageRoots.has(message) ? message : body;
    const owner = turnOwner(answer);
    const group = groups.get(owner) || [];
    if (!group.includes(answer)) group.push(answer);
    groups.set(owner, group);
  }
  return [...groups.values()].map(bodies => {
    // Earlier siblings are progress messages, not additional final answers.
    return bodies[bodies.length - 1];
  });
}
export function answerContent(answer: Element): Element {
  // Capture the whole assistant message, not just its first Markdown fragment.
  return answer;
}
export function cloneAnswerContent(answer: Element): Element {
  let clone: Element;
  if (answer.matches('[data-message-role="assistant"]') && !answer.matches(ANSWER_SELECTOR)) {
    // Keep all sibling body fragments, without cloning message headings or tools.
    clone = answer.ownerDocument.createElement('div');
    for (const body of candidates(answer)) clone.append(body.cloneNode(true));
  } else clone = answer.cloneNode(true) as Element;
  for (const label of clone.querySelectorAll('[data-conversation-role="assistant"]')) if (/^H[1-6]$/.test(label.tagName)) label.remove();
  return clone;
}
export function answerKey(answer: Element): string {
  return answer.getAttribute('data-message-id') || answer.getAttribute('data-chatgpt-search-unit-key') || answer.querySelector('[data-chatgpt-search-unit-key$=":assistant"]')?.getAttribute('data-chatgpt-search-unit-key') || answer.closest('[data-message-role="assistant"][id]')?.id || answer.closest('[data-turn-id]')?.getAttribute('data-turn-id') || '';
}
export function generationState(answers = answerElements()): { last: Element | undefined; stop: boolean; activeTurn: Element | undefined } {
  const raw = Array.from(document.querySelectorAll(ANSWER_SELECTOR)).filter(el => !el.closest(`[${UI_ATTRIBUTE}]`));
  const latest = raw.at(-1);
  const pendingTurn = Array.from(document.querySelectorAll('[data-talvt-turn-state]')).filter(el => el.getAttribute('data-talvt-turn-state') !== 'complete' && !el.closest(`[${UI_ATTRIBUTE}]`)).at(-1);
  return {
    last: answers.at(-1),
    activeTurn: pendingTurn || (latest ? turnOwner(latest) : undefined),
    stop: !!document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"]'),
  };
}
export function isGenerating(answer: Element, state = generationState()): boolean {
  const turn = turnOwner(answer);
  const modern = answer.closest('[data-talvt-turn-state]');
  if (modern && modern.getAttribute('data-talvt-turn-state') !== 'complete') return true;
  if (turn.matches('[data-message-complete="false"]') || answer.closest('[data-message-role="assistant"][data-message-complete="false"]')) return true;
  if (turn.matches(BUSY_SELECTOR) || turn.querySelector(BUSY_SELECTOR)) return true;
  return state.stop && (state.activeTurn ? turn === state.activeTurn : state.last === answer);
}
