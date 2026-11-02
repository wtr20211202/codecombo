# Codecombo Shell Integration for bash
# 通过 DEBUG trap 捕获命令开始时间，PROMPT_COMMAND 输出 OSC 133 命令结束标记
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

# 仅注入一次（防止 PROMPT_COMMAND 重复）
if [ -z "$SIMPLE_CODING_SHELL_INTEGRATION" ]; then
    export SIMPLE_CODING_SHELL_INTEGRATION=1

    # OSC 包装器：tmux 内用 DCS passthrough，否则裸输出
    # 用法：__simple_coding_osc <code> <payload>，如 '133' 'A' / '133' "D;$ec;$dur" / '7' "$url"
    __simple_coding_osc() {
        if [ -n "$TMUX" ]; then
            # DCS P tmux ; <ESC 双倍> ] <code> ; <payload> BEL <ST>
            printf '\033Ptmux;\033\033]%s;%s\007\033\\' "$1" "$2"
        else
            printf '\033]%s;%s\007' "$1" "$2"
        fi
    }

    # OSC 7 cwd 上报（P-20261004-59）：file URL 保守百分号编码——仅编码 URL
    # 语义消歧必需的四个字符（% 自身/空格/#/?），多字节 UTF-8 与其余字符原样
    # 透传（消费方按 UTF-8 解码，宽编码反而膨胀每 prompt 帧体积）
    __simple_coding_urlenc() {
        local s=$1
        s=${s//%/%25}
        s=${s// /%20}
        s=${s//#/%23}
        s=${s//\?/%3F}
        printf '%s' "$s"
    }

    # OSC 7 帧：file://<host><pwd>——cwd 实时追踪的消费方（前端 currentDir /
    # 服务端列表 currentDir）据此把会话位置从「创建时快照」变实时
    __simple_coding_osc7() {
        local host="${HOSTNAME:-${HOST:-localhost}}"
        __simple_coding_osc 7 "file://$host$(__simple_coding_urlenc "$PWD")"
    }

    # 命令开始时间戳（ms）
    __simple_coding_cmd_start=""
    # PROMPT_COMMAND 期间保护标志 + 去重基准（最近一次记事件的 history 顶目指纹）：
    # - in_prompt：precmd 执行期间置位，用户 PROMPT_COMMAND 钩子（git-prompt 等）
    #   内部的命令也会触发 DEBUG trap，置位期间一律不记事件；自愈判据见 trap 内注记。
    #   安装期即置位：rcfile 源化期的内部命令（含本块尾部的 A/OSC7 首标）同样不入
    #   history、不该记事件，trap 安装后立即由同款判据拦截
    # - last_hist + last_line：同一命令行内复合命令/循环体会多次触发 DEBUG trap，
    #   顶目未变只记首次。指纹=（HISTCMD，fc 顶行文本）二元组——单靠 HISTCMD 算术
    #   比较不可靠：bash 5.2.21（WSL 实测，2026-10-08）在 PROMPT_COMMAND 期已把
    #   「即将读入行」预支进 HISTCMD，precmd 校准值恰等于下一条命令的编号，锁步
    #   吞掉全部 C/E（real-PTY 三测试实证）；顶目身份判定不依赖该编号约定
    __simple_coding_in_prompt=1
    __simple_coding_last_hist=""
    # 最近一个 PROMPT_COMMAND 时刻的 HISTCMD：E 文本取数判别位（late-add
    # history 形态下 DEBUG 时刻 HISTCMD 与之相等即视为 fc 已陈旧，见 trap 内）
    __simple_coding_hist_at_pc=""

    # DEBUG trap：每条命令执行前触发，记录开始时间 + 回传整行命令文本
    __simple_coding_preexec() {
        __simple_coding_cmd_start=$(($(date +%s%N) / 1000000))
        __simple_coding_osc 133 'C'
        # E 事件：命令文本 base64 回传（BEL 终止与 A/C/D 一致）；
        # 超长截断 8KB 防异常大命令；-w0 是 GNU base64 选项，BSD/macOS 不支持时回退
        local cmd_b64
        cmd_b64=$(printf '%s' "$1" | head -c 8192 | base64 -w0 2>/dev/null || printf '%s' "$1" | head -c 8192 | base64)
        __simple_coding_osc 133 "E;$cmd_b64"
    }

    # PROMPT_COMMAND 钩子：每条命令完成后、新 prompt 显示前
    __simple_coding_precmd() {
        # $? 必须首句捕获：本函数体内的每条语句（含其触发的 DEBUG trap 自愈
        # 分支）都会重写 $?,迟一行读到的就是 0 而非真实退出码——历史上 D 帧
        # 退出码恒 0，命令历史「只看失败」/成败装饰在 bash 全部失真
        local ec=$?
        __simple_coding_in_prompt=1
        __simple_coding_prompt_histcmd="${HISTCMD:-}"
        local now=$(($(date +%s%N) / 1000000))
        local dur=0
        if [ -n "$__simple_coding_cmd_start" ]; then
            dur=$((now - __simple_coding_cmd_start))
            __simple_coding_cmd_start=""
        fi
        __simple_coding_osc 133 "D;$ec;$dur"
        __simple_coding_osc 133 'A'
        __simple_coding_osc7
        # 解除安装期武装。开门不能依赖 DEBUG trap 的 HISTCMD 自愈——
        # HISTCONTROL=ignoredups（主流发行版 .bashrc 默认）下重跑同一条命令
        # 不新增历史，HISTCMD 不前进，自愈永不触发，命令被永久拦截无 C/E
        # （实测 /root/.bashrc 场景复现）。
        #
        # 去重基准校准仅当 PROMPT_COMMAND 还有本钩子之后的余段：余段钩子的
        # 内部命令不入历史、HISTCMD 不越过基准，须靠校准拦截。单段链（本
        # 产品默认形态，PROMPT_COMMAND 恰为 __simple_coding_precmd）无余段
        # 可拦，不校准——WSL bash 5.2 真实 PTY 实测交互命令的 history 条目
        # 在执行后才入列（DEBUG 触发期 HISTCMD/fc 仍是上个 PC 时刻的旧值），
        # 校准基准会与首条命令的 HISTCMD 恒等，去重闸把全部命令事件吞掉
        # （Ubuntu 24.04 C/D/E 全丢实测复现；`bash -i <file>` 读入即入列，
        # 无此形态，两形态判别与文本回退见 trap 内注记）
        if [ "$PROMPT_COMMAND" = "__simple_coding_precmd" ]; then
            :
        else
            __simple_coding_last_hist="${HISTCMD:-$__simple_coding_last_hist}"
        fi
        __simple_coding_hist_at_pc="${HISTCMD:-}"
        __simple_coding_in_prompt=""
    }

    # 用 DEBUG trap 捕获命令开始（bash 没有 preexec 钩子，这是业界惯用法）
    __simple_coding_debug_trap() {
        # 仅在交互式 shell 记录
        [ -n "$BASH_VERSION" ] || return
        # 取最近一行 history：真实用户命令在执行前已入 history，正在执行的
        # BASH_COMMAND（复合命令取整行形态）与它一致；PROMPT_COMMAND 钩子内的
        # 命令与安装期内部命令不入 history，取到的最近行仍是上一条用户命令，
        # 与 BASH_COMMAND 必不相等。precmd 自体的 DEBUG 触发同此判据拦下：
        # PROMPT_COMMAND 执行期 HISTCMD 是「即将读入行」的错位编号而非已执行行
        # （WSL bash 5.2 实测 P=503/H=502 倒挂），且此窗口跑 fc 会把尚未执行的
        # pending 输入误当刚完成的命令记一次 C/E——首条命令的事件就此被占名，
        # 真执行时的 trap 再被去重闸吃掉，C/E 全丢；服务端 OSC 运行态 cmdActive
        # 闸连带把该命令的 D 帧一并抑制，退出码等待错位（oscstate_wait
        # Linux/tmux 踩坑）。显式把本函数当命令跑（bash -i driver 场景）时
        # fc 取到的就是它本身，照常记事件
        local line
        line=$(HISTTIMEFORMAT= fc -ln -1 2>/dev/null | sed '1s/^[[:space:]]*//')
        # PROMPT_COMMAND 自触发拦截：precmd 作为 PROMPT_COMMAND 执行时，其 DEBUG
        # 触发取到的最近行仍是上一条用户命令（≠ __simple_coding_precmd）——放行
        # 会把刚执行完的命令再记一次 C/E（in_prompt 已被该命令的自愈清除，旧
        # 判据拦不住）。显式把本函数当命令跑时 fc 取到的就是它本身，照常记事件
        if [ "$BASH_COMMAND" = "__simple_coding_precmd" ]; then
            # 武装期：precmd 周期自身（PROMPT_COMMAND 或 -i script 显式模拟）
            # 无条件不记事件——它是集成机械而非用户命令；FC 恰为它本身的平台
            # 形态不得借下一分支的自愈门放行（P-20261003-326 门禁暴露：该
            # 形态在 WSL 5.2/git-bash 方向相反，旧判据只拦其一）
            if [ -n "$__simple_coding_in_prompt" ]; then
                return
            fi
            # 非武装期：PROMPT_COMMAND 触发（FC=上一条用户命令）照旧拦；显式
            # 命令行形态（fc 即它本身）照旧记事件（bash -i driver 场景既有语义）
            if [ "$line" != "$BASH_COMMAND" ]; then
                return
            fi
        fi
        if [ -n "$__simple_coding_in_prompt" ]; then
            # 安装期内不开自愈门：install 块语句是集成内部命令，不是用户命令
            if [ -n "$__simple_coding_installing" ]; then
                return
            fi
            if [ -z "$line" ] || [ "$line" != "$BASH_COMMAND" ]; then
                return
            fi
            __simple_coding_in_prompt=""
        fi
        # fc 异常返回空行（history 损坏等）时放弃记录，不发空 E 帧
        [ -n "$line" ] || return
        # 复合命令/循环体的每个子命令都会触发 DEBUG trap（BASH_COMMAND 只是子命令文本），
        # 以 HISTCMD（当前命令行的 history 编号）递增去重：仅新命令行
        # 首条触发记一次 C/E。已知行为：`history -c` 清空后 HISTCMD 重置为小值，
        # 去重基准高于新编号，后续命令将漏记 C/E（保守方向：宁漏记不误记）
        local hist="${HISTCMD:-}"
        if [ "$hist" = "$__simple_coding_last_hist" ] && [ "$line" = "$__simple_coding_last_line" ]; then
            return
        fi
        __simple_coding_last_hist="$hist"
        # 记账后同步行文本半边指纹——二元组门的契约是「记账条目即新基准」：
        # 061f0bf7 判据重写时漏掉本行，last_line 恒为安装期空串，复合命令的
        # 内层 DEBUG 触发（BC=子命令、顶行=整行、HISTCMD 不变）永不与基准
        # 相等 → 管道记 2 帧、循环逐内层触发记 N 帧（WSL 5.2.21 / msys 5.2.26
        # -i script 与 real-pty 同理），C/E 与命令一一对应被破坏
        __simple_coding_last_line="$line"
        # E 帧文本：FC 即当前行（at-read 时序）时用 fc 全文（复合命令取整行，
        # BASH_COMMAND 只有首子命令）；lag-readline 时序（WSL 5.2.21 readline
        # 实测：DEBUG 触发时当前行尚未入历史，FC 是上一条命令的残留）下 FC
        # 是错误文本，退化用 BASH_COMMAND——简单命令即全文，复合命令为首子
        # 命令（全文此刻结构性不存在，宁短不假）。判据：HISTCMD 与最近一帧
        # precmd 时刻相等 = 当前历史滞后未纳入本行 = lag 时序
        local text="$line"
        if [ "${__simple_coding_hist_at_prompt:-}" = "$hist" ]; then
            text="$BASH_COMMAND"
        fi
        __simple_coding_preexec "$line"
    }
    # 同步去重基准：置空（「尚无任何已记命令」语义）——安装期的内部命令由
    # in_prompt 保护拦截（下置位），非基准；基准若取安装期 HISTCMD，在
    # 「执行后才入列」形态（见 trap 内注记）+ 空宿主 history 下会与首条命令
    # 的 HISTCMD 恒等，首命令事件被吞。必须在 trap 安装前赋值——否则该赋值
    # 自身触发 DEBUG trap 时基准尚未生效
    __simple_coding_last_hist=""
    # 安装期即置 in_prompt 保护：bash 对交互 shell 延迟装 HISTFILE（首个 prompt
    # 前才读，HISTFILE 未设时读默认 ~/.bash_history），安装期基准必然「过期」——
    # 首个 PROMPT_COMMAND 自身的 DEBUG trap（此刻 precmd 体尚未执行、in_prompt
    # 尚未在体内置位）会越过基准，把历史文件尾条目当会话首命令发幻影 C/E/D，
    # 污染命令历史/成败装饰/git 面板写命令检测（P-20261004-82，WSL 实测复现）。
    # 保护由首个 precmd 体末尾解除（同时以当下 HISTCMD 校准去重基准），见
    # precmd 内注释
    __simple_coding_in_prompt=1
    __simple_coding_prompt_histcmd=""
    trap '__simple_coding_debug_trap' DEBUG

    # 串联到现有 PROMPT_COMMAND（不覆盖用户配置）
    if [ -z "$PROMPT_COMMAND" ]; then
        PROMPT_COMMAND='__simple_coding_precmd'
    else
        PROMPT_COMMAND='__simple_coding_precmd;'$'\n'"$PROMPT_COMMAND"
    fi

    # 首次 prompt 标记
    __simple_coding_osc 133 'A'
    __simple_coding_osc7
    # 安装期结束（见 __simple_coding_installing 注记）：此后武装期自愈门对
    # 真实用户命令生效
    __simple_coding_installing=""
fi
