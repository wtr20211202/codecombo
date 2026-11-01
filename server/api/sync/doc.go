// Package sync implements 多实例项目与上下文同步（P-20261023-1）：
// manifest/plan/pull/push 端点族 + 同步账本四态判定 + 流式 zip 传输 +
// 对端落位安全（原子落位/.sync-backup 备份/磁盘预检/自动注册项目）+
// 进度广播 + 定时同步。同步单元 = 项目本体（工作区或含 .git 两档）+
// 可选上下文包（会话/笔记/片段/定时任务/运行时/审批规则/接续链/uiState）。
//
// 跨实例调用沿实例注册表既有链（Bearer 实例令牌 + TOFU TLS + scheme 翻转
// 自愈，dispatch/探活同源先例）；对端未声明 sync 能力族（/api/meta）即
// 明确降级报「对端实例需升级」，不做半兼容猜测。
package sync
