import type { Element as HastElement, RootContent as HastNode } from 'hast';

const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

// Keep this path bounded independently of the TeX renderer. A rejected tree is
// reported by the caller; it must never be flattened into misleading math text.
const MAX_DEPTH = 64;
const MAX_NODES = 2_048;
const MAX_CHARACTERS = 50_000;
const MAX_ATTRIBUTES = 24;

type Validator = (value: string) => boolean;
const enumeration = (...values: string[]): Validator => value => values.includes(value);
const boolean = enumeration('true', 'false');
const horizontal = enumeration('left', 'center', 'right');
const vertical = enumeration('top', 'bottom', 'center', 'baseline', 'axis');
const line = enumeration('none', 'solid', 'dashed');
const text = (limit: number): Validator => value => value.length <= limit;
const list = (validate: Validator, maximum = 64): Validator => value => {
  const entries = value.trim().split(/\s+/);
  return entries.length <= maximum && entries.every(validate);
};
const integer = (minimum: number, maximum: number): Validator => value =>
  /^[+-]?\d{1,3}$/.test(value) && Number(value) >= minimum && Number(value) <= maximum;

const namedSpaces = new Set([
  'veryverythinmathspace', 'verythinmathspace', 'thinmathspace', 'mediummathspace',
  'thickmathspace', 'verythickmathspace', 'veryverythickmathspace',
]);
function length(value: string, negative = false): boolean {
  if (namedSpaces.has(value) || (negative && value.startsWith('negative') && namedSpaces.has(value.slice(8)))) return true;
  const match = /^([+-]?(?:\d{1,4}(?:\.\d{1,6})?|\.\d{1,6}))(em|ex|px|pt|pc|in|cm|mm|%)?$/.exec(value);
  if (!match) return false;
  const number = Number(match[1]);
  return Number.isFinite(number) && Math.abs(number) <= 1_000 && (negative || number >= 0);
}
const positiveLength: Validator = value => length(value);
const signedLength: Validator = value => length(value, true);
const quote = text(64);
const globalAttributes: Record<string, Validator> = {
  dir: enumeration('ltr', 'rtl'),
  displaystyle: boolean,
  scriptlevel: integer(-20, 20),
  mathvariant: enumeration(
    'normal', 'bold', 'italic', 'bold-italic', 'double-struck', 'bold-fraktur',
    'script', 'bold-script', 'fraktur', 'sans-serif', 'bold-sans-serif',
    'sans-serif-italic', 'sans-serif-bold-italic', 'monospace', 'initial', 'tailed', 'looped', 'stretched',
  ),
  mathsize: value => enumeration('small', 'normal', 'big')(value) || positiveLength(value),
  lang: value => value.length <= 63 && /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value),
  'aria-label': text(4_096),
};

// Attribute names here are DOM/serialized MathML names, not guessed camel case.
const attributes: Record<string, Record<string, Validator>> = {
  math: { display: enumeration('inline', 'block'), alttext: text(4_096) },
  mrow: {}, mi: {}, mn: {}, mtext: {},
  mo: {
    form: enumeration('prefix', 'infix', 'postfix'), fence: boolean, separator: boolean,
    lspace: signedLength, rspace: signedLength, stretchy: boolean, symmetric: boolean,
    maxsize: value => value === 'infinity' || positiveLength(value), minsize: positiveLength,
    largeop: boolean, movablelimits: boolean, accent: boolean,
  },
  ms: { lquote: quote, rquote: quote },
  mfrac: {
    linethickness: value => enumeration('thin', 'medium', 'thick')(value) || positiveLength(value),
    numalign: horizontal, denomalign: horizontal, bevelled: boolean,
  },
  msqrt: {}, mroot: {},
  msub: { subscriptshift: positiveLength },
  msup: { superscriptshift: positiveLength },
  msubsup: { subscriptshift: positiveLength, superscriptshift: positiveLength },
  mover: { accent: boolean, align: horizontal },
  munder: { accentunder: boolean, align: horizontal },
  munderover: { accent: boolean, accentunder: boolean, align: horizontal },
  mtable: {
    align: value => /^(top|bottom|center|baseline|axis)(?: [+-]?\d{1,3})?$/.test(value),
    rowalign: list(vertical), columnalign: list(horizontal),
    rowspacing: list(positiveLength), columnspacing: list(positiveLength),
    rowlines: list(line), columnlines: list(line), frame: line,
    framespacing: value => value.trim().split(/\s+/).length === 2 && list(positiveLength, 2)(value),
    equalrows: boolean, equalcolumns: boolean,
    width: value => value === 'auto' || positiveLength(value),
    columnwidth: list(value => value === 'auto' || value === 'fit' || positiveLength(value)),
  },
  mtr: { rowalign: vertical, columnalign: list(horizontal) },
  mtd: { rowalign: vertical, columnalign: horizontal, rowspan: integer(1, 100), columnspan: integer(1, 100) },
  mfenced: { open: quote, close: quote, separators: quote },
  menclose: {
    notation: list(enumeration(
      'longdiv', 'actuarial', 'radical', 'box', 'roundedbox', 'circle', 'left', 'right', 'top', 'bottom',
      'updiagonalstrike', 'downdiagonalstrike', 'verticalstrike', 'horizontalstrike',
      'madruwb', 'updiagonalarrow', 'phasorangle',
    ), 16),
  },
  mmultiscripts: {}, mprescripts: {}, none: {},
  mspace: { width: signedLength, height: positiveLength, depth: positiveLength, linebreak: enumeration('auto', 'newline', 'goodbreak', 'badbreak', 'nobreak') },
  mstyle: {}, mphantom: {}, merror: {},
  semantics: {},
  annotation: { encoding: value => value.length <= 128 && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value) },
};

/** Presentation-only elements; interactive and external-resource MathML is excluded. */
export const nativeMathMlTags: string[] = Object.keys(attributes);

// Verified against the installed rehype-raw / hast-util-from-parse5 path:
// unknown MathML properties stay lowercase, while shared HTML properties use
// HAST's ariaLabel and rowSpan spellings. Do not use mathVariant/columnAlign.
const hastProperty = (name: string): string => name === 'aria-label' ? 'ariaLabel' : name === 'rowspan' ? 'rowSpan' : name;
export const nativeMathMlAttributes: Record<string, string[]> = Object.fromEntries(
  nativeMathMlTags.map(tag => [tag, [
    ...Object.keys(globalAttributes).map(hastProperty),
    ...Object.keys(attributes[tag]).map(hastProperty),
    ...(tag === 'math' ? ['xmlns'] : []),
  ]]),
);

const tokens = new Set(['mi', 'mn', 'mo', 'mtext', 'ms', 'annotation']);
const empty = new Set(['mspace', 'none', 'mprescripts']);
const nonExpressions = new Set(['math', 'mtr', 'mtd', 'annotation', 'none', 'mprescripts']);
const arity: Record<string, number> = { mfrac: 2, mroot: 2, msub: 2, msup: 2, msubsup: 3, mover: 2, munder: 2, munderover: 3 };

function fail(reason: string): never { throw new Error(`Native MathML: ${reason}`); }

function escapeText(value: string, attribute = false): string {
  return value.replace(attribute ? /[&<>"'\r\n\t]/g : /[&<>\r]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    '\r': '&#13;', '\n': '&#10;', '\t': '&#9;',
  })[character]!);
}

interface MathAttribute { name: string; value: string; namespace?: string | null; prefix?: string | null; }
interface TreeAdapter<T> {
  kind(node: T): 'element' | 'text' | 'unsupported';
  name(node: T): string;
  text(node: T): string;
  namespace(node: T): string | null;
  prefix(node: T): string | null;
  children(node: T): ArrayLike<T>;
  attributeCount(node: T): number;
  attributes(node: T): Iterable<MathAttribute>;
}

function validateShape(tag: string, children: string[], hasText: boolean, parent: string | undefined): void {
  if (!tokens.has(tag) && hasText) fail(`text must be inside a token element (${tag})`);
  if (tokens.has(tag) && children.length) fail(`${tag} must contain plain text only`);
  if (empty.has(tag) && (children.length || hasText)) fail(`${tag} must be empty`);
  if (arity[tag] !== undefined && children.length !== arity[tag]) fail(`${tag} requires ${arity[tag]} children`);
  if (tag === 'math' && parent) fail('nested math roots are unsupported');
  if (tag === 'annotation' && parent !== 'semantics') fail('annotation must belong to semantics');
  if (tag === 'mtr' && parent !== 'mtable') fail('mtr must belong to mtable');
  if (tag === 'mtd' && parent !== 'mtr') fail('mtd must belong to mtr');
  if ((tag === 'none' || tag === 'mprescripts') && parent !== 'mmultiscripts') fail(`${tag} must belong to mmultiscripts`);

  if (tag === 'semantics') {
    if (!children.length || nonExpressions.has(children[0])) fail('semantics requires a presentation expression');
    if (children.slice(1).some(child => child !== 'annotation')) fail('semantics supports plain text annotations only');
  } else if (tag === 'mtable') {
    if (children.some(child => child !== 'mtr')) fail('mtable supports mtr rows only');
  } else if (tag === 'mtr') {
    if (children.some(child => child !== 'mtd')) fail('mtr supports mtd cells only');
  } else if (tag === 'mmultiscripts') {
    if (!children.length || nonExpressions.has(children[0])) fail('mmultiscripts requires a base');
    let count = 0;
    let prescripts = false;
    for (const child of children.slice(1)) {
      if (child === 'mprescripts') {
        if (prescripts || count % 2) fail('invalid prescript boundary');
        prescripts = true; count = 0;
      } else {
        if (nonExpressions.has(child) && child !== 'none') fail('invalid script expression');
        count += 1;
      }
    }
    if (count % 2) fail('scripts require subscript/superscript pairs');
  } else if (!tokens.has(tag) && children.some(child => nonExpressions.has(child))) {
    fail(`${tag} contains an invalid presentation child`);
  }
}

function processMathTree<T>(source: T, adapter: TreeAdapter<T>): string {
  if (adapter.kind(source) !== 'element' || adapter.name(source) !== 'math' || adapter.namespace(source) !== MATHML_NAMESPACE) fail('a MathML namespace math root is required');
  let nodes = 0;
  let characters = 0;
  const checked = (value: string): string => {
    characters += value.length;
    if (characters > MAX_CHARACTERS) fail('character limit exceeded');
    for (const character of value) {
      const point = character.codePointAt(0)!;
      if ((point < 0x20 && point !== 9 && point !== 10 && point !== 13)
        || (point >= 0xD800 && point <= 0xDFFF) || (point & 0xFFFF) >= 0xFFFE) fail('unsupported text character');
    }
    return value;
  };
  const visit = (node: T, depth: number, parent?: string): string => {
    nodes += 1;
    if (nodes > MAX_NODES) fail('node limit exceeded');
    if (depth > MAX_DEPTH) fail('depth limit exceeded');
    if (adapter.kind(node) === 'text') return escapeText(checked(adapter.text(node)));
    if (adapter.kind(node) !== 'element') fail('unsupported node type');
    const tag = adapter.name(node);
    if (adapter.namespace(node) !== MATHML_NAMESPACE || adapter.prefix(node) || !Object.hasOwn(attributes, tag)) fail(`unsupported element or namespace (${tag})`);
    const childNodes = adapter.children(node);
    if (childNodes.length > MAX_NODES) fail('node limit exceeded');
    if (adapter.attributeCount(node) > MAX_ATTRIBUTES) fail('attribute limit exceeded');
    const childTags: string[] = [];
    let hasText = false;
    for (let index = 0; index < childNodes.length; index += 1) {
      const child = childNodes[index];
      if (adapter.kind(child) === 'element') childTags.push(adapter.name(child));
      else if (adapter.kind(child) === 'text' && adapter.text(child).trim()) hasText = true;
    }
    validateShape(tag, childTags, hasText, parent);
    let serializedAttributes = tag === 'math' ? ` xmlns="${MATHML_NAMESPACE}"` : '';
    for (const attribute of adapter.attributes(node)) {
      if (attribute.name === 'xmlns' && (!attribute.namespace || attribute.namespace === XMLNS_NAMESPACE)) {
        if (attribute.value !== MATHML_NAMESPACE) fail('conflicting namespace declaration');
        continue;
      }
      if (attribute.namespace || attribute.prefix) fail(`namespaced attribute (${attribute.name})`);
      const validator = Object.hasOwn(attributes[tag], attribute.name) ? attributes[tag][attribute.name]
        : Object.hasOwn(globalAttributes, attribute.name) ? globalAttributes[attribute.name] : undefined;
      if (!validator) fail(`unsupported attribute (${attribute.name})`);
      const value = checked(attribute.value);
      if (!validator(value)) fail(`invalid ${attribute.name} value`);
      serializedAttributes += ` ${attribute.name}="${escapeText(value, true)}"`;
    }
    let children = '';
    for (let index = 0; index < childNodes.length; index += 1) children += visit(childNodes[index], depth + 1, tag);
    return `<${tag}${serializedAttributes}>${children}</${tag}>`;
  };
  return visit(source, 1);
}

const domAdapter: TreeAdapter<Node> = {
  kind: node => node.nodeType === 1 ? 'element' : node.nodeType === 3 || node.nodeType === 4 ? 'text' : 'unsupported',
  name: node => (node as Element).localName,
  text: node => node.nodeValue ?? '',
  namespace: node => (node as Element).namespaceURI,
  prefix: node => (node as Element).prefix,
  children: node => node.childNodes,
  attributeCount: node => (node as Element).attributes.length,
  attributes: function* (node) {
    for (const attribute of (node as Element).attributes) yield {
      name: attribute.name, value: attribute.value, namespace: attribute.namespaceURI, prefix: attribute.prefix,
    };
  },
};

/** Rebuild a native DOM MathML root without mutating it or inferring TeX. */
export function serializeNativeMathML(source: Element): string {
  return processMathTree(source, domAdapter);
}

const domProperty = (name: string): string => name === 'ariaLabel' ? 'aria-label' : name === 'rowSpan' ? 'rowspan' : name;
const hastAdapter: TreeAdapter<HastNode> = {
  kind: node => node.type === 'element' ? 'element' : node.type === 'text' ? 'text' : 'unsupported',
  name: node => node.type === 'element' ? node.tagName : '',
  text: node => node.type === 'text' ? node.value : '',
  // HAST omits namespaces. The HTML parser establishes the math context;
  // the same strict child grammar excludes every HTML integration point.
  namespace: () => MATHML_NAMESPACE,
  prefix: node => node.type === 'element' && node.tagName.includes(':') ? node.tagName.split(':')[0] : null,
  children: node => node.type === 'element' ? node.children : [],
  attributeCount: node => node.type === 'element' ? Object.keys(node.properties).length : 0,
  attributes: function* (node) {
    if (node.type !== 'element') return;
    for (const [property, value] of Object.entries(node.properties)) {
      if (value === null || value === undefined) continue;
      if ((typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
        || (typeof value === 'number' && !Number.isFinite(value))) fail(`unsupported attribute value (${property})`);
      yield { name: domProperty(property), value: String(value) };
    }
  },
};

/** Validate raw-parser HAST with exactly the DOM serializer's policy/limits. */
export function validateNativeMathMLHast(source: HastElement): void {
  processMathTree(source, hastAdapter);
}
