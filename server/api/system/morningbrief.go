package system

import (
	"net/http"
	"sort"
	"sync"
	"time"

	"codecombo/server/agentops"
	"codecombo/server/git"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// MorningBrief GET /api/morning-brief —— 开工检查单聚合（P-20261005-219）。
//
// 动机：跨天重度使用的连续性断点（昨天忘 push / agent 会话挂着没看结论 /
// 未读审批积压）散在三四个面板，今早开工要逐个翻。本端点把既有信号聚合为
// 一张只读晨报：N 个未推送提交（ahead 计数，/api/ahead-behind 同源）/
// M 个运行中 agent 会话（/api/terminals/running-count 同源）/ K 条未读通知
// 与待审批（通知与审批存储同源）——前端首页横幅卡与 agent 晨间巡检读同一份
// brief（人机同源，HelpCenter「界面答案即智能体答案」同哲学）。
//
// 降级纪律：各源独立采集，单源失败 = 该条目整体缺席（响应不带该键），不拖垮
// 整卡——DiagSnapshot 零值隐藏同纪律；调用方按「键存在且 count>0」才提醒。
// 三源并行取数，整卡耗时 = 最慢源（ahead 是唯一起 git 子进程的源，走
// GetHeadTrackingCached 短 TTL 缓存——首页 ahead/behind 徽章已预热，常规
// 路径零额外子进程；冻结项目跳过探测，与 /api/ahead-behind 同口径）。
// 只读无副作用零落盘，无 AgentGuard 高危面（与 /api/selfcheck 同族）。

// MorningUnpushedProject 未推送清单条目：直达到项目（前端进项目开提交面板 +
// 一键 push 复用既有推送链）
type MorningUnpushedProject struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Ahead int    `json:"ahead"`
}

// MorningUnpushed 未推送源：count = 各项目 ahead 之和，projects 只含 ahead>0 者
type MorningUnpushed struct {
	Count    int                      `json:"count"`
	Projects []MorningUnpushedProject `json:"projects"`
}

// MorningBriefItem 单计数源（运行中 agent 会话）
type MorningBriefItem struct {
	Count int `json:"count"`
}

// MorningUnread 未读源：notifications 未读未延后通知 + approvals 待裁决审批
// （挂起主卡口径——MergedInto 非空的并入条目不重复计，与审批列表过滤一致）
type MorningUnread struct {
	Count         int `json:"count"`
	Notifications int `json:"notifications"`
	Approvals     int `json:"approvals"`
}

// MorningBrief 晨报聚合体。三源指针：源失败 = nil = 前端该项隐藏；零值计数
// 是诚实值（全零 = 前端整卡不渲染）
type MorningBrief struct {
	// Date 服务端本地当日 yyyy-MM-dd：人机对「今天」的同一锚（agent/脚本
	// 消费按此判定当日；前端横幅卡的当日已阅键用客户端本地日期，见
	// web/src/utils/morningBrief.ts 头注）
	Date string `json:"date"`

	Unpushed      *MorningUnpushed  `json:"unpushed,omitempty"`
	RunningAgents *MorningBriefItem `json:"runningAgents,omitempty"`
	Unread        *MorningUnread    `json:"unread,omitempty"`
}

// GetMorningBrief 晨报端点（只读聚合，无 AgentGuard 高危面——与 /api/selfcheck 同族）
func GetMorningBrief(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"data": MorningBriefReport()})
}

// morningBriefDate 当日语义单一事实源（单测钉格式）
func morningBriefDate(now time.Time) string {
	return now.Format("2006-01-02")
}

// MorningBriefReport 聚合三源（导出供单测）。并行采集 + 各源自兜：
// 单源 panic/失败不外溢（recover 收敛为源缺席——聚合面绝不因旁路源 500）
func MorningBriefReport() MorningBrief {
	brief := MorningBrief{Date: morningBriefDate(time.Now())}
	var wg sync.WaitGroup
	var mu sync.Mutex

	// set 槽位写入助手：各源独立 goroutine，互不阻塞
	set := func(fn func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				// 源级 recover：聚合端点的可用性 > 单源完整性（缺席优于 500）
				_ = recover()
			}()
			fn()
		}()
	}

	set(func() {
		unpushed := collectUnpushed()
		mu.Lock()
		brief.Unpushed = unpushed
		mu.Unlock()
	})
	set(func() {
		count, _, _ := terminal.DefaultManager.RunningCount(terminal.KindAgent)
		mu.Lock()
		brief.RunningAgents = &MorningBriefItem{Count: count}
		mu.Unlock()
	})
	set(func() {
		unread := collectUnread()
		mu.Lock()
		brief.Unread = unread
		mu.Unlock()
	})
	wg.Wait()
	return brief
}

// collectUnpushed 未推送源：全项目 ahead 计数（冻结跳过，与 /api/ahead-behind
// 同口径；项目列表读失败 = 源缺席）。探测走 GetHeadTrackingCached 短 TTL——
// 首页徽章链已预热时零子进程；冷缓存场景（agent 晨间巡检直调）按
// ListAllAheadBehind 同款有界并发池扇出，N 仓库不串行长尾
func collectUnpushed() *MorningUnpushed {
	projectConfigs, err := store.Get().Project.List()
	if err != nil {
		return nil
	}
	projects := make([]MorningUnpushedProject, 0, len(projectConfigs))
	var mu sync.Mutex
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for _, p := range projectConfigs {
		if p.Frozen {
			continue
		}
		wg.Add(1)
		go func(id, name, path string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			// 单仓库一次 for-each-ref（缓存命中零子进程）；探 0 = 诚实值
			//（非 git 目录等），不进清单
			_, ahead, _ := git.GetHeadTrackingCached(path)
			if ahead <= 0 {
				return
			}
			mu.Lock()
			projects = append(projects, MorningUnpushedProject{ID: id, Name: name, Ahead: ahead})
			mu.Unlock()
		}(p.ID, p.Name, p.Path)
	}
	wg.Wait()
	// ahead 降序（最欠推送的在前）、同名按 id 稳定序——前端逐项渲染顺序确定
	sort.Slice(projects, func(i, j int) bool {
		if projects[i].Ahead != projects[j].Ahead {
			return projects[i].Ahead > projects[j].Ahead
		}
		return projects[i].ID < projects[j].ID
	})
	count := 0
	for _, p := range projects {
		count += p.Ahead
	}
	return &MorningUnpushed{Count: count, Projects: projects}
}

// collectUnread 未读源：通知（未读且未延后——与前端徽标口径一致，延后中条目
// 到点重挂才回未读）+ 待裁决审批（挂起主卡，MergedInto 并入条目不重复计）。
// 两存储读失败任一即整条目缺席（细分计数与总数必须同源一致，半截数据会误导）
func collectUnread() *MorningUnread {
	items := store.Get().Notification.List(0)
	notifications := 0
	for _, n := range items {
		if !n.Read && n.SnoozeUntil == nil {
			notifications++
		}
	}
	pending, err := store.Get().AgentApproval.List(store.ApprovalPending, 0)
	if err != nil {
		return nil
	}
	approvals := 0
	for _, a := range pending {
		if a.MergedInto == "" {
			approvals++
		}
	}
	return &MorningUnread{Count: notifications + approvals, Notifications: notifications, Approvals: approvals}
}

func init() {
	// 智能体手册登记：晨间巡检第一步（开工检查单人机同源——人看首页横幅卡，
	// agent 读同一 brief 做自动化处置建议）；Order 8 排在 error-codes 之后、
	// projects 之前（工作流入口前置，agentops 手册按 Order 升序输出）
	agentops.RegisterSection(agentops.Section{
		ID: "morning-brief", Title: "开工检查单（晨间巡检第一步）", Order: 8,
		Summary: "GET /api/morning-brief 一张只读晨报聚合跨天连续性信号（未推送提交/运行中 agent 会话/未读通知与待审批）——人看首页横幅卡，agent 读同一份做巡检处置建议",
		Body: `跨天开工（或值班交接）先读本端点，再逐项处置——与人看到的首页「开工检查单」
横幅卡同一数据源（人机同源）。

- GET /api/morning-brief                     开工检查单聚合（只读无副作用）
  返回 {"data":{date,unpushed?,runningAgents?,unread?}}：
  - date           服务端本地当日 yyyy-MM-dd（「今天」的对账锚）
  - unpushed       缺席 = 源不可用；count=各项目 ahead 之和，projects 逐项
                   {id,name,ahead}（ahead 降序）——处置：提醒用户 push 或走
                   POST /api/projects/:id/push（先看 approval 规则是否拦截）
  - runningAgents  缺席 = 源不可用；count=运行中 agent 会话数（运行态清单走
                   GET /api/terminals/running-count?kind=agent）
  - unread         缺席 = 源不可用；notifications=未读未延后通知数、
                   approvals=待裁决审批数（挂起主卡口径）——待审批清单走
                   GET /api/ops-confirm?status=pending

## 处置纪律

- 任一源失败该键整体缺席：按「键存在」分支，缺席不猜测（诚实降级，不自拼 0）
- 全零（三键齐全且计数全 0）= 干净开工，无需任何动作
- 未推送项处置前先核对远端状态（behind 同看 /api/ahead-behind），
  diverged 时不要建议 force——走冲突解决流程`,
	})
}
