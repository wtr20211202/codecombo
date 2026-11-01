# agentops — Agent 运行时接入框架

把「环境内成熟智能体 CLI（claude / codex / dsh）以终端 TUI 形态接入本系统、
并被系统反向开放能力」的机制沉淀为可复用的标准框架：任何 Go 后端应用嵌入
本包，即可让环境内 Agent 安全地操作、查询、分析本系统。

本仓库（simple-coding）是框架的参考实现：终端子系统（`server/api/terminal`）
是运行时拉起方，`server/api/ai`（opsentry/module）是能力手册安装与
ops-channel 入站端点的宿主。

## 架构

```
用户 ──新建智能体终端──▶ 终端子系统（拉起方）
        │ agentops.InteractiveLaunchCommand（按设置/auto 选型）
        ▼
┌────────────────── agentops（本包，框架核心） ──────────────────┐
│  Provider 注册表   ──  claude / dsh / codex / 自定义运行时接入    │
│  Section 能力手册  ──  /ops-manual + SKILL.md 渐进式披露         │
│  InstallSkillDocs  ──  启动期把手册安装到运行时指令读取位置        │
└────────────────────────────────────────────────────────────────┘
        │ 环境变量注入 CC_BASE_URL / CC_LOCK_TOKEN / CC_TERMINAL_ID
        │ （项目绑定会话另有 CC_PROJECT_ID / CC_PROJECT_PATH）
        ▼
   环境内 Agent CLI（claude / codex / dsh，原生 TUI 由 PTY 承接）
        │ 读能力手册 → 调本系统 REST API
        ▼
   本系统的 HTTP API（git/文件/终端/实例/设置/通知…）
        │ 反向驱动（任务进度/导航/确认请求）
        ▼
   POST /api/ops-notify → /ws/ops-channel → 前端 UI
```

## 两大扩展点

### 1. Provider —— 接入新的智能体运行时（无需改动调用方）

```go
type Provider interface {
    Name() string      // 运行时名（用户设置里的选项即来源于此）
    Available() bool   // CLI 是否可用（如 PATH 探测）
    InteractiveCommand() (command string, ok bool) // 终端 TUI 启动命令（服务端常量）
}
agentops.RegisterProvider(myProvider{})  // init() 里注册即接入
```

- 选型：`InteractiveLaunchCommand(providerName)`——请求显式指定优先，
  空值/"auto" 按注册顺序取第一个可用项；指定项不可用自动回退 auto。
  设置白名单用 `IsRegisteredProvider` 校验——新 Provider 注册后自动出现在
  设置选项中（`ProviderNames`）。
- 安全契约：`InteractiveCommand` 返回服务端常量（不含用户输入），由调用方
  经 PTY 注入 shell 执行；认证凭据由终端管理器统一注入环境变量，不出现在
  进程列表。

### 2. Section —— 向智能体开放新的系统能力

```go
agentops.RegisterSection(Section{
    ID: "inventory", Title: "库存管理", Order: 60,
    Summary: "查询与调整库存（面向 AI 的一句话摘要）",
    Body: ` - GET /api/inventory ...`,
})
```

- 手册三形态自动生成：`Manual()`（完整版）、`SkillMarkdown`（索引版：认证+
  工作流+目录）、`SkillReferences`（按域明细，渐进式披露，Anthropic Skill 实践）。
- 调用方负责把 SKILL.md + references/ 写到 Agent 可读的指令读取位置
  （`InstallSkillDocs`：claude → `~/.claude/skills/codecombo-ops/` +
  `~/.claude/CLAUDE.md` 常驻标记块——技能加载靠 description 语义匹配，用户未提及
  本系统的普通任务可能不触发，会话自命名等普适约定走常驻通道；codex →
  `~/.codex/AGENTS.md` 标记块；无注入入口的运行时如 dsh 跳过，
  仅靠 SC_* 环境变量 + 手册 URL）。
- 安全契约：能力手册不包含敏感凭据面（credentials/tokens 类端点不进手册，
  E2E 有负向断言守门）。

## 在新应用中启用（4 步）

1. 引入本包，`init()` 注册内置或自定义 Provider；
2. 为系统 API 写 Section（一句话 Summary + 端点明细 Body）；
3. 启动期调用 `InstallSkillDocs()`（建议放模块 Init，失败降级不阻断）；
4. 挂载 `GET /ops-manual`（及 `?format=skill`）供 Agent 与用户查阅能力边界，
   并开放 ops-channel 类的反向驱动通道（参考 `server/api/opschannel`）。

> 注：早期版本提供的 headless 会话式运行核心（Run/BuildCommand/stream-json
> 解析，供服务端直调 Agent CLI 的对话形态）已移除——本系统定位为管理环境内
> 成熟智能体（终端 TUI 承接），不做自研助手。若未来需要 headless 形态
> （定时任务/Webhook 触发），按新需求重新设计接口而非复用历史实现
>（可从 git 历史找回：`git log --diff-filter=D -- server/agentops/runner.go`）。
