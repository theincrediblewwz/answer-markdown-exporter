type Point = { x: number; y: number };
type Segment = { a: Point; b: Point };
const names: Record<string, string> = {
  arrowdown: '↓', downarrow: '↓', 下箭头: '↓', 向下箭头: '↓', arrowup: '↑', uparrow: '↑', 上箭头: '↑', 向上箭头: '↑',
  arrowleft: '←', leftarrow: '←', 左箭头: '←', arrowright: '→', rightarrow: '→', 右箭头: '→',
  arrowupright: '↗', arrowdownright: '↘', arrowupleft: '↖', arrowdownleft: '↙',
  chevrondown: '⌄', chevronup: '⌃', chevronleft: '‹', chevronright: '›',
  check: '✓', checkmark: '✓', tick: '✓', circlecheck: '✓', checkcircle: '✓', 对勾: '✓', 勾: '✓',
  x: '×', close: '×', cross: '×', circlex: '×', xcircle: '×', 关闭: '×', 叉: '×',
  plus: '+', minus: '−', info: 'ℹ', information: 'ℹ', circleinfo: 'ℹ', infocircle: 'ℹ',
  warning: '⚠', trianglealert: '⚠', alerttriangle: '⚠', 警告: '⚠',
  externallink: '↗', download: '↓', 下载: '↓', upload: '↑', 上传: '↑',
  globe: '🌐', earth: '🌐', network: '🌐', package: '📦', box: '📦', file: '📄', filetext: '📄',
  folder: '📁', book: '📖', bookopen: '📖', paperclip: '📎', link: '🔗', star: '★', heart: '♥',
};
const same = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 0.01;
const length = ({ a, b }: Segment) => Math.hypot(a.x - b.x, a.y - b.y);

/** Straight-line SVG paths only. Unknown curves/transforms are not guessed. */
function lineSegments(svg: Element): Segment[] | null {
  const result: Segment[] = [];
  const add = (a: Point, b: Point) => { if (!same(a, b)) result.push({ a: { ...a }, b: { ...b } }); };
  const children = [...svg.querySelectorAll('*')];
  if (children.length > 40 || svg.hasAttribute('transform') || children.some(e => e.hasAttribute('transform') || !['g', 'title', 'desc', 'path', 'line', 'polyline'].includes(e.localName))) return null;
  for (const element of children) {
    if (['g', 'title', 'desc'].includes(element.localName)) continue;
    if (element.localName === 'line') {
      const values = ['x1', 'y1', 'x2', 'y2'].map(key => Number(element.getAttribute(key) || 0));
      if (!values.every(Number.isFinite)) return null;
      add({ x: values[0], y: values[1] }, { x: values[2], y: values[3] }); continue;
    }
    const data = element.getAttribute(element.localName === 'polyline' ? 'points' : 'd') || '';
    const pattern = /[MmLlHhVvZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
    const tokens = data.match(pattern) || [];
    if (tokens.length > 200 || data.replace(pattern, '').replace(/[\s,]/g, '')) return null;
    let position: Point = { x: 0, y: 0 }, start = position, command = element.localName === 'polyline' ? 'M' : '', index = 0;
    while (index < tokens.length) {
      if (/^[A-Za-z]$/.test(tokens[index])) command = tokens[index++];
      if (!command) return null;
      const kind = command.toUpperCase(), relative = command !== kind;
      if (kind === 'Z') { add(position, start); position = start; command = ''; continue; }
      const count = kind === 'H' || kind === 'V' ? 1 : 2;
      const values = tokens.slice(index, index + count).map(Number);
      if (values.length !== count || !values.every(Number.isFinite)) return null;
      index += count;
      const next = { ...position };
      if (kind === 'H') next.x = values[0] + (relative ? position.x : 0);
      else if (kind === 'V') next.y = values[0] + (relative ? position.y : 0);
      else { next.x = values[0] + (relative ? position.x : 0); next.y = values[1] + (relative ? position.y : 0); }
      if (kind === 'M') { start = next; command = relative ? 'l' : 'L'; } else add(position, next);
      position = next;
      if (result.length > 20) return null;
    }
  }
  return result;
}

function direction(x: number, y: number, cardinal = false): number {
  const directions = cardinal ? [[1, 0], [0, 1], [-1, 0], [0, -1]] : [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const magnitude = Math.hypot(x, y); if (!magnitude) return -1;
  return directions.findIndex(([dx, dy]) => (x * dx + y * dy) / (magnitude * Math.hypot(dx, dy)) > 0.999);
}

export function iconSymbol(svg: Element, owner: Element = svg): string | null {
  for (const element of [owner, svg]) {
    const candidates = [element.getAttribute('data-icon'), element.getAttribute('data-d-icon'), element.getAttribute('data-icon-name'), element.getAttribute('aria-label'), element.querySelector('title')?.textContent, ...(element.getAttribute('class') || '').split(/\s+/)];
    for (const candidate of candidates) {
      const name = candidate?.trim().replace(/^(?:(?:lucide|icon|tabler)[-_])+/i, '').toLowerCase().replace(/[\s_-]/g, '');
      if (name && Object.hasOwn(names, name)) return names[name];
    }
  }
  const segments = lineSegments(svg); if (!segments?.length) return null;
  // Filled arrows use a seven-corner polygon. Match its three symmetric levels
  // and every edge, rather than treating any similarly sized shape as an arrow.
  if (segments.length === 7) {
    for (const [index, [dx, dy]] of [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]].entries()) {
      const points = segments.flatMap(s => [s.a, s.b]).filter((p, i, all) => all.findIndex(q => same(p, q)) === i);
      if (points.length !== 7) continue;
      const levels = [...points].sort((a, b) => a.x * dx + a.y * dy - b.x * dx - b.y * dy);
      const axial = (p: Point) => p.x * dx + p.y * dy, side = (p: Point) => p.y * dx - p.x * dy;
      if (Math.abs(axial(levels[0]) - axial(levels[1])) > .01 || levels.slice(2, 6).some(p => Math.abs(axial(p) - axial(levels[2])) > .01) || axial(levels[2]) <= axial(levels[1]) || axial(levels[6]) <= axial(levels[5])) continue;
      const tip = levels[6], tail = levels.slice(0, 2).sort((a, b) => side(a) - side(b)), head = levels.slice(2, 6).sort((a, b) => side(a) - side(b));
      if (Math.abs(side(tail[0]) + side(tail[1]) - 2 * side(tip)) > .01 || Math.abs(side(head[0]) + side(head[3]) - 2 * side(tip)) > .01 || Math.abs(side(head[1]) - side(tail[0])) > .01 || Math.abs(side(head[2]) - side(tail[1])) > .01 || side(head[0]) >= side(head[1]) || side(head[3]) <= side(head[2])) continue;
      const outline = [tail[0], tail[1], head[2], head[3], tip, head[0], head[1]];
      if (outline.every((p, i) => segments.some(s => same(s.a, p) && same(s.b, outline[(i + 1) % 7]) || same(s.b, p) && same(s.a, outline[(i + 1) % 7])))) return ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'][index];
    }
  }
  if (segments.length === 3) {
    const sorted = [...segments].sort((a, b) => length(b) - length(a)); const shaft = sorted[0];
    for (const tip of [shaft.a, shaft.b]) {
      const tail = same(tip, shaft.a) ? shaft.b : shaft.a;
      const heads = sorted.slice(1).map(line => same(line.a, tip) ? line.b : same(line.b, tip) ? line.a : null);
      if (heads.some(head => !head)) continue;
      const [left, right] = heads as Point[], n = length(shaft), dx = (tip.x - tail.x) / n, dy = (tip.y - tail.y) / n;
      const projection = (p: Point) => (tip.x - p.x) * dx + (tip.y - p.y) * dy;
      const cross = (p: Point) => (p.x - tip.x) * dy - (p.y - tip.y) * dx;
      if (Math.abs(length(sorted[1]) - length(sorted[2])) > n * .02 || n < length(sorted[1]) * 1.15 || projection(left) <= 0 || projection(right) <= 0 || cross(left) * cross(right) >= 0 || Math.abs(projection(left) - projection(right)) > n * .02 || Math.abs(cross(left) + cross(right)) > n * .02) continue;
      const index = direction(dx, dy); if (index >= 0) return ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'][index];
    }
    const points = segments.flatMap(s => [s.a, s.b]).filter((p, i, all) => all.findIndex(q => same(p, q)) === i);
    if (points.length === 3) for (const tip of points) {
      const other = points.filter(p => !same(p, tip));
      if (Math.abs(Math.hypot(tip.x - other[0].x, tip.y - other[0].y) - Math.hypot(tip.x - other[1].x, tip.y - other[1].y)) > .01) continue;
      const index = direction(tip.x - (other[0].x + other[1].x) / 2, tip.y - (other[0].y + other[1].y) / 2, true);
      if (index >= 0) return ['▶', '▼', '◀', '▲'][index];
    }
  }
  if (segments.length === 2) {
    const [a, b] = segments;
    const joint = [a.a, a.b].find(p => same(p, b.a) || same(p, b.b));
    if (joint) {
      const ends = [same(joint, a.a) ? a.b : a.a, same(joint, b.a) ? b.b : b.a].sort((x, y) => x.x - y.x);
      if (joint.x > ends[0].x && joint.x < ends[1].x && joint.y > ends[0].y && joint.y > ends[1].y && Math.hypot(joint.x - ends[1].x, joint.y - ends[1].y) > Math.hypot(joint.x - ends[0].x, joint.y - ends[0].y) * 1.2) return '✓';
      if (Math.abs(length(a) - length(b)) < Math.max(length(a), length(b)) * .02) {
        const index = direction(joint.x - (ends[0].x + ends[1].x) / 2, joint.y - (ends[0].y + ends[1].y) / 2, true);
        if (index >= 0) return ['›', '⌄', '‹', '⌃'][index];
      }
    } else {
      const ma = { x: (a.a.x + a.b.x) / 2, y: (a.a.y + a.b.y) / 2 }, mb = { x: (b.a.x + b.b.x) / 2, y: (b.a.y + b.b.y) / 2 };
      if (same(ma, mb) && Math.abs(length(a) - length(b)) < length(a) * .02 && Math.abs((a.b.x - a.a.x) * (b.b.x - b.a.x) + (a.b.y - a.a.y) * (b.b.y - b.a.y)) < length(a) * length(b) * .02) return Math.abs(a.b.x - a.a.x) < .01 || Math.abs(a.b.y - a.a.y) < .01 ? '+' : '×';
    }
  }
  return null;
}
