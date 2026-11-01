#!/usr/bin/env node
// 从 Playwright JSON 报告提取失败 spec 文件（相对 web/，如 e2e/specs/x.spec.ts）。
// 用法：node scripts/e2e-failed-specs.mjs <results-dir> [...]
// 每个目录下须有 report.json（PLAYWRIGHT_JSON_OUTPUT_FILE 产物）。
// 输出每行一个 spec 文件，已排序去重；解析失败只告警不中断。
import fs from 'node:fs'
import path from 'node:path'

const failed = new Set()

function walk(suite) {
  const file = suite && suite.file
    ? String(suite.file).replaceAll('\\', '/').replace(/^web\//, '')
    : ''
  for (const spec of (suite && suite.specs) || []) {
    // spec.ok 是重试后的最终裁决：首轮失败但重试通过（flaky）不算失败；
    // 单看 results[].status 会把 flaky 误收进失败集（曾实测 35 vs 29）。
    if (spec.ok === false && file) failed.add(file)
  }
  for (const child of (suite && suite.suites) || []) walk(child)
}

for (const dir of process.argv.slice(2)) {
  const reportPath = path.join(dir, 'report.json')
  if (!fs.existsSync(reportPath)) continue
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    for (const suite of report.suites || []) walk(suite)
  } catch (err) {
    console.error(`[e2e-failed-specs] 跳过损坏报告 ${reportPath}: ${err.message}`)
  }
}

for (const file of [...failed].sort()) console.log(file)
