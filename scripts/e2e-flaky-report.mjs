#!/usr/bin/env node
// e2e-flaky-report.mjs —— e2e flaky 清单聚合：重试通过态的系统性可见（P-20261004-93）
//
// 动机：e2e-full 各分片原本只出 line 报告，重试通过（flaky）只在输出流一现即逝——
// flaky 认知全靠注记口口相传；flaky 清单是重派诊断的地基数据，慢性 flaky 淹没在
// 单次噪声里无人能见。本脚本把每轮散落的 flaky 汇总成清单并跨轮累计。
//
// 输入：e2e-full.sh 的 line,json 双报落盘的分片 JSON（<logdir>/results-<port>/report.json，
// playwright JSONReporter v2 形态：stats.flaky 计数；tests[].status 即 test.outcome()，
// 'flaky' = 有失败尝试但末次达到预期状态——重试通过的本提案口径）。
// 输出：
//   <logdir>/flaky.md    本轮 flaky 清单（分片/套件/用例/尝试数）+ 跨轮累计段
//   stdout 末行机读摘要   FLAKY_N=<n>（n = 本轮 flaky 用例数）
// 跨轮累计：历史 JSON 默认 <logdir>/../e2e-flaky-history.json——LOGDIR
// （.sc-tmp/e2e-full）每轮被 e2e-full.sh rm -rf 重建，历史放其父目录随工作树
// 存活（.sc-tmp/ 与 .e2e-data/ 同为 git 忽略运行时产物）；--history 显式覆盖供
// 测试隔离。写历史走临时文件 + rename 原子替换（进程中断不留半截 JSON）。
// 纪律：best-effort——分片 JSON 缺失/损坏/历史损坏只告警继续（不改变 e2e-full
// 门禁退出码），运行期恒退出 0（仅用法错误与 --self-test 失败非零）。
// 零第三方依赖（纯 node 标准库，路径一律 join/dirname 标准库不拼分隔符，
// win/mac/linux 直跑）。
//
// 用法：
//   node scripts/e2e-flaky-report.mjs <logdir>                   # 聚合并写 flaky.md + 历史回写
//   node scripts/e2e-flaky-report.mjs <logdir> --history <file>  # 显式历史文件（测试隔离）
//   node scripts/e2e-flaky-report.mjs --self-test                # 临时夹具自检（不碰真实产物）

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const HISTORY_VERSION = 1;
const REPORT_BASENAME = 'report.json';
const OUTPUT_BASENAME = 'flaky.md';

// ---- 解析（纯函数，--self-test 直测） ---------------------------------------

// 从 playwright JSON 报告提取 outcome=flaky 的用例。套件树：顶层 suites[] 为文件
// 套件（file 相对 playwright rootDir、posix 形态），describe 嵌套在子 suites[]；
// spec.tests[].status = test.outcome()。同一 spec 标题可在文件内不同 describe 下
// 重复，describe 路径消歧。
function collectFlaky(report) {
  const out = [];
  const walk = (suite, file, describePath) => {
    for (const sub of suite.suites || []) {
      walk(sub, file || sub.file || '', describePath.concat(sub.title || ''));
    }
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        if (t.status !== 'flaky') continue;
        out.push({
          file,
          title: describePath.concat(spec.title || '').join(' › '),
          project: t.projectName || '',
          // 尝试数 = results 长度（>1 即发生过重试，佐证 flaky 判定）
          attempts: Array.isArray(t.results) ? t.results.length : 0,
        });
      }
    }
  };
  for (const suite of report.suites || []) walk(suite, suite.file || '', []);
  return out;
}

function caseKey(entry) {
  // 键 = 套件文件 + describe 路径 + 用例名。项目名当前恒空（config 无命名
  // project），留字段不进键：若未来多 project，同键合并计数是可接受的粗化。
  return `${entry.file} › ${entry.title}`;
}

function loadHistory(path) {
  if (!existsSync(path)) return { version: HISTORY_VERSION, updatedAt: '', cases: {} };
  try {
    const h = JSON.parse(readFileSync(path, 'utf8'));
    if (h && typeof h === 'object' && h.cases && typeof h.cases === 'object') return h;
    throw new Error('结构不符（缺 cases 对象）');
  } catch (e) {
    // 历史损坏不阻断本轮：从头累计并大声告知（宁重启累计勿静默丢告警）
    console.error(`E2E_FLAKY_WARN: 历史文件损坏，从头累计（${path}: ${e.message}）`);
    return { version: HISTORY_VERSION, updatedAt: '', cases: {} };
  }
}

// ---- 聚合（读分片 JSON + 历史合并） -----------------------------------------

// 扫描 <logdir>/results-*/report.json，返回 { entries, history, parseFail, shardCount }。
// 历史在内存中合并（count++ / last=今天），不在此处落盘——写盘由调用方决定，
// --self-test 才能反复重放同一轮。
function aggregate({ logdir, historyPath, now = new Date() }) {
  const shards = [];
  let entries = [];
  let shardCount = 0;
  try {
    for (const name of readdirSync(logdir)) {
      const dir = join(logdir, name);
      if (!name.startsWith('results-') || !statSync(dir).isDirectory()) continue;
      shardCount++;
      shards.push({ shard: name.slice('results-'.length) || '?', dir });
    }
  } catch (e) {
    // logdir 不可读按 0 分片处理：flaky.md 仍落盘并如实说明（best-effort）
    console.error(`E2E_FLAKY_WARN: 日志目录不可读，按 0 分片处理（${logdir}: ${e.message}）`);
  }
  shards.sort((a, b) => a.shard.localeCompare(b.shard, undefined, { numeric: true }));

  let parseFail = 0;
  for (const { shard, dir } of shards) {
    const reportFile = join(dir, REPORT_BASENAME);
    if (!existsSync(reportFile)) {
      parseFail++;
      console.error(`E2E_FLAKY_WARN: 分片 :${shard} 无 ${REPORT_BASENAME}（JSON 双报未产出？），未计入本轮`);
      continue;
    }
    try {
      const report = JSON.parse(readFileSync(reportFile, 'utf8'));
      for (const f of collectFlaky(report)) entries.push({ ...f, shard });
    } catch (e) {
      parseFail++;
      console.error(`E2E_FLAKY_WARN: 分片 :${shard} ${REPORT_BASENAME} 解析失败，按 0 flaky 计（${e.message}）`);
    }
  }

  const history = loadHistory(historyPath);
  const today = localDate(now);
  for (const f of entries) {
    const key = caseKey(f);
    const prev = history.cases[key];
    // 覆盖 file/title 为最近一次出现形态（spec 改名/移动后键自然切换为新键）
    history.cases[key] = { count: ((prev && prev.count) || 0) + 1, last: today, file: f.file, title: f.title };
  }
  history.version = HISTORY_VERSION;
  history.updatedAt = localStamp(now);
  return { entries, history, parseFail, shardCount };
}

// ---- 渲染（markdown） --------------------------------------------------------

// markdown 表格单元格转义：竖线会破表，换行不存在（title 来自单行标题）
function mdCell(s) {
  return String(s).replace(/\|/g, '\\|');
}

function renderMarkdown({ entries, history, parseFail, shardCount, now = new Date() }) {
  const lines = [];
  lines.push('# e2e flaky 清单（重试通过态）');
  lines.push('');
  lines.push(`> 生成：${localStamp(now)} · 本轮分片 JSON：${shardCount - parseFail}/${shardCount} 解析成功 · 本轮 flaky：${entries.length} 用例`);
  lines.push('>');
  lines.push('> 口径：playwright outcome()=flaky——首次失败、重试（retries=1）后通过；恒定失败不在本清单（见各分片 shard-<port>.log）。');
  if (parseFail > 0) {
    lines.push('>');
    lines.push(`> ⚠ ${parseFail} 个分片 JSON 缺失/损坏未计入本轮（best-effort，不影响门禁退出码）。`);
  }
  lines.push('');
  lines.push('## 本轮 flaky');
  lines.push('');
  if (entries.length === 0) {
    lines.push(shardCount === 0 ? '未发现分片 JSON 报告（实例启动失败或日志目录为空）。' : '本轮无 flaky。');
  } else {
    lines.push('| 分片 | 套件 | 用例 | 尝试 |');
    lines.push('|---|---|---|---|');
    for (const f of entries) {
      const proj = f.project ? `（project: ${mdCell(f.project)}）` : '';
      lines.push(`| :${mdCell(f.shard)} | ${mdCell(f.file)} | ${mdCell(f.title)}${proj} | ${f.attempts || '?'} |`);
    }
  }
  lines.push('');
  lines.push('## 跨轮累计（同用例跨轮出现次数）');
  lines.push('');
  const thisRound = new Set(entries.map(caseKey));
  const histEntries = Object.entries(history.cases)
    .sort((a, b) => (b[1].count - a[1].count) || a[0].localeCompare(b[0]));
  if (histEntries.length === 0) {
    lines.push('暂无历史（首轮或历史上无 flaky）。');
  } else {
    lines.push('| 套件 › 用例 | 累计轮次 | 最近出现 | 本轮 |');
    lines.push('|---|---|---|---|');
    for (const [key, c] of histEntries) {
      const hit = thisRound.has(key) ? '✅ 本轮复现' : '';
      lines.push(`| ${mdCell(c.file)} › ${mdCell(c.title)} | ${c.count} | ${c.last || '?'} | ${hit} |`);
    }
    lines.push('');
    lines.push('> 重派分组/失败归因前先读本表：累计 ≥2 的慢性 flaky，失败更可能是并行负载噪声而非改动引入（对照本表优先按环境噪声归因，再考虑真回归）。');
  }
  lines.push('');
  return lines.join('\n');
}

// ---- 落盘（原子写） -----------------------------------------------------------

function atomicWriteJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

// ---- 本地时间格式（三平台显式一致：本地时区，固定字段序） ----------------------

function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${localDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---- 入口 --------------------------------------------------------------------

function usage(code) {
  console.error('用法: node scripts/e2e-flaky-report.mjs <logdir> [--history <file>]');
  console.error('  <logdir>            e2e-full 日志目录（含 results-<port>/report.json）');
  console.error('  --history <file>    跨轮累计历史（默认 <logdir>/../e2e-flaky-history.json）');
  console.error('  --self-test         临时夹具自检');
  return code;
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  const logdir = args[0];
  const hi = args.indexOf('--history');
  const historyPath = hi >= 0 ? args[hi + 1] : join(dirname(logdir || '.'), 'e2e-flaky-history.json');
  if (!logdir || (hi >= 0 && !args[hi + 1])) return usage(2);

  const now = new Date();
  const { entries, history, parseFail, shardCount } = aggregate({ logdir, historyPath, now });

  mkdirSync(logdir, { recursive: true });
  writeFileSync(join(logdir, OUTPUT_BASENAME), renderMarkdown({ entries, history, parseFail, shardCount, now }));
  atomicWriteJson(historyPath, history);

  console.log(`flaky 清单: ${join(logdir, OUTPUT_BASENAME)}（本轮 ${entries.length} 例，历史累计 ${Object.keys(history.cases).length} 例${parseFail ? `，${parseFail} 分片解析失败` : ''}）`);
  console.log(`FLAKY_N=${entries.length}`);
  return 0;
}

// ---- 自检（临时夹具，不碰真实产物） -------------------------------------------

function assert(cond, msg) {
  if (!cond) throw new Error(`self-test 断言失败: ${msg}`);
}

// 最小合法 JSONReporter v2 夹具：只含 collectFlaky 消费的字段
function fixtureReport(file, specs) {
  return {
    stats: { expected: 0, unexpected: 0, flaky: specs.filter((s) => s.status === 'flaky').length, skipped: 0 },
    suites: [{ title: file, file, line: 0, column: 0, specs: specs.filter((s) => !s.describe).map((s) => fixtureSpec(s)) }]
      .concat(specs.some((s) => s.describe)
        ? [{
            title: file, file, line: 0, column: 0,
            suites: [{
              title: 'describe A', line: 0, column: 0,
              specs: specs.filter((s) => s.describe).map((s) => fixtureSpec(s)),
            }],
          }]
        : []),
  };
}

function fixtureSpec(s) {
  return {
    title: s.title, ok: s.status === 'flaky' || s.status === 'expected', id: s.title,
    tests: [{ timeout: 30000, annotations: [], expectedStatus: 'passed', projectId: 'p', projectName: '', status: s.status, results: s.status === 'expected' ? [{}] : [{}, {}] }],
  };
}

function selfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'sc-e2e-flaky-selftest-'));
  try {
    const historyPath = join(tmp, 'history.json');
    const logA = join(tmp, 'round-a');

    // 第一轮：分片 10971（1 flaky + 1 describe 嵌套 flaky + 1 steady + 1 unexpected）、分片 10975 JSON 损坏
    mkdirSync(join(logA, 'results-10971'), { recursive: true });
    writeFileSync(join(logA, 'results-10971', REPORT_BASENAME), JSON.stringify(fixtureReport('e2e/specs/foo.spec.ts', [
      { title: 'flaky case A', status: 'flaky' },
      { title: 'nested flaky B', status: 'flaky', describe: true },
      { title: 'steady case', status: 'expected' },
      { title: 'dead case', status: 'unexpected' },
    ])));
    mkdirSync(join(logA, 'results-10975'), { recursive: true });
    writeFileSync(join(logA, 'results-10975', REPORT_BASENAME), '{corrupt');

    const r1 = aggregate({ logdir: logA, historyPath, now: new Date('2026-10-11T10:00:00') });
    assert(r1.entries.length === 2, `第一轮应聚合 2 例 flaky，实得 ${r1.entries.length}`);
    assert(r1.parseFail === 1, '损坏 JSON 应计 1 次解析失败');
    assert(r1.shardCount === 2, '应发现 2 个分片目录');
    assert(r1.entries.some((e) => e.shard === '10971' && e.title === 'flaky case A' && e.attempts === 2), 'flaky case A 应含分片与尝试数');
    assert(r1.entries.some((e) => e.title === 'describe A › nested flaky B'), 'describe 嵌套应进用例标题');
    atomicWriteJson(historyPath, r1.history); // 与 main() 每轮落盘历史对齐，下一轮才能读到

    const md1 = renderMarkdown({ ...r1, now: new Date('2026-10-11T10:00:00') });
    assert(md1.includes('flaky case A') && md1.includes(':10971'), 'flaky.md 本轮清单应含用例与分片');
    assert(md1.includes('1 个分片 JSON 缺失/损坏'), 'flaky.md 应如实标注解析失败');

    // 第二轮（同历史文件、不同 logdir）：case A 复现 + 新 case C——累计 2/1
    const logB = join(tmp, 'round-b');
    mkdirSync(join(logB, 'results-10971'), { recursive: true });
    writeFileSync(join(logB, 'results-10971', REPORT_BASENAME), JSON.stringify(fixtureReport('e2e/specs/foo.spec.ts', [
      { title: 'flaky case A', status: 'flaky' },
      { title: 'fresh case C', status: 'flaky' },
    ])));
    const r2 = aggregate({ logdir: logB, historyPath, now: new Date('2026-10-12T10:00:00') });
    atomicWriteJson(historyPath, r2.history);
    assert(r2.history.cases['e2e/specs/foo.spec.ts › flaky case A'].count === 2, '同用例跨轮应累计 2');
    assert(r2.history.cases['e2e/specs/foo.spec.ts › fresh case C'].count === 1, '新用例应计 1');
    const md2 = renderMarkdown({ ...r2, now: new Date('2026-10-12T10:00:00') });
    assert(md2.includes('✅ 本轮复现'), '跨轮累计段应标注本轮复现');

    // 第三轮（干净轮）：零 flaky，历史保留不被清空
    const logC = join(tmp, 'round-c');
    mkdirSync(join(logC, 'results-10971'), { recursive: true });
    writeFileSync(join(logC, 'results-10971', REPORT_BASENAME), JSON.stringify(fixtureReport('e2e/specs/foo.spec.ts', [{ title: 'steady case', status: 'expected' }])));
    const r3 = aggregate({ logdir: logC, historyPath, now: new Date('2026-10-13T10:00:00') });
    assert(r3.entries.length === 0, '干净轮应 0 flaky');
    assert(Object.keys(r3.history.cases).length === 3, '干净轮不应清空历史');

    // main() 端到端：写 flaky.md + stdout 末行机读 FLAKY_N
    const logD = join(tmp, 'round-d');
    mkdirSync(join(logD, 'results-10971'), { recursive: true });
    writeFileSync(join(logD, 'results-10971', REPORT_BASENAME), JSON.stringify(fixtureReport('e2e/specs/foo.spec.ts', [{ title: 'flaky case A', status: 'flaky' }])));
    const historyD = join(tmp, 'history-d.json');
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    try {
      main(['node', 'e2e-flaky-report.mjs', logD, '--history', historyD]);
    } finally {
      console.log = origLog;
    }
    assert(logs[logs.length - 1] === 'FLAKY_N=1', `stdout 末行应为 FLAKY_N=1，实得 ${logs[logs.length - 1]}`);
    assert(readFileSync(join(logD, OUTPUT_BASENAME), 'utf8').includes('flaky case A'), 'main 应写出 flaky.md 并含用例');
    assert(existsSync(historyD), 'main 应写出历史文件');

    console.log('self-test OK: 解析/聚合/跨轮累计/损坏容错/端到端落盘 全过');
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  process.exitCode = main(process.argv);
} catch (e) {
  console.error('E2E_FLAKY_ERROR:', (e && e.stack) || e);
  process.exitCode = 1;
}
