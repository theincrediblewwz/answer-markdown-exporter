import { build } from 'esbuild';
import { mkdir, writeFile, cp, readFile, readdir, lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
// dist is generated output. Never carry temporary QA pages into a release.
// Check the resolved target before recursively removing it on Windows.
const resolvedRoot = await realpath(root);
if (path.dirname(out) !== root || path.basename(out) !== 'dist') throw new Error('Unexpected build output path');
try {
  const existing = await lstat(out);
  if (!existing.isDirectory() || existing.isSymbolicLink()
    || await realpath(out) !== path.join(resolvedRoot, 'dist')) throw new Error('Refusing to clean a redirected build output');
  await rm(out, { recursive: true });
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(out, { recursive: true });
await build({ entryPoints: [path.join(root, 'src/content.ts')], bundle: true, outfile: path.join(out, 'content.js'), format: 'iife', target: 'chrome120', loader: { '.css': 'text' }, legalComments: 'linked', minify: false, define: { __EXTENSION_VERSION__: JSON.stringify(pkg.version) } });
await build({ entryPoints: [path.join(root, 'src/popup.ts')], bundle: true, outfile: path.join(out, 'popup.js'), format: 'iife', target: 'chrome120' });
await build({ entryPoints: [path.join(root, 'src/background.ts')], bundle: true, outfile: path.join(out, 'background.js'), format: 'iife', target: 'chrome120' });
await build({ entryPoints: [path.join(root, 'src/print.ts')], bundle: true, outfile: path.join(out, 'print.js'), format: 'iife', target: 'chrome120', loader: { '.css': 'text' }, legalComments: 'linked' });
await cp(path.join(root, 'node_modules/katex/dist/fonts'), path.join(out, 'vendor/katex/fonts'), { recursive: true });
const manifest = {
  manifest_version: 3, name: '回答导出工具', version: pkg.version, minimum_chrome_version: '130',
  description: '本地保存已加载的 ChatGPT 回答：Markdown、图片 ZIP、复制、预览与 PDF。独立项目，非官方产品。',
  permissions: ['clipboardWrite'],
  background: { service_worker: 'background.js' },
  action: { default_title: '回答导出工具', default_popup: 'popup.html' },
  content_scripts: [{ matches: ['https://chatgpt.com/*', 'https://www.chatgpt.com/*'], js: ['content.js'], run_at: 'document_idle' }],
  web_accessible_resources: [{ resources: ['vendor/katex/fonts/*'], matches: ['https://chatgpt.com/*', 'https://www.chatgpt.com/*'] }],
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" }
};
await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(out, 'print.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>PDF 预览</title><script src="print.js" defer></script></head><body></body></html>');
await writeFile(path.join(out, 'popup.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>回答导出工具</title><style>body{width:330px;margin:0;padding:18px;font:14px/1.7 system-ui;color:#263647;background:#fff}h1{font-size:18px;margin:0 0 10px}a{color:#087e70}button{border:1px solid #c9d5df;border-radius:7px;padding:6px 10px;background:#f7fafb;color:inherit;cursor:pointer}button:disabled{opacity:.5;cursor:wait}button:focus-visible{outline:2px solid #087e70;outline-offset:2px}.actions{display:flex;gap:8px;flex-wrap:wrap}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.6 Consolas,monospace;max-height:240px;overflow:auto;background:#f5f7fa;padding:10px;border-radius:7px}.hint{font-size:12px;color:#64748b}</style><script src="popup.js" defer></script></head><body><h1>回答导出工具 <small>${pkg.version}</small></h1><p id="status" role="status">正在检测当前标签页…</p><div class="actions"><button id="retry" type="button">重新检测</button><button id="copy" type="button" disabled>复制检测信息</button></div><details><summary>页面检测详情</summary><pre id="details"></pre></details><p class="hint">检测信息仅包含版本、节点数量和运行错误，不含对话正文与对话链接。所有处理均在本机完成。</p><a href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">打开 ChatGPT</a></body></html>`);
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const notices = ['Third-party dependencies (independently obtained from npm):'];
const seen = new Set();
for (const [relative, entry] of Object.entries(lock.packages || {})) {
  if (!relative || entry.dev === true) continue;
  const dir = path.join(root, relative);
  const meta = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const key = `${meta.name}@${meta.version}`; if (seen.has(key)) continue; seen.add(key);
  notices.push(`\n${key} — ${meta.license || 'See package license'}`);
  let licenseIncluded = false;
  for (const candidate of await readdir(dir)) {
    if (!/^(?:licen[sc]e|notice)(?:[.-].*)?$/i.test(candidate)) continue;
    notices.push(await readFile(path.join(dir, candidate), 'utf8'));licenseIncluded = true;
  }
  if (!licenseIncluded) {
    if (!['rehype-katex@7.0.1', 'remark-math@6.0.0'].includes(key)) throw new Error(`Missing third-party license: ${key}`);
    notices.push(await readFile(path.join(root, 'licenses/remark-math-MIT.txt'), 'utf8'));
  }
}
await writeFile(path.join(out, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'));
await cp(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
console.log('Built unpacked Edge extension:', out);
