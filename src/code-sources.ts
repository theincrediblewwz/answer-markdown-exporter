import { answerBodyElements, UI_ATTRIBUTE } from './adapter';

const BLOCK_SELECTOR = '[data-code-block="true"][data-markdown-copy="code-block"]';
const OMIT_SELECTOR = `[${UI_ATTRIBUTE}],[data-gpt-md-ignore],[hidden],[inert],[aria-hidden="true"],[data-markdown-copy="exclude"],[data-message-channel="analysis"],[data-message-channel="commentary"],[data-message-type="reasoning"],[data-testid="thinking"],[data-testid="reasoning"]`;
const MAX_BLOCKS = 100;
const MAX_CHARACTERS = 2_000_000;
const MAX_WAIT = 12_000;

function visible(block: Element): boolean {
  if (!block.isConnected || block.closest(OMIT_SELECTOR)) return false;
  const view = block.ownerDocument.defaultView;
  if (!view) return true;
  for (let ancestor: Element | null = block; ancestor; ancestor = ancestor.parentElement) {
    const style = view.getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  }
  return true;
}

function source(block: Element): Element | undefined {
  return Array.from(block.children).find(child => child.matches('[data-code-block-source="true"]') && child.querySelector('code'));
}

async function settle(view: Window | null, deadline: number, current: () => boolean): Promise<void> {
  if (!view || !current() || Date.now() >= deadline) return;
  await new Promise<void>(resolve => {
    let frame = 0;
    let remaining = 2;
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (frame && view.cancelAnimationFrame) view.cancelAnimationFrame(frame);
      resolve();
    };
    const next = () => {
      if (!current() || --remaining === 0) { finish(); return; }
      frame = view.requestAnimationFrame(next);
    };
    const check = () => {
      if (!current() || Date.now() >= deadline) finish();
      else timer = setTimeout(check, Math.min(100, Math.max(0, deadline - Date.now())));
    };
    timer = setTimeout(check, Math.min(100, Math.max(0, deadline - Date.now())));
    if (view.requestAnimationFrame) frame = view.requestAnimationFrame(next);
    else finish();
  });
}

/** Capture only this export's code blocks before GPT virtualizes them away. */
export async function captureCodeSources(answers: Element[], current: () => boolean, onPreparing: () => void): Promise<Map<Element, Element>> {
  const snapshots = new Map<Element, Element>();
  const documents = [...new Set(answers.map(answer => answer.ownerDocument))];
  const routes = documents.map(document => [document, document.location?.href] as const);
  const active = () => current() && routes.every(([document, route]) => document.location?.href === route);
  const deadline = Date.now() + MAX_WAIT;
  if (!active()) return snapshots;
  const blocks: Element[] = [];
  for (const answer of answers) {
    for (const body of answerBodyElements(answer)) {
      const found = [...(body.matches(BLOCK_SELECTOR) ? [body] : []), ...body.querySelectorAll(BLOCK_SELECTOR)];
      for (const block of found) {
        if (blocks.length === MAX_BLOCKS) break;
        if (!blocks.includes(block) && visible(block)) blocks.push(block);
      }
      if (blocks.length === MAX_BLOCKS) break;
    }
    if (blocks.length === MAX_BLOCKS) break;
  }
  let characters = 0;
  const capture = (block: Element): boolean => {
    if (snapshots.has(block)) return true;
    const mounted = source(block);
    const code = mounted?.querySelector('code');
    if (!active() || !visible(block) || !mounted || !visible(mounted) || !code || !visible(code)) return false;
    const available = MAX_CHARACTERS - characters;
    if ((block.textContent?.length || 0) > available) return false;
    const size = block.outerHTML.length;
    if (size > available) return false;
    snapshots.set(block, block.cloneNode(true) as Element);
    characters += size;
    return true;
  };
  // Saving every currently mounted block first is essential: scrolling to the
  // first missing block can immediately unmount any of these existing sources.
  for (const block of blocks) capture(block);
  const missing = blocks.filter(block => !source(block));
  if (!missing.length || !active() || Date.now() >= deadline) return snapshots;
  onPreparing();
  const positions = new Map<Element, { top: number; left: number }>();
  for (const block of missing) {
    for (let ancestor = block.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (!positions.has(ancestor)) positions.set(ancestor, { top: ancestor.scrollTop, left: ancestor.scrollLeft });
    }
    const scrolling = block.ownerDocument.scrollingElement;
    if (scrolling && !positions.has(scrolling)) positions.set(scrolling, { top: scrolling.scrollTop, left: scrolling.scrollLeft });
  }
  try {
    for (const [index, block] of missing.entries()) {
      if (!active() || Date.now() >= deadline) break;
      if (capture(block) || !visible(block)) continue;
      block.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const until = Date.now() + Math.floor(Math.max(0, deadline - Date.now()) / (missing.length - index));
      while (active() && block.isConnected && !source(block) && Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, until - Date.now()))));
      }
      capture(block);
    }
  } finally {
    // Navigation/cancellation must not drag the user back to the old page's
    // saved position. Normal completion restores every affected ancestor.
    if (active()) {
      for (const [element, position] of positions) {
        if (!active()) break;
        if (!element.isConnected) continue;
        if (element.scrollTo) element.scrollTo({ ...position, behavior: 'instant' });
        else { element.scrollTop = position.top; element.scrollLeft = position.left; }
      }
      for (const document of documents) await settle(document.defaultView, deadline, active);
    }
  }
  return snapshots;
}
