import type { Diagnostic } from './types';
import { IMAGE_LIMITS } from './limits';

export interface PrintPayload {
  markdown: string;
  imageAssets: Record<string, string>;
  diagnostics: Diagnostic[];
}

export const PRINT_SESSION_LIFETIME_MS = 120_000;
export const PRINT_LIMITS = {
  markdownCharacters: 1_000_000,
  imageCount: IMAGE_LIMITS.count,
  imageKeys: 60,
  imageUriCharacters: IMAGE_LIMITS.uriCharacters,
  imageCharacters: IMAGE_LIMITS.totalUriCharacters,
  cacheCharacters: 64_000_000,
  sessions: 4,
  diagnostics: 200,
} as const;

type PrintReply = { ok: true; payload?: PrintPayload } | { ok: false; error: string };
type PrintMessageListener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (reply: PrintReply) => void) => boolean | undefined;
interface BrokerOptions {
  extensionId: string;
  getURL(path: string): string;
  openTab(url: string): Promise<unknown>;
  now?: () => number;
  randomUUID?: () => string;
  schedule?: (callback: () => void, milliseconds: number) => unknown;
  cancel?: (timer: unknown) => void;
}
interface PrintSession { payload: PrintPayload; expiresAt: number; characters: number; timer: unknown; }
const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Raster data only. File signatures prevent mislabeled SVG/HTML from becoming an asset. */
export function safeRasterDataUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > PRINT_LIMITS.imageUriCharacters) return false;
  const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4) return false;
  let prefix: string;
  try { prefix = atob(match[2].slice(0, 64)); } catch { return false; }
  if (match[1] === 'png') return prefix.startsWith('\x89PNG\r\n\x1a\n');
  if (match[1] === 'jpeg') return prefix.startsWith('\xff\xd8\xff');
  if (match[1] === 'gif') return prefix.startsWith('GIF87a') || prefix.startsWith('GIF89a');
  return prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP';
}

function validatePayload(message: Record<string, unknown>): { payload: PrintPayload; characters: number } {
  if (typeof message.markdown !== 'string' || !message.markdown.trim() || message.markdown.length > PRINT_LIMITS.markdownCharacters) throw new Error('打印内容为空或超过长度限制。');
  const imageAssets: Record<string, string> = Object.create(null);
  const assets = message.imageAssets ?? {};
  if (!record(assets) || Object.keys(assets).length > PRINT_LIMITS.imageKeys) throw new Error('打印图片数量或格式不符合要求。');
  let imageCharacters = 0;
  let assetKeyCharacters = 0;
  const canonicalAssets = new Map<string, string>();
  for (const [url, value] of Object.entries(assets)) {
    if (!url || typeof value !== 'string' || (url.length > 16_384 && url !== value)) throw new Error('打印图片必须是已验证的内嵌 PNG、JPEG、GIF 或 WebP。');
    if (!canonicalAssets.has(value)) {
      if (!safeRasterDataUri(value)) throw new Error('打印图片必须是已验证的内嵌 PNG、JPEG、GIF 或 WebP。');
      canonicalAssets.set(value, value);imageCharacters += value.length;
      if (canonicalAssets.size > PRINT_LIMITS.imageCount) throw new Error('打印图片数量超过限制。');
      if (imageCharacters > PRINT_LIMITS.imageCharacters) throw new Error('打印图片总大小超过限制。');
    }
    assetKeyCharacters += url.length;
    imageAssets[url] = canonicalAssets.get(value)!;
  }
  const inputDiagnostics = message.diagnostics ?? [];
  if (!Array.isArray(inputDiagnostics) || inputDiagnostics.length > PRINT_LIMITS.diagnostics) throw new Error('打印说明数量或格式不符合要求。');
  const diagnostics: Diagnostic[] = inputDiagnostics.map(item => {
    if (!record(item) || typeof item.code !== 'string' || item.code.length > 100 || typeof item.message !== 'string' || item.message.length > 2_000 || (item.severity !== 'info' && item.severity !== 'warning')) throw new Error('打印说明格式不符合要求。');
    return { code: item.code, message: item.message, severity: item.severity };
  });
  const characters = message.markdown.length + imageCharacters + assetKeyCharacters + diagnostics.reduce((sum, item) => sum + item.code.length + item.message.length, 0);
  return { payload: { markdown: message.markdown, imageAssets, diagnostics }, characters };
}

/** In-memory broker: a worker restart deliberately discards all conversation data. */
export function createPrintBroker(options: BrokerOptions): { onMessage: PrintMessageListener; dispose(): void } {
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const schedule = options.schedule ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const cancel = options.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const sessions = new Map<string, PrintSession>();
  const forget = (token: string): void => { const entry = sessions.get(token); if (entry) { cancel(entry.timer); sessions.delete(token); } };
  const prune = (): void => { for (const [token, entry] of sessions) if (entry.expiresAt <= now()) forget(token); };
  const sourceIsGpt = (sender: chrome.runtime.MessageSender): boolean => {
    if (sender.id !== options.extensionId || sender.frameId !== 0 || !Number.isSafeInteger(sender.tab?.id)) return false;
    try { const url = new URL(sender.url || ''); return url.protocol === 'https:' && (url.hostname === 'chatgpt.com' || url.hostname === 'www.chatgpt.com'); } catch { return false; }
  };
  const sourceIsPrintPage = (sender: chrome.runtime.MessageSender, token: string): boolean => {
    if (sender.id !== options.extensionId || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
    try {
      const actual = new URL(sender.url || ''); const expected = new URL(options.getURL('print.html'));
      return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname && !actual.search && (!actual.hash || actual.hash === '#' + token);
    } catch { return false; }
  };
  const onMessage: PrintMessageListener = (message, sender, respond) => {
    if (!record(message) || (message.type !== 'gpt-md:print-request' && message.type !== 'gpt-md:print-payload')) return undefined;
    prune();
    if (message.type === 'gpt-md:print-payload') {
      if (typeof message.token !== 'string' || !tokenPattern.test(message.token) || !sourceIsPrintPage(sender, message.token)) { respond({ ok: false, error: '打印会话或请求来源无效。' }); return undefined; }
      const entry = sessions.get(message.token);
      if (!entry) { respond({ ok: false, error: '打印数据已过期或后台已重启，请返回 GPT 再次打印。' }); return undefined; }
      respond({ ok: true, payload: entry.payload });
      return undefined;
    }
    if (!sourceIsGpt(sender)) { respond({ ok: false, error: '只接受本扩展在 GPT 主页面发起的打印请求。' }); return undefined; }
    let validated: ReturnType<typeof validatePayload>;
    try {
      validated = validatePayload(message);
      const used = [...sessions.values()].reduce((sum, entry) => sum + entry.characters, 0);
      if (sessions.size >= PRINT_LIMITS.sessions || used + validated.characters > PRINT_LIMITS.cacheCharacters) throw new Error('待打印会话过多，请稍后重试。');
    } catch (error) { respond({ ok: false, error: error instanceof Error ? error.message : '打印数据无效。' }); return undefined; }
    const token = randomUUID();
    if (!tokenPattern.test(token) || sessions.has(token)) { respond({ ok: false, error: '无法创建打印会话，请重试。' }); return undefined; }
    const timer = schedule(() => forget(token), PRINT_SESSION_LIFETIME_MS);
    sessions.set(token, { ...validated, expiresAt: now() + PRINT_SESSION_LIFETIME_MS, timer });
    void options.openTab(options.getURL('print.html') + '#' + token).then(() => respond({ ok: true })).catch(() => { forget(token); respond({ ok: false, error: '无法打开打印页面，请重试。' }); });
    return true;
  };
  return { onMessage, dispose: () => { for (const token of sessions.keys()) forget(token); } };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  const broker = createPrintBroker({ extensionId: chrome.runtime.id, getURL: path => chrome.runtime.getURL(path), openTab: async url => { await chrome.tabs.create({ url, active: true }); } });
  chrome.runtime.onMessage.addListener(broker.onMessage);
}
