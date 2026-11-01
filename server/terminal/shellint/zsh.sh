# Codecombo Shell Integration for zsh
# 通过 preexec 捕获命令开始，precmd 输出 OSC 133 命令结束标记
# 输出格式：
#   \x1b]133;C\x07                          命令开始
#   \x1b]133;D;<exitcode>;<duration_ms>\x07 命令结束（携带退出码和运行时长ms）
#   \x1b]133;E;<base64>\x07                 命令文本（整行命令 base64 编码回传，超长截断 8KB）
#   \x1b]133;A\x07                          Prompt 开始
#   \x1b]7;file://<host><pwd>\x07            cwd 上报（OSC 7，会话位置实时追踪）
#
# tmux 兼容：在 tmux 内（$TMUX 非空）通过 DCS Ptmux; passthrough 包装，
# 否则 tmux 默认会吞掉未知 OSC 序列，导致前端命令时长通知失效。
# 要求 tmux 3.3+ 配置 allow-passthrough on（由 ~/.simple-coding/tmux.conf 注入）

# 仅注入一次
if [ -z "$SIMPLE_CODING_SHELL_INTEGRATION" ]; then
    export SIMPLE_CODING_SHELL_INTEGRATION=1

    # 加载 zsh/datetime 模块以获取 $EPOCHREALTIME（纳秒精度）
    zmodload zsh/datetime 2>/dev/null

    # OSC 包装器：tmux 内用 DCS passthrough，否则裸输出
    # 用法：__simple_coding_osc <code> <payload>，如 '133' 'A' / '7' "$url"
    __simple_coding_osc() {
        if [ -n "$TMUX" ]; then
            printf '\033Ptmux;\033\033]%s;%s\007\033\\' "$1" "$2"
        else
            printf '\033]%s;%s\007' "$1" "$2"
        fi
    }

    # OSC 7 cwd 上报（P-20261004-59）：file URL 保守百分号编码——仅编码 URL
    # 语义消歧必需的四个字符（% 自身/空格/#/?），多字节 UTF-8 原样透传
    __simple_coding_urlenc() {
        local s=$1
        s=${s//%/%25}
        s=${s// /%20}
        s=${s//#/%23}
        s=${s//\?/%3F}
        printf '%s' "$s"
    }

    # OSC 7 帧：file://<host><pwd>——会话 cwd 从「创建时快照」变实时
    __simple_coding_osc7() {
        local host="${HOST:-${HOSTNAME:-localhost}}"
        __simple_coding_osc 7 "file://$host$(__simple_coding_urlenc "$PWD")"
    }

    # 命令开始时间戳（ms）
    typeset -g __simple_coding_cmd_start=""

    # preexec：用户按回车、shell 执行命令前（$1 为整行命令文本，zsh 官方语义，
    # 每个命令行仅触发一次，无 bash DEBUG trap 的复合命令多次触发问题）
    __simple_coding_preexec() {
        __simple_coding_cmd_start=$(((${EPOCHREALTIME//./} - 0) / 1000))
        __simple_coding_osc 133 'C'
        # E 事件：命令文本 base64 回传（BEL 终止与 A/C/D 一致）；
        # 超长截断 8KB 防异常大命令；-w0 是 GNU base64 选项，BSD/macOS 不支持时回退
        local cmd_b64
        cmd_b64=$(printf '%s' "$1" | head -c 8192 | base64 -w0 2>/dev/null || printf '%s' "$1" | head -c 8192 | base64)
        __simple_coding_osc 133 "E;$cmd_b64"
    }

    # precmd：命令完成后、新 prompt 显示前
    __simple_coding_precmd() {
        local ec=$?
        local now=$((${EPOCHREALTIME//./} / 1000))
        local dur=0
        if [ -n "$__simple_coding_cmd_start" ]; then
            dur=$((now - __simple_coding_cmd_start))
            __simple_coding_cmd_start=""
        fi
        __simple_coding_osc 133 "D;$ec;$dur"
        __simple_coding_osc 133 'A'
        __simple_coding_osc7
    }

    autoload -Uz add-zsh-hook
    add-zsh-hook preexec __simple_coding_preexec
    add-zsh-hook precmd __simple_coding_precmd

    # 首次 prompt 标记
    __simple_coding_osc 133 'A'
    __simple_coding_osc7
fi
