package sync

// 通知中心模板键（前端 locales 按 titleKey 渲染；sync 域常量单一事实源）。
const (
	// SyncLandedTitleKey 落位完成通知（对端侧入账；Action=sync-landed 触发
	// 前端 OPS_FILES_EXTERNAL_CHANGE 分发）
	SyncLandedTitleKey = "sync.landed.title"
	// SyncCronConflictsTitleKey 定时同步冲突待裁决（safe 档；Action=open-sync-center）
	SyncCronConflictsTitleKey = "sync.cronConflicts.title"
	// SyncCronDoneTitleKey 定时同步完成（Action=open-sync-center）
	SyncCronDoneTitleKey = "sync.cronDone.title"
	// CredSyncStagedTitleKey 携密档首次接收暂存待确认（P-20261024-3；
	// Action=open-sync-center——同步中心暂存卡终审）
	CredSyncStagedTitleKey = "sync.credStaged.title"
	// SyncProgressEvent WS 广播消息 type（前端 utils/opsEvents 注册同串）
	SyncProgressEvent = syncProgressEvent
)
