#!/bin/bash
# release-ci-gate.sh —— 发布链 CI 绿门禁（P-20261106 用户纪律：未绿不打 tag）。
#
# 背景（价值实证）：v0.0.1-beta.3 发布时，挂起的 5 个修复提交在发布仓 main 上
# CI 双红却无人盯——差一点带着红底打 tag。本脚本把 runbook 的「打 tag 前确认
# CI 双平台绿」从口头纪律变成可执行门禁：轮询 GitHub API 直至该提交的 CI run
# 终态，仅 success 放行。
#
# 用法：bash scripts/release-ci-gate.sh <发布仓提交SHA> [超时秒，默认 2400]
#   环境变量：
#     GITHUB_TOKEN  可选——配了走认证限额（5000/h），不配匿名（60/h，轮询
#                   间隔自动放宽到 60s 防限流）
#     CC_CI_REPO    仓标识，默认 wtr20211202/codecombo
#
# 退出码：0=CI success（可打 tag）；1=失败或超时（禁止打 tag）；
#         2=用法错误。失败时指引诊断通道（ci-diagnostics 分支，contents API 读）。

set -euo pipefail
cd "$(dirname "$0")/.."

SHA="${1:-}"
TIMEOUT="${2:-2400}"
REPO="${CC_CI_REPO:-wtr20211202/codecombo}"
INTERVAL=45
[ -n "${GITHUB_TOKEN:-}" ] || INTERVAL=60

if [ -z "$SHA" ]; then
  echo "FATAL: 用法：bash scripts/release-ci-gate.sh <发布仓提交SHA> [超时秒]" >&2
  exit 2
fi

AUTH=()
[ -n "${GITHUB_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")

echo "==> CI 绿门禁：repo=$REPO sha=${SHA:0:7} 超时=${TIMEOUT}s 轮询=${INTERVAL}s"
deadline=$(( $(date +%s) + TIMEOUT ))
while :; do
  resp=$(curl -sf -m 30 "${AUTH[@]}" \
    "https://api.github.com/repos/$REPO/actions/runs?head_sha=$SHA&per_page=20" 2>/dev/null || echo '{}')
  # 只看 CI 工作流的 run（Pages 部署等非测试链不在门禁口径）
  row=$(echo "$resp" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    const runs=(JSON.parse(s).workflow_runs||[]).filter(r=>r.name==='CI');
    if(!runs.length){console.log('none');return}
    const pend=runs.filter(r=>r.status!=='completed');
    if(pend.length){console.log('pending');return}
    const bad=runs.filter(r=>r.conclusion!=='success');
    console.log(bad.length?('failure:'+bad.map(r=>r.conclusion).join(',')):'success')
  }catch(e){console.log('none')}
})")
  now=$(date +%s)
  case "$row" in
    success)
      echo "==> CI 绿（双平台 success）——可以打 tag"
      exit 0
      ;;
    pending)
      [ $now -ge $deadline ] && { echo "FATAL: 超时（${TIMEOUT}s）CI 仍未终态——继续等待或人工核查 Actions 页，未绿不打 tag" >&2; exit 1; }
      echo "    CI running...（$((deadline-now))s 剩余）"
      ;;
    none)
      [ $now -ge $deadline ] && { echo "FATAL: 超时——未见到该提交的 CI run（推送是否完成？Actions 是否被禁用？）" >&2; exit 1; }
      echo "    暂未见 CI run..."
      ;;
    failure:*)
      echo "FATAL: CI 未绿（conclusion=${row#failure:}）——禁止打 tag" >&2
      echo "       诊断：curl -s \"https://api.github.com/repos/$REPO/contents/diagnostics?ref=ci-diagnostics\"" >&2
      echo "       （失败日志在 ci-diagnostics 分支，contents API 读 base64）" >&2
      exit 1
      ;;
  esac
  sleep "$INTERVAL"
done
