import type { Diagnostic } from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const MAX_CHARACTERS = 250_000;
const MAX_NODES = 3_000;
const MAX_DEPTH = 32;
const MAX_DIAGRAMS = 20;
const MAX_PIXELS = 4_000_000;
const MAX_TOTAL_PIXELS = 16_000_000;
const MAX_TOTAL_CHARACTERS = 1_000_000;
const MAX_PNG_CHARACTERS = 8_000_000;
const MAX_TOTAL_PNG_CHARACTERS = 24_000_000;
const MAX_CACHE_CHARACTERS = 12_000_000;
const MAX_CACHE_ENTRIES = 16;
const TOTAL_MS = 8_000;
const EACH_MS = 2_000;
// Match answer extraction's exclusions before replacing a graphic with a new IMG.
const ignoredAnswerContent = 'script,style,noscript,template,button:not([data-message-image="original"][aria-haspopup="dialog"]),input,textarea,select,[hidden],[data-gpt-md-ui],[data-gpt-md-ignore],[data-message-content-controls],[data-markdown-copy="exclude"],h4[data-conversation-role="assistant"][tabindex="-1"]:not([data-d-component]),[role="toolbar"],[aria-hidden="true"],pre,code';
const hiddenGraphicContent = '[hidden],[aria-hidden="true"],[data-gpt-md-ui],[data-gpt-md-ignore],[data-markdown-copy="exclude"]';
const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
const scalarPattern = new RegExp(`^${NUMBER}$`);
const numberListPattern = new RegExp(`^${NUMBER}(?:[\\s,]+${NUMBER})*$`);
const lengthPattern = new RegExp(`^(${NUMBER})(%|px)?$`);
const resourceKinds = new Set(['marker', 'pattern', 'linearGradient', 'radialGradient', 'clipPath']);
const paintKinds = new Set(['pattern', 'linearGradient', 'radialGradient']);
const elements: Record<string, Set<string>> = {
  svg: new Set(['viewBox', 'width', 'height', 'preserveAspectRatio']),
  g: new Set(), defs: new Set(),
  path: new Set(['d', 'pathLength']),
  rect: new Set(['x', 'y', 'width', 'height', 'rx', 'ry', 'pathLength']),
  circle: new Set(['cx', 'cy', 'r', 'pathLength']),
  ellipse: new Set(['cx', 'cy', 'rx', 'ry', 'pathLength']),
  line: new Set(['x1', 'y1', 'x2', 'y2', 'pathLength']),
  polyline: new Set(['points', 'pathLength']), polygon: new Set(['points', 'pathLength']),
  text: new Set(['x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust']),
  tspan: new Set(['x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust']),
  title: new Set(), desc: new Set(),
  marker: new Set(['viewBox', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'markerUnits', 'preserveAspectRatio']),
  pattern: new Set(['x', 'y', 'width', 'height', 'patternUnits', 'patternContentUnits', 'patternTransform', 'viewBox', 'preserveAspectRatio']),
  linearGradient: new Set(['x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod']),
  radialGradient: new Set(['cx', 'cy', 'r', 'fx', 'fy', 'fr', 'gradientUnits', 'gradientTransform', 'spreadMethod']),
  stop: new Set(['offset', 'stop-color', 'stop-opacity']),
  clipPath: new Set(['clipPathUnits']),
};
const presentation = new Set([
  'fill', 'stroke', 'color', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-dasharray', 'stroke-dashoffset', 'fill-rule', 'clip-rule', 'opacity', 'fill-opacity', 'stroke-opacity',
  'transform', 'vector-effect', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
  'dominant-baseline', 'alignment-baseline', 'letter-spacing', 'word-spacing', 'text-decoration',
  'marker-start', 'marker-mid', 'marker-end', 'clip-path', 'stop-color', 'stop-opacity', 'visibility', 'display',
]);
const enums: Record<string, RegExp> = {
  'stroke-linecap': /^(?:butt|round|square)$/,
  'stroke-linejoin': /^(?:miter|round|bevel)$/,
  'fill-rule': /^(?:nonzero|evenodd)$/, 'clip-rule': /^(?:nonzero|evenodd)$/,
  'vector-effect': /^(?:none|non-scaling-stroke)$/,
  'font-style': /^(?:normal|italic|oblique)$/,
  'font-weight': /^(?:normal|bold|[1-9]00)$/,
  'text-anchor': /^(?:start|middle|end)$/,
  'dominant-baseline': /^(?:auto|alphabetic|central|middle|text-before-edge|text-after-edge|hanging|ideographic)$/,
  'alignment-baseline': /^(?:auto|baseline|alphabetic|central|middle|before-edge|after-edge|text-before-edge|text-after-edge|hanging|ideographic)$/,
  'text-decoration': /^(?:none|underline|overline|line-through)$/,
  lengthAdjust: /^(?:spacing|spacingAndGlyphs)$/,
  markerUnits: /^(?:strokeWidth|userSpaceOnUse)$/,
  patternUnits: /^(?:objectBoundingBox|userSpaceOnUse)$/,
  patternContentUnits: /^(?:objectBoundingBox|userSpaceOnUse)$/,
  gradientUnits: /^(?:objectBoundingBox|userSpaceOnUse)$/,
  clipPathUnits: /^(?:objectBoundingBox|userSpaceOnUse)$/,
  spreadMethod: /^(?:pad|reflect|repeat)$/,
  visibility: /^(?:visible|hidden|collapse)$/, display: /^(?:inline|none)$/,
};

class DiagramError extends Error {
  constructor(readonly code: 'unsafe' | 'unsupported' | 'limit' | 'dimensions' | 'timeout' | 'aborted' | 'raster') { super(code); }
}

export interface SanitizedDiagram {
  svg: string;
  /** Portable display dimensions, independent of the higher resolution PNG. */
  width: number; height: number;
  pixelWidth: number; pixelHeight: number;
  alt: string;
}

function numericList(value: string, maximum = 1_000_000): number[] {
  if (!numberListPattern.test(value)) throw new DiagramError('unsupported');
  const numbers = value.split(/[\s,]+/).map(Number);
  if (numbers.length > 20_000 || numbers.some(number => !Number.isFinite(number) || Math.abs(number) > maximum)) throw new DiagramError('limit');
  return numbers;
}

function normalizeText(value: string): string { return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim(); }

function explicitlyHidden(element: Element): boolean {
  if (element.matches(hiddenGraphicContent)) return true;
  const style = (element as HTMLElement).style;
  return element.getAttribute('data-gpt-md-display')?.trim() === 'none'
    || /^(?:hidden|collapse)$/.test(element.getAttribute('data-gpt-md-visibility')?.trim() || '')
    || style?.getPropertyValue('display').trim() === 'none'
    || /^(?:hidden|collapse)$/.test(style?.getPropertyValue('visibility').trim() || '')
    || element.getAttribute('display') === 'none' || /^(?:hidden|collapse)$/.test(element.getAttribute('visibility') || '');
}

interface LabelLimits { nodes: number; characters: number; depth: number; }

/** Read only accessible labels and SVG text, with bounded traversal even for rejected input. */
function labels(source: Element, limits: LabelLimits = { nodes: MAX_NODES, characters: 4_000, depth: MAX_DEPTH }): { alt: string; fallback: string; visited: number } {
  let visited = 0; let characters = 0;
  const titles: string[] = []; const descriptions: string[] = []; const text: string[] = [];
  const add = (collection: string[], value: string): void => {
    const clean = normalizeText(value.slice(0, Math.max(0, limits.characters - characters)));
    if (clean) { collection.push(clean); characters += clean.length; }
  };
  const walk = (element: Element, depth: number): void => {
    if (visited >= limits.nodes || depth > limits.depth || characters >= limits.characters) return;
    visited += 1;
    if (element.namespaceURI !== SVG_NS || !elements[element.localName] || explicitlyHidden(element)) return;
    for (const child of element.childNodes) {
      if (visited >= limits.nodes || characters >= limits.characters) break;
      if (child.nodeType === 1) walk(child as Element, depth + 1);
      else {
        visited += 1;
        if (child.nodeType === 3 && ['title', 'desc', 'text', 'tspan'].includes(element.localName)) add(element.localName === 'title' ? titles : element.localName === 'desc' ? descriptions : text, child.textContent || '');
      }
    }
  };
  walk(source, 0);
  const aria = normalizeText((source.getAttribute('aria-label') || '').slice(0, Math.min(1_000, limits.characters)));
  const labelled = [...titles, ...descriptions].join('；');
  return {
    alt: (aria || labelled || text.join('；') || 'SVG 图表').slice(0, 1_000),
    fallback: [...new Set([aria, ...titles, ...descriptions, ...text].filter(Boolean))].join('；').slice(0, limits.characters) || 'SVG 图表（无可确认的文字标注）',
    visited,
  };
}

function dimensions(source: Element): Pick<SanitizedDiagram, 'width' | 'height' | 'pixelWidth' | 'pixelHeight'> & { viewBox: string } {
  const viewBoxValue = source.getAttribute('viewBox');
  const viewBox = viewBoxValue ? numericList(viewBoxValue.trim()) : null;
  if (viewBox && (viewBox.length !== 4 || viewBox[2] <= 0 || viewBox[3] <= 0)) throw new DiagramError('dimensions');
  const length = (attribute: string): number | null => {
    const raw = source.getAttribute(attribute)?.trim();
    if (!raw) return null;
    const match = lengthPattern.exec(raw);
    if (!match || match[2] === '%') return null;
    const result = Number(match[1]);
    if (!Number.isFinite(result) || result <= 0 || result > 1_000_000) throw new DiagramError('dimensions');
    return result;
  };
  let width = length('width'); let height = length('height');
  if (viewBox) {
    if (width && !height) height = width * viewBox[3] / viewBox[2];
    if (height && !width) width = height * viewBox[2] / viewBox[3];
    width ||= viewBox[2]; height ||= viewBox[3];
  }
  if (!width || !height || width / height > 1_000 || height / width > 1_000) throw new DiagramError('dimensions');
  const displayScale = Math.min(Math.max(1, 1 / width, 1 / height), 1_200 / width, 1_200 / height);
  width *= displayScale; height *= displayScale;
  const rasterScale = Math.min(2, 4_096 / width, 4_096 / height, Math.sqrt(MAX_PIXELS / (width * height)));
  return {
    width: Math.max(1, Math.round(width * 100) / 100), height: Math.max(1, Math.round(height * 100) / 100),
    pixelWidth: Math.max(1, Math.floor(width * rasterScale)), pixelHeight: Math.max(1, Math.floor(height * rasterScale)),
    viewBox: viewBox ? viewBox.join(' ') : `0 0 ${width / displayScale} ${height / displayScale}`,
  };
}

function transform(value: string): string {
  const pieces = value.match(/(?:matrix|translate|scale|rotate|skewX|skewY)\([^()]*\)/g);
  if (!pieces?.length || pieces.length > 64 || pieces.join('').replace(/[\s,]/g, '') !== value.replace(/[\s,]/g, '')) throw new DiagramError('unsupported');
  for (const piece of pieces) {
    const name = piece.slice(0, piece.indexOf('('));
    const values = numericList(piece.slice(piece.indexOf('(') + 1, -1).trim());
    const counts: Record<string, number[]> = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1] };
    if (!counts[name].includes(values.length)) throw new DiagramError('unsupported');
  }
  return value;
}

function safeValue(name: string, raw: string): string {
  const value = raw.trim();
  if (!value || value.length > MAX_CHARACTERS || /[<>\\\u0000-\u0008\u000b\u000c\u000e-\u001f]|(?:https?|data|javascript|file):|(?:url|var|env|expression)\s*\(|@|\/\*/i.test(value)) throw new DiagramError('unsafe');
  if (['fill', 'stroke', 'color', 'stop-color'].includes(name)) {
    // Literal alphabetic CSS colors cannot introduce resources; unknown names fail closed in the renderer.
    if (/^[a-z]{1,24}$/i.test(value) || /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)
      || /^(?:rgb|rgba|hsl|hsla)\([\d\s.,%+/-]+\)$/i.test(value)) return value;
  } else if (enums[name]?.test(value)) return value;
  else if (name === 'font-family' && /^[A-Za-z0-9 ,"'_\-]{1,160}$/.test(value)) return value;
  else if (name === 'preserveAspectRatio' && /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/.test(value)) return value;
  else if (name === 'orient' && /^(?:auto|auto-start-reverse)$/.test(value)) return value;
  else if (['transform', 'patternTransform', 'gradientTransform'].includes(name)) return transform(value);
  else if (name === 'd') {
    if (!/^[MmZzLlHhVvCcSsQqTtAa\d\s.,+eE-]+$/.test(value)) throw new DiagramError('unsupported');
    const numbers = value.match(new RegExp(NUMBER, 'g')) || [];
    if (numbers.length > 20_000 || numbers.some(number => !Number.isFinite(Number(number)) || Math.abs(Number(number)) > 1_000_000)) throw new DiagramError('limit');
    return value;
  } else if (name === 'viewBox') {
    const numbers = numericList(value);
    if (numbers.length === 4 && numbers[2] > 0 && numbers[3] > 0) return numbers.join(' ');
  } else if (name === 'stroke-dasharray' && value === 'none') return value;
  else if (name === 'clip-path' && value === 'none') return value;
  else if (name.startsWith('marker-') && value === 'none') return value;
  else if (['opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity', 'offset'].includes(name)) {
    const match = lengthPattern.exec(value);
    if (match && match[2] !== 'px' && Number(match[1]) >= 0 && Number(match[1]) <= (match[2] === '%' ? 100 : 1)) return value;
  } else if (name === 'font-size') {
    const match = lengthPattern.exec(value);
    if (match && Number(match[1]) > 0 && Number(match[1]) <= 4_096) return value;
  } else if (['points', 'rotate', 'stroke-dasharray'].includes(name)) {
    const values = numericList(value);
    if (name === 'points' && values.length % 2 !== 0) throw new DiagramError('unsupported');
    if (name === 'stroke-dasharray' && (values.length > 128 || values.some(number => number < 0))) throw new DiagramError('unsupported');
    return value;
  } else if (!presentation.has(name) || ['stroke-width', 'stroke-miterlimit', 'stroke-dashoffset', 'letter-spacing', 'word-spacing'].includes(name)) {
    const match = lengthPattern.exec(value);
    if (match && Math.abs(Number(match[1])) <= 1_000_000) return value;
    if (['x', 'y', 'dx', 'dy'].includes(name)) { numericList(value); return value; }
  }
  throw new DiagramError('unsupported');
}

/** Rebuild a self-contained, passive SVG from an explicit element/attribute whitelist. */
export function sanitizedDiagramSvg(source: Element): SanitizedDiagram {
  if (source.localName !== 'svg' || source.namespaceURI !== SVG_NS) throw new DiagramError('unsupported');
  const size = dimensions(source);
  const document = source.ownerDocument.implementation.createDocument(SVG_NS, 'svg', null);
  const ids = new Map<string, { mapped: string; element: Element }>();
  const references: { owner: Element; name: string; target: string; output: Element }[] = [];
  let count = 0; let characters = 0;
  const charge = (amount: number): void => { characters += amount; if (characters > MAX_CHARACTERS) throw new DiagramError('limit'); };
  const copy = (input: Element, output: Element, depth: number): void => {
    if (++count > MAX_NODES || depth > MAX_DEPTH) throw new DiagramError('limit');
    if (input.namespaceURI !== SVG_NS || !elements[input.localName] || (input !== source && input.localName === 'svg')) throw new DiagramError('unsupported');
    const drawing = new Map<string, string>();
    const set = (name: string, raw: string): void => {
      if (!presentation.has(name) && !elements[input.localName].has(name)) return;
      const reference = /^url\(\s*#([A-Za-z_][A-Za-z0-9_.:-]{0,127})\s*\)$/.exec(raw.trim());
      if (reference && ['fill', 'stroke', 'clip-path', 'marker-start', 'marker-mid', 'marker-end'].includes(name)) {
        drawing.set(name, raw.trim()); return;
      }
      drawing.set(name, safeValue(name, raw));
    };
    const styles: [string, string][] = [];
    for (const attribute of input.attributes) {
      const name = attribute.name;
      charge(name.length + attribute.value.length);
      if (/^on/i.test(name) || attribute.localName.toLowerCase() === 'href' || /^(?:src|filter)$/i.test(name)) throw new DiagramError('unsafe');
      if (name === 'xmlns' && attribute.value === SVG_NS) continue;
      if (name === 'xml:space' && attribute.namespaceURI === XML_NS && /^(?:default|preserve)$/.test(attribute.value)) { output.setAttributeNS(XML_NS, name, attribute.value); continue; }
      if (attribute.namespaceURI && attribute.namespaceURI !== 'http://www.w3.org/2000/xmlns/') throw new DiagramError('unsafe');
      if (name === 'id') {
        if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(attribute.value) || ids.has(attribute.value)) throw new DiagramError('unsupported');
        const mapped = `gpt-md-diagram-${ids.size + 1}`;
        ids.set(attribute.value, { mapped, element: input }); output.setAttribute('id', mapped); continue;
      }
      if (name === 'style') {
        if (/[\\\u0000-\u0008\u000b\u000c\u000e-\u001f]|@|\/\*|(?:https?|data|javascript|file):|(?:var|env|expression)\s*\(/i.test(attribute.value)) throw new DiagramError('unsafe');
        for (const declaration of attribute.value.split(';').filter(value => value.trim())) {
          const colon = declaration.indexOf(':');
          if (colon < 1) throw new DiagramError('unsupported');
          const property = declaration.slice(0, colon).trim().toLowerCase();
          const value = declaration.slice(colon + 1).trim().replace(/\s*!important\s*$/i, '');
          if (/url\s*\(/i.test(value) && !/^url\(\s*#[A-Za-z_][A-Za-z0-9_.:-]{0,127}\s*\)$/.test(value)) throw new DiagramError('unsafe');
          if (property === 'filter' || property.startsWith('animation') || property === 'transition') throw new DiagramError('unsupported');
          if (presentation.has(property)) styles.push([property, value]);
        }
        continue;
      }
      if (/url\s*\(|(?:https?|data|javascript|file):/i.test(attribute.value) && !/^url\(\s*#[A-Za-z_][A-Za-z0-9_.:-]{0,127}\s*\)$/.test(attribute.value.trim())) throw new DiagramError('unsafe');
      if (input === source && (name === 'width' || name === 'height')) continue;
      set(name, attribute.value);
    }
    // Inline drawing styles override presentation attributes regardless of DOM attribute order.
    for (const [property, value] of styles) set(property, value);
    for (const [name, value] of drawing) {
      const reference = /^url\(\s*#([A-Za-z_][A-Za-z0-9_.:-]{0,127})\s*\)$/.exec(value);
      if (reference) references.push({ owner: input, name, target: reference[1], output });
      else output.setAttribute(name, value);
    }
    for (const child of input.childNodes) {
      if (child.nodeType !== 1 && ++count > MAX_NODES) throw new DiagramError('limit');
      if (child.nodeType === 3) {
        const text = child.textContent || ''; charge(text.length);
        if (['text', 'tspan', 'title', 'desc'].includes(input.localName)) output.append(document.createTextNode(text));
        else if (text.trim()) throw new DiagramError('unsupported');
      } else if (child.nodeType === 1) {
        if (['title', 'desc', 'stop'].includes(input.localName)) throw new DiagramError('unsupported');
        const element = child as Element;
        // Dropping a hidden attribute while copying its drawing would reveal it.
        if (elements[element.localName] && explicitlyHidden(element)) continue;
        if (input.localName === 'text' || input.localName === 'tspan') {
          if (element.localName !== 'tspan') throw new DiagramError('unsupported');
        }
        const clean = document.createElementNS(SVG_NS, element.localName);
        copy(element, clean, depth + 1); output.append(clean);
      } else if (child.nodeType !== 8) throw new DiagramError('unsupported');
      else charge(child.textContent?.length || 0);
    }
  };
  const root = document.documentElement;
  copy(source, root, 0);
  const edges = new Map<Element, Set<Element>>();
  for (const reference of references) {
    const target = ids.get(reference.target);
    const validKind = reference.name === 'clip-path' ? target?.element.localName === 'clipPath'
      : reference.name.startsWith('marker-') ? target?.element.localName === 'marker' : target && paintKinds.has(target.element.localName);
    if (!target || !validKind) throw new DiagramError('unsupported');
    reference.output.setAttribute(reference.name, `url(#${target.mapped})`);
    for (let owner: Element | null = reference.owner; owner && owner !== source; owner = owner.parentElement) {
      if (resourceKinds.has(owner.localName)) {
        const dependencies = edges.get(owner) || new Set<Element>(); dependencies.add(target.element); edges.set(owner, dependencies);
      }
    }
  }
  const depths = new Map<Element, number>();
  const visiting = new Set<Element>();
  const visit = (element: Element): number => {
    const known = depths.get(element);
    if (known !== undefined) return known;
    if (visiting.has(element) || visiting.size > 8) throw new DiagramError('unsupported');
    visiting.add(element);
    let depth = 0;
    for (const dependency of edges.get(element) || []) depth = Math.max(depth, 1 + visit(dependency));
    visiting.delete(element);
    if (depth > 8) throw new DiagramError('unsupported');
    depths.set(element, depth); return depth;
  };
  for (const element of edges.keys()) visit(element);
  root.setAttribute('viewBox', size.viewBox);
  root.setAttribute('width', String(size.pixelWidth)); root.setAttribute('height', String(size.pixelHeight));
  if (!root.hasAttribute('color')) root.setAttribute('color', '#334155');
  if (!root.hasAttribute('font-family')) root.setAttribute('font-family', 'Arial, Microsoft YaHei, sans-serif');
  const Serializer = source.ownerDocument.defaultView?.XMLSerializer;
  if (!Serializer) throw new DiagramError('raster');
  const svg = new Serializer().serializeToString(root);
  if (svg.length > MAX_CHARACTERS) throw new DiagramError('limit');
  return { svg, width: size.width, height: size.height, pixelWidth: size.pixelWidth, pixelHeight: size.pixelHeight, alt: labels(source).alt };
}

function dataSvg(image: Element): Element {
  const source = image.getAttribute('src') || '';
  if (source.length > MAX_CHARACTERS * 4) throw new DiagramError('limit');
  const match = /^data:image\/svg\+xml((?:;charset=(?:utf-8|us-ascii))?)(;base64)?,([\s\S]*)$/i.exec(source);
  if (!match) throw new DiagramError('unsupported');
  let text: string;
  try {
    const payload = decodeURIComponent(match[3]);
    if (match[2]) {
      if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(payload)) throw new DiagramError('unsupported');
      const binary = image.ownerDocument.defaultView!.atob(payload);
      text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
    } else text = payload;
  } catch { throw new DiagramError('unsupported'); }
  if (text.length > MAX_CHARACTERS) throw new DiagramError('limit');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new DiagramError('unsafe');
  const Parser = image.ownerDocument.defaultView?.DOMParser;
  if (!Parser) throw new DiagramError('unsupported');
  const parsed = new Parser().parseFromString(text, 'image/svg+xml');
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg' || parsed.documentElement.namespaceURI !== SVG_NS) throw new DiagramError('unsupported');
  // Use the page's DOM constructors for serialization, never its markup or styles.
  return image.ownerDocument.importNode(parsed.documentElement, true);
}

const pngCache = new Map<string, string>();
let cacheCharacters = 0;
function remember(svg: string, png: string): void {
  if (svg.length + png.length > MAX_CACHE_CHARACTERS) return;
  const previous = pngCache.get(svg);
  if (previous) { cacheCharacters -= svg.length + previous.length; pngCache.delete(svg); }
  while (pngCache.size >= MAX_CACHE_ENTRIES || cacheCharacters + svg.length + png.length > MAX_CACHE_CHARACTERS) {
    const oldest = pngCache.keys().next().value;
    if (oldest === undefined) break;
    cacheCharacters -= oldest.length + pngCache.get(oldest)!.length; pngCache.delete(oldest);
  }
  pngCache.set(svg, png); cacheCharacters += svg.length + png.length;
}

async function rasterize(diagram: SanitizedDiagram, document: Document, timeout: number, signal?: AbortSignal): Promise<string> {
  const view = document.defaultView;
  if (!view?.URL.createObjectURL || signal?.aborted) throw new DiagramError(signal?.aborted ? 'aborted' : 'raster');
  const image = new view.Image();
  const url = view.URL.createObjectURL(new view.Blob([diagram.svg], { type: 'image/svg+xml' }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  let canvas: HTMLCanvasElement | undefined;
  try {
    await Promise.race([
      (async () => { image.src = url; await image.decode(); })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DiagramError('timeout')), Math.max(1, timeout));
        abort = () => reject(new DiagramError('aborted'));
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      }),
    ]);
    if (signal?.aborted) throw new DiagramError('aborted');
    canvas = document.createElement('canvas'); canvas.width = diagram.pixelWidth; canvas.height = diagram.pixelHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new DiagramError('raster');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = canvas.toDataURL('image/png');
    if (png.length > MAX_PNG_CHARACTERS) throw new DiagramError('limit');
    if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(png)) throw new DiagramError('raster');
    return png;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', abort); image.src = ''; view.URL.revokeObjectURL(url);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

function fallback(element: Element, text: string): void {
  const label = `[图表未转换] ${text}`;
  if (element.localName === 'img' && element.closest('button[data-message-image="original"][aria-haspopup="dialog"]')) {
    // Answer-image buttons expose only IMG children to extraction. A source-less
    // IMG retains its own alt as text instead of exposing the button's chrome.
    const image = element.ownerDocument.createElement('img');
    image.setAttribute('data-gpt-md-diagram-fallback', ''); image.alt = label; element.replaceWith(image);
  } else {
    const span = element.ownerDocument.createElement('span');
    span.setAttribute('data-gpt-md-diagram-fallback', ''); span.textContent = label; element.replaceWith(span);
  }
}

/** Remaining graphics get bounded labels, never full SVG parsing/rasterization. */
function remainingFallback(element: Element, budget: { nodes: number; characters: number; encoded: number }): void {
  const limit = Math.max(0, Math.min(1_000, budget.characters));
  let text = normalizeText((element.getAttribute('alt') || element.getAttribute('aria-label') || '').slice(0, limit));
  let source: Element | null = element;
  if (element.localName === 'img') {
    const encoded = element.getAttribute('src') || '';
    if (!/^data:image\/svg\+xml(?:[;,])/i.test(encoded)) return; // Remote SVG keeps its original reference and alt.
    source = null;
    // A small, bounded data SVG can contribute a title if no outer alt exists.
    if (!text && encoded.length <= 8_192 && encoded.length <= budget.encoded && budget.nodes > 0 && limit > 0) {
      budget.encoded -= encoded.length;
      try { source = dataSvg(element); } catch { /* Preserve only the outer label for rejected XML. */ }
    }
  }
  if (!text && source?.localName === 'svg' && budget.nodes > 0 && limit > 0) {
    const found = labels(source, { nodes: Math.min(96, budget.nodes), characters: limit, depth: 8 });
    text = found.fallback; budget.nodes -= found.visited;
  } else if (!text && source?.localName === 'canvas' && budget.nodes > 0 && limit > 0) {
    const walker = source.ownerDocument.createTreeWalker(source, 0xffffffff);
    let visited = 0;
    while (visited < Math.min(96, budget.nodes) && text.length < limit && walker.nextNode()) {
      visited += 1;
      const node = walker.currentNode;
      if (node.nodeType === 3 && !node.parentElement?.closest(ignoredAnswerContent)) text += normalizeText((node.textContent || '').slice(0, limit - text.length)) + ' ';
    }
    budget.nodes -= visited; text = text.trim();
  }
  text = text.slice(0, limit); budget.characters -= text.length;
  fallback(element, text || '超出图表转换或文字读取预算，未读取更多内容');
}

/** Convert only referenced diagrams in the caller's cloned answer; this function never fetches. */
export async function prepareDiagramImages(root: Element, options: { signal?: AbortSignal; current?: () => boolean } = {}): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const excluded = '[data-d-component="icon"],math,.katex,.katex-display,[data-gpt-md-icon-image],[data-gpt-md-diagram-image]';
  const visibility = new WeakMap<Element, boolean>();
  const hidden = (element: Element): boolean => {
    const known = visibility.get(element);
    if (known !== undefined) return known;
    let result = explicitlyHidden(element);
    // The capture clone records live layout facts. A connected standalone DOM
    // can also be checked directly, without attaching or changing the clone.
    if (!result && element.isConnected) {
      const computed = element.ownerDocument.defaultView?.getComputedStyle(element);
      result = computed?.display === 'none' || /^(?:hidden|collapse)$/.test(computed?.visibility || '');
    }
    if (!result && element.parentElement) result = hidden(element.parentElement);
    visibility.set(element, result); return result;
  };
  const candidates = [...root.querySelectorAll('svg,img,canvas')].filter(element => {
    if (element.closest(excluded) || element.closest(ignoredAnswerContent) || hidden(element)) return false;
    // Original-image zoom buttons contribute their actual IMG only.
    if (element.closest('button') && element.localName !== 'img') return false;
    if (element.localName === 'svg') return !element.parentElement?.closest('svg');
    if (element.closest('svg')) return false;
    const source = element.getAttribute('src') || '';
    if (element.localName === 'canvas' || /^data:image\/svg\+xml(?:[;,])/i.test(source)) return true;
    try { return /\.svg(?:[?#]|$)/i.test(source) && /^https?:$/.test(new URL(source, root.ownerDocument.baseURI).protocol); }
    catch { return false; }
  });
  if (!candidates.length) return diagnostics;
  const deadline = Date.now() + TOTAL_MS;
  let converted = 0; let failed = 0; let pixels = 0; let characters = 0; let pngCharacters = 0;
  const reasons = new Set<string>();
  const cancelled = () => options.signal?.aborted || options.current?.() === false;
  let index = 0;
  for (; index < Math.min(candidates.length, MAX_DIAGRAMS); index += 1) {
    const element = candidates[index];
    if (cancelled()) { reasons.add('aborted'); break; }
    if (Date.now() >= deadline) { reasons.add('timeout'); failed += 1; break; }
    let source = element;
    try {
      if (element.localName === 'canvas') {
        remainingFallback(element, { nodes: 96, characters: 1_000, encoded: 0 });
        throw new DiagramError('unsupported');
      }
      if (element.localName === 'img') source = dataSvg(element);
      const diagram = sanitizedDiagramSvg(source);
      if (pixels + diagram.pixelWidth * diagram.pixelHeight > MAX_TOTAL_PIXELS || characters + diagram.svg.length > MAX_TOTAL_CHARACTERS) throw new DiagramError('limit');
      pixels += diagram.pixelWidth * diagram.pixelHeight; characters += diagram.svg.length;
      let png = pngCache.get(diagram.svg);
      if (!png) {
        png = await rasterize(diagram, root.ownerDocument, Math.min(EACH_MS, deadline - Date.now()), options.signal);
        if (!cancelled()) remember(diagram.svg, png);
      }
      if (cancelled()) { reasons.add('aborted'); break; }
      if (Date.now() > deadline) throw new DiagramError('timeout');
      if (pngCharacters + png.length > MAX_TOTAL_PNG_CHARACTERS) throw new DiagramError('limit');
      pngCharacters += png.length;
      const image = root.ownerDocument.createElement('img');
      image.src = png; image.setAttribute('width', String(diagram.width)); image.setAttribute('height', String(diagram.height));
      image.setAttribute('data-gpt-md-diagram-image', '');
      image.alt = normalizeText((element.localName === 'img' ? element.getAttribute('alt') || diagram.alt : diagram.alt).slice(0, 1_000));
      element.replaceWith(image); converted += 1;
    } catch (error) {
      if (cancelled() || (error instanceof DiagramError && error.code === 'aborted')) { reasons.add('aborted'); break; }
      failed += 1; reasons.add(error instanceof DiagramError ? error.code : 'raster');
      if (element.localName === 'svg') fallback(element, labels(element).fallback);
      else if (element.localName === 'img' && /^data:/i.test(element.getAttribute('src') || '')) fallback(element, normalizeText((element.getAttribute('alt') || (source !== element ? labels(source).fallback : 'SVG 图片（无可确认的文字标注）')).slice(0, 4_000)));
    }
  }
  if (!reasons.has('aborted') && !cancelled() && index < candidates.length) {
    reasons.add(index >= MAX_DIAGRAMS ? 'limit' : 'timeout');
    const budget = { nodes: 8_000, characters: 64_000, encoded: 64_000 };
    for (; index < candidates.length; index += 1) {
      if (cancelled()) { reasons.add('aborted'); break; }
      remainingFallback(candidates[index], budget); failed += 1;
    }
  }
  if (converted) diagnostics.push({ code: 'DIAGRAMS_AS_IMAGES', severity: 'info', message: `${converted} 张 SVG 图表已按原比例转换为本地 PNG，保留图中文字和图题标注。` });
  if (failed || candidates.length > MAX_DIAGRAMS || reasons.has('timeout')) {
    const explanation: Record<string, string> = { unsafe: '脚本或外部资源', unsupported: '不支持的 SVG、远程 SVG 或 Canvas 内容', limit: '数量、长度、深度或像素预算', dimensions: '无法确认的尺寸', timeout: '转换时间上限', raster: '图片解码或绘制失败' };
    const detail = [...reasons].map(reason => explanation[reason]).filter(Boolean).join('、') || '数量上限';
    diagnostics.push({ code: 'DIAGRAM_CONVERSION_INCOMPLETE', severity: 'warning', message: `部分图表未转换为 PNG（${detail}）；已保留可确认的文字标注或原图片引用。` });
  }
  if (reasons.has('aborted')) diagnostics.push({ code: 'DIAGRAM_CONVERSION_ABORTED', severity: 'warning', message: '图表转换已取消；未继续修改本次导出副本。' });
  return diagnostics;
}
