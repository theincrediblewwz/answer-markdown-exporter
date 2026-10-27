import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema, type Options as SanitizeOptions } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import rehypeStringify from 'rehype-stringify';
import type { Element, Root, RootContent, Text } from 'hast';
import type { Diagnostic, PreviewResult } from './types';
import { nativeMathMlAttributes, nativeMathMlTags, validateNativeMathMLHast } from './native-mathml';
import { presentationClasses } from './presentation';

declare module 'hast' { interface ElementData { gptMdLiteralMath?: boolean; } }

const MAX_PREVIEW_CHARACTERS = 1_000_000;
const MAX_FORMULA_CHARACTERS = 20_000;
export interface PreviewOptions { imageAssets?: Record<string, string>; }

// The input is page content. Only KaTeX's own output is allowed to add styles
// after this boundary. No page styles, executable markup, or resource loads pass.
const previewSchema: SanitizeOptions = {
  ...defaultSchema,
  tagNames: [...new Set([...(defaultSchema.tagNames ?? []), ...nativeMathMlTags, 'ruby', 'rt', 'rp', 'dl', 'dt', 'dd', 'mark', 'bdi', 'bdo'])],
  strip: [...new Set([...(defaultSchema.strip ?? []), 'script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript'])],
  attributes: {
    ...defaultSchema.attributes,
    ...nativeMathMlAttributes,
    '*': [
      ...(defaultSchema.attributes?.['*'] ?? []).filter(attribute => attribute !== 'dir' && attribute !== 'scope'),
      ['dir', 'ltr', 'rtl', 'auto'],
    ],
    code: [['className', /^language-./, 'math-inline', 'math-display', 'gpt-md-inline-code']],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', 'gpt-md-layout-scroll', ...presentationClasses], ['role', 'img'], 'ariaLabel', 'dataGptMdRatio', 'dataGptMdBarColor', 'dataGptMdBarHeight'],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', ...presentationClasses]],
    table: [...(defaultSchema.attributes?.table ?? []), ['className', 'gpt-md-layout', 'gpt-md-plain-row', 'gpt-md-meter-row']],
    td: [...(defaultSchema.attributes?.td ?? []), 'colSpan', 'rowSpan', 'width', ['className', 'gpt-md-card', 'gpt-md-connector', 'gpt-md-highlight', 'gpt-md-plain-cell']],
    th: [...(defaultSchema.attributes?.th ?? []), 'colSpan', 'rowSpan', ['scope', 'row', 'col', 'rowgroup', 'colgroup']],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https', 'data'],
  },
};

function text(value: string): Text {
  return { type: 'text', value };
}

function element(tagName: string, children: RootContent[], properties: Element['properties'] = {}): Element {
  return { type: 'element', tagName, properties, children: children as Element['children'] };
}

function plainText(node: RootContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(plainText).join('');
  return '';
}

function safeImageLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

// Exact plain-text TeX annotations are rebuilt as code before KaTeX, discarding
// the complete untrusted visual tree. Native math takes the shared DOM/HAST
// validator instead: the sanitizer's attribute names alone are not a grammar.
const restoreMathSources: Plugin<[{ diagnostics: Diagnostic[] }], Root> = ({ diagnostics }) => tree => {
  const mathTags = new Set(nativeMathMlTags);
  const rejected = (reason: string): Element => {
    diagnostics.push({
      code: 'native-mathml-preview-rejected', severity: 'warning',
      message: `原生 MathML 未通过安全校验，已显示占位；完整 Markdown 源码保持不变：${reason}`,
    });
    return element('span', [text('［原生 MathML 无法安全预览；请查看 Markdown 源码］')]);
  };
  const walk = (parent: Root | Element): void => {
    const children = parent.children as RootContent[];
    for (let index = 0; index < children.length; index += 1) {
      const node = children[index];
      if (node.type !== 'element') continue;
      if (node.tagName === 'math') {
        const semantics = node.children.find(child => child.type === 'element' && child.tagName === 'semantics');
        const annotation = semantics?.type === 'element' ? semantics.children.find(child => child.type === 'element' && child.tagName === 'annotation' && child.properties.encoding === 'application/x-tex') : undefined;
        if (annotation && annotation.type === 'element' && annotation.children.every(child => child.type === 'text') && plainText(annotation).trim()) {
          const display = node.properties.display === 'block';
          const code = element('code', [text(plainText(annotation))], { className: ['language-math', display ? 'math-display' : 'math-inline'] });
          children[index] = display ? element('pre', [code]) : code;
          continue;
        }
        try { validateNativeMathMLHast(node); }
        catch (error) { children[index] = rejected(error instanceof Error ? error.message : String(error)); }
        continue;
      }
      if (mathTags.has(node.tagName)) {
        children[index] = rejected('MathML 元素缺少 math 根节点');
        continue;
      }
      walk(node);
    }
  };
  walk(tree);
};

const hardenResources: Plugin<[{ diagnostics: Diagnostic[]; imageAssets?: Record<string, string> }], Root> = ({ diagnostics, imageAssets }) => {
  return (tree) => {
    let imageCount = 0;
    const ids = new Set<string>();
    const collectIds = (parent: Root | Element): void => {
      for (const child of parent.children) {
        if (child.type !== 'element') continue;
        if (typeof child.properties.id === 'string') ids.add(child.properties.id);
        collectIds(child);
      }
    };
    collectIds(tree);
    const walk = (parent: Root | Element): void => {
      const children = parent.children as RootContent[];
      for (let index = 0; index < children.length; index += 1) {
        const node = children[index];
        if (node.type !== 'element') continue;

        if (Array.isArray(node.properties.className) && !node.properties.className.length) delete node.properties.className;

        if (node.tagName === 'td' && node.properties.width !== undefined) {
          const width = Number(node.properties.width);
          if (!Number.isInteger(width) || width < 1 || width > 256) delete node.properties.width;
        }
        if (node.tagName === 'div' && Array.isArray(node.properties.className) && node.properties.className.includes('gpt-md-meter')) {
          const ratio = Number(node.properties.dataGptMdRatio), height = Number(node.properties.dataGptMdBarHeight);
          const color = String(node.properties.dataGptMdBarColor || '');
          if (node.properties.dataGptMdRatio === undefined || !Number.isFinite(ratio) || ratio < 0 || ratio > 100
            || !Number.isFinite(height) || height <= 0 || height > 64 || !/^[\da-f]{6}$/i.test(color)) {
            children[index] = element('span', [text('［比例图形参数不可用；请核对原页］')]);
            diagnostics.push({ code: 'bar-preview-rejected', severity: 'warning', message: '有比例图形的参数未通过校验，已保留位置说明。' });
            continue;
          }
          // CSS is stripped above. Rebuild numeric geometry and one opaque
          // hex color, including the complete fill subtree, after validation.
          node.properties.style = `height:${height}px`;
          node.properties.role = 'img'; node.properties.ariaLabel = `比例条：${ratio}%`;
          node.children = [element('span', [], { className: ['gpt-md-meter-fill'], style: `width:${ratio}%;background:#${color}` })];
          continue;
        }

        if (node.tagName === 'img') {
          const saved = typeof node.properties.src === 'string' ? imageAssets?.[node.properties.src] : undefined;
          if (saved && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(saved)) {
            node.properties.src = saved; node.properties.loading = 'eager'; node.properties.decoding = 'sync';
            continue;
          }
          imageCount += 1;
          const alt = typeof node.properties.alt === 'string' && node.properties.alt
            ? node.properties.alt : '图片';
          const href = safeImageLink(node.properties.src);
          const label = `［${alt}：预览不自动加载图片］`;
          children[index] = href
            ? element('a', [text(label)], { href, target: '_blank', rel: ['noopener', 'noreferrer'], referrerPolicy: 'no-referrer' })
            : element('span', [text(label)]);
          continue;
        }

        if (node.tagName === 'a') {
          const href = typeof node.properties.href === 'string' ? node.properties.href : '';
          if (href.trim().startsWith('#')) {
            let fragment: string | undefined;
            try { fragment = decodeURIComponent(href.trim().slice(1)); } catch { /* Keep a safe unmatched fragment unchanged. */ }
            if (fragment !== undefined) {
              const prefixed = `${defaultSchema.clobberPrefix ?? 'user-content-'}${fragment}`;
              const target = ids.has(prefixed) ? prefixed : ids.has(fragment) ? fragment : undefined;
              if (target !== undefined) node.properties.href = `#${encodeURIComponent(target)}`;
            }
            delete node.properties.target;
            delete node.properties.rel;
            delete node.properties.referrerPolicy;
          } else {
            node.properties.target = '_blank';
            node.properties.rel = ['noopener', 'noreferrer'];
            node.properties.referrerPolicy = 'no-referrer';
          }
        }

        if (node.tagName === 'code') {
          const classes = Array.isArray(node.properties.className) ? node.properties.className : [];
          if (classes.includes('gpt-md-inline-code')) {
            // GFM can autolink a URL even inside an inline raw HTML code atom.
            // Restore the exact literal text and discard that incidental tree.
            node.children = [text(plainText(node))];
            continue;
          }
          // A fence's language name is not evidence that its contents are a
          // formula. KaTeX also accepts language-math, so isolate literal code
          // until that pass finishes; genuine math carries an explicit mode.
          if (classes.includes('language-math') && !classes.some(value => value === 'math-inline' || value === 'math-display')) {
            node.data ??= {};
            node.data.gptMdLiteralMath = true;
            node.properties.className = classes.map(value => value === 'language-math' ? 'language-math-source' : value);
          }
          if (classes.some((value) => value === 'math-inline' || value === 'math-display')
            && plainText(node).length > MAX_FORMULA_CHARACTERS) {
            node.properties.className = ['language-text'];
            diagnostics.push({
              code: 'formula-preview-size', severity: 'warning',
              message: '有公式超过预览长度限制，已显示源码；下载和复制内容保持不变。',
            });
          }
        }
        walk(node);
      }
    };
    walk(tree);
    if (imageCount > 0) diagnostics.push({
      code: 'preview-images-disabled', severity: 'info',
      message: `${imageCount} 张图片在预览中显示为占位链接，未自动联网加载。`,
    });
  };
};

const restoreLiteralCodeLanguages: Plugin<[], Root> = () => tree => {
  const walk = (parent: Root | Element): void => {
    for (const node of parent.children) {
      if (node.type !== 'element') continue;
      if (node.tagName === 'code' && node.data?.gptMdLiteralMath && Array.isArray(node.properties.className)) {
        node.properties.className = node.properties.className.map(value => value === 'language-math-source' ? 'language-math' : value);
      }
      walk(node);
    }
  };
  walk(tree);
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!).replace(/\r/g, '&#13;');
}

/** Render exactly the serialized Markdown. This function never reads page DOM. */
export async function renderPreview(markdown: string, options: PreviewOptions = {}): Promise<PreviewResult> {
  const diagnostics: Diagnostic[] = [];
  if (markdown.length > MAX_PREVIEW_CHARACTERS) {
    return {
      html: `<pre><code>${escapeHtml(markdown)}</code></pre>`,
      diagnostics: [{
        code: 'preview-size', severity: 'warning',
        message: '内容超过富文本预览长度限制，已显示 Markdown 源码；仍可下载或复制完整内容。',
      }],
    };
  }

  try {
    const file = await unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkMath, { singleDollarTextMath: true })
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeRaw)
      .use(restoreMathSources, { diagnostics })
      .use(rehypeSanitize, previewSchema)
      .use(hardenResources, { diagnostics, imageAssets: options.imageAssets })
      .use(rehypeKatex, {
        output: 'htmlAndMathml', trust: false, strict: 'ignore', maxExpand: 1_000, maxSize: 30,
      })
      .use(restoreLiteralCodeLanguages)
      .use(rehypeStringify)
      .process(markdown);

    for (const message of file.messages) {
      diagnostics.push({
        code: message.source === 'rehype-katex' ? 'formula-render-error' : 'preview-render-warning',
        severity: 'warning',
        message: message.source === 'rehype-katex'
          ? `公式预览未能完整渲染，原源码仍保留：${message.reason}`
          : `预览提示：${message.reason}`,
      });
    }
    // HTML insertion normalizes literal CR to LF. Character references keep
    // a source CR intact, including CRLF in literal code, through that step.
    return { html: String(file).replace(/\r/g, '&#13;'), diagnostics };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      html: `<pre><code>${escapeHtml(markdown)}</code></pre>`,
      diagnostics: [...diagnostics, {
        code: 'preview-render-error', severity: 'warning',
        message: `富文本预览失败，已显示 Markdown 源码：${reason}`,
      }],
    };
  }
}
