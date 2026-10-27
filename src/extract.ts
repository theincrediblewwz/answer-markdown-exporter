import { unified } from 'unified';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { renderToString } from 'katex';
import type { Root } from 'mdast';
import type { CodeRecord, Diagnostic, ExportResult, FormulaRecord } from './types';
import { serializeNativeMathML } from './native-mathml';
import { highlightedCard, layoutColumns, layoutStyle } from './layout';
import { ignoredContentSelector, excludedContent } from './content-policy';
import { codeBlockSelector, codeSourceSelector, codeText, codeLineText, excludedCodeContent, inlineCodeMarkup, ownedCodeElements, ownedCodeSource, ownsCodeDescendant } from './code-dom';
import { contentAlignment, fixedColumnWidth, groupAttributes, meterMarkup } from './presentation';

/** An internal, small mdast builder. No page-owned nodes are changed. */
interface Ast {
  type: string;
  children?: Ast[];
  value?: string;
  [key: string]: unknown;
}
interface Cell { header: boolean; colspan: number; rowspan: number; blocks: Ast[]; align: string | null; scope: string | null; attributes: string; }
interface AttachmentRow { name: string; kind: string; url: string | null; }

const inlineTypes = new Set(['text', 'strong', 'emphasis', 'delete', 'inlineCode', 'inlineMath', 'link', 'image', 'break']);
const messageImageButton = 'button[data-message-image="original"][aria-haspopup="dialog"]';
const ignoreSelector = ignoredContentSelector;
const blockTags = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'FIGURE', 'FIGCAPTION', 'DETAILS', 'SUMMARY', 'HEADER', 'FOOTER', 'ADDRESS', 'ASIDE']);
const serializer = unified().use(remarkGfm).use(remarkMath).use(remarkStringify, {
  bullet: '-', fences: true, listItemIndent: 'one', emphasis: '*', strong: '*',
});

function isInline(node: Ast): boolean { return inlineTypes.has(node.type) || (node.type === 'html' && !node.block); }
function text(value: string): Ast { return { type: 'text', value }; }
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function attrSpan(name: string, value: number): string { return value > 1 ? ` ${name}="${value}"` : ''; }
function trimmedPhrasing(nodes: Ast[]): Ast[] {
  const copy = [...nodes];
  while (copy[0]?.type === 'text') {
    copy[0] = { ...copy[0], value: copy[0].value!.replace(/^ +/, '') };
    if (copy[0].value) break;
    copy.shift();
  }
  while (copy.at(-1)?.type === 'text') {
    const end = copy.length - 1;
    copy[end] = { ...copy[end], value: copy[end].value!.replace(/ +$/, '') };
    if (copy[end].value) break;
    copy.pop();
  }
  return copy;
}
function asBlocks(nodes: Ast[]): Ast[] {
  const result: Ast[] = [];
  let pending: Ast[] = [];
  const flush = () => {
    const children = trimmedPhrasing(pending);
    if (children.length) result.push({ type: 'paragraph', children });
    pending = [];
  };
  for (const node of nodes) {
    if (isInline(node)) pending.push(node);
    else { flush(); result.push(node); }
  }
  flush();
  return result;
}
function sourceWithoutDelimiters(source: string): { tex: string; stripped: boolean; display?: boolean } {
  const pairs: Array<[string, string, boolean]> = [['\\[', '\\]', true], ['\\(', '\\)', false], ['$$', '$$', true], ['$', '$', false]];
  for (const [start, end, display] of pairs) {
    if (source.length >= start.length + end.length && source.startsWith(start) && source.endsWith(end)) {
      return { tex: source.slice(start.length, -end.length), stripped: true, display };
    }
  }
  return { tex: source, stripped: false };
}
function safeUrl(value: string, element: Element): string | null {
  const clean = value.trim();
  if (!clean || /^[\u0000-\u0020]*?(?:javascript|vbscript|file):/i.test(clean)) return null;
  if (/^data:/i.test(clean)) return /^data:image\/(?:png|jpeg|gif|webp);/i.test(clean) ? clean : null;
  try {
    const parsed = new URL(clean, element.ownerDocument.baseURI);
    return /^(?:https?:|mailto:|blob:)$/.test(parsed.protocol) ? parsed.href : null;
  } catch { return /^(?:[./#?]|[^:]+$)/.test(clean) ? clean : null; }
}

function localFragment(value: string, element: Element): string | null {
  let fragment: string;
  if (value.startsWith('#')) fragment = value.slice(1);
  else {
    try {
      const base = new URL(element.ownerDocument.baseURI), target = new URL(value, base);
      if (!target.hash || target.origin !== base.origin || target.pathname !== base.pathname || target.search !== base.search) return null;
      fragment = target.hash.slice(1);
    } catch { return null; }
  }
  try { return decodeURIComponent(fragment); } catch { return fragment; }
}

function originalMathMarkup(root: Element): string {
  // Unsupported math is saved literally, with a preflight budget before asking
  // the browser for a potentially large outerHTML string. Never truncate a
  // formula and then report a successful, complete export.
  const stack: Node[] = [root]; let characters = 0; let nodes = 0;
  while (stack.length) {
    const node = stack.pop()!;
    if (++nodes > 200_000) throw new Error('数学源码节点过多，无法完整导出，请分段保存。');
    if (node.nodeType === 1) {
      const element = node as Element;
      characters += element.tagName.length * 2 + 5;
      for (const attr of element.attributes) characters += attr.name.length + attr.value.length * 6 + 4;
    } else characters += (node.nodeValue?.length || 0) * 6;
    if (characters > 2_000_000) throw new Error('数学原始标记超过安全限额，未生成截断文件，请分段保存。');
    for (const child of node.childNodes) stack.push(child);
  }
  return root.outerHTML;
}

class Capture {
  private ids = new Map<string, string>();
  constructor(root: Element, idPrefix: string) {
    const prefix = idPrefix.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || 'answer';
    const referenced = new Set([root, ...root.querySelectorAll('a[href]')].map(link => localFragment(link.getAttribute('href') || '', link)).filter(value => value !== null));
    const targets = [root, ...root.querySelectorAll('[id]')];
    for (const target of targets) {
      const id = target.getAttribute('id');
      if (id && referenced.has(id) && !target.closest(ignoreSelector) && !this.ids.has(id)) this.ids.set(id, `gpt-md-${prefix}-${this.ids.size + 1}`);
    }
  }
  private mathHtmlCharacters = 0;
  private mathHtmlCache = new Map<string, string>();
  diagnostics: Diagnostic[] = [];
  formulas: FormulaRecord[] = [];
  codeBlocks: CodeRecord[] = [];
  visited = 0;

  note(code: string, message: string, severity: 'warning' | 'info' = 'warning'): void {
    if (!this.diagnostics.some(item => item.code === code && item.message === message)) this.diagnostics.push({ code, message, severity });
  }

  children(element: Element): Ast[] { return Array.from(element.childNodes).flatMap(node => this.visit(node)); }

  anchor(element: Element): Ast[] {
    const id = this.ids.get(element.getAttribute('id') || '');
    return id ? [{ type: 'html', value: `<a id="${id}"></a>` }] : [];
  }

  attributes(element: Element): string {
    const id = this.ids.get(element.getAttribute('id') || '');
    const dir = element.getAttribute('dir');
    return (id ? ` id="${id}"` : '') + (dir && /^(?:ltr|rtl|auto)$/.test(dir) ? ` dir="${dir}"` : '');
  }

  visit(node: Node): Ast[] {
    let result = this.captureNode(node);
    if (node.nodeType !== 1 || !result.length) return result;
    const element = node as Element;
    const dir = element.getAttribute('dir');
    if (dir && /^(?:ltr|rtl|auto)$/.test(dir) && !element.matches('math,.katex,.katex-display,[data-math-source],[data-d-component="math"],bdi,bdo,pre,code')) {
      if (element.tagName.toUpperCase() === 'P') {
        result = asBlocks(result).map(part => ({ type: 'html', block: true, value: part.type === 'paragraph'
          ? `<p dir="${dir}">${(part.children || []).map(child => this.html(child)).join('')}</p>`
          : `<div dir="${dir}">${this.html(part)}</div>` }));
      } else if (result.every(isInline)) result = [{ type: 'html', value: `<span dir="${dir}">${result.map(part => this.html(part)).join('')}</span>` }];
      else result = [{ type: 'html', block: true, value: `<div dir="${dir}">${asBlocks(result).map(part => this.html(part)).join('')}</div>` }];
    }
    return [...this.anchor(element), ...result];
  }

  captureNode(node: Node): Ast[] {
    if (++this.visited > 200_000) throw new Error('回答内容过大，请分段导出。');
    if (node.nodeType === 3) {
      const value = node.nodeValue || '';
      const preLine = node.parentElement && /^(?:pre-line|pre-wrap|break-spaces|pre)$/.test(layoutStyle(node.parentElement, 'white-space'));
      return preLine ? value.replace(/\r\n?/g, '\n').split('\n').flatMap((line, index) => [...(index ? [{ type: 'break' }] : []), text(line)]) : [text(value.replace(/[ \t\r\n]+/g, ' '))];
    }
    if (node.nodeType !== 1) return [];
    const element = node as Element;
    if (excludedContent(element)) return [];
    if (element.matches(`pre,code,kbd,samp,.cm-editor,.cm-scroller,.cm-content,.cm-line,${codeSourceSelector},${codeBlockSelector}`) && excludedCodeContent(element)) return [];
    if (element.hasAttribute('data-gpt-md-layout-incomplete')) this.note('LAYOUT_CAPTURE_LIMIT', '部分布局信息超过采集数量限额，已保留可取得的正文结构；请核对较长回答。');
    if (layoutStyle(element, 'display') === 'none' || /^(?:hidden|collapse)$/.test(layoutStyle(element, 'visibility'))) return [];
    // GPT wraps answer images in a zoom button. Keep only its image children;
    // the button's label and interaction chrome are never answer content.
    if (element.matches(messageImageButton)) {
      const images = Array.from(element.querySelectorAll('img')).filter(image => image.closest('button') === element && !image.closest(ignoreSelector));
      if (images.length) return images.flatMap(image => this.visit(image));
      this.note('IMAGE_NOT_LOADED', '有回答图片尚未提供可保存资源，已保留图片位置；请在原页加载图片后重试。');
      return [text(`[图片尚未加载：${element.getAttribute('aria-label') || '回答图片'}]`)];
    }
    const renderedCode = this.renderedCodeBlock(element);
    if (renderedCode) return [renderedCode];
    const codeMirror = this.codeMirror(element);
    if (codeMirror) return [codeMirror];
    if (element.matches(codeBlockSelector) && !ownedCodeSource(element)) {
      this.note('CODE_SOURCE_NOT_LOADED', '有代码块尚未加载，未取得源码；已保留代码位置，请在原页加载后重试。');
      // DIL widgets have an unmarked language/header skeleton; it is not prose.
      const children = element.matches('[data-d-component="code_block"]')
        ? this.codeWidgetParts(element).flatMap(part => this.visit(part))
        : asBlocks(this.children(element));
      return [...children, { type: 'paragraph', children: [text('[代码块尚未加载，未取得源码]')] }];
    }
    if (element.matches('[data-d-component="code_block"]')) {
      const source = ownedCodeSource(element);
      return this.codeWidgetParts(element, source).flatMap(part => this.visit(part));
    }
    const formula = this.formula(element);
    if (formula) return [formula];
    const attachments = this.attachments(element);
    if (attachments) return attachments;
    const layout = this.layout(element);
    if (layout) return layout;
    const component = this.component(element);
    if (component) return component;
    const tag = element.tagName.toUpperCase();
    if (tag === 'PRE') { const code = this.code(element); return code ? [code] : []; }
    if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') {
      const source = tag === 'CODE' ? element.closest(codeSourceSelector) : null;
      if (source && ownsCodeDescendant(source, element)) {
        const code = this.code(element, this.language([source]) || this.codeHeaderLanguage(source.closest(codeBlockSelector), source));
        return code ? [code] : [];
      }
      if (tag === 'CODE' && layoutStyle(element, 'display') === 'block' && !element.closest('p,h1,h2,h3,h4,h5,h6')) {
        const code = this.code(element);
        return code ? [code] : [];
      }
      const value = codeText(element);
      if (/[\r\n]/.test(value)) {
        this.note('MULTILINE_INLINE_CODE', '多行行内代码已以安全 HTML 保留段落位置和内部换行，阅读器需支持对应格式。');
        return [{ type: 'html', value: inlineCodeMarkup(value) }];
      }
      return [{ type: 'inlineCode', value }];
    }
    if (tag === 'BR') return [{ type: 'break' }];
    if (tag === 'HR') return [{ type: 'thematicBreak' }];
    if (tag === 'IMG') {
      const url = safeUrl(element.getAttribute('src') || element.getAttribute('data-src') || '', element);
      const alt = element.getAttribute('alt') || '';
      if (!url) { this.note('IMAGE_SOURCE_MISSING', '有图片缺少可保存的链接，已保留替代文字。'); return [text(alt || '[图片链接不可用]')]; }
      if (element.hasAttribute('data-gpt-md-diagram-image')) {
        const width = Math.min(1200, Math.max(1, Number(element.getAttribute('width')) || 600));
        const height = Math.min(1200, Math.max(1, Number(element.getAttribute('height')) || 400));
        return [{ type: 'html', value: `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" width="${width}" height="${height}" style="max-width:100%;height:auto">`, block: true }];
      }
      return [{ type: 'image', url, alt, title: element.getAttribute('title') || null }];
    }
    if (tag === 'TABLE') return this.table(element);
    if (tag === 'UL' || tag === 'OL') {
      const items = Array.from(element.children).filter(child => child.tagName.toUpperCase() === 'LI' && !excludedContent(child) && layoutStyle(child, 'display') !== 'none');
      const children = items.map(item => {
        const checkbox = Array.from(item.querySelectorAll('input[type="checkbox"]')).find(input => input.closest('li') === item) as HTMLInputElement | undefined;
        const blocks = asBlocks(this.children(item));
        const dir = /^(?:ltr|rtl|auto)$/.test(item.getAttribute('dir') || '') ? item.getAttribute('dir') : null;
        return { type: 'listItem', checked: checkbox ? checkbox.checked : null, dir, spread: blocks.length > 1, children: [...this.anchor(item), ...blocks] };
      });
      const list = {
        type: 'list', ordered: tag === 'OL', start: tag === 'OL' ? Number(element.getAttribute('start') || 1) : null,
        spread: children.some(item => item.spread), children,
      };
      return children.some(item => item.dir) ? [{ type: 'html', block: true, value: this.html(list) }] : [list];
    }
    if (tag === 'BLOCKQUOTE') return [{ type: 'blockquote', children: asBlocks(this.children(element)) }];
    if (/^H[1-6]$/.test(tag)) {
      const converted = asBlocks(this.children(element));
      return converted.map(part => part.type === 'paragraph' ? { type: 'heading', depth: Number(tag[1]), children: part.children } : part);
    }
    if (tag === 'P') {
      const blocks = asBlocks(this.children(element));
      if (Array.from(element.children).some(child => child.tagName.toUpperCase() === 'SPAN' && layoutStyle(child, 'display') === 'block')
        && blocks.every(part => part.type === 'paragraph')) {
        return [{ type: 'paragraph', children: blocks.flatMap((part, index) => [...(index ? [{ type: 'break' }] : []), ...(part.children || [])]) }];
      }
      return blocks;
    }
    if (tag === 'DL') return [{ type: 'html', block: true, value: `<dl>${this.definitionChildren(element)}</dl>` }];
    if (['RUBY', 'RT', 'RP', 'BDI', 'BDO', 'MARK'].includes(tag)) {
      const direction = /^(?:ltr|rtl|auto)$/.test(element.getAttribute('dir') || '') ? ` dir="${element.getAttribute('dir')}"` : '';
      return [{ type: 'html', value: `<${tag.toLowerCase()}${direction}>${this.children(element).map(part => this.html(part)).join('')}</${tag.toLowerCase()}>` }];
    }
    const children = this.children(element);
    if (tag === 'STRONG' || tag === 'B') return this.inlineWrapper('strong', children);
    if (tag === 'EM' || tag === 'I') return this.inlineWrapper('emphasis', children);
    if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return this.inlineWrapper('delete', children);
    if (tag === 'A') {
      const href = element.getAttribute('href') || '';
      const fragment = localFragment(href, element);
      const url = fragment !== null ? `#${this.ids.get(fragment) || encodeURIComponent(fragment)}` : safeUrl(href, element);
      if (!url) { this.note('LINK_UNAVAILABLE', '有链接缺失或使用不支持的协议，已保留文字。'); return children; }
      return this.link(children, url, element.getAttribute('title') || null);
    }
    if (tag === 'SUP' || tag === 'SUB' || tag === 'U' || tag === 'INS') {
      return [{ type: 'html', value: `<${tag.toLowerCase()}>` }, ...children, { type: 'html', value: `</${tag.toLowerCase()}>` }];
    }
    if (tag === 'CANVAS' || tag === 'IFRAME' || tag === 'OBJECT' || tag === 'VIDEO' || tag === 'AUDIO' || tag === 'SVG') {
      this.note('UNSUPPORTED_EMBED', '有嵌入内容不能从当前页面取得源码，已保留说明。');
      return [text(element.getAttribute('aria-label') || `[${tag.toLowerCase()} 内容未导出]`)];
    }
    if (tag === 'SPAN' && /^(?:block|flex|grid|list-item)$/.test(layoutStyle(element, 'display'))) return asBlocks(children);
    if (blockTags.has(tag)) return asBlocks(children);
    return children;
  }

  definitionChildren(element: Element): string {
    return Array.from(element.children).map(child => {
      if (child.matches(ignoreSelector) || layoutStyle(child, 'display') === 'none') return '';
      const tag = child.tagName.toLowerCase();
      if (tag === 'dt' || tag === 'dd') return `<${tag}${this.attributes(child)}>${asBlocks(this.children(child)).map(part => this.html(part)).join('')}</${tag}>`;
      return this.definitionChildren(child);
    }).join('');
  }

  layout(element: Element): Ast[] | null {
    if (!element.matches('div,section,article,aside,main') || element.matches('[data-d-inline]')) return null;
    const columns = layoutColumns(element);
    if (columns < 0) return null;
    const direct = Array.from(element.children).filter(child => !child.matches(ignoreSelector) && layoutStyle(child, 'display') !== 'none');
    if (direct.length < 2 || direct.length > 96 || Array.from(element.childNodes).some(child => child.nodeType === 3 && /\S/.test(child.nodeValue || ''))) return null;
    const blocks = direct.filter(child => child.matches('div,section,article,aside,p,figure,ul,ol,dl,[data-d-component="box"]'));
    const dilRow = element.getAttribute('data-d-component') === 'row';
    const compactIconText = direct.length === 2 && direct.some(child => child.getAttribute('data-d-component') === 'icon')
      && direct.some(child => child.matches('[data-d-component="text"],[data-d-component="title"]'));
    if (blocks.length < 2 && (!dilRow || compactIconText)) return null;
    const plainRow = dilRow && (blocks.length < 2 || !direct.every(child => child.matches('[data-d-component="box"],[data-d-component="icon"]')));
    const meterRow = plainRow && direct.some(child => meterMarkup(child) !== null);
    const ordered = direct.map((child, index) => ({ child, index, order: Number(layoutStyle(child, 'order')) || 0 })).sort((a, b) => a.order - b.order || a.index - b.index);
    if (layoutStyle(element, 'flex-direction') === 'row-reverse') ordered.reverse();
    if (dilRow && direct.some(child => child.getAttribute('data-d-component') === 'badge')
      && direct.every(child => child.matches('[data-d-component="text"],[data-d-component="title"],[data-d-component="badge"]'))) {
      return [{ type: 'html', block: true, value: `<div class="gpt-md-inline-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:100%">${ordered.flatMap(({ child }) => asBlocks(this.visit(child))).map(part => this.html(part)).join('')}</div>` }];
    }
    let width = columns || ordered.length;
    type Position = { child: Element; row: number; column: number; rowspan: number; colspan: number };
    let positions: Position[] = ordered.map(({ child }, index) => ({ child, row: Math.floor(index / width) + 1, column: index % width + 1, rowspan: 1, colspan: 1 }));
    const explicit = columns > 0 && direct.some(child => ['grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end'].some(name => {
      const value = layoutStyle(child, name as 'grid-row-start'); return !!value && value !== 'auto';
    }));
    if (explicit) {
      const occupied = new Set<string>();
      const line = (child: Element, name: 'grid-row-start' | 'grid-column-start') => {
        const value = layoutStyle(child, name); return /^\d{1,2}$/.test(value) && Number(value) >= 1 ? Number(value) : 0;
      };
      const span = (child: Element, name: 'grid-row-end' | 'grid-column-end', start: number) => {
        const value = layoutStyle(child, name);
        if (!value || value === 'auto') return 1;
        const match = /^span\s+(\d{1,2})$/.exec(value);
        return match ? Number(match[1]) : /^\d{1,2}$/.test(value) ? Number(value) - start : 0;
      };
      let valid = true;
      positions = ordered.map(({ child }) => {
        const row = line(child, 'grid-row-start'), column = line(child, 'grid-column-start');
        const rowspan = span(child, 'grid-row-end', row), colspan = span(child, 'grid-column-end', column);
        if (!row || !column || rowspan < 1 || colspan < 1 || row + rowspan > 25 || column + colspan > 25) { valid = false; return { child, row, column, rowspan, colspan }; }
        for (let y = row; y < row + rowspan; y++) for (let x = column; x < column + colspan; x++) {
          const key = `${y}:${x}`; if (occupied.has(key)) valid = false; occupied.add(key);
        }
        return { child, row, column, rowspan, colspan };
      });
      if (!valid) {
        this.note('LAYOUT_POSITION_FALLBACK', '网格包含命名、自动混排、重叠或超限定位，未推测视觉顺序；已按正文顺序保留内容，请核对原页布局。');
        return null;
      }
      width = Math.max(width, ...positions.map(position => position.column + position.colspan - 1));
    }
    const starts = new Map(positions.map(position => [`${position.row}:${position.column}`, position]));
    const covered = new Set<string>();
    for (const position of positions) for (let y = position.row; y < position.row + position.rowspan; y++) for (let x = position.column; x < position.column + position.colspan; x++) covered.add(`${y}:${x}`);
    const rows: string[] = [];
    const height = Math.max(...positions.map(position => position.row + position.rowspan - 1));
    for (let row = 1; row <= height; row++) {
      let cells = '';
      for (let column = 1; column <= width; column++) {
        const position = starts.get(`${row}:${column}`);
        if (!position) { if (!covered.has(`${row}:${column}`)) cells += '<td></td>'; continue; }
        const { child, rowspan, colspan } = position;
        const connector = child.getAttribute('data-d-component') === 'icon';
        const highlight = highlightedCard(child);
        const align = contentAlignment(child) || (plainRow ? 'left' : 'center');
        const className = plainRow ? 'gpt-md-plain-cell' : connector ? 'gpt-md-connector' : 'gpt-md-card' + (highlight ? ' gpt-md-highlight' : '');
        const columnWidth = plainRow ? fixedColumnWidth(child) : null;
        const widthAttribute = columnWidth ? ` width="${columnWidth}"` : '';
        const fixedStyle = plainRow ? `border:0;padding:${meterRow ? '0 2px' : '4px'};vertical-align:middle;text-align:${align}${columnWidth ? `;width:${columnWidth}px` : ''}`
          : connector ? 'border:0;width:28px;text-align:center;vertical-align:middle;padding:2px' : `border:0;border-radius:8px;text-align:${align};vertical-align:middle;padding:8px;background:${highlight ? '#e0efea' : '#f6f8fa'}`;
        const content = asBlocks(this.visit(child)).map(part => meterRow && part.type === 'paragraph'
          ? `<p style="margin:0;line-height:1.4">${(part.children || []).map(child => this.html(child)).join('')}</p>` : this.html(part)).join('');
        cells += `<td class="${className}" align="${align}"${widthAttribute}${attrSpan('rowspan', rowspan)}${attrSpan('colspan', colspan)} style="${fixedStyle}">${content}</td>`;
      }
      rows.push(`<tr>${cells}</tr>`);
    }
    this.note('LAYOUT_AS_TABLE', '横向或网格分组已以 HTML 表格保留；采用文档样式重新排版，阅读器需支持 HTML。', 'info');
    return [{ type: 'html', block: true, value: `<div class="gpt-md-layout-scroll" style="max-width:100%;overflow-x:auto${meterRow ? ';margin:0' : ''}"><table class="gpt-md-layout${plainRow ? ' gpt-md-plain-row' : ''}${meterRow ? ' gpt-md-meter-row' : ''}" style="width:100%;table-layout:fixed;border-collapse:separate;border-spacing:${meterRow ? '0' : plainRow ? '2' : '8'}px"><tbody>${rows.join('')}</tbody></table></div>` }];
  }

  inlineWrapper(type: string, children: Ast[]): Ast[] {
    if (children.some(child => !isInline(child))) return children;
    return children.length ? [{ type, children }] : [];
  }

  link(children: Ast[], url: string, title: string | null = null, label = '打开链接'): Ast[] {
    const link = (content: Ast[]): Ast => ({ type: 'link', url, title, children: content.length ? content : [text(label)] });
    if (children.every(isInline)) return [link(children)];
    // Markdown links cannot wrap block content. Retain the card's blocks and
    // provide its known destination as a separate portable link.
    return [...children, { type: 'paragraph', children: [link([text(label)])] }];
  }

  attachmentRow(element: Element): AttachmentRow | null {
    if (element.tagName.toUpperCase() !== 'SPAN') return null;
    const labels = Array.from(element.querySelectorAll('span[title]')).filter(label => {
      const name = label.getAttribute('title')?.trim();
      return !!name && label.textContent?.trim() === name && /\.[a-z0-9]{1,12}$/i.test(name);
    });
    if (labels.length !== 1) return null;
    const label = labels[0]; const name = label.getAttribute('title')!.trim();
    const preview = element.firstElementChild;
    if (preview?.tagName.toUpperCase() !== 'BUTTON' || !preview.getAttribute('aria-label')?.includes(name)
      || !/(?:预览|preview)/i.test(preview.getAttribute('aria-label') || '')) return null;
    if (!Array.from(element.querySelectorAll('button[aria-label]')).some(button => /^(?:下载文件|download file)$/i.test(button.getAttribute('aria-label') || ''))) return null;
    const metadata = label.nextElementSibling;
    const kind = metadata?.tagName.toUpperCase() === 'SPAN' && metadata.firstElementChild?.tagName.toUpperCase() === 'SPAN'
      ? metadata.firstElementChild.textContent?.trim() || '' : '';
    if (!kind || kind.length > 64 || /[\r\n]/.test(kind)) return null;
    const link = element.querySelector('a[href]');
    return { name, kind, url: link ? safeUrl(link.getAttribute('href') || '', link) : null };
  }

  attachments(element: Element): Ast[] | null {
    if (element.tagName.toUpperCase() !== 'DIV' || !element.childElementCount) return null;
    const children = Array.from(element.children);
    if (children.some(child => child.tagName.toUpperCase() !== 'SPAN')
      || Array.from(element.childNodes).some(child => child.nodeType === 3 && /\S/.test(child.nodeValue || ''))) return null;
    const rows = children.map(child => this.attachmentRow(child));
    if (rows.some(row => !row)) return null;
    const files = rows as AttachmentRow[];
    if (files.some(file => !file.url)) this.note('ATTACHMENT_LINK_UNAVAILABLE', '附件文件行已保留，但页面只提供交互按钮，未提供可确认的下载地址；请在原对话打开附件。');
    const cell = (nodes: Ast[]): Ast => ({ type: 'tableCell', children: nodes });
    return [{ type: 'table', align: [null, null, null], children: [
      { type: 'tableRow', children: ['文件', '类型', '入口'].map(value => cell([text(value)])) },
      ...files.map(file => ({ type: 'tableRow', children: [
        cell([text(file.name)]), cell([text(file.kind)]),
        cell([file.url ? { type: 'link', url: file.url, children: [text('打开文件')] } : text('请在原对话打开')]),
      ] })),
    ] }];
  }

  component(element: Element): Ast[] | null {
    const component = element.getAttribute('data-d-component');
    if (!component) return null;
    if (component === 'divider') return [{ type: 'thematicBreak' }];
    if (component === 'badge') {
      const color = element.getAttribute('data-color');
      const tone = color && ['success', 'warning', 'danger'].includes(color) ? ` gpt-md-badge-${color}` : '';
      const parts = this.children(element);
      if (!parts.every(part => isInline(part) || (part.type === 'paragraph' && part.children?.every(isInline)))) {
        this.note('BADGE_BLOCK_CONTENT', '徽标包含独立块内容，已按内容组保留，避免将代码或表格塞入行内标记。', 'info');
        return [{ type: 'html', block: true, value: `<div class="gpt-md-group">${asBlocks(parts).map(part => this.html(part)).join('')}</div>` }];
      }
      const inline = parts.flatMap((part, index) => [
        ...(index && (part.type === 'paragraph' || parts[index - 1].type === 'paragraph') ? [text(' ')] : []),
        ...(part.type === 'paragraph' ? part.children || [] : [part]),
      ]);
      return [{ type: 'html', value: `<span class="gpt-md-badge${tone}">${inline.map(part => this.html(part)).join('')}</span>` }];
    }
    if (component === 'text' || component === 'caption') {
      let children = this.children(element);
      if (element.hasAttribute('data-d-default-strong') || /^(?:bold|semibold)$/.test(element.getAttribute('data-d-weight') || '')) children = this.inlineWrapper('strong', children);
      const classes = [];
      if (/^(?:2xs|xs|sm)$/.test(element.getAttribute('data-d-size') || '') || component === 'caption') classes.push('gpt-md-small');
      if (component === 'caption' || /secondary/.test((element as HTMLElement).style?.color || '')) classes.push('gpt-md-muted');
      if (element.getAttribute('data-d-weight') === 'medium') classes.push('gpt-md-medium');
      if (classes.length && children.every(isInline)) children = [{ type: 'html', value: `<span class="${classes.join(' ')}">${children.map(part => this.html(part)).join('')}</span>` }];
      if (element.tagName.toUpperCase() === 'P' || component === 'caption') return asBlocks(children);
      return children;
    }
    if (component === 'icon') {
      const raster = element.querySelector('img[data-gpt-md-icon-image]');
      const source = raster?.getAttribute('src') || '';
      if (/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(source)) {
        const label = raster?.getAttribute('alt') || element.getAttribute('aria-label') || '图标';
        return [{ type: 'html', value: `<img src="${escapeHtml(source)}" alt="${escapeHtml(label)}" width="20" height="20">` }];
      }
      // The page's D renderer supplies vector paths, not portable icon names.
      // Link arrows are decorative; accessible labels can retain other meaning.
      if (element.closest('[data-d-component="pressable"][role="link"]')) return [];
      const label = element.getAttribute('aria-label')?.trim() || element.querySelector('title')?.textContent?.trim();
      if (label) return [text(`[图标：${label}]`)];
      this.note('ICON_LABEL_UNAVAILABLE', '有图标没有可确认的文字标注，已保留图标位置，未猜测其形状或功能。', 'info');
      return [text('[图标] ')];
    }
    if (component === 'pressable' && element.getAttribute('role') === 'link') {
      const children = this.children(element);
      const href = element.getAttribute('href');
      const url = href ? safeUrl(href, element) : null;
      if (url) return this.link(children, url, null, element.getAttribute('aria-label')?.replace(/^Open\s+/, '') || '打开链接');
      this.note('LINK_TARGET_UNAVAILABLE', '有交互入口没有可确认的可移植链接，已保留文字；请在原对话中打开，未推测附件下载地址。');
      return children.length ? children : [text(element.getAttribute('aria-label')?.replace(/^Open\s+/, '') || '[原对话入口]')];
    }
    if (component === 'image' && element.tagName.toUpperCase() !== 'IMG'
      && !element.querySelector('img[src],img[data-src]')) {
      this.note('IMAGE_NOT_LOADED', '有图片仍是加载占位，当前页面未提供可保存的图片资源；请先让图片在原页完成加载。');
      return [{ type: 'paragraph', children: [text('[图片尚未加载，未取得可保存资源]')] }];
    }
    if ((component === 'box' || component === 'row') && !element.hasAttribute('data-d-inline')) {
      const meter = meterMarkup(element);
      if (meter) return [{ type: 'html', block: true, value: meter }];
      const converted = this.children(element);
      if (component === 'row' && !element.hasAttribute('data-d-has-border')) {
        const direct = Array.from(element.children).filter(child => !child.matches(ignoreSelector));
        const iconCount = direct.filter(child => child.getAttribute('data-d-component') === 'icon').length;
        const textCount = direct.filter(child => child.matches('[data-d-component="text"],[data-d-component="title"]')).length;
        const looseText = Array.from(element.childNodes).some(child => child.nodeType === 3 && /\S/.test(child.nodeValue || ''));
        const blocks = converted.filter(child => !isInline(child));
        if (direct.length === 2 && iconCount === 1 && textCount === 1 && !looseText
          && blocks.length === 1 && ['paragraph', 'heading'].includes(blocks[0].type)) {
          const block = blocks[0];
          return [{ ...block, children: converted.flatMap(child => child === block ? child.children || [] : [child]) }];
        }
      }
      const children = asBlocks(converted);
      // Cards are presentation groups, not quotations. Rebuild a bounded
      // document-owned wrapper rather than flattening their visual hierarchy.
      if (component === 'box' || element.getAttribute('data-d-justify') === 'center') {
        const attributes = groupAttributes(element);
        const styledBox = element.hasAttribute('data-d-direction') || element.hasAttribute('data-d-has-border')
          || /^(?:inline-)?(?:flex|grid)$/.test(layoutStyle(element, 'display'))
          || /[1-9]/.test(layoutStyle(element, 'gap')) || contentAlignment(element) !== null || attributes.includes('gpt-md-surface') || attributes.includes('gpt-md-bordered');
        if (component === 'box' && !styledBox) return children;
        const centered = component === 'row' ? ' class="gpt-md-align-center" style="text-align:center"' : '';
        return children.length ? [{ type: 'html', block: true, value: component === 'row'
          ? `<div${centered}>${children.map(child => this.html(child)).join('')}</div>`
          : `<div ${attributes}>${children.map(child => this.html(child)).join('')}</div>` }] : [];
      }
      return children;
    }
    return null;
  }

  formula(element: Element): Ast | null {
    if (!element.matches('[data-math-source],.katex-display,.katex,math,[role="math"]')) return null;
    // A code fence containing TeX is still code, not a rendered formula.
    if (element.closest('pre,code') && !element.matches('math,[role="math"]')) return null;
    const attributeHost = element.hasAttribute('data-math-source') ? element : element.closest('[data-math-source]');
    const own = element.getAttribute('data-math-source');
    const inherited = attributeHost?.getAttribute('data-math-source');
    const annotation = element.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    const present = (value: string | null | undefined): value is string => !!value?.trim();
    const rawSource = [own, inherited, annotation].find(present) || '';
    const sourceKind: FormulaRecord['sourceKind'] = present(own) || present(inherited) ? 'attribute' : present(annotation) ? 'annotation' : 'missing';
    const declared = (element.getAttribute('data-math-type') || element.getAttribute('data-display') || element.getAttribute('data-math-display') || '').trim().toLowerCase();
    const declaredDisplay = /^(?:block|display|true)$/.test(declared) ? true : /^(?:inline|false)$/.test(declared) ? false : undefined;
    const blockLayout = element.matches('.katex-display,.math-display') || !!element.closest('.katex-display,.math-display') || element.getAttribute('display') === 'block';
    // Explicit false overrides an inner MathML hint, but never an actual
    // display wrapper. A single-line block must not rely on a newline fallback.
    let display = blockLayout || (declaredDisplay ?? !!element.querySelector('math[display="block"]'));
    if (!display && element.getAttribute('role') === 'math') display = (element as HTMLElement).style?.display === 'block';
    if (!rawSource) {
      const native = element.localName === 'math' ? element : element.querySelector('math');
      if (native) {
        try {
          const markup = serializeNativeMathML(native);
          this.formulas.push({ rawSource: markup, tex: '', display, sourceKind: 'mathml' });
          this.note('MATHML_SOURCE_PRESERVED', '有公式使用原生 MathML 保存数学结构；页面未提供 TeX，未推测或改写为 LaTeX。', 'info');
          return { type: 'html', value: markup, block: display };
        } catch {
          const source = originalMathMarkup(native);
          this.formulas.push({ rawSource: source, tex: '', display, sourceKind: 'mathml' });
          this.note('MATHML_SOURCE_REJECTED', '有数学结构超出安全支持范围，已将原标记保留为代码，未展平为可能改变含义的文字。');
          return { type: display ? 'code' : 'inlineCode', lang: display ? 'xml' : undefined, value: source };
        }
      }
      const visual = element.querySelector('.katex-html')?.textContent || this.mathVisibleText(element) || element.getAttribute('aria-label');
      this.formulas.push({ rawSource: '', tex: '', display, sourceKind: 'missing' });
      this.note('MATH_SOURCE_MISSING', '有公式没有可确认的 TeX 源码，已保留显示文字；无障碍标签未被当作 LaTeX。');
      const value = `[公式源码缺失]${visual ? ` ${visual}` : ''}`;
      return display ? { type: 'paragraph', children: [text(value)] } : text(value);
    }
    const unwrapped = sourceWithoutDelimiters(rawSource);
    if (unwrapped.stripped) {
      this.note('MATH_DELIMITER_UNWRAPPED', '公式属性中的外层数学定界符已识别；捕获原串保留在本次预览诊断数据中。', 'info');
      display = unwrapped.display ?? display;
    }
    const tex = unwrapped.tex;
    const alternatives = [own, inherited, annotation].filter(present).map(value => sourceWithoutDelimiters(value).tex);
    if (new Set(alternatives).size > 1) this.note('MATH_SOURCE_CONFLICT', '公式源码属性和 TeX 标注不一致，优先采用源码属性；请在预览中核对。');
    this.formulas.push({ rawSource, tex, display, sourceKind });
    if (/\r/.test(tex)) this.note('MATH_LINE_ENDINGS', '公式含回车字符；原串保留，但外部 Markdown 阅读器可能规范化换行。');
    if (!display && /[\r\n]/.test(tex)) {
      this.note('MATH_MULTILINE_DISPLAY', '含换行的行内公式已使用块公式保存，以保留内部换行；显示布局有所变化。');
      return { type: 'math', value: tex };
    }
    return { type: display ? 'math' : 'inlineMath', value: tex };
  }

  mathVisibleText(element: Element): string {
    const clone = element.cloneNode(true) as Element;
    clone.querySelectorAll('annotation,annotation-xml,script,style').forEach(node => node.remove());
    return clone.textContent || '';
  }

  codeMirror(element: Element): Ast | null {
    let content: Element | null = null;
    if (element.matches('.cm-content,.cm-line')) content = element;
    else if (element.matches(`pre,.cm-editor,.cm-scroller,[data-markdown-copy="code-block"],${codeSourceSelector}`)) {
      const contents = Array.from(element.querySelectorAll('.cm-content')).filter(candidate => ownsCodeDescendant(element, candidate));
      // Do not collapse two distinct editors into one apparent code block.
      const sourceOnly = (node: Node): boolean => {
        if (node === contents[0]) return true;
        if (node.nodeType === 3) return !/\S/.test(node.nodeValue || '');
        if (node.nodeType !== 1) return true;
        const child = node as Element;
        if (excludedCodeContent(child) || child.matches('.cm-gap')) return true;
        return Array.from(child.childNodes).every(sourceOnly);
      };
      if (contents.length === 1 && sourceOnly(element)) content = contents[0];
    } else {
      const directChildren = Array.from(element.children).filter(child => !excludedCodeContent(child));
      const lines = directChildren.filter(child => child.matches('.cm-line'));
      const hasOtherContent = directChildren.some(child => !child.matches('.cm-line,.cm-gap'));
      const hasLooseText = Array.from(element.childNodes).some(node => node.nodeType === 3 && /\S/.test(node.nodeValue || ''));
      if (lines.length && !hasOtherContent && !hasLooseText) content = element;
    }
    if (!content || excludedCodeContent(content) || content.querySelector(codeBlockSelector)) return null;
    if (Array.from(content.querySelectorAll('.cm-gap')).some(gap => ownsCodeDescendant(content!, gap) && !excludedCodeContent(gap))) {
      this.note('CODE_SOURCE_INCOMPLETE', '有代码编辑器仅提供部分已加载行，未取得全部源码；已保留当前可读取的代码，请在原页完整加载后重试。');
    }
    const language = this.language([
      content, element, content.closest('.cm-editor'), content.closest('[data-markdown-copy="code-block"]'),
    ]) || this.codeHeaderLanguage(content.closest(codeBlockSelector), content);
    const codes = ownedCodeElements(content);
    if (codes.length) return this.code(content, language);
    const lines = content.matches('.cm-line') ? [content] : Array.from(content.querySelectorAll('.cm-line')).filter(line =>
      ownsCodeDescendant(content!, line) && !excludedCodeContent(line)
      && !line.parentElement?.closest('.cm-line')
      && (!content!.matches('.cm-content') || line.closest('.cm-content') === content));
    const value = lines.length ? lines.map(codeLineText).join('\n') : codeText(content, true);
    this.codeBlocks.push({ text: value, language });
    if (/\r/.test(value)) this.note('CODE_LINE_ENDINGS', '代码含回车字符，外部 Markdown 阅读器可能规范化为 LF。');
    return { type: 'code', lang: language, value };
  }

  language(elements: Array<Element | null>): string | null {
    for (const element of elements) {
      if (!element || excludedCodeContent(element)) continue;
      const explicit = element.getAttribute('data-language');
      const className = element.getAttribute('class')?.match(/(?:^|\s)language-([^\s]+)/)?.[1];
      const candidate = explicit || className;
      if (candidate && /^[\w.+#-]+$/.test(candidate)) return candidate;
    }
    return null;
  }

  codeHeaderLanguage(block: Element | null, source: Element): string | null {
    if (!block) return null;
    const explicit = this.language([block]);
    if (explicit) return explicit;
    const hidden = (element: Element): boolean => {
      for (let current: Element | null = element; current && current !== block; current = current.parentElement) {
        if (current.matches('[hidden],[inert],[aria-hidden="true"],[data-gpt-md-ignore]')
          || layoutStyle(current, 'display') === 'none' || /^(?:hidden|collapse)$/.test(layoutStyle(current, 'visibility'))) return true;
      }
      return false;
    };
    const header = Array.from(block.children).find(child => child.matches('[data-markdown-copy="exclude"]'));
    if (header && !hidden(header) && Array.from(header.querySelectorAll('[data-code-block-controls="true"]')).some(control => ownsCodeDescendant(block, control) && !hidden(control))) {
      const labels = Array.from(header.children).filter(child => child.tagName.toUpperCase() === 'DIV'
        && !child.childElementCount && !child.hasAttribute('data-code-block-controls') && !hidden(child));
      const label = labels.length === 1 ? labels[0].textContent?.trim() : null;
      if (label && /^[\w.+#-]+$/.test(label)) return label.toLowerCase();
    }
    if (!block.matches('[data-d-component="code_block"]')) return null;
    // Observed DIL headers pair a plain language label with their own Copy button.
    // Never borrow prose elsewhere in the widget or outside its source owner.
    const labelText = (element: Element): string | null => {
      if (!element.matches('div,span') || excludedCodeContent(element)) return null;
      const read = (node: Node): string | null => {
        if (node.nodeType === 3) return node.nodeValue || '';
        if (node.nodeType !== 1) return '';
        const child = node as Element;
        if (excludedCodeContent(child)) return '';
        if (!child.matches('span')) return null;
        const parts = Array.from(child.childNodes).map(read);
        return parts.some(part => part === null) ? null : parts.join('');
      };
      const parts = Array.from(element.childNodes).map(read);
      const label = parts.some(part => part === null) ? '' : parts.join('').trim();
      return /^[\w.+#-]+$/.test(label) ? label.toLowerCase() : null;
    };
    for (const button of block.querySelectorAll('button[aria-label]')) {
      if (!ownsCodeDescendant(block, button) || hidden(button) || !/^(?:复制(?:代码)?|copy(?: code)?)$/i.test(button.getAttribute('aria-label')?.trim() || '')) continue;
      for (let container = button.parentElement; container && container !== block && !container.contains(source); container = container.parentElement) {
        const candidates = Array.from(container.children).filter(child => !child.contains(button) && !hidden(child));
        const labels = candidates.map(labelText).filter((label): label is string => label !== null);
        if (labels.length === 1 && candidates.length === 1) return labels[0];
      }
    }
    return null;
  }

  codeWidgetParts(block: Element, source?: Element): Element[] {
    const candidates = [...(source ? [source] : []), ...Array.from(block.querySelectorAll(`${codeBlockSelector},p,blockquote,ul,ol,table,h1,h2,h3,h4,h5,h6`)).filter(part =>
      !source?.contains(part) && (part.matches(codeBlockSelector)
        ? part.parentElement?.closest(codeBlockSelector) === block : ownsCodeDescendant(block, part)))];
    return candidates.filter(part => !candidates.some(parent => parent !== part && parent.contains(part)))
      .sort((left, right) => left.compareDocumentPosition(right) & 2 ? 1 : -1);
  }

  renderedCodeBlock(element: Element): Ast | null {
    // Source semantics do not depend on a header or on containing multiple lines.
    if (element.matches(codeSourceSelector)) {
      if (element.querySelector(codeBlockSelector)) return null;
      return this.codeMirror(element) || this.code(element, this.codeHeaderLanguage(element.closest(codeBlockSelector), element));
    }
    if (element.matches('[data-d-component="code_block"]')) {
      if (element.querySelector(codeBlockSelector)) return null;
      const source = ownedCodeSource(element);
      if (this.codeWidgetParts(element, source).some(part => part !== source)) return null;
      return source && !excludedCodeContent(source)
        ? this.codeMirror(source) || this.code(source, this.codeHeaderLanguage(element, source)) : null;
    }
    // The current GPT renderer puts the language beside PRE instead of on CODE.
    // Require its code-control marker and an otherwise self-contained block so
    // an ordinary paragraph that happens to precede code stays ordinary prose.
    const children = Array.from(element.children);
    const pre = children.find(child => child.tagName.toUpperCase() === 'PRE');
    if (!pre?.querySelector('code') || !children.some(child => child.hasAttribute('data-message-content-controls'))) return null;
    const label = pre.previousElementSibling;
    const language = label?.tagName.toUpperCase() === 'SPAN' && !label.childElementCount && !label.matches(ignoreSelector) ? label.textContent?.trim() : null;
    if (!language || !/^[\w.+#-]+$/.test(language)) return null;
    if (children.some(child => child !== pre && child !== label && !child.matches(ignoreSelector))) return null;
    if (Array.from(element.childNodes).some(child => child.nodeType === 3 && /\S/.test(child.nodeValue || ''))) return null;
    return this.code(pre, language);
  }

  code(element: Element, fallbackLanguage: string | null = null): Ast | null {
    if (excludedCodeContent(element)) return null;
    const codes = ownedCodeElements(element);
    const visibleCodes = codes.filter(candidate => !excludedCodeContent(candidate));
    if (codes.length && !visibleCodes.length) return null;
    const code = visibleCodes.length === 1 ? visibleCodes[0] : undefined;
    const value = codeText(code || element, true);
    const language = this.language([code || null, element, element.closest(codeSourceSelector)]) || fallbackLanguage
      || this.codeHeaderLanguage(element.closest(codeBlockSelector), element);
    this.codeBlocks.push({ text: value, language });
    if (/\r/.test(value)) this.note('CODE_LINE_ENDINGS', '代码含回车字符，外部 Markdown 阅读器可能规范化为 LF。');
    return { type: 'code', lang: language, value };
  }

  table(element: Element): Ast[] {
    const sourceRows = Array.from(element.querySelectorAll('tr')).filter(row => row.closest('table') === element && !excludedContent(row) && layoutStyle(row, 'display') !== 'none');
    const rows = sourceRows.map(row =>
      Array.from(row.children).filter(cell => /^(?:TH|TD)$/.test(cell.tagName.toUpperCase()) && !excludedContent(cell) && layoutStyle(cell, 'display') !== 'none').map(cell => ({
        header: cell.tagName.toUpperCase() === 'TH',
        colspan: Math.max(1, Number(cell.getAttribute('colspan')) || 1),
        rowspan: Math.max(1, Number(cell.getAttribute('rowspan')) || 1),
        blocks: asBlocks(this.children(cell)),
        align: (cell.getAttribute('align') || (cell as HTMLElement).style?.textAlign || '').match(/^(?:left|center|right)$/)?.[0] || null,
        scope: /^(?:row|col|rowgroup|colgroup)$/.exec(cell.getAttribute('scope') || '')?.[0] || null,
        attributes: this.attributes(cell),
      } satisfies Cell)),
    );
    if (!rows.length) return [];
    const caption = element.querySelector(':scope > caption');
    const prefix = caption ? asBlocks(this.children(caption)) : [];
    const sectionOf = (row: Element): Element | null => {
      const parent = row.parentElement;
      return parent?.parentElement === element && /^(?:THEAD|TBODY|TFOOT)$/.test(parent.tagName.toUpperCase()) ? parent : null;
    };
    const sections = Array.from(element.children).filter(child => /^(?:THEAD|TBODY|TFOOT)$/.test(child.tagName.toUpperCase()));
    const headerRows = sourceRows.filter(row => sectionOf(row)?.tagName.toUpperCase() === 'THEAD');
    const complexSections = sections.some(section => section.tagName.toUpperCase() === 'TFOOT')
      || sections.filter(section => section.tagName.toUpperCase() === 'THEAD').length > 1
      || sections.filter(section => section.tagName.toUpperCase() === 'TBODY').length > 1
      || headerRows.length > 1 || (headerRows.length === 1 && headerRows[0] !== sourceRows[0]);
    const semanticHeaders = !rows[0].every(cell => cell.header) || rows.slice(1).some(row => row.some(cell => cell.header)) || rows.some(row => row.some(cell => cell.scope));
    const needsFallback = semanticHeaders || complexSections || sourceRows.some(row => this.attributes(row)) || sections.some(section => this.attributes(section)) || rows.some(row => row.some(cell => cell.attributes || cell.colspan > 1 || cell.rowspan > 1 || cell.blocks.length > 1 || cell.blocks.some(block => block.type !== 'paragraph') || this.hasTableMathConflict(cell.blocks)));
    if (needsFallback) {
      this.note('TABLE_HTML_FALLBACK', '表格已以安全 HTML 保留行列、表头或复杂内容；公式保留可取得的 TeX 或 MathML，阅读器需支持对应格式。', 'info');
      const rowSource = new Map(rows.map((row, index) => [row, sourceRows[index]]));
      const rowHtml = (row: Cell[]): string => `<tr${this.attributes(rowSource.get(row)!)}>` + row.map(cell => {
        const tag = cell.header ? 'th' : 'td';
        return `<${tag}${cell.attributes}${attrSpan('colspan', cell.colspan)}${attrSpan('rowspan', cell.rowspan)}${cell.align ? ` align="${cell.align}"` : ''}${cell.scope ? ` scope="${cell.scope}"` : ''}>${cell.blocks.map(part => this.html(part)).join('')}</${tag}>`;
      }).join('') + '</tr>';
      const groups: Array<{ section: Element | null; rows: Cell[][] }> = [];
      rows.forEach((row, index) => {
        const section = sectionOf(sourceRows[index]);
        const previous = groups.at(-1);
        if (previous && previous.section === section) previous.rows.push(row);
        else groups.push({ section, rows: [row] });
      });
      const html = '<table>\n' + groups.map(group => {
        const content = group.rows.map(rowHtml).join('\n');
        const tag = group.section?.tagName.toLowerCase();
        return tag ? `<${tag}${this.attributes(group.section!)}>\n${content}\n</${tag}>` : content;
      }).join('\n') + '\n</table>';
      return [...prefix, { type: 'html', value: html, block: true }];
    }
    const width = Math.max(...rows.map(row => row.length));
    if (!rows[0].some(cell => cell.header)) this.note('TABLE_HEADER_INFERRED', '原表格没有显式表头，Markdown 使用第一行作表头。', 'info');
    if (rows.some(row => row.length !== width)) this.note('TABLE_ROWS_PADDED', '表格行列数不同，已补齐空单元格。', 'info');
    const children = rows.map(row => ({ type: 'tableRow', children: Array.from({ length: width }, (_, index) => ({
      type: 'tableCell', children: (row[index]?.blocks[0]?.children || []).map(part => part.type === 'break' ? { type: 'html', value: '<br>' } : part),
    })) }));
    return [...prefix, { type: 'table', align: Array.from({ length: width }, (_, index) => rows[0][index]?.align || null), children }];
  }

  hasTableMathConflict(nodes: Ast[]): boolean {
    return nodes.some(node => (node.type === 'inlineMath' && /[|\r\n]/.test(node.value || '')) || node.type === 'math' || this.hasTableMathConflict(node.children || []));
  }

  tableMath(node: Ast): string {
    const tex = node.value || '';
    const display = node.type === 'math';
    const key = `${display ? 'block' : 'inline'}:${tex}`;
    let markup = this.mathHtmlCache.get(key);
    if (tex.length <= 20_000 && this.mathHtmlCharacters < 500_000) {
      try {
        if (!markup) {
          const rendered = renderToString(tex, { output: 'mathml', displayMode: display, trust: false, throwOnError: true, strict: 'ignore', maxExpand: 1_000, maxSize: 30 });
          markup = rendered.match(/<math\b[\s\S]*<\/math>/)?.[0];
          if (!markup) throw new Error('Missing native math output');
          // A numeric character reference retains CR through an HTML parser.
          markup = markup.replace(/\r/g, '&#13;');
          if (markup.length > 200_000) throw new Error('Native math output too large');
        }
        if (this.mathHtmlCharacters + markup.length > 500_000) {
          this.mathHtmlCharacters = 500_000;
          throw new Error('Native math budget exceeded');
        }
        this.mathHtmlCache.set(key, markup);
        this.mathHtmlCharacters += markup.length;
        return markup;
      } catch { /* Keep exact, escaped TeX below when it cannot safely render. */ }
    }
    this.note('TABLE_MATH_SOURCE_FALLBACK', '有表格公式无法在安全限额内生成 MathML，已保留 LaTeX 源码；该公式在外部阅读器中可能显示为代码。');
    const code = `<code class="language-math ${display ? 'math-display' : 'math-inline'}">${escapeHtml(tex)}</code>`;
    return display ? `<pre>${code}</pre>` : code;
  }

  /** Render only our own AST and selected attributes, never page-owned outerHTML. */
  html(node: Ast): string {
    const children = node.type === 'table' ? '' : (node.children || []).map(child => this.html(child)).join('');
    const value = escapeHtml(node.value || '');
    switch (node.type) {
      case 'text': return value;
      case 'paragraph': return `<p>${children}</p>`;
      case 'strong': return `<strong>${children}</strong>`;
      case 'emphasis': return `<em>${children}</em>`;
      case 'delete': return `<del>${children}</del>`;
      case 'inlineCode': return `<code>${value}</code>`;
      case 'code': return `<pre><code${node.lang ? ` class="language-${escapeHtml(String(node.lang))}"` : ''}>${value}</code></pre>`;
      case 'inlineMath':
      case 'math': return this.tableMath(node);
      case 'break': return '<br>';
      case 'thematicBreak': return '<hr style="align-self:stretch;width:100%;border:0;border-top:1px solid #d7dce2;margin:8px 0">';
      case 'blockquote': return `<blockquote>${children}</blockquote>`;
      case 'heading': return `<h${Number(node.depth)}>${children}</h${Number(node.depth)}>`;
      case 'list': return node.ordered ? `<ol start="${Number(node.start) || 1}">${children}</ol>` : `<ul>${children}</ul>`;
      case 'listItem': return `<li${node.dir ? ` dir="${node.dir}"` : ''}>${typeof node.checked === 'boolean' ? `<input type="checkbox" disabled${node.checked ? ' checked' : ''}> ` : ''}${children}</li>`;
      case 'table': {
        const rows = node.children || [];
        const align = Array.isArray(node.align) ? node.align : [];
        const rowHtml = (row: Ast, header: boolean): string => `<tr>${(row.children || []).map((cell, index) => {
          const tag = header ? 'th' : 'td';
          const alignment = /^(?:left|center|right)$/.test(String(align[index])) ? ` align="${align[index]}"` : '';
          return `<${tag}${alignment}>${(cell.children || []).map(part => this.html(part)).join('')}</${tag}>`;
        }).join('')}</tr>`;
        return rows.length ? `<table><thead>${rowHtml(rows[0], true)}</thead><tbody>${rows.slice(1).map(row => rowHtml(row, false)).join('')}</tbody></table>` : '<table></table>';
      }
      case 'link': return `<a href="${escapeHtml(String(node.url))}">${children}</a>`;
      case 'image': return `<img src="${escapeHtml(String(node.url))}" alt="${escapeHtml(String(node.alt || ''))}">`;
      case 'html': return node.value || '';
      default: return children || value;
    }
  }
}

export function extractMarkdown(root: Element, options: { idPrefix?: string } = {}): ExportResult {
  const capture = new Capture(root, options.idPrefix || 'answer');
  // Visit the root as well: callers may supply a pre, table, or formula itself.
  const children = asBlocks(capture.visit(root));
  // CommonMark HTML blocks terminate at a blank line, including blank lines
  // inside PRE or a TeX annotation. Character references survive HTML readback
  // exactly while keeping every generated HTML atom a single Markdown line.
  const protectHtml = (nodes: Ast[]): void => {
    for (const part of nodes) {
      if (part.type === 'html' && part.value) part.value = part.value.replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
      if (part.children) protectHtml(part.children);
    }
  };
  protectHtml(children);
  const markdown = serializer.stringify({ type: 'root', children } as unknown as Root);
  return { markdown, diagnostics: capture.diagnostics, formulas: capture.formulas, codeBlocks: capture.codeBlocks };
}
