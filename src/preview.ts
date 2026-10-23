import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema, type Options as SanitizeOptions } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import rehypeStringify from 'rehype-stringify';
import type { Element, Root, RootContent } from 'hast';
import type { Diagnostic, PreviewResult } from './types';

const MAX_PREVIEW_CHARACTERS = 1_000_000;
const MAX_FORMULA_CHARACTERS = 20_000;
export interface PreviewOptions { imageAssets?: Record<string, string>; }

// The input is page content. Only KaTeX's own output is allowed to add styles
// after this boundary. No page styles, executable markup, or resource loads pass.
const previewSchema: SanitizeOptions = {
  ...defaultSchema,
  strip: [...new Set([...(defaultSchema.strip ?? []), 'script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript'])],
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    td: [...(defaultSchema.attributes?.td ?? []), 'colSpan', 'rowSpan'],
    th: [...(defaultSchema.attributes?.th ?? []), 'colSpan', 'rowSpan'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https', 'data'],
  },
};

function text(value: string): RootContent {
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

const hardenResources: Plugin<[{ diagnostics: Diagnostic[]; imageAssets?: Record<string, string> }], Root> = ({ diagnostics, imageAssets }) => {
  return (tree) => {
    let imageCount = 0;
    const walk = (parent: Root | Element): void => {
      const children = parent.children as RootContent[];
      for (let index = 0; index < children.length; index += 1) {
        const node = children[index];
        if (node.type !== 'element') continue;

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
          node.properties.target = '_blank';
          node.properties.rel = ['noopener', 'noreferrer'];
          node.properties.referrerPolicy = 'no-referrer';
        }

        if (node.tagName === 'code') {
          const classes = Array.isArray(node.properties.className) ? node.properties.className : [];
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
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
      .use(rehypeSanitize, previewSchema)
      .use(hardenResources, { diagnostics, imageAssets: options.imageAssets })
      .use(rehypeKatex, {
        output: 'htmlAndMathml', trust: false, strict: 'ignore', maxExpand: 1_000, maxSize: 30,
      })
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
    return { html: String(file), diagnostics };
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
