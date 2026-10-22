/**
 * 校验构建产物：manifest 里引用的每个路径在 dist 里都真实存在，
 * 并且该声明的 content_scripts 真的声明了。
 *
 * 为什么需要这个：单测全绿也救不了「manifest 忘了声明 content_scripts」
 * 这种接线错误——模块单测测的是孤立函数，测不到扩展有没有被注入到页面。
 * 这个脚本是构建后的最后一道闸。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录：从脚本自身位置推算，换机器/换盘符都不用改代码。
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO, 'dist');
const problems: string[] = [];

function readManifest(): any {
  const p = join(DIST, 'manifest.json');
  if (!existsSync(p)) {
    console.error('dist/manifest.json 不存在——先跑 npm run build');
    process.exit(1);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

const m = readManifest();

console.log('=== manifest 关键字段 ===');
console.log('manifest_version:', m.manifest_version);
console.log('name           :', m.name);
console.log('version        :', m.version);

if (m.manifest_version !== 3) problems.push('manifest_version 必须是 3');

// content_scripts 必须有，否则 content script 根本不会被注入
if (!Array.isArray(m.content_scripts) || m.content_scripts.length === 0) {
  problems.push('manifest 没有 content_scripts —— content script 永远不会被注入');
} else {
  console.log('content_scripts:', JSON.stringify(m.content_scripts));
  for (const cs of m.content_scripts) {
    if (!Array.isArray(cs.matches) || cs.matches.length === 0) {
      problems.push('content_scripts 缺少 matches');
    }
    if (!Array.isArray(cs.js) || cs.js.length === 0) {
      problems.push('content_scripts 缺少 js');
    }
  }
}

// manifest 引用的每个文件都必须在 dist 里存在
const refs: string[] = [];
if (m.background?.service_worker) refs.push(m.background.service_worker);
if (m.action?.default_popup) refs.push(m.action.default_popup);
for (const k of Object.keys(m.icons ?? {})) refs.push(m.icons[k]);
for (const cs of m.content_scripts ?? []) {
  for (const j of cs.js ?? []) refs.push(j);
}
for (const w of m.web_accessible_resources ?? []) {
  for (const r of w.resources ?? []) refs.push(r);
}

console.log('\n=== 引用路径检查 ===');
for (const r of refs) {
  const p = join(DIST, r);
  const ok = existsSync(p);
  console.log((ok ? 'OK   ' : 'MISS ') + r);
  if (!ok) problems.push('manifest 引用的文件不存在：' + r);
}

// content script 必须是真正的 JS 入口（不能是 .ts 源码路径——那没被编译）
for (const cs of m.content_scripts ?? []) {
  for (const j of cs.js ?? []) {
    if (j.endsWith('.ts')) {
      problems.push('content_scripts 指向了 .ts 源码：' + j + '（CRXJS 应重写成 assets/*.js）');
    }
  }
}

// web_accessible_resources 里的页面脚本路径要与 content script 里 getURL() 的字面量一致
const pageFetch = (m.web_accessible_resources ?? []).flatMap((w: any) => w.resources ?? []);
if (!pageFetch.includes('content/page-fetch.js')) {
  problems.push('web_accessible_resources 里没有 content/page-fetch.js（页面上下文脚本注入会 404）');
}

// MV3 合规：不能用远程代码
const manifestText = readFileSync(join(DIST, 'manifest.json'), 'utf8');
if (/content_security_policy/.test(manifestText) && /unsafe-eval/.test(manifestText)) {
  problems.push('CSP 里出现 unsafe-eval');
}
if (m.content_security_policy) {
  problems.push('MV3 不允许自定义宽松 CSP，删掉 content_security_policy');
}

console.log('\n=== 结果 ===');
if (problems.length) {
  console.error('发现 ' + problems.length + ' 个问题:');
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('全部通过 ✓');
