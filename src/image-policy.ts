/** Omit source chrome, never infer that all small images are disposable. */
export function citationDecoration(element: Element): boolean {
  if (!element.matches('img,svg,[data-d-component="icon"]')) return false;
  if (element.closest('figure,picture,[data-d-component="image"],[data-message-image="original"],[data-gpt-md-diagram-image]')) return false;
  const graphic = element.matches('[data-d-component="icon"]') ? element.querySelector('svg,img') || element : element;
  const source = graphic.getAttribute('src') || graphic.getAttribute('data-src') || '';
  let favicon = false;
  try {
    const url = new URL(source, element.ownerDocument.baseURI);
    favicon = /(?:^|\/)(?:favicon(?:s)?(?:\.[\w-]+)?|site-icon)(?:\/|$)/i.test(url.pathname) || /\/s2\/favicons(?:\/|$)/i.test(url.pathname);
  } catch { /* Non-URL graphics still require semantic source context. */ }
  const label = [element.getAttribute('class'), graphic.getAttribute('class'), graphic.getAttribute('alt'), element.getAttribute('aria-label'), element.getAttribute('data-testid')].join(' ');
  const namedIcon = /(?:favicon|site[-_ ]?icon|source[-_ ]?icon|citation[-_ ]?icon|网站图标|网站标志|站点图标)/i.test(label);
  const size = (axis: 'width' | 'height') => {
    const value = graphic.getAttribute(axis) || graphic.getAttribute('data-gpt-md-' + axis) || (graphic as HTMLElement).style?.getPropertyValue(axis) || '';
    return /^(?:\d+(?:\.\d+)?)(?:px)?$/.test(value) ? parseFloat(value) : 0;
  };
  const w = size('width'), h = size('height');
  const small = (w > 0 && w <= 32 && h > 0 && h <= 32) || /(?:^|\s)(?:size-[34568]|w-[34568])(?:\s|$)/.test(graphic.getAttribute('class') || '');
  const sourceWidget = element.closest('[data-d-component="badge"],[data-testid*="citation" i],[data-testid*="source" i],[data-citation],[data-source-id],.citation,.source-citation');
  const link = element.closest('a,button,[role="link"]');
  // Source URL/icon identity is stronger evidence than pixel dimensions.
  if ((favicon || namedIcon) && (sourceWidget || link)) return true;
  const container = sourceWidget || link;
  if (!container || !small) return false;
  // A linked miniature without alt text can still be a real picture. Require
  // source-widget or explicit icon semantics, rather than size + link alone.
  if (!sourceWidget && !element.matches('[data-d-component="icon"]') && !graphic.closest('[data-d-component="icon"]')) return false;
  const alt = graphic.getAttribute('alt')?.trim();
  const explicitCitation = sourceWidget && !sourceWidget.matches('[data-d-component="badge"]');
  if (alt && !explicitCitation && !/(?:favicon|图标|网站标志|logo|\bicon\b)/i.test(alt)) return false;
  const copy = container.cloneNode(true) as Element;
  copy.querySelectorAll('img,svg,[data-d-component="icon"]').forEach(image => image.remove());
  return !!copy.textContent?.trim();
}
