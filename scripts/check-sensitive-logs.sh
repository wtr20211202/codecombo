#!/bin/bash
# 敏感字段日志防回流扫描（P-20261005-146，兑现 P-20261002-95 方案④「自定义规则防回流」）。
#
# 动机：P-95 日志脱敏落地时靠人工三模式审计清偿存量（合并注记 7993116e），该人工动作
# 未固化——新代码再写一行 token=明文 slog 无门禁会红。本脚本把那次审计口径固化为门禁，
# 挂 wsl-verify quick 首步（scripts/ 侧既有链），HEAD 全绿起步（零存量违例）。
#
# 扫描口径（与 P-95 执行者三模式一致）+ stdlib log：
#   模式1  slog. 前缀（slog.Debug/Info/Warn/Error/Log/LogAttrs/*Context/With）
#   模式2  任意 logger 变量（var.Debug/Info/Warn/Error/With( 且首参带引号——
#          排除 err.Error() 这类非日志调用与 context.WithCancel 等 WithXxx 家族）
#   模式3  kernel Logger() 链（server/kernel 的 k.Logger().Info(...)，含 *Context 变体）
#   模式4  stdlib log（Print/Printf/Println/Fatal*/Panic*）
#
# 违例形态（敏感值类字段名后跟非脱敏裸值；敏感词集：token/secret/password/credential/
# device_code/Authorization/bearer，大小写不敏感、含复合词如 access_token/oldToken）：
#   kv 形态   "token", tok / "password", pw ——键为引号敏感词（标识符风格，不含连字符
#             与空格；连字符引号串是 "find-credential" 这类 op 名值形态），前随 ,（调用
#             实参位——首参位无 , 前随，doc.List("credentials",…) 集合名类天然排除）或
#             行首缩进（多行 slog 调用的续行 kv 与自定义 log helper）；日志调用行另有
#             首参位（logger.With("token", tok) 持久化 kv）。kv 形态不限于日志调用行，
#             但非日志行只报裸值形态：字面量值（Header.Set("Authorization", "Bearer "+t)
#             等按设计携带凭据的 HTTP/结构体载体）与赋值形态（a, b = "token", x）与
#             行尾逗号空值（切片字面量续行）不报；日志调用行连字面量值也报（log 里
#             打引号包住的密钥同样是泄漏）。
#   内嵌形态  仅日志调用行：token= / token: / Authorization: 等独立敏感词后紧跟 = 或 :
#             （log.Printf("token=%s", tok) 即此形态；词边界排除 ValidateToken=true
#             这类驼峰标识符内的子串）。
#
# 放行形态（脱敏族，值或整行含即放行）：Summary / Redact / Mask / 摘要 / Encrypt /
# ***（大小写不敏感）——share.TokenSummary、share.RedactLogLine、mask.MaskText 即此族。
# Decrypt 不放行：先解密再入日志 = 明文落日志，正是要抓的。
#
# 白名单：行尾注释 // logsafe: <理由>（理由必填，空理由仍算违例）——宁可多报人工标注，
# 不静默漏。初始基线零标注：HEAD 存量命中全部已是 Summary 脱敏形态。
#
# 已知边界（如实声明，非静默漏）：attrs... 展开参数、m["token"] = v 下标赋值、键值跨行
# 分写无法静态定位——靠评审兜底。
#
# 用法：
#   bash scripts/check-sensitive-logs.sh [target-dir]   # 默认脚本所在仓库根
#   bash scripts/check-sensitive-logs.sh --self-test    # 夹具红绿自证（临时目录不碰仓库）
# 退出码：0 全绿；1 有违例；2 用法/自证失败/扫描面为空。
# 平台：纯 bash + POSIX awk（无 gawk 扩展、无 [[:space:]] 类——mawk 兼容），Git Bash / WSL 双跑通用。
set -u

fail_usage() { echo "check-sensitive-logs: $1" >&2; exit 2; }

# 扫描面（.go 文件清单）——scan_target 与文件计数共用同一表达，避免口径漂移
go_files() {
  find "$1" -type f -name '*.go' -not -path '*/.git/*' -not -path '*/node_modules/*' -print0
}

# scan_target <dir>：逐文件扫描，命中行打到 stdout（ASCII 标记前缀供计数）。
# SENSLOG_VIOL(kv|embed) <rel>:<行>: <源码行>   违例
# SENSLOG_WL <rel>:<行>: <源码行>               logsafe 白名单
scan_target() {
  go_files "$1" | xargs -0 -r awk -v tgt="$1" '
    BEGIN {
      # 日志调用行（三模式 + stdlib）；[.] [(] 写法避开正则元字符歧义；
      # Context 变体属 slog. 前缀/kernel 链口径（模式2 首参引号启发式不收 ctx 首参签名，
      # 其 kv 泄漏由 kv_call 全行扫描兜住）
      m1   = "(^|[^A-Za-z0-9_.])slog[.](Debug|Info|Warn|Error|Log|LogAttrs|DebugContext|InfoContext|WarnContext|ErrorContext|With)[(]"
      m3   = "Logger[(][)][.](Debug|Info|Warn|Error|Log|DebugContext|InfoContext|WarnContext|ErrorContext|With)[(]"
      mstd = "(^|[^A-Za-z0-9_.])log[.](Print|Printf|Println|Fatal|Fatalf|Fatalln|Panic|Panicf|Panicln)[(]"
      m2q  = "[A-Za-z_][A-Za-z0-9_]*[.](Debug|Info|Warn|Error|With)[(][ \t]*\""
      # kv 形态：敏感键引号串（标识符风格）+ 逗号；前随 ,（调用实参位——
      # 首参位不带 , 前随，doc.List("credentials",…) 这类集合名在此天然排除）
      kv_call = ",[ \t]*\"[A-Za-z0-9_.]*(token|secret|password|credential|device_code|authorization|bearer)[A-Za-z0-9_.]*\"[ \t]*,"
      # kv 形态（行首缩进位）：多行调用续行 / 自定义 helper
      kv_cont = "^[ \t]*\"[A-Za-z0-9_.]*(token|secret|password|credential|device_code|authorization|bearer)[A-Za-z0-9_.]*\"[ \t]*,"
      # kv 形态（首参位）：仅日志调用行——logger.With("token", tok) 持久化 kv；
      # slog 首参恒为消息，首参即敏感词的日志调用本身就是可疑形态
      kv_first = "[(][ \t]*\"[A-Za-z0-9_.]*(token|secret|password|credential|device_code|authorization|bearer)[A-Za-z0-9_.]*\"[ \t]*,"
      # 内嵌形态（仅日志调用行）：敏感词后紧跟 = 或 :；词边界防 ValidateToken=true 驼峰误报
      embed = "(^|[^A-Za-z0-9_])(token|secret|password|credential|device_code|authorization|bearer)[ \t]*[:=]"
      # 放行（脱敏族）
      allow   = "(summary|redact|mask|摘要|encrypt|\\*\\**)"
      logsafe = "//[ \t]*logsafe:[ \t]*[^ \t]"
    }
    function rel(f) { return (index(f, tgt "/") == 1) ? substr(f, length(tgt) + 2) : f }
    {
      low = tolower($0)
      if (low ~ logsafe) { printf "SENSLOG_WL %s:%d: %s\n", rel(FILENAME), FNR, $0; next }
      is_log = ($0 ~ m1) || ($0 ~ m3) || ($0 ~ mstd) || ($0 ~ m2q)
      # kv 形态：非日志行要求裸值（字面量值放行）；日志行连字面量值也报。
      # 值为空（行尾逗号、切片字面量续行）不报——同位置 slog kv 的值必在同一行，
      # 键值跨行分写属已知边界
      matched = 0
      if (match(low, kv_call)) matched = 1
      else if (match(low, kv_cont)) matched = 1
      else if (is_log && match(low, kv_first)) matched = 1
      if (matched) {
        val = substr(low, RSTART + RLENGTH)
        if (val !~ allow && val !~ /^[ \t]*$/ && (val !~ /^[ \t]*"/ || is_log)) {
          printf "SENSLOG_VIOL(kv) %s:%d: %s\n", rel(FILENAME), FNR, $0
          next
        }
      }
      # 内嵌形态：仅日志调用行
      if (is_log && low ~ embed) printf "SENSLOG_VIOL(embed) %s:%d: %s\n", rel(FILENAME), FNR, $0
    }
    ' | LC_ALL=C sort
}

# ---- 入口 ----
target_dir=""
self_test=0
for arg in "$@"; do
  case "$arg" in
    --self-test) self_test=1 ;;
    -h|--help) echo "用法: check-sensitive-logs.sh [target-dir] | --self-test"; exit 2 ;;
    *) target_dir="$arg" ;;
  esac
done

count_mark() { printf '%s\n' "$1" | grep -c "^$2" || true; }

if [ "$self_test" = 1 ]; then
  # 夹具自证：断言精确计数（6 违例覆盖四模式+Context 变体+With 首参位，3 放行守卫 +
  # 1 白名单）——模式集回归（误改放行词/键字符集/位置规则）在此即红，不需污染真实仓库。
  tmp="$(mktemp -d)" || fail_usage "self-test: mktemp 不可用"
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/fixture"
  cat > "$tmp/fixture/case.go" <<'EOF'
package fixture

func Cases(tok, pw, dc string) {
	logger.Info("x", "token", tok)                            // 违例: 模式2 任意 logger 变量 kv 裸值
	log.Printf("token=%s", tok)                               // 违例: 模式4 stdlib 内嵌形态
	slog.Debug("auth", "password", pw, "note", "ok")          // 违例: 模式1 slog. 前缀 kv 裸值
	k.Logger().Warn("z", "device_code", dc)                   // 违例: 模式3 kernel Logger() kv 裸值
	slog.InfoContext(ctx, "dump", "token", tok)               // 违例: slog. 前缀 Context 变体
	logger = logger.With("token", tok)                        // 违例: With 首参位持久化 kv
	doc.List("credentials", opts)                             // 放行: 非日志首参集合名不报
	slog.Info("ok summary", "token", share.TokenSummary(tok)) // 放行: Summary 脱敏形态
	a, b = "token", tok                                       // 放行: 赋值形态非调用实参位
}
EOF
  cat > "$tmp/fixture/case2.go" <<'EOF'
package fixture

func Whitelisted(tok string) {
	slog.Info("x", "token", tok) // logsafe: 自证夹具——白名单机制生效
}
EOF
  all="$(scan_target "$tmp/fixture")"
  viol=$(count_mark "$all" 'SENSLOG_VIOL')
  wl=$(count_mark "$all" 'SENSLOG_WL')
  files=$(go_files "$tmp/fixture" | tr '\0' '\n' | grep -c .)
  if [ "${files:-0}" -ge 2 ] && [ "${viol:-0}" = "6" ] && [ "${wl:-0}" = "1" ]; then
    echo "SELF_TEST_OK（6 违例 / 1 白名单，红绿自证通过）"
    exit 0
  fi
  echo "SELF_TEST_FAIL：期待 files>=2 viol=6 wl=1，实得 files=$files viol=$viol wl=$wl" >&2
  printf '%s\n' "$all"
  exit 2
fi

# 默认目标：脚本所在仓库根（可显式传参；wsl-verify 门禁传 $REPO）
if [ -z "$target_dir" ]; then
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  target_dir="$(cd "$script_dir/.." && pwd)"
fi
[ -d "$target_dir" ] || fail_usage "目标目录不存在: $target_dir"

echo "== check-sensitive-logs on $target_dir =="
all="$(scan_target "$target_dir")"
viol=$(count_mark "$all" 'SENSLOG_VIOL')
wl=$(count_mark "$all" 'SENSLOG_WL')
files=$(go_files "$target_dir" | tr '\0' '\n' | grep -c . || true)
[ "${files:-0}" -gt 0 ] || fail_usage "扫描面为空（未发现 .go 文件）: $target_dir"

printf '%s\n' "$all" | grep '^SENSLOG' || true
if [ "${viol:-0}" -gt 0 ]; then
  echo "SENSITIVE_LOG_CHECK_FAILED: ${viol} 处违例——敏感字段明文落日志。" >&2
  echo "  放行须走脱敏族（Summary/Redact/Mask，如 share.TokenSummary），" \
    "确属安全的形态行尾标注 // logsafe: <理由>。" >&2
  exit 1
fi
echo "SENSITIVE_LOG_CHECK_OK（零违例，扫描 ${files} 个 .go，白名单 ${wl:-0} 处）"
exit 0
