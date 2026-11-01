package system

import (
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/claims"
	"codecombo/server/config"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 实例族总览（P-20261003-56）：同机多实例 fleet 一览。本产品真实形态就是
// 同机多实例，此前看「哪些实例活着、各开着什么项目」要逐端口开页面；claim
// 文件（P-20261003-3，项目 .git 内 项目→port+instanceId）落地后有现成发现
// 面，这里补聚合视图：
//   - GET  /api/instances/fleet                聚合族表（port/instanceId/项目清单/存活态）
//   - DELETE /api/instances/fleet/:instanceId  清理死实例残留 claim（与既有 staleness 惰性清理联动）
//
// 数据边界：只读 claim 元数据（instanceId/port/时间戳）+ 对端探活打
// /api/settings（实例 check 同款元数据面），不越权访问他实例内容。
// 探活复用 checkInstanceURL（online/invalid/offline 三态 + scheme 自动发现，
// 与实例管理面板同一套判定，避免两套口径漂移）；TLS 默认形态下 claim 只有
// port 没有 scheme，从 http://127.0.0.1 起探、对侧真身是 https 时 flip 自愈。

// fleetProjectRef 族表行内项目摘要（id 供跳转、name 供展示）
type fleetProjectRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// fleetInstance 实例族一行
type fleetInstance struct {
	InstanceID string `json:"instanceId"`
	Port       int    `json:"port"`
	Self       bool   `json:"self"`
	// Status self（本实例，恒活）/ online / invalid（端口被他用，原实例已不在）/ offline
	Status    string            `json:"status"`
	Version   string            `json:"version,omitempty"`
	Projects  []fleetProjectRef `json:"projects"`
	StartedAt string            `json:"startedAt,omitempty"`
	UpdatedAt string            `json:"updatedAt,omitempty"`
	// Stale 全部 claim 超过 StaleAfter 未续期 = 崩溃残留（SIGKILL/断电走不到退出清理）
	Stale bool `json:"stale"`
}

// fleetClaimAggregate 按实例聚合的 claim 快照（族表与清理共用同一扫描）
type fleetClaimAggregate struct {
	port        int
	startedAt   time.Time
	updatedAt   time.Time
	hasClaim    bool
	gitDirs     []string // 该实例 claim 所在 gitDir（清理按此定位；共锚点已由扫描侧 gitDirSeen 去重）
	projectRefs []fleetProjectRef
}

// InstanceFleet GET /api/instances/fleet——扫描全部已知项目的 claim 目录
// （只读快照：残留要显死态给用户手动清，不能像 ScanGitDir 那样读取顺手删），
// 按 instanceId 聚合后逐非本实例探活。
func InstanceFleet(c *gin.Context) {
	s := store.Get()
	if s == nil {
		shared.Error(c, http.StatusInternalServerError, "store not ready", nil)
		return
	}
	projects, err := s.Project.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "fleet aggregation failed", err)
		return
	}
	selfID, err := claims.InstanceID(config.DataDir())
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "fleet aggregation failed", err)
		return
	}

	aggs := scanFleetClaims(projects)
	now := time.Now()

	// 本实例行：端口取设置面主端口（与 claims 模块装配同源），claim 里自己的
	// 项目清单照排——族表回答「哪些实例活着」，本机恒活排最前
	self := fleetInstance{
		InstanceID: selfID,
		Port:       selfPort(),
		Self:       true,
		Status:     "self",
	}
	if a, ok := aggs[selfID]; ok {
		self.Projects = a.projectRefs
		self.StartedAt = rfctime(a.startedAt)
		self.UpdatedAt = rfctime(a.updatedAt)
		delete(aggs, selfID)
	}

	rows := make([]fleetInstance, 0, len(aggs)+1)
	rows = append(rows, self)
	for id, a := range aggs {
		rows = append(rows, fleetInstance{
			InstanceID: id,
			Port:       a.port,
			Status:     "offline", // 探活失败时的兜底值，下方并发探测覆写
			Projects:   a.projectRefs,
			StartedAt:  rfctime(a.startedAt),
			UpdatedAt:  rfctime(a.updatedAt),
			Stale:      now.Sub(a.updatedAt) > claims.StaleAfter,
		})
	}

	// 逐非本实例探活（并发上限与 CheckAllInstances 对齐；族表规模 = 同机
	// 开过的实例数，个位数量级，5s 超时兜底最坏等待）
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i := range rows {
		if rows[i].Self {
			continue
		}
		wg.Add(1)
		go func(row *fleetInstance) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			res := checkInstanceURL(fleetProbeURL(row.Port), "")
			row.Status = res.status
			row.Version = res.version
		}(&rows[i])
	}
	wg.Wait()

	// self 恒排最前，其余按端口稳定序
	sort.Slice(rows[1:], func(i, j int) bool { return rows[i+1].Port < rows[j+1].Port })

	c.JSON(http.StatusOK, gin.H{"data": rows})
}

// CleanFleetResidual DELETE /api/instances/fleet/:instanceId——清理死实例
// 残留 claim。与既有清理的联动：staleness 惰性回收要等 3 分钟且由下次扫描
// 触发，此口给「立即清」；删除前重探活防竞态（族表快照是旧的，实例可能刚
// 被拉起——instanceId 是数据目录级持久身份，重启不换号）
func CleanFleetResidual(c *gin.Context) {
	id := c.Param("instanceId")
	s := store.Get()
	if s == nil {
		shared.Error(c, http.StatusInternalServerError, "store not ready", nil)
		return
	}
	selfID, err := claims.InstanceID(config.DataDir())
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "fleet cleanup failed", err)
		return
	}
	if id == "" || id == selfID {
		shared.Error(c, http.StatusBadRequest, "cannot clean own claims", nil)
		return
	}

	projects, err := s.Project.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "fleet cleanup failed", err)
		return
	}

	a := scanFleetClaims(projects)[id]
	if a == nil || len(a.gitDirs) == 0 {
		shared.Error(c, http.StatusNotFound, "no residual claims for instance", nil)
		return
	}

	// 判活拒清：可达且仍在心跳窗内说明实例活着（或刚重启）——删了也会被
	// 30s 心跳重写，徒增竞态；端口未知（claim 损坏兜底）或已超 stale 窗直清
	now := time.Now()
	if a.port > 0 && now.Sub(a.updatedAt) <= claims.StaleAfter {
		if res := checkInstanceURL(fleetProbeURL(a.port), ""); res.status == "online" {
			shared.Error(c, http.StatusConflict, "instance is alive, refuse to clean claims", nil)
			return
		}
	}

	for _, gitDir := range a.gitDirs {
		if err := claims.RemoveClaim(gitDir, id); err != nil {
			shared.Error(c, http.StatusInternalServerError, "fleet cleanup failed", err)
			return
		}
	}
	slog.Info("fleet residual claims cleaned", "instance", id, "removed", len(a.gitDirs))
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"removed": len(a.gitDirs)}})
}

// scanFleetClaims 只读聚合：逐项目解析 gitdir 并按 instanceId 归并 claim。
// linked worktree 与主仓共锚点时同一 gitDir 只记一次（gitDirs 去重），项目
// 占用按项目条目照记（同 gitDir 的两个注册项目各自算一行占用，与项目列表一致）
func scanFleetClaims(projects []config.ProjectConfig) map[string]*fleetClaimAggregate {
	aggs := map[string]*fleetClaimAggregate{}
	gitDirSeen := map[string]bool{}
	for _, p := range projects {
		gitDir := claims.ResolveGitDir(p.Path)
		if gitDir == "" || gitDirSeen[gitDir] {
			continue
		}
		gitDirSeen[gitDir] = true
		list, err := claims.ListClaims(gitDir)
		if err != nil {
			continue
		}
		for _, cl := range list {
			a := aggs[cl.InstanceID]
			if a == nil {
				a = &fleetClaimAggregate{}
				aggs[cl.InstanceID] = a
			}
			a.gitDirs = append(a.gitDirs, gitDir)
			a.projectRefs = append(a.projectRefs, fleetProjectRef{ID: p.ID, Name: p.Name})
			if !a.hasClaim || cl.UpdatedAt.After(a.updatedAt) {
				a.port = cl.Port
				a.updatedAt = cl.UpdatedAt
			}
			if !a.hasClaim || cl.StartedAt.Before(a.startedAt) {
				a.startedAt = cl.StartedAt
			}
			a.hasClaim = true
		}
	}
	return aggs
}

// fleetProbeURL claim 只有 port：同机前提（claim 文件物理在本机项目 .git 内），
// 探活目标恒为回环；127.0.0.1 而非 localhost——后者可能解析到 ::1 而服务只听
// IPv4。scheme 从 http 起步，TLS 真身由 checkInstanceURL 的 flip 自愈
func fleetProbeURL(port int) string {
	return "http://127.0.0.1:" + strconv.Itoa(port)
}

// selfPort 本实例主端口：与 update.go 同源（settings 面 Server.Port，缺省 9999）
func selfPort() int {
	port := store.Get().Settings.Get().Server.Port
	if port == 0 {
		port = 9999
	}
	return port
}

// rfctime 时间出 API 的统一序列化形（RFC3339，与实例配置 UpdatedAt 同款）
func rfctime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}
