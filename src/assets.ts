import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkStringify from 'remark-stringify';
import { strToU8, zipSync } from 'fflate';
import type { Diagnostic } from './types';
import { IMAGE_LIMITS } from './limits';

export interface PreparedAssets {
  markdown: string;
  imageAssets: Record<string, string>;
  files: Record<string, Uint8Array>;
  /** Whether at least one image was successfully saved into files. */
  hasImages: boolean;
  diagnostics: Diagnostic[];
}

interface MdNode {
  type: string; url?: string; alt?: string | null; title?: string | null;
  value?: string; identifier?: string; children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
interface Reference { url: string; start: number; end: number; render: (path: string) => string; }
interface ImageFormat { mime: string; extension: 'png' | 'jpg' | 'gif' | 'webp'; }

const MAX_IMAGES = IMAGE_LIMITS.count;
const MAX_IMAGE_BYTES = IMAGE_LIMITS.bytes;
const MAX_TOTAL_BYTES = IMAGE_LIMITS.totalBytes;
const MAX_DATA_URI_CHARACTERS = IMAGE_LIMITS.totalUriCharacters;
const TIMEOUT_MS = 12_000;
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const imageSerializer = unified().use(remarkStringify);

class AssetError extends Error {
  constructor(readonly code: string) { super(code); }
}

function htmlDecode(value: string): string {
  // extractMarkdown's generated HTML uses these five escapes, not arbitrary HTML.
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity]!);
}
function htmlEscape(value: string): string { return value.replace(/[&"<>]/g, character => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[character]!); }

function imageReferences(markdown: string): Reference[] {
  const tree = parser.parse(markdown) as unknown as MdNode;
  const definitions = new Map<string, MdNode>();
  const gather = (node: MdNode): void => {
    if (node.type === 'definition' && node.identifier) definitions.set(node.identifier.toLowerCase(), node);
    node.children?.forEach(gather);
  };
  gather(tree);
  const result: Reference[] = [];
  const walk = (node: MdNode): void => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if ((node.type === 'image' || node.type === 'imageReference') && start !== undefined && end !== undefined) {
      const definition = node.type === 'imageReference' ? definitions.get(node.identifier?.toLowerCase() || '') : node;
      result.push({ url: definition?.url || '', start, end, render: path => imageSerializer.stringify({ type: 'root', children: [{ type: 'paragraph', children: [{ type: 'image', url: path, alt: node.alt || '', title: definition?.title || null }] }] }).replace(/\n$/, '') });
    } else if (node.type === 'html' && start !== undefined) {
      // This captures the safe, quoted IMG attributes generated for complex tables.
      // Code/math AST nodes are never scanned, so TeX and code stay byte-for-byte.
      const html = node.value || '';
      const tags = /<img(?=\s|\/?>)(?:[^"'<>]|"[^"]*"|'[^']*')*?>/gi;
      for (const tag of html.matchAll(tags)) {
        const source = /\ssrc\s*=\s*(["'])(.*?)\1/i.exec(tag[0]);
        if (!source) { result.push({ url: '', start: start + tag.index!, end: start + tag.index! + tag[0].length, render: () => tag[0] }); continue; }
        const valueStart = start + tag.index! + source.index + source[0].indexOf(source[1]) + 1;
        result.push({ url: htmlDecode(source[2]), start: valueStart, end: valueStart + source[2].length, render: htmlEscape });
      }
    }
    node.children?.forEach(walk);
  };
  walk(tree);
  return result;
}

function formatOf(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return { mime: 'image/png', extension: 'png' };
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mime: 'image/jpeg', extension: 'jpg' };
  if (bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 6)).match(/^GIF8[79]a$/)) return { mime: 'image/gif', extension: 'gif' };
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return { mime: 'image/webp', extension: 'webp' };
  return null;
}
function validateType(bytes: Uint8Array, declared: string): ImageFormat {
  const format = formatOf(bytes);
  const mime = declared.toLowerCase().split(';')[0].trim().replace(/^image\/jpg$/, 'image/jpeg');
  if (!format || (mime && mime !== 'application/octet-stream' && mime !== format.mime)) throw new AssetError('IMAGE_TYPE_UNSUPPORTED');
  return format;
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AssetError('IMAGE_ABORTED'));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new AssetError('IMAGE_ABORTED'));
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}

async function readBytes(url: string, fetcher: typeof fetch, externalSignal?: AbortSignal): Promise<{ bytes: Uint8Array; format: ImageFormat }> {
  if (externalSignal?.aborted) throw new AssetError('IMAGE_ABORTED');
  if (/^data:/i.test(url)) {
    const data = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/\r\n]*={0,2})$/i.exec(url);
    if (!data) throw new AssetError('IMAGE_TYPE_UNSUPPORTED');
    const encoded = data[2].replace(/[\r\n]/g, '');
    if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new AssetError('IMAGE_SIZE_LIMIT');
    let binary: string;
    try { binary = atob(encoded); } catch { throw new AssetError('IMAGE_TYPE_UNSUPPORTED'); }
    if (binary.length > MAX_IMAGE_BYTES) throw new AssetError('IMAGE_SIZE_LIMIT');
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return { bytes, format: validateType(bytes, data[1]) };
  }
  let source: URL;
  try { source = new URL(url, typeof location === 'undefined' ? undefined : location.href); }
  catch { throw new AssetError('IMAGE_ASSET_UNAVAILABLE'); }
  if (!['http:', 'https:', 'blob:'].includes(source.protocol)) throw new AssetError('IMAGE_TYPE_UNSUPPORTED');
  const controller = new AbortController();
  const abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  try {
    const sameOrigin = typeof location !== 'undefined' && source.origin === location.origin;
    const response = await abortable(fetcher(source.href, { credentials: sameOrigin ? 'include' : 'omit', referrerPolicy: 'no-referrer', signal: controller.signal }), controller.signal);
    if (!response.ok) throw new AssetError('IMAGE_ASSET_UNAVAILABLE');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) throw new AssetError('IMAGE_SIZE_LIMIT');
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const part = await abortable(reader.read(), controller.signal);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_IMAGE_BYTES) throw new AssetError('IMAGE_SIZE_LIMIT');
          chunks.push(part.value);
        }
      } catch (error) { void reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { bytes, format: validateType(bytes, response.headers.get('content-type') || '') };
  } catch (error) {
    if (timedOut) throw new AssetError('IMAGE_TIMEOUT');
    if (externalSignal?.aborted) throw new AssetError('IMAGE_ABORTED');
    throw error;
  } finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', abort); controller.abort(); }
}

function diagnostic(code: string, index: number): Diagnostic {
  const reason: Record<string, string> = {
    IMAGE_TYPE_UNSUPPORTED: '格式或文件内容不受支持（仅保存 PNG、JPEG、GIF、WebP）',
    IMAGE_SIZE_LIMIT: '超过单张 8 MiB 的保存上限', IMAGE_TOTAL_LIMIT: '超过本次图片总量上限',
    IMAGE_COUNT_LIMIT: '超过本次 30 张不同图片的保存上限', IMAGE_TIMEOUT: '读取超时',
    IMAGE_ABORTED: '保存已取消', IMAGE_ASSET_UNAVAILABLE: '无法读取，可能需要原对话登录状态或站点不允许跨域读取',
  };
  return { code, severity: 'warning', message: `第 ${index} 个图片引用${reason[code] || reason.IMAGE_ASSET_UNAVAILABLE}；Markdown 保留原链接，未保存说明可在预览中查看。` };
}

/** Resolve only images already referenced in an export, without changing other Markdown. */
export async function prepareAssets(markdown: string, options: { fetcher?: typeof fetch; signal?: AbortSignal } = {}): Promise<PreparedAssets> {
  const references = imageReferences(markdown);
  const prepared: PreparedAssets = { markdown, imageAssets: {}, files: {}, hasImages: false, diagnostics: [] };
  if (!references.length) return prepared;
  const urls = [...new Set(references.map(reference => reference.url))];
  const replacements = new Map<string, string>();
  let totalBytes = 0; let totalDataCharacters = 0; let saved = 0;
  for (const [index, url] of urls.entries()) {
    try {
      if (index >= MAX_IMAGES) throw new AssetError('IMAGE_COUNT_LIMIT');
      if (!url) throw new AssetError('IMAGE_ASSET_UNAVAILABLE');
      const { bytes, format } = await readBytes(url, options.fetcher || fetch, options.signal);
      if (totalBytes + bytes.length > MAX_TOTAL_BYTES) throw new AssetError('IMAGE_TOTAL_LIMIT');
      const uri = `data:${format.mime};base64,${base64(bytes)}`;
      if (totalDataCharacters + uri.length > MAX_DATA_URI_CHARACTERS) throw new AssetError('IMAGE_TOTAL_LIMIT');
      const path = `images/image-${String(++saved).padStart(3, '0')}.${format.extension}`;
      totalBytes += bytes.length; totalDataCharacters += uri.length;
      prepared.files[path] = bytes;
      prepared.imageAssets[path] = uri;prepared.imageAssets[url] = uri;replacements.set(url, path);
    } catch (error) { prepared.diagnostics.push(diagnostic(error instanceof AssetError ? error.code : 'IMAGE_ASSET_UNAVAILABLE', index + 1)); }
  }
  // Replacements are offset-based and applied backwards; code, math, and prose are untouched.
  for (const reference of [...references].sort((a, b) => b.start - a.start)) {
    const path = replacements.get(reference.url);
    if (path) prepared.markdown = prepared.markdown.slice(0, reference.start) + reference.render(path) + prepared.markdown.slice(reference.end);
  }
  prepared.hasImages = saved > 0;
  return prepared;
}

/** Package the exact preview/copy Markdown plus successfully saved image bytes. */
export function zipMarkdown(prepared: PreparedAssets, filename = 'answer.md'): Uint8Array {
  if (!/^[^/\\\0]{1,120}\.md$/i.test(filename)) throw new Error('Markdown 文件名无效。');
  const files: Record<string, Uint8Array> = { [filename]: strToU8(prepared.markdown) };
  for (const [path, bytes] of Object.entries(prepared.files)) {
    if (!/^images\/image-\d{3}\.(?:png|jpg|gif|webp)$/.test(path)) throw new Error('图片包路径无效。');
    files[path] = bytes;
  }
  if (prepared.diagnostics.length) files['EXPORT-NOTES.md'] = strToU8('# 导出说明\n\n' + prepared.diagnostics.map(item => `- ${item.message}`).join('\n') + '\n');
  return zipSync(files, { level: 0 });
}
