import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { extractMarkdown } from '../src/extract';

interface AstNode { type: string; value?: string; lang?: string; children?: AstNode[]; }
const source = 'def render(rows):\n    marker = "```"\n    for row in rows:\n        if row["ok"]:\n            print(row["name"])\n\n    return "done"';
function find(node: AstNode, type: string): AstNode[] {
  return [...(node.type === type ? [node] : []), ...(node.children || []).flatMap(child => find(child, type))];
}
function parsed(markdown: string): AstNode {
  return unified().use(remarkParse).parse(markdown) as unknown as AstNode;
}
function currentBlock(codeAttributes = '', bodyAttributes = '', wrapperAttributes = ''): string {
  return `<div data-code-block="true" data-markdown-copy="code-block" ${wrapperAttributes}>
    <div data-markdown-copy="exclude"><svg aria-hidden="true"><path d="M1 1"></path></svg><div>Python</div><div data-code-block-controls="true"><button>复制代码</button><label>启用自动换行</label></div></div>
    <div data-code-block-source="true" ${bodyAttributes}><code ${codeAttributes}></code></div>
  </div>`;
}
function capture(html: string, run: (answer: Element) => void): void {
  const page = new JSDOM(`<article>${html}</article>`);
  try {
    for (const code of page.window.document.querySelectorAll('code')) {
      for (const [index, line] of source.split('\n').entries()) {
        if (index) code.append(page.window.document.createTextNode('\n'));
        const token = page.window.document.createElement('span');
        token.textContent = line;
        code.append(token);
      }
    }
    run(page.window.document.querySelector('article')!);
  } finally { page.window.close(); }
}

test('the current GPT no-PRE code block retains its language and exact highlighted source without header controls', () => {
  capture(currentBlock(), answer => {
    assert.equal(answer.querySelectorAll('pre').length, 0, 'this fixture must exercise the actual no-PRE renderer');
    const result = extractMarkdown(answer);
    assert.equal(result.codeBlocks.length, 1);
    assert.equal(result.codeBlocks[0].text, source);
    assert.match(result.codeBlocks[0].language || '', /^python$/i);
    const ast = parsed(result.markdown);
    const blocks = find(ast, 'code');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].value, source, 'four-space nesting, the blank line and literal backticks must survive serialization');
    assert.match(blocks[0].lang || '', /^python$/i);
    assert.equal(find(ast, 'paragraph').length, 0);
    assert.doesNotMatch(result.markdown, /复制代码|自动换行|M1 1|<svg/);
    assert.deepEqual(result.diagnostics, []);
  });
});

for (const [name, codeAttributes, bodyAttributes, wrapperAttributes, expected] of [
  ['CODE language class', 'class="language-text"', '', '', 'text'],
  ['explicit CODE language over its class', 'data-language="javascript" class="language-typescript"', '', '', 'javascript'],
  ['source-container language', '', 'data-language="json"', '', 'json'],
  ['code-block language', '', '', 'data-language="shell"', 'shell'],
] as const) {
  test(`a current GPT no-PRE ${name} takes priority over the visual Python label`, () => {
    capture(currentBlock(codeAttributes, bodyAttributes, wrapperAttributes), answer => {
      const result = extractMarkdown(answer);
      assert.deepEqual(result.codeBlocks, [{ text: source, language: expected }]);
      const blocks = find(parsed(result.markdown), 'code');
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].lang, expected);
      assert.equal(blocks[0].value, source);
    });
  });
}

test('a language-looking ordinary neighbor is retained as prose and never borrowed by a no-PRE code node', () => {
  capture('<div><div>Python</div><div data-code-block-controls="true"><button>复制代码</button></div><div data-code-block-source="true"><code></code></div></div>', answer => {
    const result = extractMarkdown(answer);
    assert.deepEqual(result.codeBlocks, [{ text: source, language: null }]);
    const ast = parsed(result.markdown);
    assert.equal(find(ast, 'code')[0].lang, null);
    assert.ok(find(ast, 'text').some(node => node.value === 'Python'));
    assert.equal(find(ast, 'code')[0].value, source);
  });
});

test('a modern visual language label requires its own code-header control marker', () => {
  capture(currentBlock().replace('data-code-block-controls="true"', 'data-unrelated-controls="true"'), answer => {
    const result = extractMarkdown(answer);
    assert.deepEqual(result.codeBlocks, [{ text: source, language: null }]);
    assert.equal(find(parsed(result.markdown), 'code')[0].value, source);
  });
});

test('a marked code-containing wrapper with additional prose does not swallow that prose into code', () => {
  capture(currentBlock().replace('<div data-code-block-source', '<p>Keep this explanation.</p><div data-code-block-source'), answer => {
    const result = extractMarkdown(answer);
    assert.match(result.markdown, /Keep this explanation\./);
    assert.equal(result.codeBlocks.length, 1);
    assert.equal(result.codeBlocks[0].text, source);
    assert.equal(find(parsed(result.markdown), 'code')[0].value, source);
  });
});

test('a virtualized code surface without source keeps an explicit position and warning', () => {
  const page = new JSDOM('<article><p>Before</p><div data-code-block="true" data-markdown-copy="code-block"><div data-markdown-copy="exclude"><div>Python</div></div><div style="height:240px"></div></div><p>After</p></article>');
  try {
    const result = extractMarkdown(page.window.document.querySelector('article')!);
    assert.match(result.markdown, /Before/); assert.match(result.markdown, /After/);
    assert.match(result.markdown, /代码块尚未加载/);
    assert.equal(result.codeBlocks.length, 0);
    assert.ok(result.diagnostics.some(item => item.code === 'CODE_SOURCE_NOT_LOADED'));
  } finally { page.window.close(); }
});

for (const attributes of ['hidden', 'aria-hidden="true"', 'data-gpt-md-ignore']) {
  test(`a modern code source container marked ${attributes} stays excluded`, () => {
    capture(currentBlock('', attributes), answer => {
      const result = extractMarkdown(answer);
      assert.equal(result.markdown, '');
      assert.deepEqual(result.codeBlocks, []);
    });
  });

  test(`a modern direct CODE node marked ${attributes} stays excluded`, () => {
    capture(currentBlock(attributes), answer => {
      const result = extractMarkdown(answer);
      assert.equal(result.markdown, '');
      assert.deepEqual(result.codeBlocks, []);
    });
  });

  test(`a modern visual language label marked ${attributes} is never borrowed`, () => {
    capture(currentBlock().replace('<div>Python</div>', `<div ${attributes}>Python</div>`), answer => {
      const result = extractMarkdown(answer);
      assert.deepEqual(result.codeBlocks, [{ text: source, language: null }]);
      const blocks = find(parsed(result.markdown), 'code');
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].lang, null);
      assert.equal(blocks[0].value, source);
      assert.doesNotMatch(result.markdown, /Python/i);
    });
  });
}
