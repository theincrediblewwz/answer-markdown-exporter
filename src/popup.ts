import { DIAGNOSTICS_MESSAGE, type PageDiagnostics } from './diagnostics';

const status = document.querySelector<HTMLElement>('#status')!;
const details = document.querySelector<HTMLPreElement>('#details')!;
const retry = document.querySelector<HTMLButtonElement>('#retry')!;
const copy = document.querySelector<HTMLButtonElement>('#copy')!;
let report = '';

async function detect(): Promise<void> {
  retry.disabled = true; copy.disabled = true; report = ''; details.textContent = '';
  status.textContent = '正在检测当前标签页…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error('没有当前标签页');
    const result: PageDiagnostics = await chrome.tabs.sendMessage(tab.id, { type: DIAGNOSTICS_MESSAGE, rescan: true });
    if (!result || typeof result.version !== 'string') throw new Error('页面没有返回检测结果');
    report = JSON.stringify(result, null, 2); details.textContent = report; copy.disabled = false;
    if (result.error) status.textContent = '页面脚本运行出错，请复制检测信息反馈。';
    else if (!result.answerCount) status.textContent = '脚本已运行，但未识别到回答。若页面已有回答，请复制检测信息反馈。';
    else if (!result.controlCount) status.textContent = `识别到 ${result.answerCount} 条回答，但按钮尚未生成。请复制检测信息反馈。`;
    else status.textContent = `已识别 ${result.answerCount} 条回答，已生成 ${result.controlCount} 组导出按钮。按钮位于各条回答末尾。`;
  } catch {
    status.textContent = '当前标签页的页面脚本未响应。请在 chatgpt.com 的对话页打开此弹窗；更新扩展后需刷新对话页。';
  } finally { retry.disabled = false; }
}
retry.addEventListener('click', () => { void detect(); });
copy.addEventListener('click', () => {
  if (!report) return;
  void navigator.clipboard.writeText(report).then(() => { copy.textContent = '已复制检测信息'; }).catch(() => { copy.textContent = '复制受限，可选中下方信息复制'; });
});
void detect();
