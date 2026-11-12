package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/servicectx"
	"codecombo/server/sysinfo"
)

// Status 更新状态
type Status string

const (
	StatusIdle        Status = "idle"
	StatusChecking    Status = "checking"
	StatusDownloading Status = "downloading"
	// StatusVerifying 下载完成后的完整性/真实性校验阶段（P-20261109-10）：此前
	// verifyUpdate 在 downloading 态内跑，进度停在 100% 却无阶段透出
	StatusVerifying  Status = "verifying"
	StatusReplacing  Status = "replacing"
	StatusRestarting Status = "restarting"
	StatusSuccess    Status = "success"
	StatusFailed     Status = "failed"
	StatusRolledBack Status = "rolled_back"
)

// InFlight 在途四态（下载/校验/替换/重启）：受理闸门拒绝重入、检查不得覆写、
// 清状态（DELETE /updates/status）不得打断——前端据此常驻进度指示
func (s Status) InFlight() bool {
	switch s {
	case StatusDownloading, StatusVerifying, StatusReplacing, StatusRestarting:
		return true
	}
	return false
}

// UpdateResult 更新结果文件
type UpdateResult struct {
	Status          string `json:"status"`
	Version         string `json:"version"`
	PreviousVersion string `json:"previousVersion"`
	Error           string `json:"error,omitempty"`
	Timestamp       string `json:"timestamp"`
	// NotifiedAt 结果通知已入账时刻（P-20261109-10）：新进程启动观察窗推送
	// 完成/回滚/失败通知后回写，5 分钟新鲜窗内重启不重推。旧文件无此字段 =
	// 未推送；旧版本读新文件忽略未知字段——双向兼容
	NotifiedAt string `json:"notifiedAt,omitempty"`
}

// UpdateStatusResult GetStatus 返回的状态快照
type UpdateStatusResult struct {
	Status   Status `json:"status"`
	Progress int64  `json:"progress"`
	Total    int64  `json:"total"`
	Version  string `json:"version"`
	ErrMsg   string `json:"errMsg"`
	// ResumedBytes 本次下载尝试实际从 .part 续传的起点字节数（P-20261110-1-S4，
	// 取值唯一来源 = downloadResumable 的追加基偏移；全量回退归 0）。增量字段
	// omitempty——0 时省略，旧前端忽略未知字段零影响。重试场景（S2 重试分层后
	// 每次重试亦经 downloadResumable）语义 = 当前这次尝试的续传起点
	ResumedBytes int64 `json:"resumedBytes,omitempty"`
}

// ProgressCallback 下载进度回调
type ProgressCallback func(downloaded, total int64)

// Manager 更新管理器
type Manager struct {
	mu           sync.Mutex
	status       Status
	progress     int64
	total        int64
	resumedBytes int64 // 本次下载尝试的续传起点（downloadResumable 写入，见 UpdateStatusResult）
	version      string
	errMsg       string
	source       UpdateSource
	dataDir      string
	binaryPath   string

	// 版本缓存
	cachedInfo    *ReleaseInfo
	cachedAt      time.Time
	cacheDuration time.Duration
	// sourceGen 换源代际（SetSource 递增）：拉取期间被换源时旧源结果不落缓存。
	// 用代际而非比较 source 接口值——不可比较的动态类型做 == 会运行时 panic
	sourceGen uint64
}

var (
	globalManager *Manager
	once          sync.Once
)

// GetManager 获取全局更新管理器
func GetManager() *Manager {
	once.Do(func() {
		exePath, _ := os.Executable()
		globalManager = &Manager{
			status:        StatusIdle,
			dataDir:       configDataDir(),
			binaryPath:    exePath,
			cacheDuration: time.Hour,
		}
	})
	return globalManager
}

// SetSource 设置更新源。运行时重接线走 ApplySource（启动与保存共用同一
// 装配语义，P-20261106 热化），不直接调用本方法。
// 换源即清版本缓存：缓存的 ReleaseInfo 属于旧源/旧通道——切预发布通道或改
// 分发源后若仍沿用最长 1h 的旧结果，「保存即生效」就只是表面生效（旧缓存同样
// 会把旧源的伴随拉取失败原因带过来，P-20261109-9）。sourceGen 递增让拉取途中
// 被换源的旧源结果不再回写缓存（见 CheckUpdateWithCache）
func (m *Manager) SetSource(source UpdateSource) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.source = source
	m.sourceGen++
	m.cachedInfo = nil
	m.cachedAt = time.Time{}
}

// Source 返回当前更新源（nil=未装配）——诊断与测试消费
func (m *Manager) Source() UpdateSource {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.source
}

// GetStatus 获取当前更新状态
func (m *Manager) GetStatus() UpdateStatusResult {
	m.mu.Lock()
	defer m.mu.Unlock()
	return UpdateStatusResult{
		Status:       m.status,
		Progress:     m.progress,
		Total:        m.total,
		ResumedBytes: m.resumedBytes,
		Version:      m.version,
		ErrMsg:       m.errMsg,
	}
}

// CheckUpdate 检查更新（skipCache 为 true 时跳过缓存强制刷新）
func (m *Manager) CheckUpdate(ctx context.Context, currentVersion string) (*ReleaseInfo, error) {
	return m.CheckUpdateWithCache(ctx, currentVersion, false)
}

// CheckUpdateWithCache 检查更新，可选跳过缓存。skipCache=true 是「要实时结果」：
// 既不读缓存，拉取失败也不回落过期缓存而是如实返回错误（P-20261109-9 伴随
// 重拉的调用方据此区分「重拉成功」与「重拉本身失败」——回落旧缓存会把旧的
// 失败原因冒充成新结果透出）
func (m *Manager) CheckUpdateWithCache(ctx context.Context, currentVersion string, skipCache bool) (*ReleaseInfo, error) {
	m.mu.Lock()
	// 在途更新不被检查覆写（P-20261109-10）：否则下方 Checking→Idle 收尾会把
	// 下载中/校验中抹成 Idle——进度指示失真，受理闸门也会放行并发的第二次更新。
	// 异步受理后下载期跨分钟级，期间的定时/手动检查必然撞上；受理前的伴随重拉
	// （P-20261109-9）同样经此守卫，撞上并发受理的在途更新不会把它抹掉
	if !m.status.InFlight() {
		m.status = StatusChecking
	}
	// 源与缓存锁内取快照（P-20261109-9）：拉取不持锁（网络慢），期间 SetSource
	// 可能换源清缓存——用快照判定，回写前再按代际核对
	source, gen := m.source, m.sourceGen
	cached, cachedAt, ttl := m.cachedInfo, m.cachedAt, m.cacheDuration
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		if m.status == StatusChecking {
			m.status = StatusIdle
		}
		m.mu.Unlock()
	}()

	if source == nil {
		// 稳定原文收口 errmarkers 注册表（P-20261004-29）：api/system/update.go
		// 的 404 响应同串双发射点
		return nil, errors.New(errmarkers.UpdateSourceNotConfigured)
	}

	// 缓存命中（未过期且不强制跳过）
	if !skipCache && cached != nil && time.Since(cachedAt) < ttl {
		return cached, nil
	}

	platform, arch := DetectPlatform()
	// 更新尝试边界探测挂点（P-20261110-1 S6）：真要出网取数时探测一次系统代理
	// （开关关零探测；上方缓存命中不出网即不探测），本次检查的全部请求（release
	// 端点 + 伴随资产及其 302 跳）共用这份快照——选路热路径不再探测
	refreshSystemProxyDetection(ctx)
	info, err := source.FetchLatest(ctx, platform, arch)
	if err != nil {
		// 请求失败时返回过期缓存（skipCache 调用方要实时结果，不回落）
		if !skipCache && cached != nil {
			return cached, nil
		}
		return nil, err
	}

	m.mu.Lock()
	// 拉取期间被换源（设置保存热接线）：旧源结果不落缓存，免得刚清掉的旧通道
	// 结果又被写回、再盖住新源 1h
	if m.sourceGen == gen {
		m.cachedInfo = info
		m.cachedAt = time.Now()
	}
	m.mu.Unlock()
	return info, nil
}

// ErrNpmManaged npm 分发形态拒绝自更新（stable 文本进 errmarkers 注册表，
// update api 以 409 发射——包装器/前端按此文案给出 npm 更新指引）
var ErrNpmManaged = errors.New(errmarkers.UpdateNpmManaged)

// ErrUpdateInProgress 受理闸门拒绝：已有在途更新（API 层映射 409）。返回时
// 包装为「update already in progress: <status>」，文案与历史一致，判型走 errors.Is
var ErrUpdateInProgress = errors.New("update already in progress")

// verifyUpdateFn 校验步骤取值口（默认 verifyUpdate）：单测替换以断言流水线
// 在校验时刻处于 verifying 阶段（P-20261109-10），生产路径恒为 verifyUpdate
var verifyUpdateFn = verifyUpdate

// launchUpdateSubprocessFn 换包子进程拉起取值口（默认 LaunchUpdateSubprocess）：
// 单测替换以断言流水线走完校验后的替换阶段并核对下发参数——测试绝不真实 spawn
// 换包进程（该进程会等待测试进程退出后真实换包，护栏），生产路径恒为本体
var launchUpdateSubprocessFn = LaunchUpdateSubprocess

// companionRefetchTimeout 受理前伴随重拉的总时限（P-20261109-9）：release 端点 +
// 伴随资产预算（companionFetchBudget）之和的上界。重拉发生在受理之前、请求方
// 同步等待受理结论（StartUpdate），故须低于前端 apply 请求的 axios 30s 超时——
// 失败路径要把真实原因带回去，而不是让用户只看到一个客户端超时。包级变量便于
// 测试压缩
var companionRefetchTimeout = 20 * time.Second

// ApplyUpdate 同步执行更新（下载+校验+启动子进程），返回即本进程内终态。
// Failed/RolledBack 视为可重试终态：上次失败不阻断本次（Reset 语义内联）。
// HTTP 入口走异步的 StartUpdate；本形态供单测与无请求语境的调用方
func (m *Manager) ApplyUpdate(ctx context.Context, info *ReleaseInfo, currentVersion string, port int, progressCB ProgressCallback) error {
	return m.applyUpdate(ctx, info, currentVersion, port, progressCB, nil)
}

// StartUpdate 异步受理更新（P-20261109-10，HTTP 入口）：npm 形态、伴随预检
// 拒绝（P-20261109-9）与在途闸门同步裁决后即返回（nil = 已受理），下载/校验/
// 拉起换包子进程在后台 goroutine 以脱离请求的 context 跑完。历史同步形态把数
// 分钟的下载塞进请求——主引擎 WriteTimeout 60s 与前端 axios 30s 双重截断，前端
// 报失败而服务端仍在换包（用户「不知道什么情况」实锚）。生命周期通知服务端单一
// 发射：受理点入账「开始」（先于后台任何失败，时序恒定）；受理后失败入账
// 「失败」（原因 = 状态机 errMsg）；受理前拒绝（含伴随重拉后仍失败——此刻
// 发「开始更新」就是假话）零通知，真实原因随错误交还请求方；成功路径本进程
// 随即退出，完成/回滚由新进程启动观察窗推送
func (m *Manager) StartUpdate(info *ReleaseInfo, currentVersion string, port int) error {
	admission := make(chan error, 1)
	go func() {
		accepted := false
		version := info.Version
		err := m.applyUpdate(context.Background(), info, currentVersion, port, nil, func(admittedVersion string) {
			accepted = true
			// 受理版本以流水线实际采用的为准：伴随重拉（P-20261109-9）可能换成
			// 比请求方缓存检查结果更新的 release，通知不能报旧版本号
			version = admittedVersion
			notifyUpdateStarted(version)
			admission <- nil
		})
		if !accepted {
			// 受理前即返回（npm 形态/伴随预检拒绝/在途闸门）：错误交还请求方。
			// 零通知、结果文件不动——「开始更新」只发生在真受理之后
			admission <- err
			return
		}
		if err != nil {
			reason := m.GetStatus().ErrMsg
			if reason == "" {
				reason = err.Error()
			}
			slog.Warn("update: background apply failed", "version", version, "err", err)
			notifyUpdateFailed(version, reason)
		}
	}()
	return <-admission
}

// applyUpdate 更新流水线本体。admitted 在受理点（闸门通过、状态机进入
// downloading、上一轮结果文件已清）同步回调一次、带实际受理的版本——StartUpdate
// 据此把「受理/拒绝」交还请求方；受理之前的一切失败（npm 形态/伴随预检拒绝/
// 在途闸门）同样经返回值交还；受理之后的失败经状态机（failed+errMsg）承载
func (m *Manager) applyUpdate(ctx context.Context, info *ReleaseInfo, currentVersion string, port int, progressCB ProgressCallback, admitted func(version string)) error {
	// npm 分发形态（P-20261102-2）：node_modules 里的文件归 npm 管——自更新
	// 原位替换会让 npm 版本记账漂移（下次 npm update 把旧版盖回来）。在动
	// 状态机之前就拒绝，错误面给出 npm 更新指引
	if IsNpmManaged(m.binaryPath) {
		return ErrNpmManaged
	}

	// 伴随资产重拉前置（P-20261109-9 缓存粘性处置）：check 结果走 1h 缓存，一次
	// 瞬时的伴随资产拉取失败会被钉住整个缓存窗、点几次更新都同样被拒——带失败
	// 标记先 skipCache 重拉一次（成功即刷新缓存，面板再查随之恢复）。属受理之前
	// 的同步前置段（StartUpdate 的请求方同步等待受理结论），放在状态闸门之前：
	// CheckUpdateWithCache 自身要过 Checking 态，与 API 层闸门前的 CheckUpdate
	// 同一位置语义（在途态有 InFlight 守卫不被它抹掉）。重拉结果须仍是可用更新
	// 才采用（发布被撤回等边角形态沿用原 info，由下方预检/校验照常裁决）。重拉
	// 限时 companionRefetchTimeout：失败路径要在前端请求超时之前把真实原因带回
	var refetchErr error
	if info.CompanionFetchFailed() {
		rctx, cancel := context.WithTimeout(ctx, companionRefetchTimeout)
		fresh, err := m.CheckUpdateWithCache(rctx, currentVersion, true)
		cancel()
		switch {
		case err != nil:
			refetchErr = err
		case fresh != nil && HasUpdate(currentVersion, fresh.Version):
			info = fresh
		}
	}

	m.mu.Lock()
	if m.status != StatusIdle && m.status != StatusChecking && m.status != StatusFailed && m.status != StatusRolledBack {
		st := m.status
		m.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrUpdateInProgress, st)
	}
	// 重拉后仍注定过不了校验（伴随资产没取到、无逃生门、无其他可用校验数据；
	// 判定与 verifyUpdate 同源 CompanionPreflight，放行/拒绝结果零变化）→ 受理前
	// 同步拒绝（P-20261109-9）：不进异步下载（注定被拒的主包不白拉几十 MB）、
	// 不入账「开始/失败」通知、不清上一轮结果文件——三态真实原因随错误交还请求
	// 方（API 层 500 带原文，前端 KNOWN_ERROR_I18N 本地化）。落账在闸门之后、与
	// 闸门同一临界区（闸门前落账会踩掉在途更新的状态；同区则不经 downloading
	// 中间态）。诊断落点 = manager errMsg（GET /updates/status 可见，面板「上次
	// 更新」块回显）+ 主进程 stderr（拉取失败由 GitHubSource 逐资产 slog.Warn；
	// 本拒绝经 API 层 shared.Error 的 slog 落主进程日志并镜像 stderr）——伴随拉取
	// 发生在主进程，update.log 由 _do_update 子进程 initLogger 落盘，记录不到
	if CompanionPreflight(info) != nil {
		reason := info.CompanionFetchError()
		if refetchErr != nil {
			// 重拉本身失败（release 端点不可达等）：缓存里的旧原因之外，此刻的
			// 新失败一并进原因段（前端插值参数整段透出，不丢在指引之后）
			reason += "; re-fetch failed: " + refetchErr.Error()
		}
		err := fmt.Errorf("update verification failed: %w", companionFetchFailedError(reason))
		m.status = StatusFailed
		m.progress = 0
		m.total = 0
		m.resumedBytes = 0
		m.version = info.Version
		m.errMsg = err.Error()
		m.mu.Unlock()
		return err
	}
	// 新受理从零起算：resumedBytes 由 downloadResumable 按本尝试的实际续传偏移
	// 覆写（上一次失败尝试的旧值不得泄漏进新受理的状态面）
	m.status = StatusDownloading
	m.progress = 0
	m.total = info.FileSize
	m.resumedBytes = 0
	m.version = info.Version
	m.errMsg = ""
	m.mu.Unlock()

	// 受理即清上一轮结果文件：轮询方（前端/中心链）与新进程启动观察窗都按
	// 结果文件判定终态——残留的旧结论会在换包重启窗（新进程已起、子进程尚未
	// 落盘本轮结果）被误读成本轮结局
	_ = ClearUpdateResult(m.dataDir)
	if admitted != nil {
		admitted(info.Version)
	}

	tmpDir := filepath.Join(m.dataDir, "tmp", "update-"+info.Version)
	if err := os.MkdirAll(tmpDir, 0755); err != nil {
		m.fail("create temp dir failed: " + err.Error())
		return err
	}

	if info.FileSize > 0 {
		// 空间预检走共享采集口（P-20261002-12 自 update 本地实现提升）：
		// Avail 为非特权可写口径，与原 diskFree 语义一致
		du, err := sysinfo.Usage(tmpDir)
		if err == nil && du.Avail < uint64(info.FileSize)*3 {
			m.fail("insufficient disk space")
			return fmt.Errorf("insufficient disk space: need %d, available %d", info.FileSize*3, du.Avail)
		}
	}

	newBinary := filepath.Join(tmpDir, filepath.Base(m.binaryPath))
	// 更新尝试边界探测挂点（P-20261110-1 S6）：受理后、出网下载前探测一次系统代理
	// （开关关零探测），整条下载（含资产 302 跳）共用该快照
	refreshSystemProxyDetection(ctx)
	// 断点续传下载（P-20261110-1-S1）+ 续传重试（P-20261110-1-S2）：目标改写
	// <binary>.part，失败/终止/进程死亡保留半截文件与旁元数据——同一受理内的瞬时
	// 故障由重试层自动退避重拨、从已有字节续传；重试耗尽落 failed，下一次受理（或
	// 重启后再受理）接着续。历史行为「失败即 os.RemoveAll(tmpDir) 从零重来」随续传
	// 语义退役——大包慢网下一次停滞即前功尽弃；孤儿目录由启动期 CleanupOldUpdateTmp
	// 7 天回收
	if err := m.downloadResumableWithRetry(ctx, info.DownloadURL, newBinary, progressCB); err != nil {
		m.fail("download failed: " + err.Error())
		return err
	}

	_ = os.Chmod(newBinary, 0755)

	// 完整性/真实性校验（安全 backlog A5）：签名验签优先，其次 sha256 比对，
	// 两者皆无默认拒绝。校验失败即删除下载产物，不进入替换流程。
	// 独立 verifying 阶段（P-20261109-10）：大包哈希可感知耗时，前端阶段透出
	m.mu.Lock()
	m.status = StatusVerifying
	m.mu.Unlock()
	if err := verifyUpdateFn(newBinary, info); err != nil {
		os.RemoveAll(tmpDir)
		m.fail("update verification failed: " + err.Error())
		return fmt.Errorf("update verification failed: %w", err)
	}

	m.mu.Lock()
	m.status = StatusReplacing
	m.mu.Unlock()

	pid := os.Getpid()
	if err := launchUpdateSubprocessFn(m.binaryPath, newBinary, port, pid, m.dataDir, info.Version, currentVersion); err != nil {
		m.fail("start update process failed: " + err.Error())
		return err
	}

	m.mu.Lock()
	m.status = StatusRestarting
	m.mu.Unlock()

	// 本进程退出：更新子进程等待旧进程（本 pid）退出后才替换二进制。
	// 钩子触发逻辑（含 500ms 延迟让响应先写出）统一在 RestartViaHook
	RestartViaHook()
	return nil
}

// downloadStallTimeout 下载停滞判定：连续无新数据超过该时长视为连接死亡，
// 中止并报错（http.Client 对大文件不能设整体超时，停滞检测是唯一可靠保护）
const downloadStallTimeout = 60 * time.Second

// stallTimeout 停滞判定取值口（默认 downloadStallTimeout，生产路径恒取 60s）：
// 包级原子变量仅为测试压缩——「看门狗判死 → 当次尝试失败 → 重试层另拨号续传」
// 是 P-20261110-1-S2 的提案点名形态，60s 常量塞不进单测。原子形态同 notify.go
// 的 resultWatchWindow：每个下载会话起点读一次（pumpResponseBody），后台流水线
// goroutine 的读与测试收尾期的改写可能并发，普通变量在 -race 门禁（wsl-verify
// race 清单含本包）下即数据竞争
var stallTimeout = newAtomicDuration(downloadStallTimeout)

// downloadClient 下载专用：safeRoundTripper 出站选路（显式代理/env 代理/系统探测
// 代理命中时过官方域白名单，直连档 https + 拒绝内网/保留地址，P-20261109-12 +
// P-20261110-1 S6），不设整体超时——大文件下载的停滞检测由 pumpResponseBody 的
// read 循环负责
var downloadClient = &http.Client{Transport: safeRoundTripper{}}

// validateDownloadURL 下载地址校验口（默认 ValidatePublicHTTPSURL，P-20261110-1）：
// 包级变量仅为测试注入——续传协议的 Range/206/416 各态要用 httptest 本地源演练，
// 而生产直连档的拨号期 IP 守卫本就拒绝回环，两道闸共用一个注入口
var validateDownloadURL = ValidatePublicHTTPSURL

// 主包下载自动退避重试预算（P-20261110-1-S2，companionFetchAttempts 同风格）：
// 首试 + 2 次退避重试，吸收连接重置/DNS 抖动/CDN 5xx 等瞬时故障——停滞看门狗
// 判死的死链同属瞬时态，下一拨号自愈常见。仅瞬时故障重试（retryableDownloadErr），
// 确定性失败（403/404 等）与外层取消立即收手。重试即续传重试：重试层套在 S1 续传
// 会话外层（downloadResumableWithRetry），中心分发缓存路径不经本层。包级变量便于
// 测试压缩时长
var (
	downloadRetryAttempts = 3
	// downloadRetryBackoff 第 n 次重试前的退避（n 从 1 起：500ms、1s），与伴随
	// 资产拉取 companionRetryBackoff 同曲线同源（一处定义两处消费）
	downloadRetryBackoff = companionRetryBackoff
)

// downloadStatusError 续传会话（downloadResumable）的非预期状态码响应：重试判定按
// 状态码分流（companionStatusError 同款分类）。文案沿历史「download returned N」
// 不夹 URL——GitHub 资产 302 后是带数百字符签名参数的预签名 CDN 地址，进失败态
// errMsg 不可读
type downloadStatusError struct{ status int }

func (e *downloadStatusError) Error() string { return fmt.Sprintf("download returned %d", e.status) }

// retryableDownloadErr 瞬时故障判定：HTTP 5xx/429 与传输层错误（连接重置/DNS/
// 拨号与握手超时/停滞看门狗判死）可重试；其余状态码（403/404 等确定性结果）
// 不重试。其余未知错误按可重试计（与伴随拉取 retryableCompanionErr 同口径，
// 磁盘满等多拨号代价可忽略、空间预检在受理前已做）——续传会话完整性闸未过
// （源端截短 206 区间，.part 已保留增长后的字节）同属此类，下一尝试从截断处续上。
// 外层取消不在此分流——由重试层先行 ctx.Err() 判定收手：Go 的拨号超时
// （"i/o timeout"）与响应头超时都满足 errors.Is(err, context.DeadlineExceeded)，
// 按 context 错误排除会把 CDN 连接超时这类最常见的瞬时故障误判成确定性失败
// （单测实锚）
func retryableDownloadErr(err error) bool {
	var se *downloadStatusError
	if errors.As(err, &se) {
		return se.status >= 500 || se.status == http.StatusTooManyRequests
	}
	return true
}

// downloadResumableWithRetry 自更新主包下载 = 续传重试（P-20261110-1-S2 收编进 S1
// 续传路径，applyUpdate 单一调用方）：每次尝试即一次 downloadResumable 会话——失败
// 尝试留下的 .part 与旁元数据跨尝试原样保留，下一尝试带 Range 从已有偏移续传（身份
// 核对 / 200·416 全量回退 / 完整性闸逐次照 S1 语义生效，资产漂移即丢弃重下）。进度
// 从续传偏移起步不回零：会话拿到响应即把进度落到续传起点，退避窗内停在上一尝试的
// 末次采样——重试层刻意不碰进度（全量重试形态的「重试前进度归零」已随收编删除）。
// 停滞看门狗 60s 判死即当次尝试失败、重试层另拨号；超限/确定性失败透真实原因（附
// 尝试注记，失败态 errMsg 原文可读），.part 留给下一次受理续传（续传触发点=下次
// apply 的下载启动，非 check 轮询）。中心分发缓存（download/DownloadToFile）维持
// S1 定案的单拨号全量模式不经本层（作用域收窄：缓存可再生，下一次分发请求即重拉）
func (m *Manager) downloadResumableWithRetry(ctx context.Context, url, dest string, progressCB ProgressCallback) error {
	// 地址校验是确定性结果，不参与重试（续传会话内照常复核；纯字面量校验不拨号，
	// 重复代价可忽略）
	if err := validateDownloadURL(url); err != nil {
		return err
	}
	attempt := 0
	var lastErr error
	for {
		attempt++
		err := m.downloadResumable(ctx, url, dest, progressCB)
		if err == nil {
			return nil
		}
		// 传输错误剥预签名 CDN 查询串（redactURLError，companion 同款）——host+path
		// 足以定位是哪一跳失败。续传会话的传输错误即 Do 原样返回的 *url.Error，
		// 其余错误不含 *url.Error、原样透过
		err = redactURLError(err)
		lastErr = err
		// 外层取消（停机/请求方放弃）：立即收手不重试
		if ctx.Err() != nil {
			return err
		}
		if attempt >= downloadRetryAttempts || !retryableDownloadErr(err) {
			break
		}
		if !sleepCtx(ctx, downloadRetryBackoff(attempt)) {
			break // 退避期间外层取消
		}
		slog.Warn("update: download attempt failed, retrying (resume from kept .part)", "attempt", attempt, "err", err)
	}
	// 超限/确定性失败透真实原因：附尝试次数注记（companion fetchCompanion 同款），
	// 「一次就确定失败」与「反复抖动后超限」在失败态 errMsg 里可区分
	note := "after 1 attempt"
	if attempt > 1 {
		note = fmt.Sprintf("after %d attempts", attempt)
	}
	return fmt.Errorf("%w (%s)", lastErr, note)
}

// download 全量下载（带可选进度回调），响应 ctx 取消与停滞检测。P-20261110-1-S1
// 起自更新改走断点续传 downloadResumable，本函数只剩中心分发缓存（DownloadToFile
// → ServeBinary，track=false）一个调用方，直写 dest、不产 .part 旁产物；亦不经
// 续传重试层（P-20261110-1-S2 作用域收窄：失败即弃，缓存由下一次分发请求重拉）。
// track 是否回写状态机进度：中心分发下载若也回写会与并发的自更新下载互踩
// progress/total（P-20261109-10 进度事实源收口），故恒为 false
func (m *Manager) download(ctx context.Context, url, dest string, progressCB ProgressCallback, track bool) error {
	// 下载地址来自更新源 API 响应（非本地配置）：同样强制 https 公网，
	// 防响应被篡改后把二进制拉取指向内网/本机
	if err := validateDownloadURL(url); err != nil {
		return err
	}
	dctx, cancel := context.WithCancel(ctx)
	defer cancel()
	req, err := http.NewRequestWithContext(dctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}

	resp, err := downloadClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download returned %d", resp.StatusCode)
	}

	// 发布元数据未带体积（FileSize=0）时以响应 Content-Length 补齐分母，
	// 前端百分比才有意义；元数据已有则以元数据为准不覆盖
	if track && resp.ContentLength > 0 {
		m.mu.Lock()
		if m.total <= 0 {
			m.total = resp.ContentLength
		}
		m.mu.Unlock()
	}

	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()

	written, err := pumpResponseBody(ctx, dctx, cancel, resp.Body, f, func(n int64) {
		if track {
			m.mu.Lock()
			m.progress = n
			m.mu.Unlock()
		}
		if progressCB != nil {
			progressCB(n, resp.ContentLength)
		}
	})
	if err != nil {
		return err
	}

	// 最终进度更新
	if track {
		m.mu.Lock()
		m.progress = written
		m.mu.Unlock()
	}
	if progressCB != nil {
		progressCB(written, resp.ContentLength)
	}
	return nil
}

// pumpResponseBody 读空 body 写入 w（download 与 downloadResumable 共享的读循环）：
// 返回累计写入字节数。停滞看门狗在此装配——Body.Read 阻塞期间循环顶部的
// lastProgress 检查永不执行（历史缺陷——检测点在阻塞读之前等于失效），由
// watchdog 在 stall 超时后 cancel 请求强制解开 Read，循环顶/读错误分支再区分
// 「外层取消」与「停滞」。onProgress 每采样窗（200ms）收到一次累计字节数，
// 免得频繁加锁；续传路径的基偏移由调用方闭包内并加
func pumpResponseBody(ctx, dctx context.Context, cancel context.CancelFunc, body io.ReadCloser, w io.Writer, onProgress func(written int64)) (int64, error) {
	// 判定时长在会话起点读一次固化（生产恒为 60s 常量，与原先逐处读常量等价）：
	// 看门狗装配、逐读重置与报错文案同取这一个值，测试压缩改写取值口不波及
	// 已在跑的会话
	stall := stallTimeout.Load()
	watchdog := time.AfterFunc(stall, cancel)
	defer watchdog.Stop()
	rb := &stallResetBody{ReadCloser: body, reset: func() { watchdog.Reset(stall) }}

	buf := make([]byte, 32*1024)
	var written int64
	var lastUpdate time.Time
	lastProgress := time.Now()
	for {
		// 响应取消 + 停滞检测兜底（看门狗触发时由下方分支给出准确报错）
		if err := dctx.Err(); err != nil {
			if ctx.Err() != nil {
				return written, ctx.Err()
			}
			return written, fmt.Errorf("download stalled: no data for %s", stall)
		}
		if time.Since(lastProgress) > stall {
			return written, fmt.Errorf("download stalled: no data for %s", stall)
		}
		n, readErr := rb.Read(buf)
		if n > 0 {
			if _, wErr := w.Write(buf[:n]); wErr != nil {
				return written, wErr
			}
			written += int64(n)
			lastProgress = time.Now()
			// 采样更新进度，避免频繁加锁
			if now := time.Now(); now.Sub(lastUpdate) > 200*time.Millisecond {
				if onProgress != nil {
					onProgress(written)
				}
				lastUpdate = now
			}
		}
		if readErr == io.EOF {
			return written, nil
		}
		if readErr != nil {
			if ctx.Err() != nil {
				return written, ctx.Err()
			}
			if dctx.Err() != nil {
				return written, fmt.Errorf("download stalled: no data for %s", stall)
			}
			return written, readErr
		}
	}
}

// stallResetBody 每读到数据就重置停滞看门狗计时器的 Body 包装
type stallResetBody struct {
	io.ReadCloser
	reset func()
}

func (b *stallResetBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if n > 0 {
		b.reset()
	}
	return n, err
}

// DownloadToFile 下载文件到指定路径（无进度回调、不回写状态机进度）。中心分发
// 缓存下载同走 safeRoundTripper 四档选路，入口即更新尝试边界探测挂点（S6）
func (m *Manager) DownloadToFile(ctx context.Context, url, dest string) error {
	refreshSystemProxyDetection(ctx)
	return m.download(ctx, url, dest, nil, false)
}

func (m *Manager) fail(msg string) {
	m.mu.Lock()
	m.status = StatusFailed
	m.errMsg = msg
	m.mu.Unlock()
}

// Reset 重置更新状态
func (m *Manager) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.status = StatusIdle
	m.progress = 0
	m.total = 0
	m.resumedBytes = 0
	m.version = ""
	m.errMsg = ""
}

// LoadUpdateResult 从文件加载更新结果
func LoadUpdateResult(dataDir string) (*UpdateResult, error) {
	path := filepath.Join(dataDir, "update-result.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var result UpdateResult
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// SaveUpdateResult 保存更新结果到文件
func SaveUpdateResult(dataDir string, result *UpdateResult) error {
	result.Timestamp = time.Now().UTC().Format(time.RFC3339)
	return writeUpdateResult(dataDir, result)
}

// MarkUpdateResultNotified 回写结果通知已入账时刻（P-20261109-10 启动观察窗
// 跨重启防重）：保留子进程落盘的 Timestamp 原值——它是新鲜度判定的锚，
// 走 SaveUpdateResult 会被改写成此刻。结果文件不存在时空操作
func MarkUpdateResultNotified(dataDir string, at time.Time) error {
	r, err := LoadUpdateResult(dataDir)
	if err != nil || r == nil {
		return err
	}
	r.NotifiedAt = at.UTC().Format(time.RFC3339)
	return writeUpdateResult(dataDir, r)
}

func writeUpdateResult(dataDir string, result *UpdateResult) error {
	path := filepath.Join(dataDir, "update-result.json")
	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// ClearUpdateResult 清除更新结果文件
func ClearUpdateResult(dataDir string) error {
	path := filepath.Join(dataDir, "update-result.json")
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// ClearOldUpdateResult 清除超过 5 分钟的更新结果文件
func ClearOldUpdateResult(dataDir string) {
	path := filepath.Join(dataDir, "update-result.json")
	info, err := os.Stat(path)
	if err != nil {
		return
	}
	if time.Since(info.ModTime()) > 5*time.Minute {
		os.Remove(path)
	}
}

// CleanupBackup 清理备份文件
func CleanupBackup(binaryPath string) {
	backup := binaryPath + ".bak"
	os.Remove(backup)
}

// CopyFile 复制文件（导出复用点：_do_update 回滚复制等；P-20261109-5 起
// main.go CLI 离线换包路径已退役，不再有 main 侧调用方）
func CopyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}

func configDataDir() string {
	return config.DataDir()
}

// CleanupServeCache 清理超过 1 小时的跨平台二进制缓存
func CleanupServeCache(dataDir string) {
	tmpDir := filepath.Join(dataDir, "tmp")
	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "serve-") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if time.Since(info.ModTime()) > time.Hour {
			os.RemoveAll(filepath.Join(tmpDir, entry.Name()))
		}
	}
}

// 测试注入口（环境依赖探测的测试纪律）：服务上下文探测平台锁定（仅 Windows
// SCM 服务为真，非 Windows 恒否）、launchd 依赖 GOOS+ppid 宿主实况——单测
// 注入可控值。launchd 判定与页面重启链同口径（server/app RegisterRestart 的
// darwin && ppid==1）：非 darwin 一律否——ppid==1 在 Linux/Windows 语义完全
// 不同（init/SCM 服务），不可泛化
var (
	isServiceFn      = servicectx.IsService
	launchdManagedFn = func() bool { return runtime.GOOS == "darwin" && os.Getppid() == 1 }
)

// currentSuperviseForm 主进程侧监管形态探测（env 契约下发源）：判定链与页面
// 重启链同构——Windows 服务→launchd→其余 bare。systemd 形态不探测也不在
// 契约值域内：更新子进程自查 /proc/self/cgroup 且自查优先（restart.go
// superviseFromEnv），对 systemd 形态下发 bare 即可
func currentSuperviseForm() superviseForm {
	if isServiceFn() {
		return superviseWindowsService
	}
	if launchdManagedFn() {
		return superviseLaunchd
	}
	return superviseBare
}

// currentSuperviseFormFn 监管形态探测取值口（默认 currentSuperviseForm）：
// 单测注入以断言 env 契约按形态下发
var currentSuperviseFormFn = currentSuperviseForm

// origArgsFn 主进程原参数取值口（P-20261112-1-S2 argv 契约下发源）：bare/前台
// 形态换包后按原参数原样重启（历史只传 --serve --port 静默丢 --host/--data-dir
// 等，host 无 env 回写面全仓无读取——用户点名「直接 start 的必须用老参数原样
// 启动」）。os.Args[0] 是自身路径，新进程 argv[0] 由 currentBinary 权威替代，
// 故只下发 [1:]。取值口注入（环境依赖探测的测试纪律）——单测注入可控值
var origArgsFn = func() []string { return os.Args[1:] }

// updateSubprocessEnv 换包子进程 env 契约组装（纯函数便于单测断言，真实
// spawn 由 LaunchUpdateSubprocess 负责）：正名+旧名双写一个版本期（注释见
// LaunchUpdateSubprocess）+ 监管形态提示后置——Go 1.19+ exec 对重复键取末
// 值，外部预置的同名陈旧变量以本次探测下发为准。
// S2 增 argv 列式契约（envUpdateArgvN + envUpdateArgvPrefix 逐键承载
// origArgs）：逐键 env 天然免疫参数内空白/引号/分隔符歧义（长度前缀方案需
// 自拼编码，逐键即列式）；N=0（无参数）读侧按无契约回落，无需特殊形态。
// 可选字段无旧名双写（本字段诞生前不存在任何名字的下发）：旧主进程不下发、
// 旧 _do_update 忽略未知 env——跨版本双向矩阵安全
func updateSubprocessEnv(dataDir, version, prevVersion string, form superviseForm, origArgs []string) []string {
	env := append(os.Environ(),
		envUpdateDataDir+"="+dataDir,
		envUpdateVersion+"="+version,
		envUpdatePrevVer+"="+prevVersion,
		envUpdateDataDirOld+"="+dataDir,
		envUpdateVersionOld+"="+version,
		envUpdatePrevVerOld+"="+prevVersion,
		envUpdateSupervise+"="+string(form),
	)
	env = append(env, envUpdateArgvN+"="+strconv.Itoa(len(origArgs)))
	for i, arg := range origArgs {
		env = append(env, envUpdateArgvPrefix+strconv.Itoa(i)+"="+arg)
	}
	return env
}

// newUpdateCmd 组装换包子进程命令（不启动）。拆出便于单测断言 argv 与 env
// 契约注入——测试绝不真实 spawn 换包进程（launchUpdateSubprocessFn 注释
// 同款护栏）
func newUpdateCmd(currentBinary, newBinary string, port, pid int, dataDir, version, prevVersion string, form superviseForm, origArgs []string) *exec.Cmd {
	cmd := exec.Command(newBinary, "_do_update", currentBinary, newBinary, fmt.Sprintf("%d", port), fmt.Sprintf("%d", pid))
	cmd.Env = updateSubprocessEnv(dataDir, version, prevVersion, form, origArgs)
	return cmd
}

// LaunchUpdateSubprocess 启动 _do_update 子进程执行二进制替换。
// env 正名 CODECOMBO_UPDATE_* + 旧名 SIMPLE_CODING_UPDATE_* 双写一个版本期：
// 跨版本矩阵「旧中心二进制下载新包后以新二进制 _do_update 拉起」时 env 由
// 旧代码下发旧名，新代码 getenvOr 双读兜底（同版本子进程读正名）。
// P-20261112-1-S1 增发可选监管形态提示 CODECOMBO_UPDATE_SUPERVISE（缺省回落
// bare=旧对端行为不劣化，语义见 do_update.go 契约块）。
// P-20261112-1-S2 增发可选 argv 列式契约（origArgsFn=本进程 os.Args[1:]）：
// bare/前台形态换包后按原参数原样重启，见 updateSubprocessEnv
func LaunchUpdateSubprocess(currentBinary, newBinary string, port, pid int, dataDir, version, prevVersion string) error {
	return newUpdateCmd(currentBinary, newBinary, port, pid, dataDir, version, prevVersion, currentSuperviseFormFn(), origArgsFn()).Start()
}
