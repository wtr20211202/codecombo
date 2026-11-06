# 更新日志（简体中文）

本文件是 [CHANGELOG.md](../CHANGELOG.md) 的中文对照版，按版本段落一一对应；
发布工作流从两份各提取对应版本段拼接为双语 Release 说明。新版本两份同 PR
更新（英文为叙事主源，中文为对照译文）。

## [Unreleased]

## [0.0.1-beta.3] - 2026-11-06

### 修复

- **检查更新此前从未真正工作** —— 内置官方源是 github.com 网页地址，而取数
  端点全按 REST API 路径拼接；缺一步 URL 归一使每次检查都在把网页 HTML 当
  JSON 解码而失败，最终呈现为误导性的「未配置更新分发源」提示。网页仓库地址
  现归一到 api.github.com；检查失败不再一律吞成「已是最新」：stable 通道暂无
  正式版时如实说明并指向「跟进预发布版本」开关，其余失败（网络/非法源）
  如实呈现原因（beta.1/beta.2 回归）。
- **Windows 服务数据目录** —— 服务命令行直传 `--data-dir`，把数据目录钉到
  安装者用户目录（`%USERPROFILE%\.codecombo`）：此前经服务环境变量注入在
  LocalSystem 下静默不生效，服务会以空数据目录启动而非复用既有数据。
- **远程部署存量升级** —— 老版本迁移不再 `install binary exit 1`：二进制
  直接装入 ExecStart 最终路径（legacy 目录随首启迁移整体改名），消除装入
  目录与迁移目标之间的鸡生蛋死锁；安装失败时远端命令 stderr 原文进任务日志。
- **Windows 短路径归一** —— 缺失目标尾段的短名（8.3）成分一致解析；祖先
  解析曾丢失最后一段路径，边界场景误判 traversal。
- **最近裁决浮层** —— 最近审批浮层支持手动关闭（✕），且只回看 48 小时内
  的裁决，不再永久遮挡终端面板。

### 变更

- **更新相关设置即时生效** —— 「跟进预发布版本」开关、更新源变更与自动检查
  开关保存即生效，不再要求重启。版本面板新增「重启应用」按钮兜底真正需要
  重启的少数设置：Windows 服务走 SCM failure-recovery 拉起，systemd 走
  `systemctl restart`，前台实例以原参数自拉起。
- **npm 平台包改名** —— `codecombo-win32-*` 更名 `codecombo-windows-*`
  （npm spam 风控对 win32 命名加权拦截；darwin/linux 同构包未受影响）。
  `os: win32` 字段保留（npm 官方平台标识），`npm i -g codecombo` 的平台
  选择行为不变。
- **npm 发布流程** —— 主包最先发布，单包失败不再中断其余包；失败包收集
  汇总呈现。

## [0.0.1-beta.2] - 2026-11-05

### 新增

- **Windows 服务支持** —— 注册的 Windows 服务真正运行完整工作台：完整 SCM 协议
  （状态上报、停止/关机请求经既有优雅退出路径处理、10 秒停止宽限），
  `--serve` 中的服务上下文自动检测，数据目录经服务环境变量钉到安装者用户目录。

### 修复

- **Windows 安装器加固**（PS 5.1 真实环境五连）：纯 ASCII 无 BOM 脚本（编码
  问题破坏 `irm | iex` 解析）、`WindowsIdentity::Current` 属性访问（方法调用
  崩溃）、WebClient 单字符串引导防逐行执行、curl 退出码显式检查（失败曾
  静默滑入校验段）、下载进度条+重试/超时（静默 50MB 下载像卡死）、root/系统
  账户防线、服务启动 RUNNING 轮询确认+诊断指引（替代无条件 started 消息）。

## [0.0.1-beta.1] - 2026-11-03

首个公开发布（Beta）。

### 新增

- **终端工作台** —— 真实 PTY 支撑的多会话/多分屏/终端标签页（Windows ConPTY、
  Unix creack/pty，可选 tmux 持久会话：输出回放与服务重启恢复）、scrollback
  书签、全端输出检索、命令块与运行态标记、粘贴图片直传。
- **智能体协作** —— 本地 AI 智能体运行时（claude / codex / dsh）一键接入，
  高危命令与批量替换的审批卡（逐项放行/拒绝）、会话接续链、定时智能体任务、
  双智能体对比实验、AI 可读的操作手册。
- **智能体操作通道** —— 智能体经结构化 API 操作工作台本身：浏览器下载、
  剪贴板、按行号开文件、dev server 预览链接、ask/审批卡、跨设备通知，
  能力注册表渲染为手册（`GET /api/ops-manual`）。
- **Git 工作台** —— hunk 级暂存/取消/丢弃、三路差异、拖拽交互式变基
  （pick/squash/fixup/reword/drop）、合并预演、changelist 与搁置、补丁
  导出导入、分支管理、冲突解决（文本与三路）、reflog、标签、子模块、
  worktree、LFS、GPG 签名支持。
- **凭据与认证** —— 按主机 PAT/密码托管、GitHub/Gitea OAuth Device Flow
  自动续期、SSH 密钥生成/导入并按主机自动注入、全部敏感值经本机 master-key
  AES-256 加密落盘。
- **远程能力** —— 远程主机管理（SSH 凭据加密托管）、远程终端（SSH PTY +
  可选远端 tmux）、一键远程部署流水线（systemd 服务 + 依赖引导）与部署日志
  实流、端口穿透、值班健康大屏。
- **多实例管理** —— 一个实例经中心代理管理多个远程 Codecombo 实例（健康
  总览、终端与面板接管、实例间同步、加密 `.scpkg` 整机迁移）。
- **访客分享** —— 文件/目录/片段/实时终端的访客链接：TTL、口令、阅后即焚、
  定格快照。
- **安全底座** —— 全局锁（首启设密、闲置自锁）、按 IP 限流、审批边界出域
  脱敏、审计日志与 CSV 导出。
- **应用自更新** —— 在线更新检查零配置开箱即用（内置官方仓库默认源，设置里
  清空 updateURL 即退出）、签名/校验和验证、子实例二进制缓存转发、更新失败
  自动回滚。
- **npm 分发** —— `npm i -g codecombo` 即装即用：npm 经 optionalDependencies
  按平台自动装上原生二进制（Windows/Linux/macOS，amd64/arm64），零
  postinstall 脚本。预发布版本走 `next` 通道（`codecombo@next`）；npm 安装
  形态更新归 npm 管，应用内自更新自动让位。
- **项目官网** —— 双语落地页（截图/场景/快速上手）：
  https://wtr20211202.github.io/codecombo/
- **跨平台** —— Windows/Linux/macOS 单静态二进制（amd64/arm64），零外部
  数据库；全部状态落 `~/.codecombo/`。

### 变更

- 文档全面刷新：快速开始前置、完整工具清单（What's inside）、典型场景
  走查、开放贡献指南（欢迎 DCO 签名的 PR）。

[Unreleased]: https://github.com/wtr20211202/codecombo/compare/v0.0.1-beta.3...HEAD
[0.0.1-beta.3]: https://github.com/wtr20211202/codecombo/releases/tag/v0.0.1-beta.3
[0.0.1-beta.2]: https://github.com/wtr20211202/codecombo/releases/tag/v0.0.1-beta.2
[0.0.1-beta.1]: https://github.com/wtr20211202/codecombo/releases/tag/v0.0.1-beta.1
