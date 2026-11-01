# Codecombo Shell Integration for PowerShell
# 通过 PSReadLine 的 SetKeyHandler 捕获命令开始（用户按 Enter 时），重写 prompt 函数输出 OSC 133 结束标记
# 兼容 Windows PowerShell 5.1 与 PowerShell 7+（避免 `e / `a 转义，统一用 [char]27 / [char]7）
# OSC 7 cwd 上报一并随 prompt 发射（file://<host>/<盘符路径>，会话位置实时追踪）

if (-not $env:SIMPLE_CODING_SHELL_INTEGRATION) {
    $env:SIMPLE_CODING_SHELL_INTEGRATION = "1"

    # ESC / BEL 字符（PS 5.1 不支持 `e / `a 转义）
    $script:__SC_ESC = [char]27
    $script:__SC_BEL = [char]7

    # OSC 7 cwd 帧（P-20261004-59）：盘符路径转 file URL 的 VS Code 惯例形态
    # /C:/...（消费方按此识别 Windows 盘符并折回本机路径）；file URL 保守百分
    # 号编码与 bash.sh 同字符集（% 空格 # ?），UTF-8 路径原样透传
    function global:__SCWriteOsc7 {
        try {
            $scPath = $executionContext.SessionState.Path.CurrentLocation.ProviderPath
            $scUrl = $scPath.Replace('\', '/')
            if ($scUrl -match '^[A-Za-z]:') { $scUrl = '/' + $scUrl }
            $scUrl = $scUrl.Replace('%', '%25').Replace(' ', '%20').Replace('#', '%23').Replace('?', '%3F')
            $scHost = $env:COMPUTERNAME
            if (-not $scHost) { $scHost = 'localhost' }
            [Console]::Write($script:__SC_ESC + "]7;file://" + $scHost + $scUrl + $script:__SC_BEL)
        } catch {}
    }

    # 全局状态：命令开始时间戳（ms）
    $script:__SimpleCodingCmdStart = 0

    # 检测 PSReadLine 是否已加载（PowerShell 5.1+ 默认加载）
    if (Get-Module -ListAvailable -Name PSReadLine) {
        Import-Module PSReadLine -ErrorAction SilentlyContinue

        # 保存原始 Enter handler（避免破坏用户自定义）
        $script:__SCEnterHandler = $null
        try {
            $h = Get-PSReadLineKeyHandler -Chord Enter -ErrorAction SilentlyContinue
            if ($h) { $script:__SCEnterHandler = $h.Handler }
        } catch {}

        # 注册 Enter 键处理器：用户按回车时记录开始时间并输出命令开始标记
        Set-PSReadLineKeyHandler -Chord Enter -BriefDescription SimpleCodingPreExec -ScriptBlock {
            $script:__SimpleCodingCmdStart = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            # E 事件（命令文本，base64）在 C 之前发出，语义与 bash.sh 对齐——
            # 前端命令历史与失败 AI 分析的上下文都依赖 E；空行不发
            try {
                $line = $null
                [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$null)
                if ($line) {
                    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line))
                    [Console]::Write($script:__SC_ESC + "]133;E;" + $b64 + $script:__SC_BEL)
                }
            } catch {}
            [Console]::Write($script:__SC_ESC + "]133;C" + $script:__SC_BEL)
            # 调用原始 handler 维持默认行为
            if ($script:__SCEnterHandler -is [ScriptBlock]) {
                & $script:__SCEnterHandler
            } else {
                [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
            }
        }
    }

    # 重写 prompt 函数：每次显示提示符前输出命令结束标记 + prompt 开始标记
    $script:__SCOriginalPrompt = $null
    try {
        $cmd = Get-Command prompt -ErrorAction SilentlyContinue
        if ($cmd) { $script:__SCOriginalPrompt = $cmd.ScriptBlock }
    } catch {}

    # 会话错误基线：cmdlet 失败不更新 LASTEXITCODE，以 $Error 计数增长判定（见 prompt 内注释）
    $script:__SCLastErrCount = $global:Error.Count

    function global:prompt {
        # 退出码语义（对齐 bash 的每命令隔离）：
        # - 原生 exe：读 LASTEXITCODE，读完即清零，防旧值跨命令残留（cmdlet 不更新它）
        # - cmdlet 失败：$Error 计数增长判定，兜底 1
        # - prompt 函数内的 $? 恒为 True（函数调用本身是成功的流水线），不可用
        $ec = 0
        if ($global:LASTEXITCODE) { $ec = $global:LASTEXITCODE }
        if ($global:Error.Count -gt $script:__SCLastErrCount -and $ec -eq 0) { $ec = 1 }
        $script:__SCLastErrCount = $global:Error.Count
        $global:LASTEXITCODE = 0
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $dur = 0
        if ($script:__SimpleCodingCmdStart -gt 0) {
            $dur = $now - $script:__SimpleCodingCmdStart
            $script:__SimpleCodingCmdStart = 0
        }
        # 输出命令结束标记（exitcode;duration_ms）
        [Console]::Write($script:__SC_ESC + "]133;D;" + $ec + ";" + $dur + $script:__SC_BEL)
        # 输出 prompt 开始标记
        [Console]::Write($script:__SC_ESC + "]133;A" + $script:__SC_BEL)
        # OSC 7 cwd 上报：cd 的效果在下一次 prompt 时点可见，与 bash precmd 同语义
        __SCWriteOsc7

        # 调用原 prompt 函数（如果有），否则返回默认 PS 提示符
        if ($script:__SCOriginalPrompt) {
            & $script:__SCOriginalPrompt
        } else {
            $path = $executionContext.SessionState.Path.CurrentLocation
            $depth = $nestedPromptLevel + 1
            "PS " + $path + (" " * 0) + "> "
        }
    }

    # 首次 prompt 标记
    [Console]::Write($script:__SC_ESC + "]133;A" + $script:__SC_BEL)
    __SCWriteOsc7
}
