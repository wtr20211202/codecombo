#!/usr/bin/env node
// check-commit-msg.cjs —— 提交信息规范检查（commit-msg 门禁，P-20261002-92）
//
// 规则（只核验标题行，正文不限；git 自动生成的 Merge/Revert 提交跳过）：
//   1. 格式：<type>(<scope>)?: <标题>，类型与冒号间括号可选、冒号后必须有一个空格
//   2. 类型白名单：TYPES（取自本仓历史既有类型 + 常规 conventional 类型，按需增删）
//   3. scope 可选但写了就不能为空：type(): 违规，应写 type(scope): 或去掉括号
//   4. 标题非空（中文标题惯例，确定性检查只拦空标题/纯空白）
//   5. 长度上限：标题默认 ≤ 100 字符（--max-len 覆盖；上限只拦超长漂移，不溯及存量）
//
// 用法：
//   node scripts/check-commit-msg.cjs <sha|ref>          # 单条核验（违规 → 退出码 1）
//   node scripts/check-commit-msg.cjs <range>            # 范围核验，如 HEAD~3..HEAD / origin/main..HEAD
//   node scripts/check-commit-msg.cjs --file <msgfile>   # 核验提交信息文件（commit-msg hook 入口）
//   node scripts/check-commit-msg.cjs --report [<range>] # 报告模式：只列违规不阻断（缺省最近 50 条）
//   node scripts/check-commit-msg.cjs --install-hook     # 可选安装 commit-msg hook（已存在则不覆盖）
//   npm run check:commit -- <range>                      # web/ 下的独立调用（等价第一条/第二条）
//   npm run check:commit                                 # web/ 下裸调用 = 最近 50 条报告（不阻断）
//
// 说明：
//   - 门禁只查新增范围（单条/给定 range），历史存量不阻断；存量清单用 --report 首跑出报告
//   - hook 为可选安装：node scripts/check-commit-msg.cjs --install-hook（worktree 与主仓共享
//     主 .git/hooks，装一次全仓生效；删除 <hooks>/commit-msg 即卸载）
//   - 退出码：0 合规/报告；1 违规（--report 模式违规也返回 0）；2 用法/执行错误

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 类型白名单：feat/fix 等常规类型 + 本仓历史沉淀的 polish/merge/diag/security/review/i18n
const TYPES = [
  'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci',
  'chore', 'revert', 'polish', 'merge', 'security', 'diag', 'review', 'i18n',
];
const DEFAULT_MAX_LEN = 100;
const SUBJECT_DISPLAY_MAX = 120; // 违规条目里标题截断展示宽度

// git 自动生成的提交信息不属规范约束对象（merge 记录另有 merge:/merge(scope): 项目惯例）
const SKIP_PREFIXES = [/^Merge /, /^Revert "/];
const SUBJECT_RE = /^([a-zA-Z][a-zA-Z0-9-]*)(\(([^()]*)\))?: (.*)$/;

const RULE_LABELS = {
  format: '格式不符 type(scope): 标题',
  type: '类型不在白名单',
  scope: 'scope 为空',
  subject: '标题为空',
  length: '标题超长',
};

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trimEnd();
}

// 从提交信息原文取标题行：跳过注释行（hook 收到的文件可能仍带 # 帮助块）与空行
function subjectOfMessage(raw) {
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t !== '' && !t.startsWith('#')) return t;
  }
  return '';
}

// 核验单条标题，返回违规列表 [{ rule, detail }]
function validateSubject(subject, maxLen) {
  if (SKIP_PREFIXES.some((re) => re.test(subject))) return [];
  if (subject.trim() === '') return [{ rule: 'subject', detail: '标题为空（空提交信息）' }];
  const errs = [];
  const m = SUBJECT_RE.exec(subject);
  if (!m) {
    errs.push({ rule: 'format', detail: `「${display(subject)}」不符合 <type>(<scope>)?: <标题> 格式（类型|可选 scope|冒号+空格|非空标题）` });
    return errs;
  }
  const [, type, scopeGroup, scope, title] = m;
  if (!TYPES.includes(type)) errs.push({ rule: 'type', detail: `类型「${type}」不在白名单（${TYPES.join('|')}）` });
  if (scopeGroup !== undefined && scope.trim() === '') errs.push({ rule: 'scope', detail: 'scope 为空：写 type(scope): 或去掉括号' });
  if (title.trim() === '') errs.push({ rule: 'subject', detail: '标题为空' });
  else if (subject.length > maxLen) errs.push({ rule: 'length', detail: `标题 ${subject.length} 字符超上限 ${maxLen}` });
  return errs;
}

function display(s) {
  return s.length > SUBJECT_DISPLAY_MAX ? s.slice(0, SUBJECT_DISPLAY_MAX) + '…' : s;
}

// 列出提交：[{ hash, date, author, subject }]
function listCommits(revArgs) {
  const out = git(['log', `--format=%h%x1f%ad%x1f%an%x1f%s`, '--date=short', ...revArgs]);
  if (out.trim() === '') return [];
  return out
    .split('\n')
    .filter((line) => line.trim() !== '') // 尾随换行会产生空行，剔除防 undefined 解构
    .map((line) => {
      const [hash, date, author, subject] = line.split('\x1f');
      return { hash, date, author, subject };
    });
}

function renderEntry(c, errs, withMeta) {
  const meta = withMeta ? `${c.date} ${c.author} ` : '';
  const lines = [`  ${c.hash} ${meta}${display(c.subject)}`];
  for (const e of errs) lines.push(`      - [${RULE_LABELS[e.rule]}] ${e.detail}`);
  return lines.join('\n');
}

function tally(commits, maxLen) {
  let checked = 0;
  let bad = 0;
  const byRule = {};
  const entries = [];
  for (const c of commits) {
    checked++;
    const errs = validateSubject(c.subject, maxLen);
    if (!errs.length) continue;
    bad++;
    for (const e of errs) byRule[e.rule] = (byRule[e.rule] || 0) + 1;
    entries.push({ commit: c, errs });
  }
  return { checked, bad, byRule, entries };
}

function breakdownLine(byRule) {
  const parts = Object.entries(byRule).map(([r, n]) => `${RULE_LABELS[r]}×${n}`);
  return parts.length ? '违规分布：' + parts.join('，') : '';
}

function installHook() {
  let hooksDir = git(['rev-parse', '--git-path', 'hooks']);
  if (!path.isAbsolute(hooksDir)) hooksDir = path.resolve(hooksDir);
  fs.mkdirSync(hooksDir, { recursive: true });
  const target = path.join(hooksDir, 'commit-msg');
  if (fs.existsSync(target)) {
    console.log(`已存在 ${target}，不覆盖；如需重装请先删除该文件`);
    return 0;
  }
  const scriptRef = path.resolve(__filename).replace(/\\/g, '/');
  const content = [
    '#!/bin/sh',
    `# 由 scripts/check-commit-msg.cjs --install-hook 安装（P-20261002-92）；删除本文件即卸载`,
    `node "${scriptRef}" --file "$1"`,
    '',
  ].join('\n');
  fs.writeFileSync(target, content);
  try { fs.chmodSync(target, 0o755); } catch { /* Windows 文件系统无 POSIX 权限，忽略 */ }
  const samePath = (p, q) => path.resolve(p).toLowerCase() === path.resolve(q).toLowerCase();
  const commonDir = git(['rev-parse', '--git-common-dir']);
  const gitDir = git(['rev-parse', '--absolute-git-dir']);
  console.log(`已安装 commit-msg hook：${target}`);
  if (!samePath(commonDir, gitDir)) console.log('注意：当前在 worktree 内，hooks 目录与主仓共享（装一次全仓生效）');
  let hooksPath = '';
  try { hooksPath = git(['config', 'core.hooksPath']).trim(); } catch { /* 未配置 → 退出码 1 */ }
  if (hooksPath) console.log(`注意：core.hooksPath=${hooksPath} 已配置，本 hook 可能不会生效`);
  return 0;
}

function usage(code) {
  console.log([
    '用法：node scripts/check-commit-msg.cjs <sha|ref>|<range>|--file <msgfile>|--report [<range>]|--install-hook',
    '  <sha|ref>            单条核验（违规 → 退出码 1）',
    '  <range>              范围核验，如 HEAD~3..HEAD / origin/main..HEAD',
    '  --file <msgfile>     核验提交信息文件（commit-msg hook 入口）',
    '  --report [<range>]   报告模式：只列违规不阻断（缺省最近 50 条）',
    '  --install-hook       可选安装 commit-msg hook（已存在则不覆盖）',
    '  --max-len <n>        标题长度上限（默认 ' + DEFAULT_MAX_LEN + '）',
  ].join('\n'));
  return code;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) process.exit(usage(0));

  let maxLen = DEFAULT_MAX_LEN;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max-len') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) process.exit(usage(2));
      maxLen = n;
    } else rest.push(argv[i]);
  }

  if (rest.includes('--install-hook')) return installHook();

  const fileArg = rest.indexOf('--file');
  if (fileArg !== -1) {
    const file = rest[fileArg + 1];
    if (!file) process.exit(usage(2));
    const subject = subjectOfMessage(fs.readFileSync(file, 'utf8'));
    const errs = validateSubject(subject, maxLen);
    if (errs.length) {
      console.error(`✗ 提交信息违规：${display(subject || '(空)')}`);
      for (const e of errs) console.error(`    - [${RULE_LABELS[e.rule]}] ${e.detail}`);
      return 1;
    }
    console.log(`✓ 提交信息合规：${display(subject)}`);
    return 0;
  }

  const reportIdx = rest.indexOf('--report');
  let rev = reportIdx !== -1 ? rest[reportIdx + 1] : rest[0];
  const isReport = reportIdx !== -1 || !rev; // 裸调用（未给范围）= 最近 50 条报告，不阻断

  const revArgs = rev ? [rev] : ['-50'];
  if (rev && !rev.includes('..') && !rev.includes('...')) revArgs.unshift('-1'); // 单条：只取该提交
  let commits;
  try {
    commits = listCommits(revArgs);
  } catch (e) {
    console.error(`git log 失败：${e.message.split('\n')[0]}`);
    return 2;
  }

  const { checked, bad, byRule, entries } = tally(commits, maxLen);
  const scope = rev || '最近 50 条';
  const emit = isReport ? console.log : console.error; // 门禁输出走 stderr，管道下不与 stdout 乱序
  const withMeta = isReport; // 报告附提交信息（日期/作者），门禁条目从简
  for (const en of entries) {
    emit(renderEntry(en.commit, en.errs, withMeta));
  }
  if (isReport) {
    emit(`\n提交信息规范报告（${scope}）：共 ${checked} 条，违规 ${bad} 条${bad ? '' : '，全部合规'}`);
    emit(breakdownLine(byRule));
    emit('报告模式不阻断（历史存量不溯及，退出码 0）');
    return 0;
  }
  if (bad) {
    emit(`\n✗ 提交信息检查（${scope}）：${checked} 条中 ${bad} 条违规`);
    emit(breakdownLine(byRule));
    emit('  修复后重新提交；历史存量不在本范围的不受影响');
    return 1;
  }
  console.log(`✓ 提交信息检查（${scope}）：${checked} 条全部合规`);
  return 0;
}

process.exit(main());
