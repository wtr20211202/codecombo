// i18n 死键扫描（诊断工具，输出需人工分诊——勿直接批量删除）：
// 比对 zh-CN 叶子键与 src 源码字面引用，输出「完整路径与叶名在源码中均无出现」的键。
// 注意误报来源：t(`前缀${x}`) 动态构造、常量表间接引用、循环内拼 key 等都会被误判；
// 近似基线：2026-09 扫出 ~338 条候选，其中相当部分为动态引用（如 changes.* 经
// utils/git 状态映射间接消费的已被字面覆盖，其余需逐条核实）。用法：node scripts/scan-dead-keys.cjs
const fs = require('fs');
const path = require('path');
const zhSrc = fs.readFileSync('src/locales/zh-CN.ts', 'utf-8');
const leafPaths = [];
const stack = [];
const lineRe = /^(\s*)(?:'([^']+)'|([A-Za-z0-9_]+))\s*:\s*(.*)$/;
zhSrc.split('\n').forEach((line) => {
  const m = line.match(lineRe);
  if (!m) return;
  const indent = m[1].length;
  const key = m[2] || m[3];
  const rest = m[4];
  while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
  stack.push({ indent, key });
  if (/^\s*'/.test(rest) || /^\s*"/.test(rest) || /^\s*`/.test(rest) || /^[\d.]+\s*,?\s*$/.test(rest) || /^(true|false|null)\s*,?\s*$/.test(rest)) {
    leafPaths.push(stack.map(s => s.key).join('.'));
  }
});
let allSrc = '';
function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (!p.includes('mimosa') && !p.includes('node_modules')) walk(p); continue; }
    if (!/\.(vue|ts|css|html)$/.test(f) || f.includes('.test.') || p.includes('locales') || p.includes('.d.ts')) continue;
    allSrc += fs.readFileSync(p, 'utf-8') + '\n';
  }
}
walk('src');
// 键名出现处（locales 之外）至少一次的叶子，视为可能被动态/间接使用
const dead = leafPaths.filter((p) => {
  if (allSrc.includes("'" + p + "'")) return false;
  if (allSrc.includes('"' + p + '"')) return false;
  if (allSrc.includes('`' + p + '`')) return false;
  const leaf = p.split('.').pop();
  return !allSrc.includes(leaf);
});
console.log('dead (strict: leaf name nowhere):', dead.length);
console.log(dead.join('\n'));
