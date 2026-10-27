// Build dist/agent-village-demo.html: one self-contained file (JS bundled,
// fonts inlined) that runs the demo anywhere — GitHub Pages, a file:// double
// click, or an iframe. The daemon does NOT need this; it serves web/ directly.
//
//   npm i --no-save esbuild && npm run build:demo

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let esbuild;
try { esbuild = await import('esbuild'); } catch {
  console.error('esbuild is needed for the demo bundle: npm i --no-save esbuild');
  process.exit(1);
}

const out = await esbuild.build({
  entryPoints: [path.join(ROOT, 'web/main.js')],
  bundle: true, format: 'esm', minify: true, write: false, target: 'es2020',
  // the demo module is loaded lazily in main.js; bundle it in
  splitting: false,
});
let js = out.outputFiles[0].text;

let html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
html = html.replace(/url\('\.\/fonts\/([^']+)'\)/g, (_, f) => {
  const b64 = fs.readFileSync(path.join(ROOT, 'web/fonts', f)).toString('base64');
  return `url(data:font/woff2;base64,${b64})`;
});
html = html.replace('<script type="module" src="./main.js"></script>', () => `<script>window.__AV_DEMO__ = true;</script>\n<script type="module">\n${js.replace(/<\/script/g, '<\\/script')}\n</script>`);
html = html.replace('<title>Agent Village</title>', '<title>Agent Village — demo</title>');

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const file = path.join(ROOT, 'dist/agent-village-demo.html');
fs.writeFileSync(file, html);
console.log(`wrote ${path.relative(ROOT, file)} (${(html.length / 1024).toFixed(0)} KB)`);
