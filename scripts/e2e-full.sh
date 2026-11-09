#!/bin/bash
# 全量 e2e 门禁：域分片并行（P-20261002-66）。
# 起 4 个独立实例（各数据面，域内串行——playwright workers=1；域间并行）。
# 当前全量约 2000 用例，4 片实测 ~70-80 分钟（2026-10-21 按域时长重排后目标 ~70m；
# 旧注释「483 用例约 25 分钟」是 2026-10 初规模，早已失真）。
# 汇总各分片退出码与失败清单，任一分片非零则整体非零。
# 末尾 best-effort 聚合 flaky 清单（P-20261004-93）：重试通过用例写
# $LOGDIR/flaky.md（含跨轮累计段）+ FLAKY_N=<n> 机读行，失败解析不影响门禁退出码。
# 失败时自动读 .goal-enhance/fulle2e-baseline-specs.txt 比对：全在册输出
# E2E_BASELINE_ONLY=1；有册外失败则在 9999 单实例串行复跑册外 spec，输出
# E2E_SERIAL_RERUN_RESULT=pass|fail 与失败清单。门禁退出码不因此改变——本段
# 只产出机读证据，是否放行仍由编排器按基线裁决。
# 已知边界：4 路并行下 WSL/回环反代类时序用例会出现少量串行不见的负载超时
# （实测 0.6~1%），见分片运行段落注记。
#
# 用法：bash scripts/e2e-full.sh [--dry-run]
#   --dry-run  只做 spec 覆盖检查并打印分片计划（用例数），不启实例不跑用例
#
# 可调项：
#   E2E_FULL_PORTS  覆盖实例端口（空格分隔，默认 "10971 10975 10979 10983"）。
#                   worktree 验证场景务必覆盖——9999 是主仓库主实例，勿夺。
#                   端口间隔须 >=4：分享/pprof 子服务占主端口+2
#                   （server/config/config.go SharePortOrDefault），间隔过小时
#                   一个实例的分享端口撞上另一个实例的主端口，启动竞态致死
#                   （原文 9972/9973 因此改为 9975/9979）。
#   分片域表        domain_specs / shard_domains 两个函数即分配清单，加减域、
#                   调整归属只改这两处。
#
# 数据面：.e2e-data/full-<port>/（经 SC_E2E_DATA_DIR 注入 e2e-restart.sh，
# 各实例 FRESH 清空互不波及）。仓库级共享层保持在 .e2e-data 根：
#   keys/      WSL e2e 密钥对机器级一份，种子把 pem 内容经 API 写进各实例 DB
#   fixtures/  Gitea git-test 推送夹具一份，各实例项目卡按绝对路径指向它
# spec 与实例的耦合面：全部经 PLAYWRIGHT_BASE_URL（playwright baseURL、
# tests/api-base.ts API_BASE、各 spec 内联 BASE 同源），无 9999 硬编码，
# 任意端口可跑（e2e-worktree.sh 同款机制）。
#
# 机器级共享资源（跨分片并发安全的前提，新增依赖时先对照）：
#   WSL sshd :23   远程流用例并发连，sshd 天然多路
#   wsl-server :9998   instance-*/remote-* 域同分片串行，无跨分片争用
#   Gitea :3000    仅 push-dialog（git 域单分片内）
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# ---- 分片计划（可调常量） ------------------------------------------------

# 实例端口：默认 10971 起 +4 间隔——2026-10-06 从「9999 起」改掉：9999 是主实例专用端口，
# 分片占用会杀主实例、EXIT trap 再停分片、且污染 inst-9999-built-head 保鲜标记（P-66 自测端口即此组，默认值遗留未改）
PORTS="${E2E_FULL_PORTS:-10971 10975 10979 10983}"

# 域 → spec 清单：相对 web/ 的路径，支持 glob，e2e/specs/ 与 tests/ 都要归域。
# 新增 spec 必须归入某域——下方覆盖检查会把未归域/失效条目/重复归属全部拦截
# （防归类漂移静默漏测）；glob 首选前缀族（新 spec 落进既有前缀即自动归域）
domain_specs() {
  case "$1" in
    git)
      echo web/e2e/specs/blame-prev.spec.ts web/e2e/specs/branch-*.spec.ts \
           web/e2e/specs/changes-*.spec.ts web/e2e/specs/clone-cancel.spec.ts \
           web/e2e/specs/clone-status-bar.spec.ts \
           web/e2e/specs/commit-*.spec.ts web/e2e/specs/conflict-*.spec.ts \
           web/e2e/specs/core-workflow.spec.ts web/e2e/specs/export-patch.spec.ts web/e2e/specs/patch-export.spec.ts web/e2e/specs/fetch-all.spec.ts \
           web/e2e/specs/pull-summary-notify.spec.ts \
           web/e2e/specs/empty-repo-empty-state.spec.ts \
           web/e2e/specs/git-*.spec.ts web/e2e/specs/gitignore-*.spec.ts \
           web/e2e/specs/push-*.spec.ts \
           web/e2e/specs/rebase-*.spec.ts web/e2e/specs/reword-flow.spec.ts \
           web/e2e/specs/rollback-confirm.spec.ts web/e2e/specs/stage-flow.spec.ts \
           web/e2e/specs/stash-flow.spec.ts web/e2e/specs/stash-apply-branch.spec.ts web/e2e/specs/stash-hash-ref.spec.ts web/e2e/specs/submodule-flow.spec.ts \
           web/e2e/specs/tag-flow.spec.ts web/e2e/specs/worktree-flow.spec.ts \
           web/tests/clone-flow.spec.ts \
           web/e2e/specs/blame-hover.spec.ts web/e2e/specs/discard-hunk.spec.ts web/e2e/specs/stash-diff-preview.spec.ts web/e2e/specs/file-history.spec.ts web/e2e/specs/rename-guard.spec.ts web/e2e/specs/filename-guard.spec.ts web/e2e/specs/indexlock-recovery.spec.ts web/e2e/specs/clone-dest-precheck.spec.ts web/e2e/specs/clone-url-precheck.spec.ts web/e2e/specs/clone-url-history.spec.ts web/e2e/specs/cross-review.spec.ts ;;
    editor)
      echo web/e2e/specs/editor-*.spec.ts web/e2e/specs/compare-two-files.spec.ts \
           web/e2e/specs/diff-*.spec.ts web/e2e/specs/file-deeplink.spec.ts \
           web/e2e/specs/md-mode-shortcut.spec.ts \
           web/e2e/specs/quick-open-*.spec.ts web/e2e/specs/search-*.spec.ts \
           web/e2e/specs/split-hotkey.spec.ts web/e2e/specs/tab-*.spec.ts \
           web/e2e/specs/untitled-draft.spec.ts web/e2e/specs/untitled-draft-persist.spec.ts \
           web/e2e/specs/workspace-snapshot.spec.ts \
           web/e2e/specs/autosave.spec.ts web/e2e/specs/format-on-save.spec.ts web/e2e/specs/problems-panel.spec.ts web/e2e/specs/encoding-indicator.spec.ts web/e2e/specs/quickopen-cache-invalidate.spec.ts web/e2e/specs/save-all.spec.ts web/e2e/specs/paste-threshold.spec.ts web/e2e/specs/output-sentinel.spec.ts web/e2e/specs/snippet-shortcut.spec.ts web/e2e/specs/snippet-params.spec.ts web/e2e/specs/replace-backup.spec.ts web/e2e/specs/replace-history-restore.spec.ts web/e2e/specs/bookmarks.spec.ts web/e2e/specs/breadcrumb-nav.spec.ts web/e2e/specs/tree-slash-focus.spec.ts ;;
    terminal)
      echo web/e2e/specs/terminal-*.spec.ts web/tests/terminal-*.spec.ts \
           web/tests/remote-terminal-tmux.spec.ts \
           web/e2e/specs/keymap-terminal.spec.ts web/e2e/specs/term-theme-follow.spec.ts web/e2e/specs/transcript-mask.spec.ts web/e2e/specs/clipboard-history.spec.ts ;;
    remote)
      echo web/e2e/specs/remote-*.spec.ts web/e2e/specs/instance-*.spec.ts \
           web/e2e/specs/fleet-overview.spec.ts \
           web/e2e/specs/remotehost-crud.spec.ts web/e2e/specs/credential-api.spec.ts \
           web/e2e/specs/ssh-tofu.spec.ts web/e2e/specs/deploy-rerun.spec.ts web/e2e/specs/deploy-host-mutex.spec.ts \
           web/e2e/specs/session-pressure.spec.ts \
           web/tests/credential-management.spec.ts web/tests/dsh-*.spec.ts \
           web/tests/instance-*.spec.ts ;;
    share)
      echo web/e2e/specs/share-*.spec.ts web/e2e/specs/share.spec.ts \
           web/e2e/specs/qr-relay.spec.ts ;;
    notify)
      echo web/e2e/specs/notify-*.spec.ts web/e2e/specs/notification-center.spec.ts web/e2e/specs/backup-push-notify.spec.ts \
           web/e2e/specs/security-notify.spec.ts web/e2e/specs/task-done-notify.spec.ts \
           web/e2e/specs/lock-notify-mute.spec.ts web/e2e/specs/long-session-notify.spec.ts web/e2e/specs/notification-snooze.spec.ts ;;
    settings)
      echo web/e2e/specs/settings-*.spec.ts web/e2e/specs/keymap-custom.spec.ts \
           web/e2e/specs/theme-follow-os.spec.ts web/e2e/specs/ui-zoom.spec.ts \
           web/e2e/specs/ui-density.spec.ts web/e2e/specs/readability-baseline.spec.ts \
           web/e2e/specs/design-tokens.spec.ts \
           web/e2e/specs/locale-single-load.spec.ts \
           web/e2e/specs/shortcuts-filter.spec.ts web/e2e/specs/shortcuts-scope.spec.ts web/e2e/specs/locale-suggest.spec.ts web/e2e/specs/workspace-presets.spec.ts web/e2e/specs/token-rotate-confirm.spec.ts web/e2e/specs/token-usage.spec.ts web/e2e/specs/whoami.spec.ts \
           web/e2e/specs/userprefs-roaming.spec.ts ;;
    ops)
      echo web/e2e/specs/monitor-*.spec.ts web/e2e/specs/overview-autorefresh.spec.ts \
           web/e2e/specs/observability.spec.ts web/e2e/specs/audit-log.spec.ts web/e2e/specs/sensitive-read-audit.spec.ts web/e2e/specs/sensitive-external-write.spec.ts \
           web/e2e/specs/diag-history.spec.ts web/e2e/specs/errorlog-filter.spec.ts web/e2e/specs/errorlog-retry.spec.ts \
           web/e2e/specs/daily-report.spec.ts web/e2e/specs/app-crash.spec.ts \
           web/e2e/specs/clip-relay.spec.ts web/e2e/specs/ops-open-file-at.spec.ts web/e2e/specs/ops-navigate.spec.ts web/e2e/specs/meta-capabilities.spec.ts web/e2e/specs/runbook.spec.ts web/e2e/specs/runbook-params.spec.ts web/e2e/specs/runbook-onfailure.spec.ts web/e2e/specs/runbook-param-history.spec.ts web/e2e/specs/runbook-fleet-run.spec.ts web/e2e/specs/sentinel-test-box.spec.ts web/e2e/specs/egress-overview.spec.ts web/e2e/specs/ingress-overview.spec.ts web/e2e/specs/self-check.spec.ts web/e2e/specs/env-profile.spec.ts web/e2e/specs/runtime-precheck.spec.ts web/e2e/specs/changelog-draft.spec.ts web/e2e/specs/cron-history.spec.ts web/e2e/specs/daily-report-archive.spec.ts web/e2e/specs/daily-report-security.spec.ts ;;
    preview)
      echo web/e2e/specs/preview-*.spec.ts ;;
    project)
      echo web/e2e/specs/add-project-enter.spec.ts web/e2e/specs/file-policy-cards.spec.ts \
           web/e2e/specs/file-download-disposition.spec.ts \
           web/e2e/specs/file-rename.spec.ts web/e2e/specs/file-reveal.spec.ts \
           web/e2e/specs/file-trash.spec.ts \
           web/e2e/specs/file-upload.spec.ts \
           web/e2e/specs/file-tree-*.spec.ts \
           web/e2e/specs/project-*.spec.ts web/e2e/specs/remove-project.spec.ts \
           web/e2e/specs/dir-stat.spec.ts web/e2e/specs/dir-agent-session.spec.ts web/e2e/specs/activity-heatmap.spec.ts web/e2e/specs/session-locate-tree.spec.ts web/e2e/specs/session-search.spec.ts web/e2e/specs/session-star-note.spec.ts web/e2e/specs/session-idle-hint.spec.ts ;;
    lock)
      echo web/e2e/specs/lock.spec.ts web/e2e/specs/lock-config.spec.ts \
           web/e2e/specs/token-warning.spec.ts web/e2e/specs/wt-lock.spec.ts \
           web/e2e/specs/overlay-flicker-defense.spec.ts ;;
    layout)
      echo web/e2e/specs/layout-reset.spec.ts web/e2e/specs/layout-lock.spec.ts web/e2e/specs/narrow-screen.spec.ts \
           web/e2e/specs/panel-registry.spec.ts web/e2e/specs/title-info.spec.ts \
           web/e2e/specs/activity-bar-drag.spec.ts \
           web/e2e/specs/icon-hit-target.spec.ts \
           web/e2e/specs/esc-layered-dismiss.spec.ts \
           web/e2e/specs/notes-view.spec.ts web/e2e/specs/notes-global.spec.ts web/e2e/specs/notes-migration.spec.ts \
           web/e2e/specs/uistate-*.spec.ts ;;
    agent)
      echo web/e2e/specs/agent-cron.spec.ts web/e2e/specs/agent-cron-chain.spec.ts web/e2e/specs/agent-cron-prompt-vars.spec.ts web/e2e/specs/agent-cron-relay.spec.ts web/e2e/specs/agent-runtime-guide.spec.ts web/e2e/specs/agent-new-session-draft.spec.ts web/e2e/specs/agent-new-session-focus.spec.ts web/e2e/specs/agent-task-template.spec.ts web/e2e/specs/agent-terminal.spec.ts web/e2e/specs/agent-review-baseline.spec.ts web/e2e/specs/agent-queue.spec.ts web/e2e/specs/agent-chain.spec.ts web/e2e/specs/agent-message.spec.ts \
           web/e2e/specs/compare-experiment.spec.ts \
           web/e2e/specs/claude-session-hide.spec.ts web/e2e/specs/claude-timeline.spec.ts web/e2e/specs/claude-session-summary.spec.ts web/e2e/specs/custom-agents.spec.ts web/e2e/specs/session-relay.spec.ts web/e2e/specs/session-instance-relay.spec.ts web/e2e/specs/session-export-relpath.spec.ts \
           web/e2e/specs/session-time-chips.spec.ts web/e2e/specs/session-runtime-groups.spec.ts web/e2e/specs/session-copy-message.spec.ts web/e2e/specs/session-count-warn.spec.ts \
           web/e2e/specs/ops-ask.spec.ts web/e2e/specs/task-runner-keyboard.spec.ts \
           web/e2e/specs/timeline-*.spec.ts web/e2e/specs/todo-panel.spec.ts web/e2e/specs/todo-agent-fix.spec.ts web/e2e/specs/todo-handled.spec.ts \
           web/e2e/specs/deploy-agent-fix.spec.ts \
           web/e2e/specs/approval-*.spec.ts web/tests/claude-sessions.spec.ts \
           web/e2e/specs/agent-session-name.spec.ts web/e2e/specs/agent-runtime-version.spec.ts web/e2e/specs/notes-agent-deposit.spec.ts web/e2e/specs/ask-selection.spec.ts web/e2e/specs/error-to-agent.spec.ts web/e2e/specs/approve-all-confirm.spec.ts web/e2e/specs/task-rerun.spec.ts web/e2e/specs/task-steps.spec.ts web/e2e/specs/fleet-bulk-agent.spec.ts web/e2e/specs/session-export-jsonl.spec.ts web/e2e/specs/session-export-md.spec.ts web/e2e/specs/session-batch-export.spec.ts web/e2e/specs/session-batch-export-enc.spec.ts web/e2e/specs/shift-summary.spec.ts \
           web/e2e/specs/agent-ui-snapshot.spec.ts web/e2e/specs/agent-sensitive-write-guard.spec.ts web/e2e/specs/agentguard-audit.spec.ts ;;
    misc)
      echo web/e2e/specs/about-page.spec.ts web/e2e/specs/console-hygiene.spec.ts \
           web/e2e/specs/error-display.spec.ts web/e2e/specs/help-center.spec.ts \
           web/e2e/specs/home-empty-guide.spec.ts web/e2e/specs/http-warning.spec.ts \
           web/e2e/specs/morning-brief.spec.ts \
           web/e2e/specs/palette-*.spec.ts web/e2e/specs/path-traversal.spec.ts \
           web/e2e/specs/present-mode.spec.ts web/e2e/specs/regression-probe.spec.ts \
           web/e2e/specs/security-headers.spec.ts web/e2e/specs/snapshot-api.spec.ts \
           web/e2e/specs/ver-unify.spec.ts web/e2e/specs/workspace-backup.spec.ts \
           web/e2e/specs/text-reachability.spec.ts \
           web/e2e/specs/ws-disconnect-bar.spec.ts \
           web/e2e/specs/ws-reconnect-refetch.spec.ts \
           web/e2e/specs/ops-reconnect-refetch.spec.ts \
           web/e2e/specs/reconnect-refetch-coverage.spec.ts ;;
    *) echo "UNKNOWN_DOMAIN:$1" >&2; return 1 ;;
  esac
}

# 域 → 分片分配（下标对应 $PORTS 顺序）。域是分片的最小单位：同域 spec
# 共享一个实例串行跑。2026-10-21 按 run27 的 report.json 实测时长重排——原按
# 用例数 122/122/122/117 均摊，早已和真实时长脱节（四片 48.7/75.5/77.0/75.9m）：
#   terminal 52.2m + remote 12.5m 同片（wsl-server :9998 串行争用不跨片），
#   preview/lock 补齐 → 68.6m；editor+agent → 69.8m；
#   misc+project+ops+layout → 69.3m；git+notify+settings+share → 69.4m。
# 关键路径 77.0m → 69.8m（约 -7m/轮）。域时长变化后重排方法：从
# .sc-tmp/e2e-full/results-*/report.json 按 spec duration 聚合；改完先跑
# `bash scripts/e2e-full.sh --dry-run` 看用例分布（用例数不等于时长）。
shard_domains() {
  case "$1" in
    0) echo terminal remote preview lock ;;  # ~68.6m（terminal 是慢域，单独配轻域）
    1) echo editor agent ;;                  # ~69.8m
    2) echo misc project ops layout ;;       # ~69.3m
    3) echo git notify settings share ;;     # ~69.4m
  esac
}

# ---- spec 归属校验与展开 -------------------------------------------------
# 输出：DOMAIN_FILES_<域> 逐域落全局数组；返回值非零表示表有错

shopt -s nullglob
ALL_DOMAINS="git editor terminal remote share notify settings ops preview project lock layout agent misc"

declare -A SEEN_SPEC=()   # spec 路径 → 首次归属的域（重复归属检测）
DOMAIN_ORDER=()           # 域名，保持表序
for d in $ALL_DOMAINS; do
  declare -n FILES="DOMAIN_FILES_$d"
  FILES=()
  DOMAIN_ORDER+=("$d")
  for pattern in $(domain_specs "$d"); do
    matches=($pattern)   # domain_specs 已带 web/ 前缀；字面量在此处仍会走 glob 展开
    if [ ${#matches[@]} -eq 0 ]; then
      echo "E2E_FULL_SPEC_TABLE_ERROR: $d 域条目 $pattern 无匹配文件（拼写漂移？）" >&2
      exit 1
    fi
    for m in "${matches[@]}"; do
      if [ -n "${SEEN_SPEC[$m]:-}" ]; then
        echo "E2E_FULL_SPEC_TABLE_ERROR: ${m#web/} 同时归属 ${SEEN_SPEC[$m]} 与 $d（glob 交叠？）" >&2
        exit 1
      fi
      SEEN_SPEC[$m]="$d"
      FILES+=("${m#web/}")   # 存 web/ 相对路径——分片运行时 cd web 后直传 playwright
    done
  done
  if [ ${#FILES[@]} -eq 0 ]; then
    echo "E2E_FULL_SPEC_TABLE_ERROR: $d 域为空" >&2
    exit 1
  fi
done

# 覆盖检查：未归域的 spec 默认落 misc 域并大声警告（2026-10-06 由硬拦截改软——
# 两天新增 71 个 spec 未归域把全量堵死过一次；执行器在 worktree 改不了主仓库
# 域表，硬拦截只会常态化卡全量。软化为 misc 兜底保持全覆盖，警告保留漂移信号，
# 由会话/修复器顺手正式归域后消除警告）
UNASSIGNED=0
for f in web/e2e/specs/*.spec.ts web/tests/*.spec.ts; do
  if [ -z "${SEEN_SPEC[$f]:-}" ]; then
    [ "$UNASSIGNED" = 0 ] && echo "E2E_FULL_SPEC_TABLE_WARN: 以下 spec 未归域，本轮默认落 misc（请尽快在 domain_specs 正式归域）：" >&2
    echo "  ${f#web/}" >&2
    SEEN_SPEC[$f]="misc"
    declare -n MFILES="DOMAIN_FILES_misc"
    MFILES+=("${f#web/}")
    UNASSIGNED=$((UNASSIGNED+1))
  fi
done
[ "$UNASSIGNED" = 0 ] || echo "E2E_FULL_SPEC_TABLE_WARN: 共 $UNASSIGNED 个未归域 spec 落 misc" >&2

# ---- 分片计划输出 --------------------------------------------------------

# shard_files <分片下标>：展开该分片的域表为 spec 清单（web/ 相对路径）；
# 域表为空即中止——PORTS 数与分片域表不齐时宁失败勿静默跑全量
shard_files() {
  local i="$1" d
  local -a files=()
  for d in $(shard_domains "$i"); do
    declare -n df="DOMAIN_FILES_$d"
    files+=("${df[@]}")
  done
  if [ ${#files[@]} -eq 0 ]; then
    echo "E2E_FULL_SPEC_TABLE_ERROR: shard_domains $i 未分配任何域（PORTS 数与分片域表不齐）" >&2
    exit 1
  fi
  printf '%s\n' "${files[@]}"
}

plan_shards() {
  local i=0 port total_files=0
  local -a files
  for port in $PORTS; do
    mapfile -t files < <(shard_files "$i")
    if [ ${#files[@]} -eq 0 ]; then exit 1; fi   # shard_files 已在 stderr 报错
    local count
    count=$(cd web && npx playwright test --list "${files[@]}" 2>/dev/null | tail -1)
    echo "shard[$i] :$port  ${count:-${#files[@]} 文件}"
    total_files=$((total_files + ${#files[@]}))
    i=$((i + 1))
  done
  echo "合计 $total_files 文件"
}

if [ "$DRY_RUN" = 1 ]; then
  plan_shards
  exit 0
fi

# ---- 前置检查与一次性构建 -------------------------------------------------

if [ ! -d web/node_modules ]; then
  echo "web/node_modules 缺失：先 (cd web && npm ci) 再跑全量" >&2
  exit 1
fi
# 依赖漂移时在此串行装联一次——否则 4 个并行 e2e-restart 会竞态重装
if [ web/package-lock.json -nt web/node_modules/.sc-installed-at ]; then
  echo "== npm ci（package-lock 领先安装标记）=="
  (cd web && npm ci --prefer-offline && touch node_modules/.sc-installed-at)
fi

echo "== 前端构建一次（4 实例共享同一 dist 嵌入产物）=="
(cd web && npm run build)

LOGDIR=".sc-tmp/e2e-full"
rm -rf "$LOGDIR"
mkdir -p "$LOGDIR"

# 分片实例异常退出时的清理兜底（stop 语义与 e2e-restart.sh 一致）
stop_shard_instances() {
  local port
  for port in $PORTS; do
    ".sc-tmp/polish-e2e-$port.exe" stop -p "$port" -d ".e2e-data/full-$port" >/dev/null 2>&1 || true
  done
}
trap stop_shard_instances EXIT

# ---- 起 4 个实例（并行重启，各自数据面） ----------------------------------

echo "== 启动分片实例：$PORTS =="
declare -A RESTART_PID=()
for port in $PORTS; do
  # e2e-restart.sh 签名 [web] [port] [repo]——端口必须显式传（默认 9999，
  # 四实例全缺省会互相抢 9999 并误杀主实例）；数据面经 env 注入分片子目录
  SC_E2E_DATA_DIR=".e2e-data/full-$port" bash scripts/e2e-restart.sh "" "$port" \
    > "$LOGDIR/restart-$port.log" 2>&1 &
  RESTART_PID[$port]=$!
done

RESTART_FAIL=""
set +e
for port in $PORTS; do
  wait "${RESTART_PID[$port]}"
  rc=$?
  # 就绪标记必须指向本分片端口——重启脚本的就绪探测若被别的端口满足会假绿
  if [ "$rc" -ne 0 ] || ! grep -q "E2E_SERVER_READY port=$port\$" "$LOGDIR/restart-$port.log"; then
    RESTART_FAIL="$RESTART_FAIL $port"
    echo "实例 :$port 启动失败 rc=$rc（$LOGDIR/restart-$port.log 尾部：）" >&2
    tail -15 "$LOGDIR/restart-$port.log" >&2
  fi
done
set -e
if [ -n "$RESTART_FAIL" ]; then
  echo "E2E_FULL_ABORT: 实例启动失败:$RESTART_FAIL" >&2
  exit 1
fi

# ---- 跑分片（并行，域内串行 workers=1） -----------------------------------

START_TS=$SECONDS
declare -A SHARD_PID=()
i=0
for port in $PORTS; do
  mapfile -t files < <(shard_files "$i")
  if [ ${#files[@]} -eq 0 ]; then exit 1; fi   # shard_files 已在 stderr 报错
  (
    cd web
    # retries 沿用全局配置（1）。实测注记：4 路并行下 WSL/回环反代类时序用例
    # （dsh-console iframe、terminal 拖拽等）会出现少量串行不见的负载超时
    # （约 0.6~1%，随机器状态波动，retry 无法稳定吸收）；gate 退出码语义与
    # 串行一致——任一用例最终失败即非零，失败清单在汇总里逐条列出
    # SC_E2E_DATA_DIR 同步注入 playwright 进程：request-id 等 spec 靠它定位
    # 本分片实例的数据面日志（.e2e-data/full-<port>/logs），缺省会读主实例
    # 的 .e2e-data/logs 而 rid 永不命中
    # line,json 双报（P-20261004-93）：line 报告器照旧进 shard 日志；JSON 经
    # PLAYWRIGHT_JSON_OUTPUT_FILE 落 results-<port>/report.json（与 --output 工件
    # 同处、随 $LOGDIR 同生命周期），供 scripts/e2e-flaky-report.mjs 聚合重试
    # 通过（flaky）用例。只加旁路产物，不改 line 输出与门禁退出码语义
    SC_E2E_DATA_DIR=".e2e-data/full-$port" PLAYWRIGHT_BASE_URL="http://127.0.0.1:$port" \
      PLAYWRIGHT_JSON_OUTPUT_FILE="../$LOGDIR/results-$port/report.json" \
      npx playwright test --reporter=line,json --output="../$LOGDIR/results-$port" "${files[@]}"
  ) > "$LOGDIR/shard-$port.log" 2>&1 &
  SHARD_PID[$port]=$!
  i=$((i + 1))
done

# ---- 等待与汇总 -----------------------------------------------------------

declare -A SHARD_RC=()
set +e
for port in $PORTS; do
  wait "${SHARD_PID[$port]}"
  SHARD_RC[$port]=$?
done
set -e

ELAPSED=$((SECONDS - START_TS))
OVERALL=0
echo ""
echo "== e2e-full 分片汇总（并行 ${ELAPSED}s）=="
for port in $PORTS; do
  rc=${SHARD_RC[$port]}
  # 行报告器输出带 ANSI 光标控制码（非 TTY 也写 \x1b[1A\x1b[2K），先剥掉再取
  # 末行汇总（形如「122 passed (17.5m)」「2 failed」「4 skipped」）
  summary=$(sed 's/\x1b\[[0-9;]*[A-Za-z]//g; s/\r/\n/g' "$LOGDIR/shard-$port.log" \
    | grep -E '^[[:space:]]*[0-9]+ (passed|failed|flaky|interrupted|skipped)' | tail -1)
  [ -n "$summary" ] || summary="(无结果行，见 $LOGDIR/shard-$port.log)"
  if [ "$rc" -eq 0 ]; then
    echo "shard :$port  OK    $summary"
  else
    OVERALL=1
    echo "shard :$port  FAIL  $summary"
    # 失败/不稳定明细：报告器把用例名列在 failed/flaky 小节下（缩进 + › 分隔）
    sed 's/\x1b\[[0-9;]*[A-Za-z]//g; s/\r/\n/g' "$LOGDIR/shard-$port.log" \
      | grep -E '^[[:space:]]+(e2e|tests)[/\\].*›' | head -20 | sed 's/^/    /'
  fi
done
if [ "$OVERALL" -ne 0 ]; then
  echo "E2E_FULL_RESULT: FAILED（分片日志 $LOGDIR/shard-<port>.log）"
else
  echo "E2E_FULL_RESULT: PASSED（分片日志 $LOGDIR/shard-<port>.log）"
fi

# ---- flaky 清单聚合（P-20261004-93） ---------------------------------------
# 解析各分片 results-<port>/report.json，把重试通过（outcome=flaky）用例汇总为
# $LOGDIR/flaky.md（清单 + 跨轮累计段）+ stdout 尾部机读行 FLAKY_N=<n>。
# best-effort：脚本内部对缺失/损坏 JSON 只告警，这里 || 兜底防意外破坏门禁退出码
node scripts/e2e-flaky-report.mjs "$LOGDIR" \
  || echo "E2E_FULL_FLAKY_REPORT_WARN: flaky 清单生成失败（不影响门禁结果）" >&2

# ---- 失败基线比对 + 册外串行复跑（2026-10-21） -----------------------------
# 把编排器每轮手工做的「对账基线 → 单实例串行复跑册外失败」固化到门禁尾部。
# 门禁退出码 OVERALL 不变：本段只产出机读证据，不自动判绿。
# 机读基线清单与 fulle2e-baseline.md 同步维护（增删在册条目两处一起改）。
BASELINE_SPECS_FILE="${E2E_BASELINE_SPECS_FILE:-.goal-enhance/fulle2e-baseline-specs.txt}"
if [ "$OVERALL" -ne 0 ]; then
  FAILED_SPECS=$(node scripts/e2e-failed-specs.mjs "$LOGDIR"/results-* 2>/dev/null | tr -d '\r' | sort -u || true)
  if [ -z "$FAILED_SPECS" ]; then
    echo "E2E_SERIAL_RERUN_RESULT=skipped (失败清单解析为空)"
  elif [ ! -f "$BASELINE_SPECS_FILE" ]; then
    echo "E2E_SERIAL_RERUN_RESULT=skipped (基线清单缺失: $BASELINE_SPECS_FILE)"
  else
    BASELINE_SPECS=$(grep -vE '^[[:space:]]*(#|$)' "$BASELINE_SPECS_FILE" | tr -d '\r' | sed 's#^web/##' | sort -u || true)
    OUTSIDE_SPECS=$(comm -23 <(printf '%s\n' "$FAILED_SPECS") <(printf '%s\n' "$BASELINE_SPECS"))
    if [ -z "$OUTSIDE_SPECS" ]; then
      echo "E2E_BASELINE_ONLY=1"
      echo "E2E_SERIAL_RERUN_RESULT=not-needed (失败集全在册)"
    else
      echo "E2E_SERIAL_RERUN_SPECS=$(printf '%s' "$OUTSIDE_SPECS" | tr '\n' ' ')"
      if [ -n "$(git status --porcelain -uno)" ]; then
        echo "E2E_SERIAL_RERUN_RESULT=skipped (主树有未提交改动，拒绝重启 9999)"
      else
        mkdir -p "$LOGDIR/results-serial" "$LOGDIR/serial-output"
        echo "== 册外失败单实例串行复跑（9999，workers=1）=="
        if bash scripts/e2e-restart.sh web 9999 "$ROOT" > "$LOGDIR/serial-rerun-restart.log" 2>&1 \
           && grep -q "E2E_SERVER_READY port=9999$" "$LOGDIR/serial-rerun-restart.log"; then
          set +e
          ( cd web && SC_E2E_DATA_DIR=".e2e-data" PLAYWRIGHT_BASE_URL="http://127.0.0.1:9999" \
              PLAYWRIGHT_JSON_OUTPUT_FILE="../$LOGDIR/results-serial/report.json" \
              npx playwright test --reporter=line,json --output="../$LOGDIR/serial-output" $OUTSIDE_SPECS ) \
            > "$LOGDIR/serial-rerun.log" 2>&1
          SERIAL_RC=$?
          set -e
          if [ "$SERIAL_RC" -eq 0 ]; then
            echo "E2E_SERIAL_RERUN_RESULT=pass (册外失败为负载抖动)"
          else
            SERIAL_FAILED=$(node scripts/e2e-failed-specs.mjs "$LOGDIR/results-serial" 2>/dev/null | tr -d '\r' | sort -u | tr '\n' ' ' || true)
            echo "E2E_SERIAL_RERUN_RESULT=fail"
            echo "E2E_SERIAL_RERUN_FAILED=${SERIAL_FAILED:-（见 $LOGDIR/serial-rerun.log）}"
          fi
        else
          echo "E2E_SERIAL_RERUN_RESULT=skipped (9999 重启失败，见 $LOGDIR/serial-rerun-restart.log)"
        fi
      fi
    fi
  fi
fi

exit "$OVERALL"
