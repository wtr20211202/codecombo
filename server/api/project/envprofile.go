package project

import (
	"log/slog"
	"net/http"
	"sort"
	"time"

	"codecombo/server/agentops"
	"codecombo/server/api/shared"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 项目环境画像（P-20261007-14）：GET /api/projects/:id/env-profile——「这个项目
// 跑起来需要什么」的只读聚合面。环境观测数据全程流经工作台（dev 端口经终端
// 探测/agent 上报进 portregistry 注册表 P-20261003-293；输出哨兵规则在 sentinel
// 存储 P-20261004-8；部署目标 = RemoteHost 主机表，TriggerDeploy 的 hostId 即此
// id），本端点把三源按项目收敛为一张「环境简历」，新人会话/换设备接手免翻
// 终端历史猜端口。纯聚合只读端点：无 schema 变更、无落盘、无硬锁（读面）。
//
// 三源边界（诚实呈现）：
//   - devPorts：登记面 = 探测/上报面（portregistry 同边界）——未被探测正则覆盖
//     或 agent 未上报的监听不在列；会话归属经 GetSession 现查，条目随会话关闭
//     摘除（窄竞态下反查不中的条目跳过，不出幽灵行）；lastSeen 标注观测时效
//     （端口已死仍列供参考——画像=历史观测聚合非实时拓扑）
//   - sentinels：该项目可见的输出哨兵规则（scope=global 或 =projectId，与
//     terminal 侧 appliesTo 同一口径防两套判定漂移）；命中时刻是会话级防抖
//     内部态不出端点，这里只列规则与级别（「状态」= level）
//   - deployTargets：部署目标主机摘要——主机名出、地址不出（fleet「只出摘要」
//     同纪律：agent 可读面不回显 Host/凭据，目标以名称指代，明细走主机管理面）
//
// 源级降级：sentinel/remotehost 读失败该键整体缺席（morning-brief 同纪律——
// 诚实降级优于半截数据）；devports 源在内存恒可用。响应挂 no-store（快照随
// 观测实时变，陈旧缓存误导「服务还在跑」判断）。

// envProfileDevPort 画像端口行：注册表条目 + 读取时反查的会话名（会话名不落
// 条目，改名即时生效——ports.go 同款直读惯例）
type envProfileDevPort struct {
	Port        int    `json:"port"`
	Label       string `json:"label"`
	Source      string `json:"source"`
	FirstSeen   string `json:"firstSeen"`
	LastSeen    string `json:"lastSeen"`
	SessionID   string `json:"sessionId,omitempty"`
	SessionName string `json:"sessionName,omitempty"`
}

// envProfileSentinel 画像哨兵行：规则元数据（pattern 不出——画像是人看的
// 简历，正则明细走哨兵管理面/GET /api/sentinels）
type envProfileSentinel struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Level string `json:"level"`
	Scope string `json:"scope"`
}

// envProfileDeployTarget 画像部署目标行：只出摘要（名称/协议/认证形态）——
// Host/Port/凭据/指纹字段刻意缺席，agent 可读面不回显地址（fleet 摘要纪律）
type envProfileDeployTarget struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Protocol string `json:"protocol"`
	AuthType string `json:"authType"`
}

// GetEnvProfile GET /api/projects/:id/env-profile
func GetEnvProfile(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	// devports 源（内存注册表，恒可用）：会话归属反查圈定本项目条目
	ports := devPortRows(terminal.DefaultManager.ListDevPorts(), terminal.DefaultManager.GetSession, p.ID)

	profile := gin.H{
		"projectId": p.ID,
		"devPorts":  ports, // 内存源恒可用：空表也是诚实值（无观测）
	}

	// sentinel 源：scope 圈定（""/global/本项目），创建序展示（List 已按
	// CreatedAt 升序）；读失败整键缺席（源级降级，不用空数组冒充「无规则」）
	if rules, err := store.Get().Sentinel.List(); err != nil {
		slog.Warn("env-profile sentinel source degraded", "projectId", p.ID, "err", err)
	} else {
		sentinels := make([]envProfileSentinel, 0, len(rules))
		for _, ru := range rules {
			if !sentinelAppliesToProject(ru.Scope, p.ID) {
				continue
			}
			sentinels = append(sentinels, envProfileSentinel{ID: ru.ID, Name: ru.Name, Level: ru.Level, Scope: ru.Scope})
		}
		profile["sentinels"] = sentinels
	}

	// deploy 目标源：全局主机表按名称稳定序（部署目标不随项目走——主机是
	// 实例级资源，画像列出「可部署到哪」）；读失败整键缺席同上
	if hosts, err := store.Get().RemoteHost.List(); err != nil {
		slog.Warn("env-profile remote host source degraded", "projectId", p.ID, "err", err)
	} else {
		sort.Slice(hosts, func(i, j int) bool {
			if hosts[i].Name != hosts[j].Name {
				return hosts[i].Name < hosts[j].Name
			}
			return hosts[i].ID < hosts[j].ID
		})
		targets := make([]envProfileDeployTarget, 0, len(hosts))
		for _, h := range hosts {
			targets = append(targets, envProfileDeployTarget{ID: h.ID, Name: h.Name, Protocol: h.Protocol, AuthType: h.AuthType})
		}
		profile["deployTargets"] = targets
	}

	c.JSON(http.StatusOK, gin.H{"data": profile})
}

// sentinelAppliesToProject 画像侧哨兵可见性判定：与 terminal 包 appliesTo
// 同一口径（空 scope 视作 global——存量规则升级兼容），画像不过滤、判定
// 不出两套（改口径两处同改，注释互指）
func sentinelAppliesToProject(scope, projectID string) bool {
	return scope == "" || scope == store.SentinelScopeGlobal || scope == projectID
}

// devPortRows devports 源的纯聚合：登记条目 × 会话反查 → 本项目画像行。
// lookup 抽成参数既是归属判定的测试缝（DefaultManager 会话表未导出，外部包
// 无法构造带会话的裸 Manager——免起真实 PTY），也让「反查不中跳过」的竞态
// 兜底可单测。entries 已按端口升序（ListDevPorts 承诺），输出序随入参稳定
func devPortRows(entries []terminal.PortEntry, lookup func(string) *terminal.Session, projectID string) []envProfileDevPort {
	rows := make([]envProfileDevPort, 0)
	for _, e := range entries {
		s := lookup(e.SessionID)
		if s == nil || s.ProjectID != projectID {
			continue // 他项目/无主会话的占用不进本画像；幽灵反查不中跳过
		}
		rows = append(rows, envProfileDevPort{
			Port:        e.Port,
			Label:       e.Label,
			Source:      e.Source,
			FirstSeen:   envRfcTime(e.FirstSeen),
			LastSeen:    envRfcTime(e.LastSeen),
			SessionID:   e.SessionID,
			SessionName: s.Name,
		})
	}
	return rows
}

// envRfcTime 时间出 API 的统一序列化形（RFC3339；system/fleet.go rfctime 同款，
// 跨包不复用避免 api 子包互依——值语义一致，漂移由对齐注释锁定）
func envRfcTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}

func init() {
	// 智能体手册登记：环境画像是 agent 起服务前的环境认知原语（选自由端口/
	// 看哨兵在盯什么/能部署到哪一页拿全），与 selfcheck（本机体检）互补成对
	agentops.RegisterSection(agentops.Section{
		ID: "env-profile", Title: "环境画像（项目环境简历）", Order: 79,
		Summary: "项目环境只读聚合：dev 端口观测 + 可见哨兵规则 + 部署目标摘要",
		Body: ` - GET /api/projects/:id/env-profile   项目环境画像（只读，no-store）

响应 data 段三源聚合（源级降级：读失败的键整体缺席，不以空数组冒充「无」）：

- devPorts:   该项目会话登记的 dev 端口 [{port,label,source,firstSeen,lastSeen,
              sessionId,sessionName}]。source: detected=终端输出探测 /
              reported=agent 上报（preview.port 同词表）；lastSeen 是最近一次
              观测刷新时刻——画像=历史观测聚合非实时拓扑，端口可能已死，
              起 dev server 前仍建议先查（条目随会话关闭摘除）
- sentinels:  该项目可见的输出哨兵规则 [{id,name,level,scope}]（scope=global
              或本项目；命中时效是会话级防抖内部态不出端点，正则明细走
              GET /api/sentinels）
- deployTargets: 部署目标主机摘要 [{id,name,protocol,authType}]——主机名出、
              地址/凭据不出（部署动作 POST /api/deploy 携 hostId 即此 id）

会话启动上下文联动（P-20261006-47 settings 键 sessionContext 的增量 token）：
PUT /api/settings {"sessionContext":"git,env"} 后，新建 agent 会话自动附带本画像
概要行（端口/哨兵数/部署目标名 ≤220 字节；源级降级键跳过、端口 label 截断），
agent 无需先 curl 也知道本项目在跑什么；明细仍以本端点为权威。

## 推荐用法（示例）

新会话接手项目，先取环境简历再动手（选端口/避冲突/知部署去向）：
` + "```bash" + `
curl {{BASE}}/api/projects/<projectId>/env-profile -H "X-Lock-Token: $CC_LOCK_TOKEN"
` + "```" + `
起 dev server 前用 devPorts 里已占端口以外的自由端口；探测/上报未被覆盖的
监听不在列（登记面=探测/上报面），preview.port 上报约定见 ops-notify 节。`,
	})
}
