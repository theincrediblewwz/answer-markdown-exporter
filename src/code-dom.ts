import { excludedContent } from './content-policy';
import { layoutStyle } from './layout';

export const codeBlockSelector = '[data-code-block="true"][data-markdown-copy="code-block"],[data-d-component="code_block"]';
export const codeSourceSelector = '[data-code-block-source="true"]';
const editorChrome = '.cm-gutters,.cm-gutter,.cm-placeholder';
interface SourcePlacement { target: Element; frames: Array<{ parent: Element; index: number; before: Element | null; after: Element | null }>; }
const snapshotPlacements = new WeakMap<Element, SourcePlacement>();

/** Restore only a widget's own source, never a nested widget's stale subtree. */
export function codeSourcePayload(source: Element): Element {
  if (!source.querySelector(codeBlockSelector)) return source;
  const owned = ownedCodeElements(source);
  if (owned.length !== 1 || owned[0].querySelector(codeBlockSelector)) throw new Error('嵌套代码源码结构无法确认，请分段导出。');
  return owned[0];
}

export function rememberCodeSourcePlacement(snapshot: Element, block: Element, mounted: Element): void {
  const target = codeSourcePayload(mounted);
  const frames: SourcePlacement['frames'] = [];
  for (let child = target; child !== block; child = child.parentElement!) {
    const parent = child.parentElement;
    if (!parent || frames.length >= 128) throw new Error('代码容器层级过深，请分段导出。');
    frames.push({ parent, index: Array.from(parent.children).indexOf(child), before: child.nextElementSibling, after: child.previousElementSibling });
  }
  snapshotPlacements.set(snapshot, { target, frames });
}

export function codeSourcePlacement(snapshot: Element): SourcePlacement | undefined { return snapshotPlacements.get(snapshot); }

/** A nested code widget owns its source independently of an outer widget. */
export function ownsCodeDescendant(root: Element, descendant: Element): boolean {
  return root === descendant || descendant.closest(codeBlockSelector) === (root.matches(codeBlockSelector) ? root : root.closest(codeBlockSelector));
}

export function ownedCodeElements(root: Element): Element[] {
  return [...(root.tagName.toUpperCase() === 'CODE' ? [root] : []), ...root.querySelectorAll('code')].filter(code =>
    ownsCodeDescendant(root, code)
    && (!root.matches(codeSourceSelector) || code.closest(codeSourceSelector) === root)
    && (root.tagName.toUpperCase() !== 'PRE' || code.closest('pre') === root));
}

/** Presence is independent of visibility: intentionally hidden sources are never scrolled into view. */
export function ownedCodeSource(block: Element): Element | undefined {
  return [...(block.matches(codeSourceSelector) ? [block] : []), ...block.querySelectorAll(`${codeSourceSelector},pre,.cm-content`)].find(source =>
    ownsCodeDescendant(block, source)
    && (source.matches('pre,.cm-content') || ownedCodeElements(source).length > 0));
}

export function excludedCodeContent(element: Element): boolean {
  if (excludedContent(element) || element.matches(editorChrome)) return true;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (layoutStyle(current, 'display') === 'none' || /^(?:hidden|collapse)$/.test(layoutStyle(current, 'visibility'))) return true;
  }
  return false;
}

/** Preserve token text literally; only explicit code surfaces may add structural line breaks. */
export function codeText(node: Node, structuralLines = false): string {
  if (node.nodeType === 3) return node.nodeValue || '';
  if (node.nodeType !== 1) return '';
  const element = node as Element;
  if (excludedCodeContent(element) || element.matches('.cm-gap')) return '';
  if (element.tagName.toUpperCase() === 'BR') return '\n';
  const children = Array.from(element.childNodes).filter(child => child.nodeType !== 1 || (!excludedCodeContent(child as Element) && !(child as Element).matches('.cm-gap')));
  const isLine = (child: Node): child is Element => child.nodeType === 1 && (
    (child as Element).tagName.toUpperCase() === 'DIV'
    || ((child as Element).tagName.toUpperCase() === 'SPAN' && layoutStyle(child as Element, 'display') === 'block'));
  const lines = children.filter(isLine);
  if (structuralLines && lines.length && children.every(child => isLine(child) || (child.nodeType === 3 && !/\S/.test(child.nodeValue || '')))) {
    let value = ''; let separator = ''; let seenLine = false;
    for (const child of children) {
      if (!isLine(child)) { separator += child.nodeValue || ''; continue; }
      if (seenLine) value += /[\r\n]/.test(separator) ? separator : '\n' + separator;
      else value += separator;
      value += codeLineText(child);
      separator = ''; seenLine = true;
    }
    return value + separator;
  }
  return children.map(child => codeText(child, structuralLines)).join('');
}

export function codeLineText(line: Element): string {
  const value = codeText(line, true);
  // Editors represent an empty row by a lone BR, rather than two rows.
  const visible = Array.from(line.childNodes).filter(child => child.nodeType !== 1 || !excludedCodeContent(child as Element));
  return value === '\n' && visible.length === 1 && visible[0].nodeType === 1 && (visible[0] as Element).tagName.toUpperCase() === 'BR' ? '' : value;
}

/** Inline HTML still parses Markdown between tags. Isolate lines and encode syntax before that boundary. */
export function inlineCodeMarkup(value: string): string {
  const content = value.split(/(\r\n|\r|\n)/).map(part => {
    if (/^[\r\n]+$/.test(part)) return Array.from(part).map(character => `&#${character.charCodeAt(0)};`).join('');
    const literal = Array.from(part).map(character => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 32 || (code >= 33 && code <= 47) || (code >= 58 && code <= 64)
        || (code >= 91 && code <= 96) || (code >= 123 && code <= 126) ? `&#${code};` : character;
    }).join('');
    return `<span>${literal}</span>`;
  }).join('');
  return `<code class="gpt-md-inline-code" style="white-space:pre-wrap">${content}</code>`;
}
