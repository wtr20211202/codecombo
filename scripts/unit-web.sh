#!/bin/bash
# 前端单元测试门禁：vue-tsc 类型检查 + Vitest（前端源码改动时作为快速层）
# 注意：Vitest 4 移除了内置 basic reporter，此处用 dot（精简输出）
set -e
cd "$(dirname "$0")/../web"
node node_modules/vue-tsc/bin/vue-tsc.js --build
exec npx vitest run --reporter=dot
