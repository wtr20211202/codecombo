#!/bin/bash
# 定向 e2e 门禁：只跑传入的 spec（按影响面，用户既定策略）
# 用法：bash scripts/e2e-targeted.sh tests/foo.spec.ts e2e/specs/bar.spec.ts
#   spec 路径相对 web/ 目录；前置：e2e 服务已在 :9999 运行（scripts/e2e-restart.sh）
set -e
cd "$(dirname "$0")/../web"
if [ "$#" -eq 0 ]; then
  echo "NO_SPECS_GIVEN" >&2
  exit 64
fi
exec npx playwright test --reporter=line "$@"
