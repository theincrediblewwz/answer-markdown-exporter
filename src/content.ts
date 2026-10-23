import { extractMarkdown } from './extract';
import { renderPreview } from './preview';
import { answerElements, answerContent, cloneAnswerContent, answerKey, generationState, isGenerating, UI_ATTRIBUTE } from './adapter';
import type { ExportResult } from './types';
import { DIAGNOSTICS_MESSAGE, type PageDiagnostics } from './diagnostics';
import mathCss from 'katex/dist/katex.min.css';
import { prepareAssets, zipMarkdown, type PreparedAssets } from './assets';
import { prepareIconImages } from './icons';

type ReadyExport = ExportResult & { assets?: PreparedAssets };
type ExportSnapshot = { answers: Element[]; changed: boolean };

const style = `:host{display:block!important;color-scheme:light dark;font:13px/1.5 system-ui,sans-serif;color:light-dark(#364152,#d0d7e2);width:100%;box-sizing:border-box}*{box-sizing:border-box}button{font:inherit;cursor:pointer;border:1px solid light-dark(#dbe0e7,#445064);border-radius:8px;background:light-dark(#fff,#202938);color:inherit;padding:6px 11px;transition:background .15s}button:hover{background:light-dark(#edf5f4,#293c40)}button:focus-visible{outline:2px solid #2b9a86;outline-offset:3px}button:disabled{opacity:.5;cursor:wait}.bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0 8px;padding-top:10px;border-top:1px solid light-dark(#e6e9ee,#354152)}.label{font-size:11px;letter-spacing:.06em;font-weight:650;color:light-dark(#417a70,#90c8b8);margin-right:3px}.status{font-size:12px;flex-basis:100%;min-height:0;color:light-dark(#667085,#a8b3c4)}.status:empty{display:none}dialog{padding:0;border:1px solid light-dark(#d9e1e6,#465266);border-radius:16px;width:min(1000px,94vw);max-height:90vh;color:light-dark(#253041,#e3e8ef);background:light-dark(#fff,#171e29);box-shadow:0 24px 80px #0005}dialog::backdrop{background:#0b16266b}.head{padding:18px 22px;border-bottom:1px solid light-dark(#e4e9ef,#354152);display:flex;align-items:center;justify-content:space-between;gap:15px}.title{font-size:18px;font-weight:650}.sub{font-size:12px;opacity:.7}.actions{display:flex;gap:8px;flex-wrap:wrap}.body{padding:20px 26px;overflow:auto;max-height:65vh;line-height:1.75;font-size:15px}.body h1,.body h2,.body h3{line-height:1.35}.body table{border-collapse:collapse;display:block;overflow:auto;max-width:100%;font-size:14px}.body td,.body th{padding:8px 12px;border:1px solid light-dark(#dce2e9,#485264);vertical-align:top}.body pre{white-space:pre;overflow:auto;background:light-dark(#f5f7fa,#0e1520);padding:16px;border-radius:9px;line-height:1.55}.body code{font-family:Consolas,monospace;font-size:.9em}.body p code{background:light-dark(#f0f3f7,#283242);padding:1px 4px;border-radius:4px}.body .katex-display{overflow-x:auto;overflow-y:hidden;padding:8px 0}.body a{color:light-dark(#087f72,#7ccebd)}.body blockquote{border-left:3px solid #57a696;margin:15px 0;padding:1px 18px}.body img{max-width:100%}.notes{padding:12px 22px;background:light-dark(#fff9e9,#352e20);font-size:12px;max-height:110px;overflow:auto}.notes:empty{display:none}textarea{width:100%;min-height:420px;resize:vertical;font:13px/1.65 Consolas,monospace;white-space:pre;padding:14px;color:inherit;background:light-dark(#f8fafc,#0e1520);border:1px solid #687585;border-radius:8px}.foot{font-size:11px;opacity:.65;padding:10px 22px;border-top:1px solid light-dark(#e4e9ef,#354152)}@media(max-width:600px){.head{align-items:flex-start;flex-direction:column}.body{padding:15px}.actions{gap:5px}button{padding:6px 8px}}@media(prefers-reduced-motion:reduce){button{transition:none}}`;

const previewImageStyle = 'dialog{overflow:hidden}dialog[open]{display:flex;flex-direction:column}.head,.notes,.foot{flex-shrink:0}.body{min-height:0;flex:1 1 auto}.body img[width="20"][height="20"]{display:inline-block;width:20px;height:20px;margin:0 6px 0 0;vertical-align:-.22em}';
function mathStyles(): string {
  return mathCss.replace(/url\(([^)]+)\)/g, (_match, value: string) => {
    const name = value.replace(/["']/g, '').replace(/^fonts\//, '');
    return `url("${chrome.runtime.getURL('vendor/katex/fonts/' + name)}")`;
  });
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el;
}
function button(text: string, action: () => void): HTMLButtonElement {
  const el = node('button', text); el.type = 'button'; el.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); action(); }); return el;
}
function download(result: ReadyExport): void {
  const packed = result.assets?.hasImages;
  const payload = packed ? new Blob([zipMarkdown({ ...result.assets!, diagnostics: result.diagnostics }) as Uint8Array<ArrayBuffer>], { type: 'application/zip' }) : new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(payload);
  const a = node('a'); a.href = url; a.download = `Answer-${new Date().toISOString().replace(/[:.]/g, '-')}.${packed ? 'zip' : 'md'}`;
  a.hidden = true; a.setAttribute(UI_ATTRIBUTE, 'download'); document.body.append(a);
  try { a.click(); } finally { a.remove(); }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function copy(result: ExportResult): Promise<void> { await navigator.clipboard.writeText(result.markdown); }
function clearPreparingStatus(status: HTMLElement): void {
  if (['正在加载回答中的图片…', '正在准备内容和图片…', '正在准备所选内容和图片…'].includes(status.textContent || '')) status.textContent = '';
}

class ExportControls {
  private entries = new Map<Element, { host: HTMLElement; key: string; status: HTMLElement; buttons: HTMLButtonElement[] }>();
  private observer: MutationObserver;
  private raf = 0;
  private url = location.href;
  private modalHost: HTMLElement | null = null;
  private closed = false;
  private generation = 0;
  private selected = new Set<Element>();
  private tray: HTMLElement | null = null;
  private lastError: string | null = null;
  private assetCache: { markdown: string; promise: Promise<PreparedAssets> } | null = null;
  private assetAbort = new AbortController();
  private pending = new Set<Element>();
  private snapshots = new Set<ExportSnapshot>();
  constructor() {
    this.observer = new MutationObserver(changes => this.observeChanges(changes));
    this.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-streaming', 'aria-busy', 'data-talvt-turn-state', 'data-message-complete', 'data-message-role', 'data-message-channel', 'data-message-type', 'data-testid', 'aria-label', 'data-turn-id', 'data-turn-key', 'data-message-id', 'data-message-author-role', 'data-assistant-markdown-root', 'data-assistant-markdown', 'data-conversation-role', 'data-markdown-text-style', 'data-chatgpt-search-unit-key', 'class', 'src', 'srcset', 'alt', 'title', 'href', 'data-math-source', 'data-math-display', 'encoding', 'rowspan', 'colspan', 'start'] });
    window.addEventListener('popstate', this.onRoute);
    chrome.runtime.onMessage?.addListener(this.onMessage);
    this.rescan();
  }
  private observeChanges(changes: MutationRecord[]): void {
    const relevant = changes.filter(change => {
      const element = change.target instanceof Element ? change.target : change.target.parentElement;
      if (element?.closest(`[${UI_ATTRIBUTE}]`)) return false;
      // Ignore unrelated hover/theme class changes on this busy single-page app.
      if (change.type === 'attributes' && change.attributeName === 'class') return /(?:^|\s)result-streaming(?:\s|$)/.test(change.oldValue || '') || !!element?.classList.contains('result-streaming');
      return true;
    });
    for (const snapshot of this.snapshots) {
      if (snapshot.changed) continue;
      snapshot.changed = relevant.some(change => {
        const element = change.target instanceof Element ? change.target : change.target.parentElement;
        return snapshot.answers.some(answer => !!element && (answer === element || answer.contains(element)
          || (change.type === 'attributes' && element.contains(answer)))
          || [...change.removedNodes].some(removed => removed === answer || removed.contains(answer)));
      });
    }
    if (relevant.length) this.schedule();
  }
  private watchSnapshot(answers: Element[]): ExportSnapshot {
    // Lazy image preparation may legitimately mutate the live answer. Flush those
    // records before fixing the snapshot; later mutations invalidate only active exports.
    this.observeChanges(this.observer.takeRecords());
    const snapshot = { answers, changed: false };this.snapshots.add(snapshot);return snapshot;
  }
  private snapshotCurrent(snapshot: ExportSnapshot | undefined): boolean {
    if (!snapshot) return true;
    this.observeChanges(this.observer.takeRecords());
    return !snapshot.changed;
  }
  private onRoute = () => this.schedule();
  private onMessage = (message: unknown, sender: chrome.runtime.MessageSender, respond: (response: PageDiagnostics) => void): void => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object' || !('type' in message) || message.type !== DIAGNOSTICS_MESSAGE) return;
    if ('rescan' in message && message.rescan === true) this.rescan();
    respond(this.diagnostics());
  };
  rescan(): void {
    if (this.closed) return;
    try { this.scan(); this.lastError = null; }
    catch (error) { this.lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
  }
  diagnostics(): PageDiagnostics {
    const selectors = ['[data-message-author-role="assistant"]', '[data-assistant-markdown-root]', '[data-assistant-markdown]', '[data-conversation-role="assistant"]', '[data-markdown-text-style="assistant-message"]', '[data-chatgpt-search-unit-key$=":assistant"]', 'article[data-turn="assistant"]', '[data-testid^="conversation-turn-"][data-turn="assistant"]', 'main .markdown', '.markdown'];
    const hosts = [...this.entries.values()].map(entry => entry.host).filter(host => host.isConnected);
    return {
      version: typeof __EXTENSION_VERSION__ === 'undefined' ? 'development' : __EXTENSION_VERSION__,
      host: location.hostname, readyState: document.readyState,
      answerCount: answerElements().length, controlCount: hosts.length,
      visibleControlCount: hosts.filter(host => !!host.getClientRects().length && getComputedStyle(host).visibility !== 'hidden').length,
      selectorCounts: Object.fromEntries(selectors.map(selector => [selector, document.querySelectorAll(selector).length])),
      error: this.lastError,
    };
  }
  private schedule(): void { if (!this.closed && !this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.rescan(); }); }
  private async revealImages(answers: Element[], current: () => boolean, status: HTMLElement): Promise<void> {
    const missing = answers.flatMap(answer => [...answer.querySelectorAll<HTMLElement>('[data-d-component="image"]')])
      .filter(image => !image.querySelector('img[src]')).slice(0, 30);
    if (!missing.length || !current()) return;
    status.textContent = '正在加载回答中的图片…';
    const positions = new Map<Element, { top: number; left: number }>();
    for (const image of missing) {
      for (let parent = image.parentElement; parent; parent = parent.parentElement) {
        if (!positions.has(parent)) positions.set(parent, { top: parent.scrollTop, left: parent.scrollLeft });
      }
    }
    const scrolling = document.scrollingElement;
    if (scrolling && !positions.has(scrolling)) positions.set(scrolling, { top: scrolling.scrollTop, left: scrolling.scrollLeft });
    const deadline = Date.now() + 12_000;
    try {
      for (const [index, image] of missing.entries()) {
        if (!current() || Date.now() >= deadline) return;
        if (!image.isConnected || image.querySelector('img[src]')) continue;
        image.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
        const until = Date.now() + Math.floor((deadline - Date.now()) / (missing.length - index));
        while (current() && image.isConnected && !image.querySelector('img[src]') && Date.now() < until) {
          await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, until - Date.now()))));
        }
      }
    } finally {
      if (current()) for (const [element, position] of positions) {
        if (!element.isConnected) continue;
        if (element.scrollTo) element.scrollTo({ top: position.top, left: position.left, behavior: 'instant' });
        else { element.scrollTop = position.top; element.scrollLeft = position.left; }
      }
    }
  }
  private async prepare(result: ExportResult): Promise<ReadyExport> {
    if (this.assetCache?.markdown !== result.markdown) this.assetCache = { markdown: result.markdown, promise: prepareAssets(result.markdown, { signal: this.assetAbort.signal }) };
    const cache = this.assetCache!;
    try {
      const assets = await cache.promise;
      if (assets.diagnostics.some(item => item.severity === 'warning') && this.assetCache === cache) this.assetCache = null;
      const saved = Object.keys(assets.files).length ? [{ code: 'IMAGE_BUNDLE', severity: 'info' as const, message: '图片已保存至 ZIP 的 images 目录；复制的 Markdown 需与该目录一起使用。' }] : [];
      return { ...result, markdown: assets.markdown, assets, diagnostics: [...result.diagnostics, ...assets.diagnostics, ...saved] };
    } catch (error) { if (this.assetCache === cache) this.assetCache = null; throw error; }
  }
  private async capture(answers: Element[], current: () => boolean): Promise<ExportResult[]> {
    const clones = answers.map(cloneAnswerContent);
    const group = node('div'); group.append(...clones);
    const diagnostics = await prepareIconImages(group, { signal: this.assetAbort.signal, current });
    if (!current()) return [];
    return clones.map((clone, index) => {
      const result = extractMarkdown(clone);
      return index === 0 ? { ...result, diagnostics: [...diagnostics, ...result.diagnostics] } : result;
    });
  }
  private async print(result: ReadyExport): Promise<void> {
    const imageAssets = Object.fromEntries(Object.entries(result.assets?.imageAssets || {}).filter(([key]) => key.startsWith('images/')));
    const response = await chrome.runtime.sendMessage({ type: 'gpt-md:print-request', markdown: result.markdown, imageAssets, diagnostics: result.diagnostics });
    if (!response?.ok) throw new Error(response?.error || '无法准备 PDF，请重试。');
  }
  private scan(): void {
    if (this.url !== location.href) { this.generation += 1; this.url = location.href; this.modalHost?.remove(); this.modalHost = null; this.assetAbort.abort(); this.assetAbort = new AbortController(); this.assetCache = null; this.clearSelection(); }
    const answers = answerElements(); const state = generationState(answers);
    const ready = answers.filter(answer => !isGenerating(answer, state) && (answer.textContent?.trim() || answer.querySelector('img, math')));
    const currentAnswers = new Set(ready);
    for (const [answer, entry] of this.entries) {
      if (!currentAnswers.has(answer) || !entry.host.isConnected || entry.key !== answerKey(answer)) { entry.host.remove(); this.entries.delete(answer); if (this.selected.delete(answer)) this.updateTray(); }
    }
    for (const answer of ready) {
      let entry = this.entries.get(answer);
      if (!entry) {
        const host = node('div'); host.setAttribute(UI_ATTRIBUTE, 'controls');
        const shadow = host.attachShadow({ mode: 'open' }); shadow.append(node('style', style));
        const bar = node('div'); bar.className = 'bar'; bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', '回答导出');
        const label = node('span', 'MD'); label.className = 'label'; bar.append(label);
        const status = node('div'); status.className = 'status'; status.setAttribute('role', 'status');
        const run = async (kind: 'download' | 'copy' | 'preview' | 'pdf') => {
          if (this.pending.has(answer)) return;
          if (isGenerating(answer)) { status.textContent = '回答仍在生成，请完成后导出。'; return; }
          const route = location.href; const key = answerKey(answer); const generation = this.generation;
          let snapshot: ExportSnapshot | undefined;
          const current = () => !this.closed && this.snapshotCurrent(snapshot) && answer.isConnected && host.isConnected && location.href === route && answerKey(answer) === key && this.generation === generation && !isGenerating(answer);
          this.pending.add(answer); buttons.forEach(button => { button.disabled = true; });
          try {
            await this.revealImages([answerContent(answer)], current, status); if (!current()) return;
            snapshot = this.watchSnapshot([answerContent(answer)]);
            status.textContent = '正在准备内容和图片…';
            const captured = await this.capture([answerContent(answer)], current); if (!current()) return;
            const result = await this.prepare(captured[0]);
            if (!current()) return;
            if (!result.markdown.trim()) throw new Error('没有找到可导出的回答正文。');
            const note = result.diagnostics.length ? `；${result.diagnostics.length} 项说明，可在预览中查看` : '';
            if (kind === 'download') { download(result); status.textContent = (result.assets?.hasImages ? 'Markdown 图片包 ZIP 已生成' : 'Markdown 已生成') + note; }
            else if (kind === 'copy') {
              try { await copy(result); if (current()) status.textContent = 'Markdown 已复制' + note; }
              catch { if (current()) { status.textContent = '复制被浏览器阻止，请在预览的源码页手动复制。'; await this.preview(result); } }
            }
            else if (kind === 'pdf') { await this.print(result); if (current()) status.textContent = '已打开 PDF 打印页，请选择“另存为 PDF”' + note; }
            else {
              const ready = await this.preview(result);
              if (current()) status.textContent = ready ? 'Markdown 预览已生成' + note : '预览已关闭';
            }
          } catch (error) { if (current()) status.textContent = error instanceof Error ? error.message : String(error); }
          finally { if (snapshot) this.snapshots.delete(snapshot); clearPreparingStatus(status); this.pending.delete(answer); this.rescan(); }
        };
        const buttons = [button('下载 Markdown', () => { void run('download'); }), button('复制', () => { void run('copy'); }), button('预览', () => { void run('preview'); }), button('导出 PDF', () => { void run('pdf'); })];
        const selectLabel = node('label'); selectLabel.style.cssText = 'margin-left:auto;display:flex;align-items:center;gap:5px;font-size:12px';
        const check = node('input'); check.type = 'checkbox'; check.setAttribute('aria-label', '选择这条回答');
        check.addEventListener('change', () => { if (check.checked) this.selected.add(answer); else this.selected.delete(answer); this.updateTray(); });
        selectLabel.append(check, node('span', '选择')); bar.append(...buttons, selectLabel, status); shadow.append(bar);
        answer.insertAdjacentElement('afterend', host);
        entry = { host, key: answerKey(answer), status, buttons }; this.entries.set(answer, entry);
      }
      if (entry.host.previousElementSibling !== answer) answer.insertAdjacentElement('afterend', entry.host);
      entry.buttons.forEach(b => { b.disabled = this.pending.has(answer); });
    }
  }
  private clearSelection(): void {
    this.selected.clear();
    for (const entry of this.entries.values()) { const check = entry.host.shadowRoot?.querySelector<HTMLInputElement>('input[type="checkbox"]'); if (check) check.checked = false; }
    this.updateTray();
  }
  private updateTray(): void {
    this.tray?.remove(); this.tray = null;
    if (!this.selected.size || this.closed) return;
    const host = node('div'); host.setAttribute(UI_ATTRIBUTE, 'selection');
    host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483000;width:auto;max-width:calc(100vw - 40px)';
    const shadow = host.attachShadow({ mode: 'open' }); shadow.append(node('style', style + '.bar{background:light-dark(#fff,#202938);padding:12px;border:1px solid #7f9f98;border-radius:12px;box-shadow:0 6px 28px #0003;margin:0}.status{max-width:400px}'));
    const bar = node('div'); bar.className = 'bar'; bar.append(node('span', `已选 ${this.selected.size} 条`));
    const status = node('div'); status.className = 'status'; status.setAttribute('role', 'status');
    let pending = false;
    const run = async (kind: 'download' | 'copy' | 'preview' | 'pdf') => {
      if (pending) return;
      const route = location.href; const generation = this.generation;
      const answers = answerElements().filter(answer => this.selected.has(answer));
      const keys = answers.map(answer => answerKey(answer));
      let snapshot: ExportSnapshot | undefined;
      const current = () => !this.closed && this.snapshotCurrent(snapshot) && host.isConnected && location.href === route && this.generation === generation
        && answers.every((answer, index) => answer.isConnected && this.selected.has(answer) && answerKey(answer) === keys[index] && !isGenerating(answer));
      pending = true; actions.forEach(action => { action.disabled = true; });
      try {
        if (!answers.length) throw new Error('选中的回答已离开页面，请重新选择。');
        if (answers.some(answer => isGenerating(answer))) throw new Error('选中的回答仍在生成，请完成后导出。');
        await this.revealImages(answers.map(answerContent), current, status); if (!current()) return;
        snapshot = this.watchSnapshot(answers.map(answerContent));
        const results = await this.capture(answers.map(answerContent), current); if (!current()) return;
        const combined: ExportResult = {
          markdown: results.map(item => item.markdown).join('\n---\n\n'),
          diagnostics: [{code:'LOADED_SELECTION',severity:'info',message:`本次仅含按页面顺序选中的 ${answers.length} 条已加载回答。`}, ...results.flatMap(item => item.diagnostics)],
          formulas: results.flatMap(item => item.formulas), codeBlocks: results.flatMap(item => item.codeBlocks),
        };
        status.textContent = '正在准备所选内容和图片…';
        const result = await this.prepare(combined); if (!current()) return;
        if (kind === 'download') { download(result); status.textContent = '已生成所选回答的 Markdown'; }
        else if (kind === 'preview') {
          const ready = await this.preview(result);
          if (current()) status.textContent = ready ? '所选回答的 Markdown 预览已生成' : '预览已关闭';
        }
        else if (kind === 'pdf') { await this.print(result); if (current()) status.textContent = '已打开 PDF 打印页'; }
        else {
          try { await copy(result); if (current()) status.textContent = '已复制所选回答'; }
          catch { if (current()) { status.textContent = '复制受限，请在预览源码页手动复制。'; await this.preview(result); } }
        }
      } catch (error) { if (current()) status.textContent = error instanceof Error ? error.message : String(error); }
      finally { if (snapshot) this.snapshots.delete(snapshot); clearPreparingStatus(status); pending = false; actions.forEach(action => { action.disabled = false; }); }
    };
    const actions = [button('下载 Markdown', () => { void run('download'); }), button('复制', () => { void run('copy'); }), button('预览', () => { void run('preview'); }), button('导出 PDF', () => { void run('pdf'); }), button('清空选择', () => this.clearSelection())];
    bar.append(...actions, status);
    shadow.append(bar); document.body.append(host); this.tray = host;
  }
  private async preview(result: ReadyExport): Promise<boolean> {
    this.modalHost?.remove();
    const host = node('div'); host.setAttribute(UI_ATTRIBUTE, 'preview'); document.body.append(host); this.modalHost = host;
    const shadow = host.attachShadow({ mode: 'open' }); shadow.append(node('style', style + previewImageStyle + mathStyles()));
    const dialog = node('dialog'); const header = node('div'); header.className = 'head';
    const title = node('div'); title.append(node('div', 'Markdown 预览')); title.firstElementChild!.className = 'title';
    const subtitle = node('div', `${result.formulas.length} 个公式 · ${result.codeBlocks.length} 个代码块 · 本地处理`); subtitle.className = 'sub'; title.append(subtitle);
    const actions = node('div'); actions.className = 'actions'; const body = node('div'); body.className = 'body'; body.textContent = '正在渲染…';
    const close = () => { dialog.close(); host.remove(); if (this.modalHost === host) this.modalHost = null; };
    let source = false; let html = '';
    const view = button('查看源码', () => { source = !source; view.textContent = source ? '查看预览' : '查看源码'; body.replaceChildren(); if (source) { const area = node('textarea'); area.readOnly = true; area.value = result.markdown; area.setAttribute('aria-label', 'Markdown 源码'); body.append(area); } else body.innerHTML = html; });
    actions.append(view, button('复制', () => { void copy(result).then(() => { notes.hidden = false; feedback.textContent = '已复制 Markdown'; }).catch(() => { notes.hidden = false; feedback.textContent = '请切到源码页手动复制。'; }); }), button('下载', () => download(result)), button('导出 PDF', () => { void this.print(result).catch(error => { notes.hidden = false; feedback.textContent = String(error); }); }), button('关闭', close));
    header.append(title, actions); const notes = node('div'); notes.className = 'notes'; const feedback = node('span'); feedback.setAttribute('role', 'status');
    notes.hidden = !result.diagnostics.length && !result.formulas.length; notes.append(feedback); for (const item of result.diagnostics) notes.append(node('div', item.message));
    if (result.formulas.length) {
      const details = node('details'); details.append(node('summary', `查看 ${result.formulas.length} 个公式的捕获源码`));
      result.formulas.forEach((formula, index) => {
        const origin = {attribute:'页面公式源码',annotation:'TeX 标注',missing:'源码缺失'}[formula.sourceKind];
        details.append(node('div', `公式 ${index + 1} · ${formula.display ? '块公式' : '行内公式'} · ${origin}`));
        const raw = node('pre', formula.rawSource || '页面未保留可确认的公式源码。'); raw.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 Consolas,monospace;margin:5px 0 12px'; details.append(raw);
      }); notes.append(details);
    }
    const foot = node('div', '预览读取的就是导出 Markdown。仅含本次选择的已加载回答；页面未保留的原始写法无法恢复。'); foot.className = 'foot';
    dialog.append(header, notes, body, foot); shadow.append(dialog); dialog.addEventListener('cancel', close); dialog.showModal();
    const rendered = await renderPreview(result.markdown, { imageAssets: result.assets?.imageAssets });
    if (!host.isConnected || this.modalHost !== host) return false;
    html = rendered.html; if (!source) body.innerHTML = html;
    if (rendered.diagnostics.length) notes.hidden = false;
    for (const item of rendered.diagnostics) notes.append(node('div', item.message));
    return true;
  }
  destroy(): void { this.closed = true; this.assetAbort.abort(); this.assetCache = null; this.observer.disconnect(); cancelAnimationFrame(this.raf); window.removeEventListener('popstate', this.onRoute); chrome.runtime.onMessage?.removeListener(this.onMessage); this.entries.forEach(entry => entry.host.remove()); this.entries.clear(); this.modalHost?.remove(); this.tray?.remove(); this.selected.clear(); }
}
const runtime = globalThis as typeof globalThis & { __gptMarkdownControls?: ExportControls };
runtime.__gptMarkdownControls?.destroy();
runtime.__gptMarkdownControls = new ExportControls();
