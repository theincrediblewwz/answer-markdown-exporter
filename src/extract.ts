import { unified } from 'unified';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { renderToString } from 'katex';
import type { Root } from 'mdast';
import type { CodeRecord, Diagnostic, ExportResult, FormulaRecord } from './types';

/** An internal, small mdast builder. No page-owned nodes are changed. */
interface Ast {
  type: string;
  children?: Ast[];
  value?: string;
  [key: string]: unknown;
}
interface Cell { header: boolean; colspan: number; rowspan: number; blocks: Ast[]; align: string | null; }
interface AttachmentRow { name: string; kind: string; url: string | null; }

const inlineTypes = new Set(['text', 'strong', 'emphasis', 'delete', 'inlineCode', 'inlineMath', 'link', 'image', 'break']);
const messageImageButton = 'button[data-message-image="original"][aria-haspopup="dialog"]';
const ignoreSelector = 'script,style,noscript,template,button:not([data-message-image="original"][aria-haspopup="dialog"]),input,textarea,select,[hidden],[data-gpt-md-ui],[data-gpt-md-ignore],[data-message-content-controls],[data-markdown-copy="exclude"],h4[data-conversation-role="assistant"][tabindex="-1"]:not([data-d-component]),[role="toolbar"],[aria-hidden="true"]';
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
function codeText(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue || '';
  if (node.nodeType !== 1) return '';
  if ((node as Element).tagName.toUpperCase() === 'BR') return '\n';
  return Array.from(node.childNodes).map(codeText).join('');
}
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

class Capture {
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

  visit(node: Node): Ast[] {
    if (++this.visited > 200_000) throw new Error('回答内容过大，请分段导出。');
    if (node.nodeType === 3) return [text((node.nodeValue || '').replace(/[ \t\r\n]+/g, ' '))];
    if (node.nodeType !== 1) return [];
    const element = node as Element;
    if (element.matches(ignoreSelector)) return [];
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
    if (element.matches('[data-code-block="true"][data-markdown-copy="code-block"]')
      && !element.querySelector('[data-code-block-source="true"] code,pre code')) {
      this.note('CODE_SOURCE_NOT_LOADED', '有代码块尚未加载，未取得源码；已保留代码位置，请在原页加载后重试。');
      return [...asBlocks(this.children(element)), { type: 'paragraph', children: [text('[代码块尚未加载，未取得源码]')] }];
    }
    const formula = this.formula(element);
    if (formula) return [formula];
    const attachments = this.attachments(element);
    if (attachments) return attachments;
    const component = this.component(element);
    if (component) return component;
    const tag = element.tagName.toUpperCase();
    if (tag === 'PRE') return [this.code(element)];
    if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') {
      const value = codeText(element);
      if (/[\r\n]/.test(value)) {
        this.note('MULTILINE_INLINE_CODE', '多行行内代码已保留为代码块，避免 Markdown 折叠内部换行。');
        this.codeBlocks.push({ text: value, language: null });
        return [{ type: 'code', lang: null, value }];
      }
      return [{ type: 'inlineCode', value }];
    }
    if (tag === 'BR') return [{ type: 'break' }];
    if (tag === 'HR') return [{ type: 'thematicBreak' }];
    if (tag === 'IMG') {
      const url = safeUrl(element.getAttribute('src') || element.getAttribute('data-src') || '', element);
      const alt = element.getAttribute('alt') || '';
      if (!url) { this.note('IMAGE_SOURCE_MISSING', '有图片缺少可保存的链接，已保留替代文字。'); return [text(alt || '[图片链接不可用]')]; }
      return [{ type: 'image', url, alt, title: element.getAttribute('title') || null }];
    }
    if (tag === 'TABLE') return this.table(element);
    if (tag === 'UL' || tag === 'OL') {
      const items = Array.from(element.children).filter(child => child.tagName.toUpperCase() === 'LI');
      return [{
        type: 'list', ordered: tag === 'OL', start: tag === 'OL' ? Number(element.getAttribute('start') || 1) : null,
        spread: items.some(item => item.querySelector('p + p')),
        children: items.map(item => {
          const checkbox = Array.from(item.querySelectorAll('input[type="checkbox"]'))
            .find(input => input.closest('li') === item) as HTMLInputElement | undefined;
          return { type: 'listItem', checked: checkbox ? checkbox.checked : null, spread: false, children: asBlocks(this.children(item)) };
        }),
      }];
    }
    if (tag === 'BLOCKQUOTE') return [{ type: 'blockquote', children: asBlocks(this.children(element)) }];
    if (/^H[1-6]$/.test(tag)) {
      const converted = asBlocks(this.children(element));
      return converted.map(part => part.type === 'paragraph' ? { type: 'heading', depth: Number(tag[1]), children: part.children } : part);
    }
    if (tag === 'P') return asBlocks(this.children(element));
    const children = this.children(element);
    if (tag === 'STRONG' || tag === 'B') return this.inlineWrapper('strong', children);
    if (tag === 'EM' || tag === 'I') return this.inlineWrapper('emphasis', children);
    if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return this.inlineWrapper('delete', children);
    if (tag === 'A') {
      const url = safeUrl(element.getAttribute('href') || '', element);
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
    if (blockTags.has(tag)) return asBlocks(children);
    return children;
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
    if (component === 'caption') return asBlocks(this.children(element));
    if ((component === 'box' || component === 'row') && !element.hasAttribute('data-d-inline')) {
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
      // A bordered card remains a grouped block in portable Markdown. Layout
      // classes and vector paths are never copied into the generated document.
      if (component === 'box' && element.hasAttribute('data-d-has-border')) return children.length ? [{ type: 'blockquote', children }] : [];
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
    const rawSource = own || inherited || annotation || '';
    const sourceKind: FormulaRecord['sourceKind'] = own || inherited ? 'attribute' : annotation ? 'annotation' : 'missing';
    const declared = (element.getAttribute('data-math-type') || element.getAttribute('data-display') || element.getAttribute('data-math-display') || '').trim().toLowerCase();
    const declaredDisplay = /^(?:block|display|true)$/.test(declared) ? true : /^(?:inline|false)$/.test(declared) ? false : undefined;
    const blockLayout = element.matches('.katex-display,.math-display') || !!element.closest('.katex-display,.math-display') || element.getAttribute('display') === 'block';
    // Explicit false overrides an inner MathML hint, but never an actual
    // display wrapper. A single-line block must not rely on a newline fallback.
    let display = blockLayout || (declaredDisplay ?? !!element.querySelector('math[display="block"]'));
    if (!display && element.getAttribute('role') === 'math') display = (element as HTMLElement).style?.display === 'block';
    if (!rawSource) {
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
    const alternatives = [own, inherited, annotation].filter((value): value is string => !!value).map(value => sourceWithoutDelimiters(value).tex);
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
    else if (element.matches('pre,.cm-editor,.cm-scroller,[data-markdown-copy="code-block"]')) {
      const contents = Array.from(element.querySelectorAll('.cm-content'));
      // Do not collapse two distinct editors into one apparent code block.
      if (contents.length === 1) content = contents[0];
    } else {
      const directChildren = Array.from(element.children);
      const lines = directChildren.filter(child => child.matches('.cm-line'));
      const hasOtherContent = directChildren.some(child => !child.matches('.cm-line') && !child.matches(ignoreSelector));
      const hasLooseText = Array.from(element.childNodes).some(node => node.nodeType === 3 && /\S/.test(node.nodeValue || ''));
      if (lines.length && !hasOtherContent && !hasLooseText) content = element;
    }
    if (!content) return null;
    const clone = content.cloneNode(true) as Element;
    clone.querySelectorAll(`${ignoreSelector},.cm-gutters,.cm-gutter,.cm-placeholder`).forEach(node => node.remove());
    const lines = clone.matches('.cm-line') ? [clone] : Array.from(clone.querySelectorAll('.cm-line')).filter(line => !line.parentElement?.closest('.cm-line'));
    const lineText = (line: Element): string => {
      const value = codeText(line);
      // A lone BR is CodeMirror's empty-line placeholder, not another line.
      return value === '\n' && !line.textContent ? '' : value;
    };
    const value = lines.length ? lines.map(lineText).join('\n') : codeText(clone);
    const language = this.language([
      content, element, content.closest('.cm-editor'), content.closest('[data-markdown-copy="code-block"]'),
    ]);
    this.codeBlocks.push({ text: value, language });
    if (/\r/.test(value)) this.note('CODE_LINE_ENDINGS', '代码含回车字符，外部 Markdown 阅读器可能规范化为 LF。');
    return { type: 'code', lang: language, value };
  }

  language(elements: Array<Element | null>): string | null {
    for (const element of elements) {
      if (!element) continue;
      const explicit = element.getAttribute('data-language');
      const className = element.getAttribute('class')?.match(/(?:^|\s)language-([^\s]+)/)?.[1];
      const candidate = explicit || className;
      if (candidate && /^[\w.+#-]+$/.test(candidate)) return candidate;
    }
    return null;
  }

  renderedCodeBlock(element: Element): Ast | null {
    // Current GPT code surfaces use a marked source DIV rather than PRE.
    // Consume only a self-contained surface with its own controls and label.
    if (element.matches('[data-code-block="true"][data-markdown-copy="code-block"]')) {
      const parts = Array.from(element.children);
      const source = parts.find(child => child.matches('[data-code-block-source="true"]'));
      const header = parts.find(child => child.matches('[data-markdown-copy="exclude"]'));
      const labels = Array.from(header?.children || []).filter(child => child.tagName.toUpperCase() === 'DIV'
        && !child.childElementCount && !child.hasAttribute('data-code-block-controls') && !child.matches(ignoreSelector));
      const label = labels.length === 1 ? labels[0].textContent?.trim() : null;
      const looseText = Array.from(element.childNodes).some(child => child.nodeType === 3 && /\S/.test(child.nodeValue || ''));
      const sourceOnly = source?.childElementCount === 1 && !source.matches(ignoreSelector)
        && source.firstElementChild?.tagName.toUpperCase() === 'CODE' && !source.firstElementChild.matches(ignoreSelector)
        && !Array.from(source.childNodes).some(child => child.nodeType === 3 && /\S/.test(child.nodeValue || ''));
      if (sourceOnly && header?.querySelector('[data-code-block-controls="true"]')
        && label && /^[\w.+#-]+$/.test(label) && !looseText
        && parts.every(child => child === source || child === header || child.matches(ignoreSelector))) {
        return this.code(source, this.language([element]) || label.toLowerCase());
      }
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

  code(element: Element, fallbackLanguage: string | null = null): Ast {
    const code = element.querySelector('code');
    let value: string;
    if (code) value = codeText(code);
    else {
      const clone = element.cloneNode(true) as Element;
      clone.querySelectorAll(ignoreSelector).forEach(node => node.remove());
      const lines = Array.from(clone.querySelectorAll('.cm-line'));
      value = lines.length ? lines.map(codeText).join('\n') : codeText(clone);
    }
    const language = this.language([code, element]) || fallbackLanguage;
    this.codeBlocks.push({ text: value, language });
    if (/\r/.test(value)) this.note('CODE_LINE_ENDINGS', '代码含回车字符，外部 Markdown 阅读器可能规范化为 LF。');
    return { type: 'code', lang: language, value };
  }

  table(element: Element): Ast[] {
    const sourceRows = Array.from(element.querySelectorAll('tr')).filter(row => row.closest('table') === element);
    const rows = sourceRows.map(row =>
      Array.from(row.children).filter(cell => /^(?:TH|TD)$/.test(cell.tagName.toUpperCase())).map(cell => ({
        header: cell.tagName.toUpperCase() === 'TH',
        colspan: Math.max(1, Number(cell.getAttribute('colspan')) || 1),
        rowspan: Math.max(1, Number(cell.getAttribute('rowspan')) || 1),
        blocks: asBlocks(this.children(cell)),
        align: (cell.getAttribute('align') || (cell as HTMLElement).style?.textAlign || '').match(/^(?:left|center|right)$/)?.[0] || null,
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
    const needsFallback = complexSections || rows.some(row => row.some(cell => cell.colspan > 1 || cell.rowspan > 1 || cell.blocks.length > 1 || cell.blocks.some(block => block.type !== 'paragraph') || this.hasTableMathConflict(cell.blocks)));
    if (needsFallback) {
      this.note('TABLE_HTML_FALLBACK', '复杂表格或含竖线等公式的表格已保存为安全 HTML；公式使用原生 MathML 并在 annotation 中保留 LaTeX 源码，阅读器需支持 HTML 和 MathML。');
      const rowHtml = (row: Cell[]): string => '<tr>' + row.map(cell => {
        const tag = cell.header ? 'th' : 'td';
        return `<${tag}${attrSpan('colspan', cell.colspan)}${attrSpan('rowspan', cell.rowspan)}${cell.align ? ` align="${cell.align}"` : ''}>${cell.blocks.map(part => this.html(part)).join('')}</${tag}>`;
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
        return tag ? `<${tag}>\n${content}\n</${tag}>` : content;
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
      case 'thematicBreak': return '<hr>';
      case 'blockquote': return `<blockquote>${children}</blockquote>`;
      case 'heading': return `<h${Number(node.depth)}>${children}</h${Number(node.depth)}>`;
      case 'list': return node.ordered ? `<ol start="${Number(node.start) || 1}">${children}</ol>` : `<ul>${children}</ul>`;
      case 'listItem': return `<li>${typeof node.checked === 'boolean' ? `<input type="checkbox" disabled${node.checked ? ' checked' : ''}> ` : ''}${children}</li>`;
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

export function extractMarkdown(root: Element): ExportResult {
  const capture = new Capture();
  // Visit the root as well: callers may supply a pre, table, or formula itself.
  const children = asBlocks(capture.visit(root));
  const markdown = serializer.stringify({ type: 'root', children } as unknown as Root);
  return { markdown, diagnostics: capture.diagnostics, formulas: capture.formulas, codeBlocks: capture.codeBlocks };
}
