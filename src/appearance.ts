export interface Appearance { font: 'sans' | 'serif'; fontSize: number; contentWidth: number; }
export const DEFAULT_APPEARANCE: Readonly<Appearance> = { font: 'sans', fontSize: 18, contentWidth: 800 };
const key = 'answer-markdown-exporter:appearance:v1';
const fonts = {
  sans: '"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",system-ui,sans-serif',
  serif: '"SimSun","Songti SC","Noto Serif CJK SC",serif',
};
export function normalizeAppearance(value: unknown): Appearance {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const bounded = (v: unknown, min: number, max: number, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
  return { font: data.font === 'serif' ? 'serif' : 'sans', fontSize: bounded(data.fontSize, 12, 28, 18), contentWidth: bounded(data.contentWidth, 560, 1400, 800) };
}
export function readAppearance(): Appearance {
  try { return normalizeAppearance(JSON.parse(localStorage.getItem(key) || 'null')); }
  catch { return { ...DEFAULT_APPEARANCE }; }
}
export function saveAppearance(value: Appearance): void {
  try { localStorage.setItem(key, JSON.stringify(normalizeAppearance(value))); } catch { /* A blocked settings store must not block exporting. */ }
}
export function applyAppearance(element: HTMLElement, value: Appearance): void {
  const appearance = normalizeAppearance(value);
  element.style.fontFamily = fonts[appearance.font];
  element.style.fontSize = `${appearance.fontSize}px`;
  element.style.width = '100%'; element.style.maxWidth = `${appearance.contentWidth}px`;
  element.style.marginInline = 'auto'; element.style.minWidth = '0';
}
export const appearanceCss = '.appearance{padding:10px 22px;border-bottom:1px solid #dce3eb;font:13px/1.5 system-ui,sans-serif}.appearance summary{cursor:pointer}.appearance-fields{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding-top:10px}.appearance label{display:flex;align-items:center;gap:6px}.appearance select,.appearance input{font:inherit;color:inherit;background:transparent;border:1px solid #9aa8b5;border-radius:6px;padding:5px}.appearance input{width:66px}.appearance button{font:inherit;padding:5px 8px}.appearance-note{font-size:12px;opacity:.75;margin:8px 0 0}@media print{.appearance{display:none!important}}';
export function appearanceControls(document: Document, initial: Appearance, changed: (value: Appearance) => void): HTMLDetailsElement {
  let value = normalizeAppearance(initial);
  const details = document.createElement('details'); details.className = 'appearance';
  const summary = document.createElement('summary'); details.append(summary);
  const fields = document.createElement('div'); fields.className = 'appearance-fields'; details.append(fields);
  const font = document.createElement('select'); font.setAttribute('aria-label', '正文字体');
  for (const [id, name] of [['sans', '无衬线'], ['serif', '宋体／衬线']]) { const option = document.createElement('option'); option.value = id; option.textContent = name; font.append(option); }
  const size = document.createElement('input'); size.type = 'number'; size.min = '12'; size.max = '28'; size.step = '1'; size.setAttribute('aria-label', '正文字号');
  const width = document.createElement('select'); width.setAttribute('aria-label', '阅读宽度');
  for (const [pixels, name] of [[640, '紧凑'], [800, '舒适'], [960, '宽'], [1200, '宽屏']] as const) { const option = document.createElement('option'); option.value = String(pixels); option.textContent = `${name} · ${pixels}px`; width.append(option); }
  const label = (name: string, control: HTMLElement) => { const element = document.createElement('label'); element.append(name, control); fields.append(element); };
  label('字体', font); label('字号', size); label('阅读宽度', width);
  const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = '恢复默认'; fields.append(reset);
  const note = document.createElement('p'); note.className = 'appearance-note'; note.textContent = '普通表格按内容自然占宽；PDF 沿用字号，宽度受纸张限制。Markdown 的显示由阅读器设置决定。'; details.append(note);
  const refresh = () => { font.value = value.font; size.value = String(value.fontSize); width.value = String(value.contentWidth); summary.textContent = `排版：${value.fontSize}px · ${value.contentWidth}px`; };
  const update = () => { value = normalizeAppearance({ font: font.value, fontSize: size.valueAsNumber, contentWidth: Number(width.value) }); refresh(); changed(value); };
  font.addEventListener('change', update); size.addEventListener('change', update); width.addEventListener('change', update);
  reset.addEventListener('click', () => { value = { ...DEFAULT_APPEARANCE }; refresh(); changed(value); });
  refresh(); return details;
}
