import { codeBlockSelector, codeSourcePayload, codeSourcePlacement, excludedCodeContent, ownedCodeElements, ownedCodeSource } from './code-dom';

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
export function answerBodyElements(answer: Element): Element[] {
  return answer.matches('[data-message-role="assistant"]') && !answer.matches(ANSWER_SELECTOR) ? candidates(answer) : [answer];
}
export function cloneAnswerContent(answer: Element, codeSources?: ReadonlyMap<Element, Element>): Element {
  const copyBody = (body: Element): Element => {
    const copied = body.cloneNode(true) as Element;
    // Capture live facts while original/copy topology still matches, then
    // restore only owned source subtrees. A parent snapshot must never replace
    // newer prose or child widgets, and a deep widget chain is cloned once.
    annotateLayout(body, copied);
    if (!codeSources?.size) return copied;
    if (codeSources.size > 100) throw new Error('代码快照数量超过限额，请分段导出。');
    const originals = [...(body.matches(codeBlockSelector) ? [body] : []), ...body.querySelectorAll(codeBlockSelector)];
    const copies = [...(copied.matches(codeBlockSelector) ? [copied] : []), ...copied.querySelectorAll(codeBlockSelector)];
    for (let index = 0; index < originals.length; index += 1) {
      const saved = codeSources.get(originals[index]), target = copies[index];
      if (!saved || !target) continue;
      const source = ownedCodeSource(saved);
      if (!source) continue;
      const payload = codeSourcePayload(source);
      let restored = payload.cloneNode(true) as Element;
      const current = ownedCodeSource(target);
      if (current && !excludedCodeContent(current)) {
        if (source.querySelector(codeBlockSelector) || current.querySelector(codeBlockSelector)) {
          const savedCodes = ownedCodeElements(source), currentCodes = ownedCodeElements(current);
          if (savedCodes.length !== 1 || currentCodes.length !== 1) throw new Error('嵌套代码的源码归属无法确认，请分段导出。');
          currentCodes[0].replaceWith(savedCodes[0].cloneNode(true));
        } else current.replaceWith(restored);
        continue;
      }
      if (current) {
        if (current.querySelector(codeBlockSelector)) throw new Error('嵌套代码的可见容器已改变，请重新准备导出。');
        current.remove();
      }
      const origin = originals[index], placement = codeSourcePlacement(saved);
      const inOwner = (node: Element) => (node === origin || origin.contains(node))
        && (node === origin || node.closest(codeBlockSelector) === origin);
      const copyOf = (live: Element): Element => {
        const path: number[] = [];
        for (let child = live; child !== origin; child = child.parentElement!) {
          if (!child.parentElement || path.length >= 128) throw new Error('代码位置无法确认，请重新导出。');
          path.unshift(Array.from(child.parentElement.children).indexOf(child));
        }
        let mapped = target;
        for (const position of path) {
          const next = mapped.children[position];
          if (!next) throw new Error('代码容器在准备期间改变，请等待页面稳定后重新导出。');
          mapped = next;
        }
        return mapped;
      };
      if (placement && inOwner(placement.target) && !excludedCodeContent(placement.target)) {
        copyOf(placement.target).replaceWith(restored); continue;
      }
      if (placement) {
        const frame = placement.frames.find(step => inOwner(step.parent) && !excludedCodeContent(step.parent));
        if (!frame) throw new Error('代码的可见容器已经改变，请重新导出。');
        const parent = copyOf(frame.parent);
        if (payload !== source && !frame.parent.matches('pre,.cm-content,[data-code-block-source="true"]')) {
          const wrapper = source.cloneNode(false) as Element; wrapper.append(restored); restored = wrapper;
        }
        const livePosition = frame.before?.parentElement === frame.parent ? Array.from(frame.parent.children).indexOf(frame.before)
          : frame.after?.parentElement === frame.parent ? Array.from(frame.parent.children).indexOf(frame.after) + 1 : frame.index;
        parent.insertBefore(restored, parent.children[Math.min(livePosition, parent.children.length)] || null);
        continue;
      }
      // Manually supplied maps have no original-node identity. They may replace
      // an existing owned source, but stale index/tag paths are never guessed.
      throw new Error('代码快照缺少可确认的原始位置，请重新准备导出。');
    }
    return copied;
  };
  let clone: Element;
  if (answer.matches('[data-message-role="assistant"]') && !answer.matches(ANSWER_SELECTOR)) {
    // Keep all sibling body fragments, without cloning message headings or tools.
    clone = answer.ownerDocument.createElement('div');
    for (const body of answerBodyElements(answer)) clone.append(copyBody(body));
  } else clone = copyBody(answer);
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
import { annotateLayout } from './layout';
