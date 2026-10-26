import type { Diagnostic } from './types';
import { excludedContent } from './content-policy';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_ICONS = 40;
const MAX_SVG_CHARACTERS = 20_000;
const geometry: Record<string, Set<string>> = {
  svg: new Set(['viewBox', 'width', 'height']), g: new Set(), path: new Set(['d']),
  circle: new Set(['cx', 'cy', 'r']), ellipse: new Set(['cx', 'cy', 'rx', 'ry']),
  rect: new Set(['x', 'y', 'width', 'height', 'rx', 'ry']), line: new Set(['x1', 'y1', 'x2', 'y2']),
  polyline: new Set(['points']), polygon: new Set(['points']),
};
const shared = new Set(['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'fill-rule', 'clip-rule', 'opacity', 'fill-opacity', 'stroke-opacity', 'transform', 'vector-effect']);
const number = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
const numbers = new RegExp(`^${number}(?:[\\s,]+${number})*$`);
const namedColors = /^(?:none|transparent|black|white|gray|grey|red|green|blue|yellow|orange|purple|pink|brown|cyan|magenta|navy|teal|lime|silver|maroon|olive)$/i;
const pngCache = new Map<string, string>();

function safeValue(name: string, value: string): string {
  const trimmed = value.trim();
  if (name === 'fill' || name === 'stroke') {
    if (/^currentColor$/i.test(trimmed)) return '#334155';
    if (namedColors.test(trimmed) || /^#[0-9a-f]{3,8}$/i.test(trimmed)
      || /^(?:rgb|rgba|hsl|hsla)\([\d\s.,%+-]+\)$/i.test(trimmed)) return trimmed;
  } else if (name === 'd') {
    if (/^[MmZzLlHhVvCcSsQqTtAa\d\s.,+eE-]+$/.test(trimmed)) return trimmed;
  } else if (name === 'transform') {
    const transforms = trimmed.match(/(?:matrix|translate|scale|rotate|skewX|skewY)\([^()]*\)/g);
    if (transforms?.length && transforms.join('').replace(/[\s,]/g, '') === trimmed.replace(/[\s,]/g, '')
      && transforms.every(transform => numbers.test(transform.slice(transform.indexOf('(') + 1, -1).trim()))) return trimmed;
  } else if (name === 'stroke-linecap' && /^(?:butt|round|square)$/.test(trimmed)) return trimmed;
  else if (name === 'stroke-linejoin' && /^(?:miter|round|bevel)$/.test(trimmed)) return trimmed;
  else if ((name === 'fill-rule' || name === 'clip-rule') && /^(?:nonzero|evenodd)$/.test(trimmed)) return trimmed;
  else if (name === 'vector-effect' && /^(?:none|non-scaling-stroke)$/.test(trimmed)) return trimmed;
  else if (name === 'stroke-dasharray' && trimmed === 'none') return trimmed;
  else if (numbers.test(trimmed)) return trimmed;
  throw new Error('图标包含不支持的几何或颜色值。');
}

/** Construct an independent geometry-only SVG; page markup is never serialized. */
export function sanitizedIconSvg(source: Element): string {
  if (source.localName !== 'svg' || source.namespaceURI !== SVG_NS) throw new Error('图标不是 SVG。');
  const document = source.ownerDocument.implementation.createDocument(SVG_NS, 'svg', null);
  let characters = 0; let count = 0;
  const copy = (input: Element, output: Element): void => {
    if (++count > 500 || !geometry[input.localName] || input.namespaceURI !== SVG_NS) throw new Error('图标包含非几何内容。');
    for (const attribute of input.attributes) {
      characters += attribute.name.length + attribute.value.length;
      if (characters > MAX_SVG_CHARACTERS) throw new Error('图标超过长度限制。');
      if (attribute.name === 'xmlns' && attribute.value === SVG_NS) continue;
      if (attribute.name.toLowerCase() === 'style') continue;
      if (/^(?:on|href$|xlink:href$|src$)/i.test(attribute.name)
        || /url\s*\(|(?:https?|data|javascript|file):|[<>]/i.test(attribute.value)) throw new Error('图标包含脚本、样式或外部资源。');
      if (input === source && (attribute.name === 'width' || attribute.name === 'height')) continue;
      if (shared.has(attribute.name) || geometry[input.localName].has(attribute.name)) output.setAttribute(attribute.name, safeValue(attribute.name, attribute.value));
    }
    for (const child of input.childNodes) {
      if (child.nodeType === 3 && !child.textContent?.trim()) continue;
      if (child.nodeType !== 1) throw new Error('图标包含非几何内容。');
      const element = child as Element;
      // An accessible title is read separately for IMG alt text, never rendered.
      if ((element.localName === 'title' || element.localName === 'desc') && !element.children.length) {
        if (element.attributes.length) throw new Error('图标标题包含不支持的属性。');
        characters += element.textContent?.length || 0;
        if (characters > MAX_SVG_CHARACTERS) throw new Error('图标超过长度限制。');
        continue;
      }
      const clean = document.createElementNS(SVG_NS, element.localName);
      copy(element, clean); output.append(clean);
    }
  };
  const root = document.documentElement;
  copy(source, root);
  if (!root.hasAttribute('viewBox')) {
    const width = Number(source.getAttribute('width')) || 24;
    const height = Number(source.getAttribute('height')) || 24;
    if (width <= 0 || height <= 0 || width > 4096 || height > 4096) throw new Error('图标尺寸不受支持。');
    root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }
  root.setAttribute('width', '80'); root.setAttribute('height', '80');
  if (!root.hasAttribute('fill')) root.setAttribute('fill', '#334155');
  const Serializer = source.ownerDocument.defaultView?.XMLSerializer;
  if (!Serializer) throw new Error('当前页面无法序列化图标。');
  const result = new Serializer().serializeToString(root);
  if (result.length > MAX_SVG_CHARACTERS) throw new Error('图标超过长度限制。');
  return result;
}

async function rasterize(svg: string, document: Document, timeout: number, signal?: AbortSignal): Promise<string> {
  const view = document.defaultView;
  if (!view || !view.URL.createObjectURL) throw new Error('当前页面无法转换图标。');
  const image = new view.Image();
  const url = view.URL.createObjectURL(new view.Blob([svg], { type: 'image/svg+xml' }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    image.src = url;
    await Promise.race([
      image.decode(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('图标转换超时。')), timeout);
        abort = () => reject(new Error('图标转换已取消。'));
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      }),
    ]);
    if (signal?.aborted) throw new Error('图标转换已取消。');
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 80;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前页面无法绘制图标。');
    context.drawImage(image, 0, 0, 80, 80);
    const data = canvas.toDataURL('image/png');
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data)) throw new Error('图标未生成 PNG。');
    return data;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', abort); image.src = ''; view.URL.revokeObjectURL(url);
  }
}

/** Convert only cloned GPT component icons. The live answer DOM is untouched. */
export async function prepareIconImages(root: Element, options: { signal?: AbortSignal; current?: () => boolean } = {}): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const icons = [...root.querySelectorAll('[data-d-component="icon"]')]
    .filter(icon => !excludedContent(icon) && !icon.closest('pre,code,[data-d-component="pressable"][role="link"]') && (icon.localName === 'svg' || icon.querySelector('svg')));
  const deadline = Date.now() + 6_000;
  let converted = 0; let failed = 0;
  for (const icon of icons.slice(0, MAX_ICONS)) {
    if (options.signal?.aborted || options.current?.() === false) break;
    if (Date.now() >= deadline) { failed += 1; break; }
    try {
      const source = icon.localName === 'svg' ? icon : icon.querySelector('svg')!;
      const svg = sanitizedIconSvg(source);
      let png = pngCache.get(svg);
      if (!png) {
        png = await rasterize(svg, root.ownerDocument, Math.min(2_000, deadline - Date.now()), options.signal);
        if (pngCache.size >= MAX_ICONS) pngCache.delete(pngCache.keys().next().value!);
        pngCache.set(svg, png);
      }
      if (options.signal?.aborted || options.current?.() === false) break;
      const image = root.ownerDocument.createElement('img');
      image.src = png; image.width = 20; image.height = 20; image.setAttribute('data-gpt-md-icon-image', '');
      image.alt = (icon.getAttribute('aria-label') || source.getAttribute('aria-label') || source.querySelector('title')?.textContent || '图标').trim().slice(0, 160) || '图标';
      if (icon.localName === 'svg') {
        const wrapper = root.ownerDocument.createElement('span');
        wrapper.setAttribute('data-d-component', 'icon'); wrapper.append(image); icon.replaceWith(wrapper);
      } else icon.replaceChildren(image);
      converted += 1;
    } catch { failed += 1; }
  }
  if (converted) diagnostics.push({ code: 'ICONS_AS_IMAGES', severity: 'info', message: `${converted} 个图标已独立转换为本地 PNG，图片包内保留图标文件。` });
  if (failed || icons.length > MAX_ICONS) diagnostics.push({ code: 'ICON_CONVERSION_INCOMPLETE', severity: 'warning', message: '部分图标未能转换为图片（不支持的内容、数量或时间限制），已保留其可确认的文字标注或位置。' });
  return diagnostics;
}
