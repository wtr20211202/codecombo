package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// /api/sync/* 端点族（方案②）。对端面（units/manifest）由对端实例令牌经
// 既有 TokenAuth 放行；编排面（plan/pull/push/crons）由前端解锁令牌或 agent
// 令牌调用（push 入 AgentGuard 高危表——批量写对端文件系统）。

var (
	// execMu 执行互斥：同刻只允许一个同步任务（手动/定时/多标签页撞车时
	// 后到者 409，进度事实单一）
	execMu sync.Mutex
	// execRunning 运行中标记（executeSync 在后台 goroutine 跑，请求即返）
	execRunning bool
)

// GetManifest GET /api/sync/manifest —— 本端单元清单+指纹（对端 plan/对账的数据面）。
// credentials=1 显式追加凭据档单元条目（P-20261024-3：仅同步中心展示面用——
// 默认面恒不含该单元，plan/定时同步由此构造性排除携密）
func GetManifest(c *gin.Context) {
	includeIgnored := c.Query("includeIgnored") == "1"
	m := buildLocalManifest()
	if includeIgnored {
		// 指纹口径随请求档变化（includeIgnored 改变文件集）：此处重算项目本体
		recomputeProjectFingerprints(&m, true)
	}
	if c.Query("credentials") == "1" {
		if e, ok := manifestCredEntry(); ok {
			m.Units = append(m.Units, e)
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": m})
}

// recomputeProjectFingerprints 按传输档重算项目本体指纹（manifest 默认工作区
// 档；拉取方以 includeIgnored 档对账时对端 manifest 需同档口径）
func recomputeProjectFingerprints(m *ManifestResponse, includeIgnored bool) {
	for i := range m.Units {
		if m.Units[i].Kind != UnitProject || m.Units[i].Path == "" {
			continue
		}
		scan, err := enumerateUnitDir(m.Units[i].Path, false, includeIgnored)
		if err != nil {
			continue
		}
		m.Units[i].Fingerprint = fingerprintFiles(scan.files)
		m.Units[i].Size = sumSizes(scan.files)
		m.Units[i].Files = len(scan.files)
		m.Units[i].Excluded = scan.excluded
	}
}

// PostPlan POST /api/sync/plan —— 四态判定预览
func PostPlan(c *gin.Context) {
	var req struct {
		InstanceID  string   `json:"instanceId" binding:"required"`
		ProjectKeys []string `json:"projectKeys,omitempty"`
		Contexts    []string `json:"contexts,omitempty"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request body", nil)
		return
	}
	inst, ok := findInstance(req.InstanceID)
	if !ok {
		shared.Error(c, http.StatusNotFound, "instance not found", nil)
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), peerJSONTimeout)
	defer cancel()
	plan, err := BuildPlan(ctx, inst, req.ProjectKeys, req.Contexts)
	if err != nil {
		shared.Error(c, http.StatusBadGateway, err.Error(), nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": plan})
}

// PostPull POST /api/sync/pull —— 从对端拉取勾选单元落地本端
func PostPull(c *gin.Context) {
	var req ExecuteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request body", nil)
		return
	}
	if len(req.InstanceIDs) == 0 {
		shared.Error(c, http.StatusBadRequest, "instanceIds required", nil)
		return
	}
	req.InstanceIDs = req.InstanceIDs[:1] // pull 单对端语义
	startExecute(c, req, "pull")
}

// PostPush POST /api/sync/push —— 推送本端单元到目标集（多目标并行 2 默认）。
// AgentGuard 高危表登记面（批量写对端文件系统）
func PostPush(c *gin.Context) {
	var req ExecuteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request body", nil)
		return
	}
	startExecute(c, req, "push")
}

// startExecute 执行互斥 + 后台启动 + 即返（进度走广播/轮询）。审计在执行侧
// 完成时入账（后台 goroutine 无请求上下文，走系统审计口）
func startExecute(c *gin.Context, req ExecuteRequest, direction string) {
	execMu.Lock()
	if execRunning {
		execMu.Unlock()
		shared.Error(c, http.StatusConflict, "another sync is running", nil)
		return
	}
	execRunning = true
	execMu.Unlock()
	go func() {
		defer func() {
			execMu.Lock()
			execRunning = false
			execMu.Unlock()
		}()
		res, err := executeSync(req, direction, "manual")
		if err != nil {
			// 参数级失败（jobId 都没建）：广播一条终态失败任务让面板可见。
			// rt/env 必填——beginJob→snapshot 走 rt.mu，缺了即空指针（SyncJob
			// 不变式，见 progress.go rt 字段注记）
			job := &SyncJob{ID: nextJobID(), Direction: direction, Source: "manual",
				StartedAt: time.Now(), Outcome: "failed",
				rt: &jobRuntime{}, env: &envCollector{}}
			beginJob(job)
			finishJob(job, "failed")
			auditSyncSystem(direction, store.AuditResultFailure, err.Error())
			return
		}
		auditSyncSystem(direction, store.AuditResultSuccess, res.summaryLine())
	}()
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"started": true, "direction": direction}})
}

// auditSyncSystem 系统侧审计（后台执行无 gin 上下文，走裸 Append 口——
// auditappend.go 双口纪律：Rid 留零值；Detail 只记单元数/字节/失败计数元数据，
// 路径脱敏——单元键非本机绝对路径）
func auditSyncSystem(direction, result, detail string) {
	action := store.AuditSyncPush
	if direction == "pull" {
		action = store.AuditSyncPull
	}
	if s := store.Get(); s != nil {
		s.Audit.Append(store.AuditEvent{Action: action, Result: result, Detail: detail})
	}
}

// PostDeliver POST /api/sync/deliver —— 非项目目录/文件轻投递（方案④）：
// 项目子树 zip → 对端显式 dest 纯落位（不注册项目）
func PostDeliver(c *gin.Context) {
	var req struct {
		InstanceID string `json:"instanceId" binding:"required"`
		ProjectID  string `json:"projectId" binding:"required"`
		// RelPath 项目内相对路径（目录或单文件）
		RelPath string `json:"relPath"`
		// Dest 对端目标相对路径（对端 syncDestRoot 内白名单校验）
		Dest string `json:"dest" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request body", nil)
		return
	}
	inst, ok := findInstance(req.InstanceID)
	if !ok {
		shared.Error(c, http.StatusNotFound, "instance not found", nil)
		return
	}
	p := findProjectByID(req.ProjectID)
	if p == nil {
		shared.Error(c, http.StatusNotFound, "project not found", nil)
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Minute)
	defer cancel()
	lr, err := deliverToPeer(ctx, inst, p, req.RelPath, req.Dest)
	if err != nil {
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditSyncPush, Result: store.AuditResultFailure,
			IP:     c.ClientIP(),
			Detail: fmt.Sprintf("deliver=%s peer=%s err=%s", sanitizeRelForAudit(req.RelPath), inst.Name, err.Error()),
		})
		shared.Error(c, http.StatusBadGateway, err.Error(), nil)
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditSyncPush, Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("deliver=%s peer=%s destRoot=%s", sanitizeRelForAudit(req.RelPath), inst.Name, lr.DestRoot),
	})
	c.JSON(http.StatusOK, gin.H{"data": lr})
}

// GetUnitsZip GET /api/sync/units?keys=&includeIgnored=&includeGit= —— 对端面：
// 打包指定单元 zip 流式响应（io.Pipe 零中转，方案②）。
// keys=credentials&cred=1 是携密专用分支（P-20261024-3）：E2E 信封 JSON 响应
// （恒密文出域），凭据档永不进 zip 打包面
func GetUnitsZip(c *gin.Context) {
	keysParam := c.Query("keys")
	if strings.TrimSpace(keysParam) == "" {
		shared.Error(c, http.StatusBadRequest, "keys required", nil)
		return
	}
	keys := strings.Split(keysParam, ",")
	for _, k := range keys {
		if k == UnitCredentials {
			if c.Query("cred") != "1" {
				shared.Error(c, http.StatusForbidden, "credentials unit requires cred=1", nil)
				return
			}
			if len(keys) > 1 {
				// 混键请求拒绝而非静默只服务凭据档（发起端 pullCredUnit 恒单键——
				// 异常形态宁可显式失败不丢单元）
				shared.Error(c, http.StatusBadRequest, "credentials unit cannot be mixed with other keys", nil)
				return
			}
			serveCredVault(c, c.GetHeader(credPairFpHeader))
			return
		}
	}
	includeIgnored := c.Query("includeIgnored") == "1"
	includeGit := c.Query("includeGit") == "1"
	payloads, errs := resolveUnitPayloads(keys, includeIgnored)
	if len(payloads) == 0 {
		msg := "no resolvable units"
		if len(errs) > 0 {
			msg = strings.Join(errs, "; ")
		}
		shared.Error(c, http.StatusBadRequest, msg, nil)
		return
	}
	sortPayloads(payloads)

	// 先同步打包到内存边界？不行——zip 可能 GB 级。io.Pipe 流式：meta 需要
	// 在响应头先行，但 Entries 在打包期补齐。取法：meta 主体（键/kind/名/指纹）
	// 解析期已定，Entries 由打包协程就地改 payloads——两边共享 slice 底层，
	// 头部写入时 Entries 可能为 0。落位对账以包内实际条目为准（Entries 是
	// 辅证），可接受
	meta := &TransferMeta{IncludeIgnored: includeIgnored}
	for i := range payloads {
		meta.Units = append(meta.Units, payloads[i].unit)
	}
	pr, pw := io.Pipe()
	go func() {
		defer pw.Close()
		if _, err := packUnitsStream(c.Request.Context(), pw, payloads, includeGit, includeIgnored, nil); err != nil {
			pw.CloseWithError(err)
		}
	}()
	c.Header("Content-Type", "application/zip")
	c.Header(syncMetaHeader, mustJSON(meta))
	c.Status(http.StatusOK)
	_, _ = io.Copy(c.Writer, pr) // 写失败（客户端断开）即中断，打包协程随 pipe 关闭退出
}

// PostUnitsZip POST /api/sync/units?mode=land|deliver|cred —— 对端面：接收流落位。
//   - mode=land（缺省）：项目/上下文/全局单元落位（自动注册项目/.sync-backup
//     备份/磁盘预检），落位后入账通知让前端编辑器自动重读
//   - mode=deliver：非项目投递纯落位到 destRoot/<Dest>（Dest 来自 meta 单元，
//     白名单前缀内校验，不注册项目）
//   - mode=cred：携密档 E2E 信封（P-20261024-3）——凭 handleCredLand 双端
//     确认仪式（未核对暂存 10min / 已核对验水位落盘）
func PostUnitsZip(c *gin.Context) {
	if c.Query("mode") == "cred" {
		handleCredLand(c)
		return
	}
	metaRaw := c.GetHeader(syncMetaHeader)
	if metaRaw == "" {
		shared.Error(c, http.StatusBadRequest, "missing "+syncMetaHeader, nil)
		return
	}
	var meta TransferMeta
	if json.Unmarshal([]byte(metaRaw), &meta) != nil {
		shared.Error(c, http.StatusBadRequest, "transfer meta not parseable", nil)
		return
	}
	// 磁盘预检（对端侧第二道——发起侧 plan 已预检过，传输间隙磁盘可能变化）
	if need, free := diskInsufficient(&meta); free >= 0 && need > free {
		shared.Error(c, http.StatusInsufficientStorage,
			fmt.Sprintf("peer disk insufficient: need %d bytes, avail %d", need, free), nil)
		return
	}
	destRoot := c.Query("destRoot")
	mode := c.Query("mode")
	if mode == "" {
		mode = "land"
	}
	var lr *LandResult
	var err error
	if mode == "deliver" {
		if len(meta.Units) != 1 || meta.Units[0].Dest == "" {
			shared.Error(c, http.StatusBadRequest, "deliver requires one unit with dest", nil)
			return
		}
		lr, err = landDeliver(c.Request.Context(), c.Request.Body, &meta.Units[0], destRoot)
	} else {
		lr, err = landUnits(c.Request.Context(), c.Request.Body, &meta, destRoot, nil)
	}
	if err != nil {
		shared.Error(c, http.StatusBadGateway, err.Error(), nil)
		return
	}
	// 落位完成广播（方案②：已打开编辑器自动重读不残留旧内容）——通知中心
	// 入账，前端按 action 分发为 OPS_FILES_EXTERNAL_CHANGE 窗口事件
	notifyLanded(lr)
	c.JSON(http.StatusOK, gin.H{"data": lr})
}

// GetProgress GET /api/sync/progress —— 当前任务快照（多标签页/刷新兜底；
// 常态走 sync.progress WS 广播）
func GetProgress(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"data": currentProgress()})
}

// GetLedger GET /api/sync/ledger —— 账本清单（落后标记/上次同步时间的数据面）
func GetLedger(c *gin.Context) {
	entries, err := store.Get().SyncLedger.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "ledger list failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": entries})
}

// DeleteLedger DELETE /api/sync/ledger?peerId=&unitKey= —— 账本条目清理
// （重置基线=下次同步按新增档重判；对端/项目删除的级联清理另有专链）
func DeleteLedger(c *gin.Context) {
	peerID := c.Query("peerId")
	unitKey := c.Query("unitKey")
	if unitKey != "" {
		if peerID == "" {
			shared.Error(c, http.StatusBadRequest, "peerId required with unitKey", nil)
			return
		}
		if err := store.Get().SyncLedger.DeleteByUnit(unitKey); err != nil {
			shared.Error(c, http.StatusInternalServerError, "ledger delete failed", err)
			return
		}
	} else if peerID != "" {
		if err := store.Get().SyncLedger.DeleteByPeer(peerID); err != nil {
			shared.Error(c, http.StatusInternalServerError, "ledger delete failed", err)
			return
		}
	} else {
		shared.Error(c, http.StatusBadRequest, "peerId or unitKey required", nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"deleted": true}})
}

// ── 内部小件 ──

// findInstance 实例 id 查找（dispatch 同款线性查找，实例量个位级）
func findInstance(id string) (config.InstanceConfig, bool) {
	all, err := store.Get().Instance.List()
	if err != nil {
		return config.InstanceConfig{}, false
	}
	for _, inst := range all {
		if inst.ID == id {
			return inst, true
		}
	}
	return config.InstanceConfig{}, false
}

// findProjectByID 本端项目查找
func findProjectByID(id string) *config.ProjectConfig {
	projects, err := store.Get().Project.List()
	if err != nil {
		return nil
	}
	for i := range projects {
		if projects[i].ID == id {
			return &projects[i]
		}
	}
	return nil
}

// sortPayloads project 单元先行（落位依赖序）
func sortPayloads(payloads []unitPayload) {
	sort.SliceStable(payloads, func(i, j int) bool {
		return unitOrder(payloads[i].unit.Kind) < unitOrder(payloads[j].unit.Kind)
	})
}

// diskInsufficient 磁盘预检复核（对端落位侧）：需求 = 各单元 Size 合计，
// 可用 = 落位根所在卷。探测失败 free=-1（跳过预检，逐文件写失败兜底）
func diskInsufficient(meta *TransferMeta) (need, free int64) {
	for _, u := range meta.Units {
		need += u.Size
	}
	free = diskFree(syncDestRoot())
	return need, free
}

// mustJSON 序列化（TransferMeta 是纯数据结构，不会失败）
func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// sanitizeRelForAudit 审计里的路径形态：相对路径归一正斜杠（不含本机绝对
// 前缀——路径脱敏 P-203 链同款）
func sanitizeRelForAudit(rel string) string {
	return strings.ReplaceAll(rel, "\\", "/")
}

// summaryLine 结果摘要（审计 Detail：单元数/字节/失败数计数元数据）
func (r *ExecuteResult) summaryLine() string {
	ok, failed, skipped := 0, 0, 0
	for _, u := range r.Units {
		switch {
		case u.OK:
			ok++
		case u.Skipped:
			skipped++
		default:
			failed++
		}
	}
	return fmt.Sprintf("units=%d ok=%d failed=%d skipped=%d bytes=%d durationMs=%d",
		len(r.Units), ok, failed, skipped, r.Bytes, r.DurationMs)
}
