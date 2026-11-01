// i18n 键位一致性检查：zh-CN 与 en-US 键结构必须完全一致
const fs = require('fs');
const path = require('path');

function loadLocale(p) {
  let src = fs.readFileSync(p, 'utf8');
  src = src.replace(/export\s+default\s*/, 'module.exports =');
  const tmp = path.join(__dirname, '.tmp-locale.cjs');
  fs.writeFileSync(tmp, src);
  const obj = require(tmp);
  fs.unlinkSync(tmp);
  return obj;
}

const zh = loadLocale(path.join(__dirname, '..', 'src', 'locales', 'zh-CN.ts'));
const en = loadLocale(path.join(__dirname, '..', 'src', 'locales', 'en-US.ts'));

function flatten(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') out.push(...flatten(v, key));
    else out.push(key);
  }
  return out.sort();
}

const zk = flatten(zh), ek = flatten(en);
const onlyZh = zk.filter(k => !ek.includes(k));
const onlyEn = ek.filter(k => !zk.includes(k));
console.log('zh keys:', zk.length, 'en keys:', ek.length);
if (onlyZh.length) console.log('MISSING in en-US:\n' + onlyZh.map(k => '  ' + k).join('\n'));
if (onlyEn.length) console.log('MISSING in zh-CN:\n' + onlyEn.map(k => '  ' + k).join('\n'));
if (!onlyZh.length && !onlyEn.length) console.log('OK: key structures identical');

const empty = [];
function findEmpty(obj, prefix = '') {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') findEmpty(v, key);
    else if (typeof v === 'string' && v.trim() === '') empty.push(key);
  }
}
findEmpty(zh); findEmpty(en);
if (empty.length) console.log('EMPTY strings:\n' + empty.map(k => '  ' + k).join('\n'));
