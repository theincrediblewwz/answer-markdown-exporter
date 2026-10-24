import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { prepareAssets, zipMarkdown } from '../src/assets';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1cAAAAASUVORK5CYII=', 'base64'));
const pngUri = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
const gif = Uint8Array.from(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'));
const response = (bytes: Uint8Array = png, type = 'image/png') => new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'content-type': type } });
const noFetch = (() => { throw new Error('No network should be requested'); }) as typeof fetch;

async function withLocation<T>(run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://chatgpt.com/c/local-test', origin: 'https://chatgpt.com' } });
  try { return await run(); }
  finally { if (previous) Object.defineProperty(globalThis, 'location', previous); else Reflect.deleteProperty(globalThis, 'location'); }
}

test('no-image exports remain a single unchanged Markdown string without fetching code or math lookalikes', async () => {
  const markdown = '# 标题\n\n$\\text{![not-an-image](https://example.invalid/math.png)}$\n\n```markdown\n![also code](https://example.invalid/code.png)\n<img src="https://example.invalid/code-html.png">\n```\n';
  const prepared = await prepareAssets(markdown, { fetcher: noFetch });
  assert.equal(prepared.markdown, markdown);
  assert.equal(prepared.hasImages, false);
  assert.deepEqual(prepared.files, {});
  assert.deepEqual(prepared.imageAssets, {});
  assert.deepEqual(prepared.diagnostics, []);
});

test('an inline raster image becomes a relative ZIP asset while math and indented code stay exact', async () => {
  const prefix = '# 保真\n\n$$\n\\begin{aligned}\nx &= y + 1 \\\\\nz &= 2\n\\end{aligned}\n$$\n\n````python\ndef f():\n    marker = "```"\n\n\n````\n\n';
  const markdown = prefix + `前 ![一张图](${pngUri} "标题") 后\n`;
  const prepared = await prepareAssets(markdown, { fetcher: noFetch });
  assert.equal(prepared.hasImages, true);
  assert.equal(prepared.markdown, prefix + '前 ![一张图](images/image-001.png "标题") 后\n');
  assert.deepEqual(prepared.files['images/image-001.png'], png);
  assert.equal(prepared.imageAssets[pngUri], pngUri);
  assert.equal(prepared.imageAssets['images/image-001.png'], pngUri);
  const archive = unzipSync(zipMarkdown(prepared));
  assert.deepEqual(Object.keys(archive).sort(), ['answer.md', 'images/image-001.png']);
  assert.equal(strFromU8(archive['answer.md']), prepared.markdown);
  assert.deepEqual(archive['images/image-001.png'], png);
});

test('repeated image URLs are fetched once and every Markdown reference points at one saved file', async () => {
  let calls = 0;
  const prepared = await prepareAssets('![first](https://images.example/a.png)\n\n![second](https://images.example/a.png)\n', { fetcher: (async () => { calls += 1; return response(); }) as typeof fetch });
  assert.equal(calls, 1);
  assert.equal(Object.keys(prepared.files).length, 1);
  assert.equal((prepared.markdown.match(/images\/image-001\.png/g) || []).length, 2);
  assert.deepEqual(prepared.diagnostics, []);
});

test('reference-style images are resolved without rewriting unrelated definitions or linked prose', async () => {
  const markdown = '![picture][asset]\n\n[ordinary link][asset]\n\n[asset]: https://images.example/a.png "Description"\n';
  const prepared = await prepareAssets(markdown, { fetcher: (async () => response()) as typeof fetch });
  assert.equal(prepared.markdown, '![picture](images/image-001.png "Description")\n\n[ordinary link][asset]\n\n[asset]: https://images.example/a.png "Description"\n');
});

test('controlled HTML table images preserve every other byte and decode URL attribute escapes', async () => {
  let requested = '';
  const markdown = '<table>\n<tr><td colspan="2">A &amp; B<img alt="chart" src="https://images.example/a.png?x=1&amp;y=2"></td></tr>\n</table>\n';
  const prepared = await prepareAssets(markdown, { fetcher: (async input => { requested = String(input); return response(); }) as typeof fetch });
  assert.equal(requested, 'https://images.example/a.png?x=1&y=2');
  assert.equal(prepared.markdown, markdown.replace('https://images.example/a.png?x=1&amp;y=2', 'images/image-001.png'));
  assert.equal(Object.keys(prepared.files).length, 1);
  assert.equal(prepared.imageAssets[requested], pngUri);
});

test('HTML data-src is not mistaken for src and an image missing src is explicitly unsaved', async () => {
  const markdown = '<table><tr><td><img data-src="https://images.example/private.png" alt="placeholder"></td></tr></table>\n';
  const prepared = await prepareAssets(markdown, { fetcher: noFetch });
  assert.equal(prepared.hasImages, false);
  assert.equal(prepared.markdown, markdown);
  assert.equal(prepared.diagnostics[0].code, 'IMAGE_ASSET_UNAVAILABLE');
});

test('same-origin assets use the current login context and cross-origin assets omit credentials and referrers', async () => {
  await withLocation(async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const prepared = await prepareAssets('![same](https://chatgpt.com/backend-api/file/image)\n\n![other](https://images.example/b.png)\n\n![blob](blob:https://chatgpt.com/fixed-test-id)\n', { fetcher: (async (input, init) => { requests.push({ url: String(input), init }); return response(); }) as typeof fetch });
    assert.equal(Object.keys(prepared.files).length, 3);
    assert.deepEqual(requests.map(item => item.init?.credentials), ['include', 'omit', 'include']);
    assert.deepEqual(requests.map(item => item.init?.referrerPolicy), ['no-referrer', 'no-referrer', 'no-referrer']);
    assert.ok(requests.every(item => item.init?.signal instanceof AbortSignal));
  });
});

test('PNG, JPEG, GIF and WebP magic determine safe saved extensions', async () => {
  const jpeg = Uint8Array.from([255, 216, 255, 224, 0, 16]);
  const webp = Uint8Array.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);
  const fixtures = [png, jpeg, gif, webp];let index = 0;
  const prepared = await prepareAssets('![a](https://images.example/1) ![b](https://images.example/2) ![c](https://images.example/3) ![d](https://images.example/4)\n', { fetcher: (async () => response(fixtures[index++], 'application/octet-stream')) as typeof fetch });
  assert.deepEqual(Object.keys(prepared.files), ['images/image-001.png', 'images/image-002.jpg', 'images/image-003.gif', 'images/image-004.webp']);
  assert.deepEqual(prepared.diagnostics, []);
});

test('SVG, executable URLs, forged image content and MIME mismatches never become ZIP image files', async () => {
  const svgUri = `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"></svg>').toString('base64')}`;
  let call = 0;
  const prepared = await prepareAssets(`![svg](${svgUri})\n\n![js](javascript:alert(1))\n\n![forged](https://images.example/forged.png)\n\n![mismatch](https://images.example/mismatch.png)\n`, { fetcher: (async () => ++call === 1 ? response(new TextEncoder().encode('<html>not an image</html>'), 'image/png') : response(gif, 'image/png')) as typeof fetch });
  assert.equal(Object.keys(prepared.files).length, 0);
  assert.equal(prepared.diagnostics.length, 4);
  assert.ok(prepared.diagnostics.every(item => item.code === 'IMAGE_TYPE_UNSUPPORTED'));
  const files = unzipSync(zipMarkdown(prepared));
  assert.deepEqual(Object.keys(files).sort(), ['EXPORT-NOTES.md', 'answer.md']);
});

test('unavailable images keep their original references and report failures without signed URLs', async () => {
  const url = 'https://images.example/photo.png?signature=private-secret';
  const markdown = `![photo](${url})\n`;
  const prepared = await prepareAssets(markdown, { fetcher: (async () => { throw new Error('Failed CORS ' + url); }) as typeof fetch });
  assert.equal(prepared.hasImages, false);
  assert.equal(prepared.markdown, markdown);
  assert.equal(prepared.diagnostics[0].code, 'IMAGE_ASSET_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(prepared.diagnostics), /signature|private-secret|images\.example/);
  assert.doesNotMatch(prepared.diagnostics[0].message, /ZIP|EXPORT-NOTES/);
  const files = unzipSync(zipMarkdown(prepared));
  assert.equal(strFromU8(files['answer.md']), markdown);
  assert.match(strFromU8(files['EXPORT-NOTES.md']), /Markdown 保留原链接/);
});

test('only successfully saved images require bundling when some image references fail', async () => {
  const markdown = '# Answer\n\n![saved](https://images.example/saved.png)\n\n![unavailable](https://images.example/unavailable.png)\n';
  const prepared = await prepareAssets(markdown, { fetcher: (async input => {
    if (String(input).endsWith('/saved.png')) return response();
    throw new Error('Unavailable');
  }) as typeof fetch });
  assert.equal(prepared.hasImages, true);
  assert.deepEqual(Object.keys(prepared.files), ['images/image-001.png']);
  assert.match(prepared.markdown, /!\[saved\]\(images\/image-001\.png\)/);
  assert.match(prepared.markdown, /!\[unavailable\]\(https:\/\/images\.example\/unavailable\.png\)/);
  assert.equal(prepared.diagnostics.length, 1);
  const files = unzipSync(zipMarkdown(prepared));
  assert.deepEqual(Object.keys(files).sort(), ['EXPORT-NOTES.md', 'answer.md', 'images/image-001.png']);
  assert.deepEqual(files['images/image-001.png'], png);
  assert.equal(strFromU8(files['answer.md']), prepared.markdown);
});

test('the advertised per-image size is rejected before reading the response body', async () => {
  const prepared = await prepareAssets('![large](https://images.example/large.png)', { fetcher: (async () => new Response(png as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'image/png', 'content-length': String(8 * 1024 * 1024 + 1) } })) as typeof fetch });
  assert.equal(prepared.diagnostics[0].code, 'IMAGE_SIZE_LIMIT');
  assert.deepEqual(prepared.files, {});
});

test('streamed bytes enforce the per-image bound even when content-length is absent', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024));controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  });
  const prepared = await prepareAssets('![large](https://images.example/large.png)', { fetcher: (async () => new Response(stream, { headers: { 'content-type': 'image/png' } })) as typeof fetch });
  assert.equal(prepared.diagnostics[0].code, 'IMAGE_SIZE_LIMIT');
  assert.equal(cancelled, true);
  assert.deepEqual(prepared.files, {});
});

test('the image count cap fetches only thirty unique assets while keeping excess original links', async () => {
  let calls = 0;
  const markdown = Array.from({ length: 31 }, (_, index) => `![${index}](https://images.example/${index}.png)`).join('\n\n');
  const prepared = await prepareAssets(markdown, { fetcher: (async () => { calls += 1;return response(); }) as typeof fetch });
  assert.equal(calls, 30);
  assert.equal(Object.keys(prepared.files).length, 30);
  assert.equal(prepared.diagnostics[0].code, 'IMAGE_COUNT_LIMIT');
  assert.match(prepared.markdown, /https:\/\/images\.example\/30\.png/);
});

test('the aggregate data-URI budget rejects an oversized bundle without discarding prior saved images', async () => {
  const large = new Uint8Array(8 * 1024 * 1024);large.set(png.subarray(0, 8));
  const prepared = await prepareAssets('![one](https://images.example/1.png)\n\n![two](https://images.example/2.png)\n\n![three](https://images.example/3.png)', { fetcher: (async () => response(large)) as typeof fetch });
  assert.equal(Object.keys(prepared.files).length, 2);
  assert.equal(prepared.diagnostics[0].code, 'IMAGE_TOTAL_LIMIT');
  assert.match(prepared.markdown, /https:\/\/images\.example\/3\.png/);
});

test('an already cancelled export does not start any image request', async () => {
  const controller = new AbortController();controller.abort();
  const prepared = await prepareAssets('![image](https://images.example/a.png)', { fetcher: noFetch, signal: controller.signal });
  assert.equal(prepared.diagnostics[0].code, 'IMAGE_ABORTED');
});

test('an export cancellation interrupts a pending request', async () => {
  const controller = new AbortController();
  const pending = prepareAssets('![image](https://images.example/a.png)', { fetcher: (() => new Promise(() => {})) as typeof fetch, signal: controller.signal });
  controller.abort();
  const prepared = await pending;
  assert.equal(prepared.diagnostics[0].code, 'IMAGE_ABORTED');
});

test('a stalled image request times out instead of blocking the export indefinitely', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = prepareAssets('![image](https://images.example/a.png)', { fetcher: (() => new Promise(() => {})) as typeof fetch });
  context.mock.timers.tick(12_000);
  const prepared = await pending;
  assert.equal(prepared.diagnostics[0].code, 'IMAGE_TIMEOUT');
});

test('ZIP construction rejects unsafe entry paths and unsafe Markdown filenames', () => {
  const base = { markdown: 'text\n', imageAssets: {}, files: {}, hasImages: false, diagnostics: [] };
  assert.throws(() => zipMarkdown(base, '../outside.md'), /文件名无效/);
  assert.throws(() => zipMarkdown({ ...base, files: { '../outside.png': png } }), /路径无效/);
});

test('Windows independent ZIP reader opens the UTF-8 Markdown and exact raster bytes', { skip: process.platform !== 'win32' }, async context => {
  const prepared = await prepareAssets('# 图片 ZIP\n\n![示例](' + pngUri + ')\n', { fetcher: noFetch });
  const script = [
    'Add-Type -AssemblyName System.IO.Compression',
    '$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    '$memory = [IO.MemoryStream]::new($bytes)',
    '$zip = [IO.Compression.ZipArchive]::new($memory, [IO.Compression.ZipArchiveMode]::Read)',
    'try {',
    '  $reader = [IO.StreamReader]::new($zip.GetEntry("answer.md").Open(), [Text.Encoding]::UTF8)',
    '  try { $markdown = $reader.ReadToEnd() } finally { $reader.Dispose() }',
    '  $image = [IO.MemoryStream]::new()',
    '  $source = $zip.GetEntry("images/image-001.png").Open()',
    '  try { $source.CopyTo($image) } finally { $source.Dispose() }',
    '  $sha = [Security.Cryptography.SHA256]::Create()',
    '  try { $digest = [BitConverter]::ToString($sha.ComputeHash($image.ToArray())).Replace("-", "").ToLowerInvariant() } finally { $sha.Dispose(); $image.Dispose() }',
    '  [pscustomobject]@{reader="System.IO.Compression.ZipArchive";entryCount=$zip.Entries.Count;utf8ChinesePresent=$markdown.Contains([char]0x56fe);relativePathFound=$markdown.Contains("images/image-001.png");pngSha256=$digest} | ConvertTo-Json -Compress',
    '} finally { $zip.Dispose(); $memory.Dispose() }',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: Buffer.from(zipMarkdown(prepared)).toString('base64'), encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout.trim());
  assert.equal(proof.reader, 'System.IO.Compression.ZipArchive');
  assert.equal(proof.entryCount, 2);
  assert.equal(proof.utf8ChinesePresent, true);
  assert.equal(proof.relativePathFound, true);
  assert.equal(proof.pngSha256, createHash('sha256').update(png).digest('hex'));
  context.diagnostic('Independent ZIP compatibility confirmed: ' + JSON.stringify(proof));
});
