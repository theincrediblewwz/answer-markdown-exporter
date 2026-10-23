export const UI_ATTRIBUTE = 'data-gpt-md-ui';
// Both forms are observed GPT response roots: the message-role layout and the
// newer server-rendered transcript's explicit assistant Markdown container.
export const ANSWER_SELECTOR = '[data-message-author-role="assistant"], [data-assistant-markdown-root], [data-assistant-markdown], [data-conversation-role="assistant"], [data-markdown-text-style="assistant-message"], [data-chatgpt-search-unit-key$=":assistant"]';
export function answerElements(root: ParentNode = document): Element[] {
  const found = Array.from(root.querySelectorAll(ANSWER_SELECTOR));
  return found.filter(el => !el.parentElement?.closest(ANSWER_SELECTOR) && !el.closest(`[${UI_ATTRIBUTE}]`));
}
export function answerContent(answer: Element): Element {
  // Capture the whole assistant message, not just its first Markdown fragment.
  return answer;
}
export function answerKey(answer: Element): string {
  return answer.getAttribute('data-message-id') || answer.getAttribute('data-chatgpt-search-unit-key') || answer.querySelector('[data-chatgpt-search-unit-key$=":assistant"]')?.getAttribute('data-chatgpt-search-unit-key') || answer.closest('[data-message-role="assistant"][id]')?.id || answer.closest('[data-turn-id]')?.getAttribute('data-turn-id') || '';
}
export function generationState(answers = answerElements()): { last: Element | undefined; stop: boolean } {
  return { last: answers.at(-1), stop: !!document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="停止生成"]') };
}
export function isGenerating(answer: Element, state = generationState()): boolean {
  const turn = answer.closest('article, [data-testid^="conversation-turn-"], [data-message-role="assistant"], [data-conversation-role="assistant"]') || answer;
  if (turn.matches('[aria-busy="true"], [data-streaming="true"], .result-streaming') || turn.querySelector('[aria-busy="true"], [data-streaming="true"], .result-streaming')) return true;
  return state.stop && state.last === answer;
}
