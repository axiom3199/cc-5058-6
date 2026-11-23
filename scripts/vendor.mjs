// 下载并本地化 three.js，使图形界面可离线运行（无外部 CDN 依赖）。
import { mkdirSync, createWriteStream } from 'node:fs';
import { dirname } from 'node:path';

const targets = [
  ['three@0.160.0/build/three.module.js', 'web/vendor/three.module.js'],
  ['three@0.160.0/examples/jsm/controls/OrbitControls.js', 'web/vendor/OrbitControls.js'],
];

mkdirSync('web/vendor', { recursive: true });

for (const [pkg, out] of targets) {
  const url = `https://cdn.jsdelivr.net/npm/${pkg}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${url}: ${res.status}`);
  const outPath = new URL(`../${out}`, import.meta.url).pathname;
  mkdirSync(dirname(outPath), { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  const ws = createWriteStream(outPath);
  ws.end(buf);
  await new Promise((r) => ws.on('close', r));
  console.log(`vendored ${pkg} -> ${out} (${buf.length} bytes)`);
}
