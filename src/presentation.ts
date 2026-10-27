import { excludedContent } from './content-policy';
import { layoutStyle } from './layout';

export const presentationClasses = ['gpt-md-group', 'gpt-md-inline-row', 'gpt-md-bordered', 'gpt-md-surface', 'gpt-md-align-left', 'gpt-md-align-center', 'gpt-md-align-right', 'gpt-md-small', 'gpt-md-muted', 'gpt-md-medium', 'gpt-md-badge', 'gpt-md-badge-success', 'gpt-md-badge-warning', 'gpt-md-badge-danger', 'gpt-md-meter', 'gpt-md-meter-fill'] as const;

export function contentAlignment(element: Element): 'left' | 'center' | 'right' | null {
  if (element.getAttribute('data-d-component') === 'box') {
    const own = element.getAttribute('data-d-align');
    if (own === 'center') return 'center';
    if (own === 'end') return 'right';
    if (own === 'start') return 'left';
  }
  const align = layoutStyle(element, 'text-align');
  return /^(?:left|center|right)$/.test(align) ? align as 'left' | 'center' | 'right' : null;
}

function opaqueHex(value: string): string | null {
  const hex = /^#([\da-f]{6})$/i.exec(value.trim());
  if (hex) return hex[1].toLowerCase();
  const rgb = /^rgba?\(\s*(\d{1,3})[, ]+\s*(\d{1,3})[, ]+\s*(\d{1,3})(?:\s*[,/]\s*(1(?:\.0*)?))?\s*\)$/.exec(value.trim());
  if (!rgb || rgb.slice(1, 4).some(v => Number(v) > 255)) return null;
  return rgb.slice(1, 4).map(v => Number(v).toString(16).padStart(2, '0')).join('');
}

export function groupAttributes(element: Element): string {
  const classes = ['gpt-md-group'];
  const styles = ['display:flex', 'flex-direction:column', 'gap:8px', 'min-width:0', 'max-width:100%', 'margin:12px 0'];
  if (element.hasAttribute('data-d-has-border') || (parseFloat(layoutStyle(element, 'border-top-width')) > 0 && !/^(?:none|hidden)$/.test(layoutStyle(element, 'border-top-style')))) {
    classes.push('gpt-md-bordered'); styles.push('border:1px solid #d7dce2', 'border-radius:10px', 'padding:12px');
  }
  const background = opaqueHex(layoutStyle(element, 'background-color'));
  if (background && background !== 'ffffff' && background !== '000000') {
    classes.push('gpt-md-surface'); styles.push('background:#f5f7f9', 'border-radius:8px', 'padding:12px');
  }
  const align = contentAlignment(element);
  if (align) { classes.push(`gpt-md-align-${align}`); styles.push(`text-align:${align}`); }
  return `class="${classes.join(' ')}" style="${styles.join(';')}"`;
}

/** Recognize bounded, visible CSS bars; never execute component expressions. */
export function meterMarkup(element: Element): string | null {
  if (element.getAttribute('data-d-component') !== 'box' || excludedContent(element) || /\S/.test(element.textContent || '')) return null;
  const children = Array.from(element.children).filter(child => !excludedContent(child));
  if (children.length !== 1) return null;
  const fill = children[0];
  if (fill.getAttribute('data-d-component') !== 'box' || fill.childElementCount || /\S/.test(fill.textContent || '')) return null;
  const height = /^([\d.]+)px$/.exec(layoutStyle(element, 'height'));
  const color = opaqueHex(layoutStyle(fill, 'background-color'));
  if (!height || Number(height[1]) <= 0 || Number(height[1]) > 64 || !color) return null;
  const inlineWidth = (fill as HTMLElement).style?.width || '';
  const percentage = /^([\d.]+)%$/.exec(inlineWidth);
  let ratio = percentage ? Number(percentage[1]) : NaN;
  if (!Number.isFinite(ratio)) {
    const parentWidth = /^([\d.]+)px$/.exec(layoutStyle(element, 'width'));
    const fillWidth = /^([\d.]+)px$/.exec(layoutStyle(fill, 'width'));
    if (parentWidth && fillWidth && Number(parentWidth[1]) > 0) ratio = Number(fillWidth[1]) / Number(parentWidth[1]) * 100;
  }
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 100) return null;
  ratio = Math.round(ratio * 10000) / 10000;
  const pixels = Math.round(Number(height[1]) * 100) / 100;
  return `<div class="gpt-md-meter" role="img" aria-label="比例条：${ratio}%" data-gpt-md-ratio="${ratio}" data-gpt-md-bar-color="${color}" data-gpt-md-bar-height="${pixels}" style="width:100%;height:${pixels}px;background:#edf0f2;border-radius:4px;overflow:hidden"><span class="gpt-md-meter-fill" style="display:block;width:${ratio}%;height:100%;background:#${color};border-radius:inherit"></span></div>`;
}

export function fixedColumnWidth(element: Element): number | null {
  if (element.getAttribute('data-d-component') === 'icon') return 24;
  if (element.getAttribute('data-d-component') === 'badge') return Math.min(160, Math.max(40, Math.ceil(parseFloat(layoutStyle(element, 'width')) || 48)));
  // Only explicitly sized labels get fixed columns. A flexible bar/card grows.
  if (!element.hasAttribute('data-d-has-width') || !element.matches('[data-d-component="text"],[data-d-component="caption"]')) return null;
  const width = parseFloat(layoutStyle(element, 'width'));
  return width > 0 && width <= 256 ? Math.ceil(width) : null;
}
