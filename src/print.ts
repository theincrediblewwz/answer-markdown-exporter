import { renderPreview } from './preview';
import type { Diagnostic, PreviewResult } from './types';
import type { PrintPayload } from './background';
import printCss from './print.css';
import mathCss from 'katex/dist/katex.min.css';

const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rasterPattern = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag); if (text !== undefined) result.textContent = text; return result;
}
function styles(): void {
  const style = node('style');
  style.textContent = printCss + '\n' + mathCss.replace(/url\(([^)]+)\)/g, (_match, value: string) => {
    const name = value.replace(/["']/g, '').replace(/^fonts\//, '');
    return `url("${chrome.runtime.getURL('vendor/katex/fonts/' + name)}")`;
  });
  document.head.append(style);
}
function waitAtMost(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    void promise.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(false); });
  });
}

async function initializePrintPage(): Promise<void> {
  styles(); document.title = '回答导出 PDF';
  const tools = node('header');tools.id = 'print-tools';tools.append(node('h1', 'PDF 预览'));
  const printButton = node('button', '打印／另存为 PDF');printButton.type = 'button';printButton.disabled = true;tools.append(printButton);
  const status = node('p', '正在准备打印内容…');status.id = 'print-status';status.setAttribute('role', 'status');
  const notes = node('details');notes.id = 'print-diagnostics';notes.hidden = true;notes.append(node('summary', '导出说明'));const noteList = node('ul');notes.append(noteList);
  const content = node('main');content.id = 'print-content';document.body.replaceChildren(tools, status, notes, content);
  const addNotes = (diagnostics: Diagnostic[]): void => { for (const diagnostic of diagnostics) noteList.append(node('li', diagnostic.message)); if (diagnostics.length) notes.hidden = false; };
  const token = location.hash.slice(1);
  if (!tokenPattern.test(token)) { status.textContent = '打印链接无效，请返回 GPT 再次打印。';return; }
  try {
    const response = await chrome.runtime.sendMessage({ type: 'gpt-md:print-payload', token });
    if (!response?.ok || !response.payload || typeof response.payload.markdown !== 'string') throw new Error(response?.error || '未取得打印数据，请返回 GPT 再次打印。');
    const payload = response.payload as PrintPayload;
    const renderer = renderPreview as (markdown: string, options?: { imageAssets?: Record<string, string> }) => Promise<PreviewResult>;
    const rendered = await renderer(payload.markdown, { imageAssets: payload.imageAssets });
    // Keep detached markup inert until all image sources have been checked.
    const template = node('template');template.innerHTML = rendered.html;
    const approvedImages = new Set(Object.values(payload.imageAssets || {}).filter(value => rasterPattern.test(value)));
    let blockedImages = 0;
    for (const image of template.content.querySelectorAll('img')) {
      const source = image.getAttribute('src') || '';
      if (!rasterPattern.test(source) || !approvedImages.has(source)) { image.replaceWith(node('span', `［${image.alt || '图片'}：未取得可打印的本地图片］`));blockedImages++;continue; }
      image.removeAttribute('srcset');image.loading = 'eager';image.decoding = 'async';image.referrerPolicy = 'no-referrer';
    }
    for (const element of template.content.querySelectorAll('iframe,object,embed,audio,video,source,link,script')) element.remove();
    for (const element of template.content.querySelectorAll('[srcset]')) element.removeAttribute('srcset');
    content.append(template.content);
    addNotes([...(payload.diagnostics || []), ...rendered.diagnostics]);
    if (blockedImages) addNotes([{ code: 'print-image-unavailable', severity: 'warning', message: `${blockedImages} 张图片未取得已验证的本地资源，打印中保留占位说明。` }]);
    const heading = content.querySelector('h1')?.textContent?.trim();if (heading) document.title = heading.slice(0, 80) + ' - PDF';
    void content.getBoundingClientRect();
    const fontsReady = !document.fonts || await waitAtMost(document.fonts.ready, 8000);
    if (!fontsReady) addNotes([{ code: 'print-font-timeout', severity: 'warning', message: '部分字体未在等待时间内准备好，可稍后再次打印。' }]);
    const images = Array.from(content.querySelectorAll('img'));
    const imageReady = await Promise.all(images.map(image => waitAtMost(typeof image.decode === 'function' ? image.decode() : Promise.resolve(), 8000)));
    if (imageReady.some(ready => !ready)) addNotes([{ code: 'print-image-decode', severity: 'warning', message: '部分图片未能完整解码，请在预览中核对后再打印。' }]);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const print = (): void => { try { window.print(); } catch { status.textContent = '无法打开打印对话框，请点击“打印／另存为 PDF”重试。'; } };
    printButton.addEventListener('click', print);printButton.disabled = false;
    const resourcesReady = fontsReady && imageReady.every(Boolean);
    status.textContent = resourcesReady
      ? '内容已准备好，默认打印布局已去除浏览器网址页脚。选择“另存为 PDF”可保留可选择文字；若自行设置了打印边距，请同时关闭“页眉和页脚”。'
      : '部分字体或图片未准备好，已暂停自动打印；请核对导出说明和预览，准备好后点击“打印／另存为 PDF”。';
    const automaticKey = 'gpt-md-print-auto:' + token;
    if (resourcesReady && !sessionStorage.getItem(automaticKey)) { sessionStorage.setItem(automaticKey, 'opened');print(); }
  } catch (error) { status.textContent = error instanceof Error ? error.message : '打印准备失败，请返回 GPT 再次打印。'; }
}

void initializePrintPage();
