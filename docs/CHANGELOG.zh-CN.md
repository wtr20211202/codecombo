# 更新日志（简体中文）

本文件是 [CHANGELOG.md](../CHANGELOG.md) 的中文对照版，按版本段落一一对应；
发布工作流从两份各提取对应版本段拼接为双语 Release 说明。新版本两份同 PR
更新（英文为叙事主源，中文为对照译文）。

## [Unreleased]

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

[Unreleased]: https://github.com/wtr20211202/codecombo/compare/v0.0.1-beta.1...HEAD
[0.0.1-beta.1]: https://github.com/wtr20211202/codecombo/releases/tag/v0.0.1-beta.1
