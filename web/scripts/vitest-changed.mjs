#!/usr/bin/env node
// vitest-changed.mjs —— check:fast 的测试段执行器：vitest --changed 关联运行（P-20261004-75）
//
// 用法：
//   node scripts/vitest-changed.mjs [额外 vitest 参数...]   # 经 package.json 的 check:fast 调用
//
// 基线（--changed since）：
//   - 默认 HEAD：执行器内循环的改动在提交前都是未提交 WIP，`--changed HEAD`
//     = staged + 未暂存 + 未跟踪（vitest GitVCSProvider 三路合并），恰好是
//     worktree 分支基点之后的全部变更；
//   - SC_CHECK_FAST_BASE=<git ref>：分支上已有中间提交（基点不再是 HEAD）时
//     显式指回基点，如 SC_CHECK_FAST_BASE=HEAD~1 或提交哈希。
//
// 为什么是独立脚本而非 npm script 一行：基线须可按场景覆盖（见上），而
// $(...) 命令替换在 npm 的 win32 默认 shell（cmd）下不可用；经
// process.execPath 直派 node_modules/vitest/vitest.mjs 则零 shell 依赖，
// win/mac/linux 同构。
//
// 语义边界（为什么 fast 可作内循环、门禁仍归全量 check）：
//   - vitest --changed 的关联判定走静态 import 图，动态导入等链外延不足时会
//     漏关联（假绿）——fast 只用于调试迭代提速，提交/PR 门禁仍走全量
//     `npm run check`（vitest run 全量 + coverage 门槛）兜底；
//   - coverage 显式关闭：utils 覆盖率门槛（vitest.config.ts thresholds）按
//     目录键校验，关联子集跑必假红，该门禁只在全量 check 生效；
//   - git 不可用/非 git 目录时不静默降级：基线预检失败即退出非零（vitest 对
//     git 失败的 changed 集实测按空集处理、配合 --passWithNoTests 会「零测试
//     放行」假绿——基线 ref 打错字绝不能无声跳过测试），此时直接跑
//     `npm run test`（全量）。
//   - 冷启动注记：eslint 无 .eslintcache / vue-tsc 无 tsbuildinfo 时对应段
//     退化为全量时长——仍正确，只是慢；跑一轮后进入增量稳态。
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vitestEntry = path.join(root, 'node_modules', 'vitest', 'vitest.mjs')
// 基线：环境变量优先（任意 git ref），默认 HEAD=未提交 WIP（内循环主形态）
const base = process.env.SC_CHECK_FAST_BASE || 'HEAD'

// 基线可解析性预检（宁红勿假绿）：vitest 对 git 失败的 changed 集按空集处理，
// 配合 --passWithNoTests 就是「零测试放行」——基线 ref 打错字/git 不可用必须
// 在这里拦红，而不是静默跳过测试。经 spawnSync 直调 git，无 shell 转义问题。
const probe = spawnSync('git', ['rev-parse', '--verify', `${base}^{commit}`], { cwd: root, encoding: 'utf8' })
if (probe.status !== 0) {
  console.error(`[check:fast] 基线不可解析：${base}（git rev-parse 失败：${(probe.stderr || '').trim()}）——核对 SC_CHECK_FAST_BASE，或改跑 npm run test`)
  process.exit(1)
}

const args = [
  vitestEntry,
  'run',
  '--changed', base,
  '--coverage.enabled=false', // utils 覆盖率门槛只在全量 check 校验（子集跑必假红）
  '--passWithNoTests',        // 变更文件无关联测试（如纯文档/配置改动）时放行——fast 的正确语义
  ...process.argv.slice(2),
]
console.log(`[check:fast] vitest ${args.slice(1).join(' ')}`)
const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: root })
process.exit(r.status ?? 1)
