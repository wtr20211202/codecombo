// Package store 结构化数据访问层（roadmap M2.2 策略声明）：
//
// Get()/SetDefault() 是全仓库唯一保留的包级可变全局——定位为「只读仓储聚合」：
// 单一实现、启动期一次装配、此后仅被读取。保留理由：17 个领域仓储的替换成本
// 远超收益，且它不承载行为注入（行为类 setter 已全部消除，见 docs/EXTENSION_POINTS.md）。
//
// 规则（新代码强制）：
//   - 禁止新增包级可变全局；跨包行为注入走构造参数或 kernel.Module.Init 装配；
//   - 新仓储加入 Store 聚合体并经 New() 构造，不另设全局入口；
//   - 未来模块化（Phase D 插件）落地时，仓储访问改经 Kernel.Store() 注入，
//     本包全局入口随之收敛为兼容垫片。
package store

import (
	"sync/atomic"

	"codecombo/server/notification"
)

// Store 聚合所有实体存储，一行注入
type Store struct {
	Project         ProjectStore
	Credential      CredentialStore
	SshKey          SshKeyStore
	Token           TokenStore
	Instance        InstanceStore
	DispatchRecord  DispatchRecordStore
	Template        TemplateStore
	Notification    NotificationStore
	UIState         UIStateStore
	Settings        SettingsStore
	Lock            LockStore
	RemoteHost      RemoteHostStore
	DeployConfig    DeployConfigStore
	DeployTask      DeployTaskStore
	AgentSession    AgentSessionMetaStore
	AgentQueue      AgentSessionQueueStore
	Inbox           InboxStore
	AgentApproval   AgentApprovalStore
	AgentAsk        AgentAskStore
	AgentTask       AgentTaskStore
	AgentCron       AgentCronStore
	AgentChain      AgentChainStore
	CompareExp      CompareExperimentStore
	ExpApply        ExpApplyStore
	Recording       RecordingStore
	TerminalHistory TerminalHistoryStore
	Snippet         SnippetStore
	Runbook         RunbookStore
	Sentinel        SentinelStore
	AgentToken      AgentTokenStore
	Share           ShareStore
	ShareMsg        ShareMessageStore
	PeerCert        PeerCertStore
	SSHHostKey      SSHHostKeyStore
	ClaudeIndex     ClaudeIndexStore
	ClaudeCur       ClaudeSessionCurStore
	ClaudeAssoc     ClaudeSessionAssocStore
	ClaudeSpend     ClaudeSpendAlertStore
	Audit           AuditLogStore
	DiagHist        DiagHistStore
	SelfCheckHist   SelfCheckHistStore
	CronMetric      CronMetricStore
	RemoteGitPath   RemoteGitPathStore
	ProjectNotes    ProjectNotesStore
	MultiNotes      MultiNotesStore
	FileHistory     FileHistoryStore
	DailyReport     DailyReportStore
	ActivityDay     ActivityDayStore
	UISnap          UISnapStore
	ReplaceHist     ReplaceHistStore
	QuickdropToken  QuickdropTokenStore
	Quickdrop       QuickdropStore
	HookToken       HookTokenStore
	FSAttribution   FSAttributionStore
	SyncLedger      SyncLedgerStore
	SyncCron        SyncCronStore
	CredSync        CredSyncStore
}

// New 创建 Store 聚合体——全部基于 DocumentStore。
// notifyOut 为通知出站广播口（可变参，省略即无出站——测试环境）：
// Add 落库后经组合根装配发布到内核事件总线（topic notification.new），
// 由 notify 模块桥回 /ws/notifications——store 不直接依赖 WS hub 运行时
func New(doc DocumentStore, notifyOut ...func(n notification.Notification)) *Store {
	var out func(n notification.Notification)
	if len(notifyOut) > 0 {
		out = notifyOut[0]
	}
	// 分享记录仓与留言附表先建后互指（P-20261006-13：级联删除/轮换迁键/
	// 计数 RMW 的协作对象——repo 间构造期接线，不经全局 Store）
	shareR := newShareRepo(doc)
	msgs := newShareMsgRepo(doc, shareR)
	shareR.msgs = msgs
	return &Store{
		Project:         &projectRepo{doc: doc},
		Credential:      &credentialRepo{doc},
		SshKey:          &sshKeyRepo{doc},
		Token:           &tokenRepo{doc: doc},
		Instance:        &instanceRepo{doc: doc},
		DispatchRecord:  newDispatchRecordRepo(doc),
		Template:        &templateRepo{doc},
		Notification:    &notificationRepo{doc: doc, out: out},
		UIState:         &uiStateRepo{doc: doc},
		Settings:        &settingsRepo{doc: doc},
		Lock:            newLockStore(doc),
		RemoteHost:      &remoteHostRepo{doc},
		DeployConfig:    &deployConfigRepo{doc},
		DeployTask:      &deployTaskRepo{doc},
		AgentSession:    newAgentSessionMetaRepo(doc),
		AgentQueue:      newAgentSessionQueueRepo(doc),
		Inbox:           newInboxRepo(doc),
		AgentApproval:   newAgentApprovalRepo(doc),
		AgentAsk:        newAgentAskRepo(doc),
		AgentTask:       newAgentTaskRepo(doc),
		AgentCron:       newAgentCronRepo(doc),
		AgentChain:      newAgentChainRepo(doc),
		CompareExp:      newCompareExpRepo(doc),
		ExpApply:        newExpApplyRepo(doc),
		Recording:       newRecordingRepo(doc),
		TerminalHistory: newTerminalHistoryRepo(doc),
		Snippet:         newSnippetRepo(doc),
		Runbook:         newRunbookRepo(doc),
		Sentinel:        newSentinelRepo(doc),
		AgentToken:      &agentTokenRepo{doc: doc},
		Share:           shareR,
		ShareMsg:        msgs,
		PeerCert:        newPeerCertRepo(doc),
		SSHHostKey:      newSSHHostKeyRepo(doc),
		ClaudeIndex:     newClaudeIndexRepo(doc),
		ClaudeCur:       newClaudeCurRepo(doc),
		ClaudeAssoc:     newClaudeAssocRepo(doc),
		ClaudeSpend:     newClaudeSpendAlertRepo(doc),
		Audit:           NewAuditLogRepo(doc),
		DiagHist:        NewDiagHistRepo(doc),
		SelfCheckHist:   NewSelfCheckHistRepo(doc),
		CronMetric:      NewCronMetricRepo(doc),
		RemoteGitPath:   NewRemoteGitPathRepo(doc),
		ProjectNotes:    NewProjectNotesRepo(doc),
		MultiNotes:      NewMultiNotesRepo(doc),
		FileHistory:     NewFileHistoryRepo(doc),
		DailyReport:     NewDailyReportRepo(doc),
		ActivityDay:     NewActivityDayRepo(doc),
		UISnap:          newUISnapRepo(doc),
		ReplaceHist:     NewReplaceHistRepo(doc),
		QuickdropToken:  &quickdropTokenRepo{doc: doc},
		Quickdrop:       newQuickdropRepo(doc),
		HookToken:       &hookTokenRepo{doc: doc},
		FSAttribution:   newFSAttributionRepo(doc),
		SyncLedger:      NewSyncLedgerRepo(doc),
		SyncCron:        NewSyncCronRepo(doc),
		CredSync:        NewCredSyncRepo(doc),
	}
}

// ── 全局单例 ──

// defaultStore 原子指针而非裸全局：SetDefault 除启动期装配外还会在测试清理
// 中换入换出（如 server/api/router_lock_ws_test.go 的 SetDefault(nil)），而
// 服务期 goroutine（WS handler、模块后台循环）随时可能并发 Get()——裸全局
// 的读写对是数据竞争（-race 实测：测试清理写 vs HandleNotificationWS 读）。
// 原子 Load/Store 消除整类竞争，签名与语义不变（启动期单写 + 运行期多读）
var defaultStore atomic.Pointer[Store]

// SetDefault 设置全局 Store（main.go 启动时调用；测试清理可换入 nil）
func SetDefault(s *Store) { defaultStore.Store(s) }

// Get 获取全局 Store
func Get() *Store { return defaultStore.Load() }

// NewForTesting 构造独立的 LockStore 实例（用于测试，避免污染全局 Store）
func NewForTesting(doc DocumentStore) LockStore {
	return newLockStore(doc)
}
