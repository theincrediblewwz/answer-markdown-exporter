/** Copy only document layout facts to an export clone, never page CSS or URLs. */
const properties = ['display', 'visibility', 'flex-direction', 'grid-template-columns', 'grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end', 'white-space', 'order', 'background-color', 'text-align', 'align-items', 'justify-content', 'flex-wrap', 'gap', 'width', 'height', 'border-top-width', 'border-top-style', 'border-radius', 'font-size', 'font-weight', 'color'] as const;
export function annotateLayout(source: Element, clone: Element): void {
  const view = source.ownerDocument.defaultView;
  if (!view) return;
  const stack: Array<[Element, Element]> = [[source, clone]];
  let visited = 0;
  while (stack.length && ++visited <= 8_000) {
    const [original, copy] = stack.pop()!;
    if (original.tagName !== copy.tagName || original.matches('math,.katex,[data-gpt-md-ui]')) continue;
    const codeScope = !!original.closest('pre,code,[data-code-block],[data-code-block-source],[data-d-component="code_block"],.cm-editor,.cm-content');
    // Clear page-provided copies of these facts before reading the live element.
    for (const name of properties) copy.removeAttribute('data-gpt-md-' + name);
    if (codeScope || original.matches('div,section,article,main,aside,p,span,li,dl,dt,dd,table,thead,tbody,tfoot,tr,th,td,svg,img,canvas,[data-d-component="row"],[data-d-component="box"]')) {
      const style = view.getComputedStyle(original);
      for (const name of properties) {
        if (codeScope && !['display', 'visibility', 'white-space'].includes(name)) continue;
        const value = style.getPropertyValue(name);
        if (value && value.length <= 512) copy.setAttribute('data-gpt-md-' + name, value);
      }
    }
    if (original.matches('svg')) continue;
    const originals = Array.from(original.children), copies = Array.from(copy.children);
    // Virtual code restoration can change a subtree. Do not pair unrelated nodes.
    if (originals.length === copies.length) for (let i = originals.length - 1; i >= 0; i--) stack.push([originals[i], copies[i]]);
  }
  if (stack.length) clone.setAttribute('data-gpt-md-layout-incomplete', '');
}

export function layoutStyle(element: Element, name: typeof properties[number]): string {
  const saved = element.getAttribute('data-gpt-md-' + name);
  if (saved !== null) return saved;
  const inline = (element as HTMLElement).style?.getPropertyValue(name);
  if (inline) return inline;
  if (/^grid-(?:row|column)-(?:start|end)$/.test(name)) {
    const shorthand = (element as HTMLElement).style?.getPropertyValue(name.replace(/-(?:start|end)$/, ''));
    if (shorthand) return shorthand.split('/')[name.endsWith('start') ? 0 : 1]?.trim() || 'auto';
  }
  // Also makes standalone DOM captures with a local stylesheet useful. The
  // normal live-page path records these values before the clone is detached.
  return element.ownerDocument.defaultView?.getComputedStyle(element).getPropertyValue(name) || '';
}

export function layoutColumns(element: Element): number {
  if (element.getAttribute('data-d-direction') === 'row') return 0; // Flex row: one cell per child.
  const display = layoutStyle(element, 'display');
  if (/^(?:inline-)?flex$/.test(display) && !/^column/.test(layoutStyle(element, 'flex-direction'))) return 0;
  if (!/^(?:inline-)?grid$/.test(display)) return -1;
  const columns = layoutStyle(element, 'grid-template-columns').trim();
  const repeated = /^repeat\(\s*(\d+)\s*,/.exec(columns);
  if (repeated) return Math.min(24, Number(repeated[1]));
  const tracks: string[] = columns.replace(/\[[^\]]*\]/g, '').match(/(?:minmax|fit-content)\([^)]*\)|[^\s]+/g) || [];
  return tracks.length > 1 && !tracks.includes('none') ? Math.min(24, tracks.length) : -1;
}

export function highlightedCard(element: Element): boolean {
  const background = layoutStyle(element, 'background-color');
  const channels = /^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(background);
  return !!channels && Number(channels[4] ?? 1) > 0 && Math.max(...channels.slice(1, 4).map(Number)) - Math.min(...channels.slice(1, 4).map(Number)) > 12;
}
