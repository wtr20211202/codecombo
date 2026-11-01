package sync

import (
	"context"
	"fmt"
	"io"
	"sort"
	"sync"
	"time"

	"codecombo/server/config"
	"codecombo/server/store"
)

// 拉取/推送执行编排（方案②③）：plan 勾选单元 → 逐单元传输 → 对端落位 →
// 账本记账 → 进度广播。失败隔离：单单元失败不中断整批（行内重试由前端再发）。

// ExecuteRequest POST /api/sync/pull|push 请求体
type ExecuteRequest struct {
	// InstanceIDs 推送目标实例集（push 可多台）；pull 取首台
	InstanceIDs []string `json:"instanceIds"`
	// Units 勾选单元（project 键 + 上下文键；顺序无关，执行时 project 先行）
	Units []string `json:"units"`
	// Resolutions 冲突裁决（键 → local|peer）：local=以本端为准（push 覆盖对端）、
	// peer=取对端（pull 覆盖本端）；缺省键按单元 action 处置
	Resolutions map[string]string `json:"resolutions,omitempty"`
	// IncludeIgnored 含被忽略文件（.gitignore 感知排除的对偶开关）
	IncludeIgnored bool `json:"includeIgnored,omitempty"`
	// IncludeGit 项目本体携带 .git（两档之二；默认纯工作区档）
	IncludeGit bool `json:"includeGit,omitempty"`
	// IncludeCredentials 手动携密同步开关（P-20261024-3）：唯一携密通道，
	// 缺省 false；仅手动路径放行（cron/自动化源服务端硬拒，credGuard），
	// 勾选时凭据档单元（UnitCredentials）自动入列——units 显式出现该键而
	// 开关未开也是拒绝（credGuard 一致性收口）
	IncludeCredentials bool `json:"includeCredentials,omitempty"`
	// Parallel 多目标推送并行度（默认 2，可配 1~4——纯串行太慢全并行打满对端）
	Parallel int `json:"parallel,omitempty"`
	// DestRoot 对端落位根覆盖（拉取落本端时为空=本端配置）
	DestRoot string `json:"destRoot,omitempty"`
}

// ExecuteResult 执行结果（结果卡数据源）
type ExecuteResult struct {
	JobID      string           `json:"jobId"`
	Units      []UnitExecResult `json:"units"`
	Bytes      int64            `json:"bytes"`
	Elapsed    time.Duration    `json:"-"`
	DurationMs int64            `json:"durationMs"`
	// EnvHints 对端环境画像差集提示（步骤⑥；键=单元键）
	EnvHints map[string]string `json:"envHints,omitempty"`
}

// UnitExecResult 单单元执行结果
type UnitExecResult struct {
	Key         string `json:"key"`
	OK          bool   `json:"ok"`
	Skipped     bool   `json:"skipped,omitempty"`
	Busy        bool   `json:"busy,omitempty"`
	Error       string `json:"error,omitempty"`
	Overwritten int    `json:"overwritten,omitempty"`
	BackupDir   string `json:"backupDir,omitempty"`
}

// executeSync 执行主体（手动路径：Background ctx，后台 goroutine 跑完由
// finishJob 收口）
func executeSync(req ExecuteRequest, direction string, source string) (*ExecuteResult, error) {
	return executeSyncWithCtx(context.Background(), req, direction, source)
}

// executeSyncWithCtx 执行主体（pull：从对端拉到本端；push：把本端推到对端集）。
// 手动路径在独立 goroutine 运行（HTTP 请求立即返回，进度走广播/轮询——大传输
// 不能挂在请求超时上）；定时路径传巡检 ctx
func executeSyncWithCtx(ctx context.Context, req ExecuteRequest, direction string, source string) (*ExecuteResult, error) {
	if len(req.InstanceIDs) == 0 {
		return nil, errf("no target instance")
	}
	if direction != "pull" && direction != "push" {
		return nil, errf("invalid direction")
	}
	// 携密开关开时允许 units 为空（纯凭据档同步：换机「一次手动同步全齐」
	// 的最小形态）；其余情形空单元即参数错误
	if len(req.Units) == 0 && !req.IncludeCredentials {
		return nil, errf("no units selected")
	}
	// 携密红线守卫（P-20261024-3）：定时/自动化 source 携密服务端硬拒；
	// units 含凭据单元而开关未开同样拒绝（一致性收口）。cron 路径的请求由
	// runSyncCronCtx 构造（IncludeCredentials 恒零值）——本守卫是防漂移的
	// 第二道服务端硬面，不依赖调用方自律
	if err := credGuard(req, source); err != nil {
		return nil, err
	}
	// 携密开关开：凭据档单元自动入列（单一开关语义——前端不手拼该键）
	if req.IncludeCredentials {
		has := false
		for _, k := range req.Units {
			if k == UnitCredentials {
				has = true
				break
			}
		}
		if !has {
			req.Units = append(req.Units, UnitCredentials)
		}
	}
	if req.Parallel < 1 || req.Parallel > 4 {
		req.Parallel = 2
	}

	// 单元排序：project 先行（落位依赖序：上下文单元寻址所属项目）
	units := append([]string(nil), req.Units...)
	sort.SliceStable(units, func(i, j int) bool {
		ki, _ := ParseUnitKey(units[i])
		kj, _ := ParseUnitKey(units[j])
		return unitOrder(ki) < unitOrder(kj)
	})

	insts, err := resolveInstances(req.InstanceIDs)
	if err != nil {
		return nil, err
	}
	job := &SyncJob{
		ID: nextJobID(), Direction: direction, Source: source,
		TotalBytes: 0, StartedAt: time.Now(), Outcome: "running",
		rt: &jobRuntime{}, env: &envCollector{},
	}
	peerName := insts[0].Name
	if len(insts) > 1 {
		peerName = fmt.Sprintf("%d 台实例", len(insts))
	}
	job.PeerName = peerName
	// 上下文单元的总量按所属项目同基数近似（manifest 已给出 Size——此处按
	// 请求序逐项填总量；枚举阶段在传输单元内完成）
	local := buildLocalManifest()
	sizeOf := map[string]int64{}
	for _, u := range local.Units {
		sizeOf[u.Key] = u.Size
	}
	for _, k := range units {
		s := sizeOf[k]
		job.Units = append(job.Units, UnitProgress{
			Key: k, Kind: kindOf(k), Name: k, State: "queued", Total: s,
		})
		job.TotalBytes += s
	}
	beginJob(job)

	res := &ExecuteResult{JobID: job.ID}
	start := time.Now()
	if direction == "pull" {
		execPull(job, res, req, units, insts[0])
	} else {
		execPush(job, res, req, units, insts)
	}
	res.Bytes = job.SentBytes
	res.Elapsed = time.Since(start)
	res.DurationMs = res.Elapsed.Milliseconds()
	res.EnvHints = job.envHintsSnapshot()

	outcome := "done"
	if len(res.unitsFailed()) > 0 {
		outcome = "partial"
	}
	if len(res.unitsFailed()) == len(res.Units) && len(res.Units) > 0 {
		outcome = "failed"
	}
	finishJob(job, outcome)
	return res, nil
}

// unitOrder 依赖排序权重：project(0) → 上下文(1) → 全局(2)
func unitOrder(kind string) int {
	switch kind {
	case UnitProject:
		return 0
	case UnitSessions, UnitNotes, UnitCrons:
		return 1
	default:
		return 2
	}
}

func kindOf(key string) string {
	k, _ := ParseUnitKey(key)
	return k
}

func (r *ExecuteResult) unitsFailed() []UnitExecResult {
	var out []UnitExecResult
	for _, u := range r.Units {
		if !u.OK && !u.Skipped {
			out = append(out, u)
		}
	}
	return out
}

// resolveInstances 实例 id → 配置（缺失即错——执行前校验，不静默跳过）
func resolveInstances(ids []string) ([]config.InstanceConfig, error) {
	all, err := store.Get().Instance.List()
	if err != nil {
		return nil, err
	}
	byID := map[string]config.InstanceConfig{}
	for _, inst := range all {
		byID[inst.ID] = inst
	}
	out := make([]config.InstanceConfig, 0, len(ids))
	for _, id := range ids {
		inst, ok := byID[id]
		if !ok {
			return nil, errf("instance %s not registered", id)
		}
		out = append(out, inst)
	}
	return out, nil
}

// unitState 定位任务内单元进度槽
func unitState(job *SyncJob, key string) *UnitProgress {
	for i := range job.Units {
		if job.Units[i].Key == key {
			return &job.Units[i]
		}
	}
	return nil
}

// ── pull ──

// execPull 从对端拉取勾选单元落地本端。逐单元独立：单单元失败其余继续。
// 冲突单元按 Resolutions[键]==peer 才执行（UI 默认不勾冲突，勾选即显式裁决）
func execPull(job *SyncJob, res *ExecuteResult, req ExecuteRequest, units []string, peer config.InstanceConfig) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for _, key := range units {
		if unitState(job, key) == nil {
			continue
		}
		// 凭据档单元走专用 E2E 通道（credflow）：不经 zip 打包/账本四态
		if key == UnitCredentials {
			job.setUnit(key, 0, "", "transferring")
			job.touch(hub)
			summary, err := pullCredUnit(ctx, job, peer)
			uer := UnitExecResult{Key: key}
			if err != nil {
				job.setUnit(key, -1, "", "failed")
				uer.Error = err.Error()
			} else {
				job.setUnit(key, -1, summary, "done")
				uer.OK = true
			}
			job.touch(hub)
			res.Units = append(res.Units, uer)
			continue
		}
		if req.Resolutions[key] == "skip" {
			job.setUnit(key, -1, "", "conflict-skipped")
			res.Units = append(res.Units, UnitExecResult{Key: key, Skipped: true})
			job.touch(hub)
			continue
		}
		// 单元锁：并发同单元推拉互斥（busy 跳过入账不阻塞其余）
		release, ok := tryUnitLock(key)
		if !ok {
			job.setUnit(key, -1, "", "busy-skipped")
			res.Units = append(res.Units, UnitExecResult{Key: key, Busy: true, Skipped: true})
			job.touch(hub)
			continue
		}
		job.setUnit(key, -1, "", "enumerating")
		job.touch(hub)
		lr, err := pullOneUnit(ctx, job, req, peer, key)
		release()
		uer := UnitExecResult{Key: key}
		if err != nil {
			job.setUnit(key, -1, "", "failed")
			uer.Error = err.Error()
		} else {
			job.setUnit(key, -1, "", "done")
			uer.OK = true
			uer.Overwritten = lr.Overwritten
			uer.BackupDir = lr.BackupDir
		}
		job.touch(hub)
		res.Units = append(res.Units, uer)
	}
}

// pullOneUnit 拉单单元：对端 GET zip 流 → 本端 landUnits（复用落位链——拉取
// 就是「对端推给本端」的角色互换，落位/注册/备份语义完全一致）
func pullOneUnit(ctx context.Context, job *SyncJob, req ExecuteRequest, peer config.InstanceConfig, key string) (*LandUnitResult, error) {
	body, meta, err := fetchPeerUnitsZip(ctx, peer, []string{key}, req.IncludeIgnored)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	if len(meta.Units) != 1 {
		return nil, errf("peer returned unexpected unit count %d", len(meta.Units))
	}
	job.setUnit(key, 0, "", "transferring")
	job.touch(hub)
	peerFP := meta.Units[0].Fingerprint
	// 进度桥：landUnits 的解包回调 → 任务单元进度（未压缩口径，与打包侧一致）
	lr, err := landUnits(ctx, body, meta, req.DestRoot, func(_ int, file string, n int64) {
		job.setUnit(key, n, file, "transferring")
		job.touch(hub)
	})
	if err != nil {
		return nil, err
	}
	u := firstUnit(lr)
	if u != nil {
		if u.Error != "" {
			return u, errf("%s", u.Error)
		}
		if u.Busy {
			return u, errf("unit busy on local instance")
		}
		// 账本回账：本端指纹现算（落地后真实态）、对端指纹用传输元数据源端值
		recordLedger(key, "pull", peer.ID, peerFP)
	}
	job.setUnit(key, -1, "", "landing")
	job.touch(hub)
	return u, nil
}

func firstUnit(lr *LandResult) *LandUnitResult {
	if lr == nil || len(lr.Units) == 0 {
		return nil
	}
	return &lr.Units[0]
}

// recordLedger 账本回账：本端指纹现算（落地后的真实状态）、对端指纹用传输
// 元数据携带的源端指纹。重算失败不阻断（账本缺基线只多一次「新增档」判定，
// 无正确性风险）
func recordLedger(key, direction, peerID, peerFP string) {
	localFP := recomputeLocalFingerprint(key)
	_ = store.Get().SyncLedger.Put(store.SyncLedgerEntry{
		PeerID: peerID, UnitKey: key,
		LocalFP: localFP, PeerFP: peerFP,
		Direction: direction, SyncedAt: time.Now(),
	})
}

// recomputeLocalFingerprint 落地后重算本端单元指纹（对账口径与 manifest 一致）
func recomputeLocalFingerprint(key string) string {
	kind, base := ParseUnitKey(key)
	if base == "" {
		// 全局单元：重打包口径哈希（无文件系统态）——直接重建 JSON 载荷哈希
		local := buildLocalManifest()
		for _, u := range local.Units {
			if u.Key == key {
				return u.Fingerprint
			}
		}
		return ""
	}
	p := findProjectByBasename(base)
	if p == nil {
		return ""
	}
	switch kind {
	case UnitProject:
		scan, err := enumerateUnitDir(p.Path, false, false)
		if err != nil {
			return ""
		}
		return fingerprintFiles(scan.files)
	default:
		local := buildLocalManifest(p.ID)
		for _, u := range local.Units {
			if u.Key == key {
				return u.Fingerprint
			}
		}
	}
	return ""
}

// ── push ──

// execPush 推送本端单元到多目标：单元间并行（semaphore 默认 2，可配 1~4），
// 单元内目标串行——并行维度取「单元」而非「目标」：同单元的两路并发推送会在
// 单元锁上互撞（busy 误伤第二目标），单元内串行走完目标集天然无竞争。离线
// 目标即时记因不阻塞其余（方案③）。冲突单元按 Resolutions[键]==local 才执行
func execPush(job *SyncJob, res *ExecuteResult, req ExecuteRequest, units []string, peers []config.InstanceConfig) {
	sem := make(chan struct{}, req.Parallel)
	var mu sync.Mutex
	var wg sync.WaitGroup
	// 逐单元多目标结果聚合（键 → 目标名 → 错误），仅聚合失败/离线/忙
	outcomes := map[string]map[string]string{}
	record := func(key, name, msg string) {
		mu.Lock()
		if outcomes[key] == nil {
			outcomes[key] = map[string]string{}
		}
		outcomes[key][name] = msg
		mu.Unlock()
	}
	// 离线预检（GetStatus 既有）：offline 即时记因，全部目标离线的单元在收尾
	// 聚合时按跳过态入账
	var active []config.InstanceConfig
	for _, p := range peers {
		if store.Get().Instance.GetStatus(p.ID) == "offline" {
			for _, key := range units {
				record(key, p.Name, "offline")
			}
			continue
		}
		active = append(active, p)
	}
	for _, key := range units {
		if req.Resolutions[key] == "skip" {
			continue // 冲突裁决 skip：不入对端，收尾统一入账
		}
		if unitState(job, key) == nil {
			continue
		}
		release, ok := tryUnitLock(key)
		if !ok {
			for _, p := range active {
				record(key, p.Name, "busy")
			}
			continue
		}
		wg.Add(1)
		go func(key string, release func()) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			defer release()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			job.setUnit(key, 0, "", "enumerating")
			job.touch(hub)
			for _, peer := range active {
				// 单元内目标串行：任一目标失败即中断该单元的后续目标
				//（同源内容重试成本低，失败目标在结果里点名可单独重跑）
				var err error
				if key == UnitCredentials {
					// 凭据档单元走专用 E2E 通道（credflow）；staged（对端首次
					// 接收待确认）按成功收口，结果行如实标注
					var staged bool
					var summary string
					staged, summary, err = pushCredUnit(ctx, job, peer)
					if err == nil && staged {
						job.setUnit(key, -1, summary+"（对端待确认）", "done")
					}
				} else {
					err = pushOneUnit(ctx, job, req, peer, key)
				}
				if err != nil {
					record(key, peer.Name, err.Error())
					return
				}
			}
		}(key, release)
	}
	wg.Wait()
	// 结果聚合入账
	for _, key := range units {
		if req.Resolutions[key] == "skip" {
			job.setUnit(key, -1, "", "conflict-skipped")
			res.Units = append(res.Units, UnitExecResult{Key: key, Skipped: true})
			continue
		}
		uer := UnitExecResult{Key: key}
		fails := outcomes[key]
		if len(fails) > 0 {
			firstErr := ""
			for name, e := range fails {
				if e != "offline" && e != "busy" {
					firstErr = name + ": " + e
					break
				}
			}
			if firstErr == "" {
				// 全部目标离线/忙：跳过态（不标失败——目标侧原因明确可重试）
				uer.Skipped = true
				uer.Busy = failsHas(fails, "busy")
				for name, e := range fails {
					uer.Error += name + ":" + e + " "
				}
				job.setUnit(key, -1, "", "busy-skipped")
				job.setUnit(key, -1, uer.Error, "")
			} else {
				uer.Error = firstErr
				job.setUnit(key, -1, "", "failed")
				job.setUnit(key, -1, firstErr, "")
			}
		} else {
			uer.OK = true
			job.setUnit(key, -1, "", "done")
		}
		res.Units = append(res.Units, uer)
		job.touch(hub)
	}
}

func failsHas(m map[string]string, want string) bool {
	for _, v := range m {
		if v == want {
			return true
		}
	}
	return false
}

// pushOneUnit 推单单元：打包 zip（io.Pipe 流式）→ 对端落位 → 双端账本回账
func pushOneUnit(ctx context.Context, job *SyncJob, req ExecuteRequest, peer config.InstanceConfig, key string) error {
	payloads, errs := resolveUnitPayloads([]string{key}, req.IncludeIgnored)
	if len(errs) > 0 {
		return errf("%s", errs[0])
	}
	if len(payloads) == 0 {
		return errf("unit not resolvable")
	}
	job.setUnit(key, 0, "", "transferring")
	job.touch(hub)

	// 元数据先行（包内单元清单已知；Entries 由打包协程经 payloads 就地补齐
	// ——meta.Units 与 payloads 共享底层数组前的拷贝无关联，Entries 以落位
	// 对账为辅证不强校验）
	meta := &TransferMeta{IncludeIgnored: req.IncludeIgnored, Units: []TransferUnit{payloads[0].unit}}
	pr, pw := io.Pipe()
	go func() {
		defer pw.Close()
		_, err := packUnitsStream(ctx, pw, payloads, req.IncludeGit, req.IncludeIgnored, func(_ int, file string, n int64) {
			job.setUnit(key, n, file, "")
			job.touch(hub)
		})
		if err != nil {
			pw.CloseWithError(err)
		}
	}()
	// 读侧 = 上传（流式：打包进度即传输进度；对端 zip 随机访问要求使其在
	// spool 中转后解包——传输本身零整读）
	lr, err := postPeerUnitsZip(ctx, peer, meta, pr)
	if err != nil {
		return err
	}
	if u := firstUnit(lr); u != nil {
		if u.Error != "" {
			return errf("peer: %s", u.Error)
		}
		if u.Busy {
			return errf("peer busy on this unit")
		}
	}
	job.setUnit(key, -1, "", "landing")
	job.touch(hub)
	// 双端记账：对端指纹 = 推送时刻本端指纹（落地内容=源内容）
	recordLedgerOutbound(key, peer.ID)
	// 环境差集提示（步骤⑥，尽力而为）：项目单元落地后取对端画像摘要比对
	if u := firstUnit(lr); u != nil && payloads[0].project != nil {
		job.noteEnvHint(key, collectEnvHint(ctx, peer, payloads[0].project.ID, u.ProjectID))
	}
	return nil
}

// recordLedgerOutbound push 方向记账（本端→对端：两端指纹同为推送时刻本端态）
func recordLedgerOutbound(key, peerID string) {
	localFP := recomputeLocalFingerprint(key)
	_ = store.Get().SyncLedger.Put(store.SyncLedgerEntry{
		PeerID: peerID, UnitKey: key,
		LocalFP: localFP, PeerFP: localFP,
		Direction: "push", SyncedAt: time.Now(),
	})
}
