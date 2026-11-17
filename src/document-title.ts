/** A local filename suggestion, never a path or markup. */
export function cleanDocumentTitle(value: string): string {
  let result = value.normalize('NFC').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/\.pdf$/i, '').replace(/^[. ]+|[. ]+$/g, '');
  result = Array.from(result).slice(0, 80).join('').replace(/[. ]+$/g, '');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = '_' + result;
  return result;
}

function titleText(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll('script,style,template,[hidden],[aria-hidden="true"],.sr-only').forEach(node => node.remove());
  for (const math of copy.querySelectorAll('.katex,math')) {
    const source = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent || math.getAttribute('aria-label') || math.textContent || '';
    math.replaceWith(copy.ownerDocument.createTextNode(source));
  }
  copy.querySelectorAll('img').forEach(image => image.replaceWith(copy.ownerDocument.createTextNode(image.getAttribute('alt') || '')));
  return cleanDocumentTitle(copy.textContent || '');
}

export function suggestDocumentTitle(root: ParentNode, now = new Date()): string {
  const generic = /^(?:chatgpt(?:说|said)?|assistant|回答导出(?:pdf)?|pdf预览|markdown预览)$/i;
  for (const selector of ['h1,h2,h3,h4,h5,h6', 'p', 'li']) {
    for (const element of root.querySelectorAll(selector)) {
      if (element.closest('pre,code,blockquote,table,figure,.gpt-md-badge,[hidden],[aria-hidden="true"]')) continue;
      const title = titleText(element);
      if (title && !generic.test(title.replace(/[\s:：]/g, ''))) return title;
    }
  }
  const part = (value: number) => String(value).padStart(2, '0');
  return `GPT回答-${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}-${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`;
}
