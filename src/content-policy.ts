// Shared by semantic walkers and visual preparation so replacement images do
// not accidentally make ignored or hidden page content visible in an export.
export const ignoredContentSelector = 'script,style,noscript,template,button:not([data-message-image="original"][aria-haspopup="dialog"]),input,textarea,select,[hidden],[inert],[data-gpt-md-ui],[data-gpt-md-ignore],[data-message-content-controls],[data-markdown-copy="exclude"],h4[data-conversation-role="assistant"][tabindex="-1"]:not([data-d-component]),[role="toolbar"],[aria-hidden="true"]';

export function excludedContent(element: Element): boolean {
  if (element.closest(ignoredContentSelector)) return true;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.getAttribute('data-gpt-md-display') === 'none' || (current as HTMLElement).style?.display === 'none') return true;
    if (/^(?:hidden|collapse)$/.test(current.getAttribute('data-gpt-md-visibility') || (current as HTMLElement).style?.visibility || '')) return true;
  }
  return false;
}
