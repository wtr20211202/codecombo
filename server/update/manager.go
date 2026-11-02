package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/sysinfo"
)

// Status 更新状态
type Status string

const (
	StatusIdle        Status = "idle"
	StatusChecking    Status = "checking"
	StatusDownloading Status = "downloading"
	StatusReplacing   Status = "replacing"
	StatusRestarting  Status = "restarting"
	StatusSuccess     Status = "success"
	StatusFailed      Status = "failed"
	StatusRolledBack  Status = "rolled_back"
)

// UpdateResult 更新结果文件
type UpdateResult struct {
	Status          string `json:"status"`
	Version         string `json:"version"`
	PreviousVersion string `json:"previousVersion"`
	Error           string `json:"error,omitempty"`
	Timestamp       string `json:"timestamp"`
}

// UpdateStatusResult GetStatus 返回的状态快照
type UpdateStatusResult struct {
	Status   Status `json:"status"`
	Progress int64  `json:"progress"`
	Total    int64  `json:"total"`
	Version  string `json:"version"`
	ErrMsg   string `json:"errMsg"`
}

// ProgressCallback 下载进度回调
type ProgressCallback func(downloaded, total int64)

// Manager 更新管理器
type Manager struct {
	mu         sync.Mutex
	status     Status
	progress   int64
	total      int64
	version    string
	errMsg     string
	source     UpdateSource
	dataDir    string
	binaryPath string

	// 版本缓存
	cachedInfo    *ReleaseInfo
	cachedAt      time.Time
	cacheDuration time.Duration
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

// SetSource 设置更新源
func (m *Manager) SetSource(source UpdateSource) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.source = source
}

// GetStatus 获取当前更新状态
func (m *Manager) GetStatus() UpdateStatusResult {
	m.mu.Lock()
	defer m.mu.Unlock()
	return UpdateStatusResult{
		Status:   m.status,
		Progress: m.progress,
		Total:    m.total,
		Version:  m.version,
		ErrMsg:   m.errMsg,
	}
}

// CheckUpdate 检查更新（skipCache 为 true 时跳过缓存强制刷新）
func (m *Manager) CheckUpdate(ctx context.Context, currentVersion string) (*ReleaseInfo, error) {
	return m.CheckUpdateWithCache(ctx, currentVersion, false)
}

// CheckUpdateWithCache 检查更新，可选跳过缓存
func (m *Manager) CheckUpdateWithCache(ctx context.Context, currentVersion string, skipCache bool) (*ReleaseInfo, error) {
	m.mu.Lock()
	m.status = StatusChecking
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		if m.status == StatusChecking {
			m.status = StatusIdle
		}
		m.mu.Unlock()
	}()

	if m.source == nil {
		// 稳定原文收口 errmarkers 注册表（P-20261004-29）：api/system/update.go
		// 的 404 响应同串双发射点
		return nil, errors.New(errmarkers.UpdateSourceNotConfigured)
	}

	// 缓存命中（未过期且不强制跳过）
	if !skipCache && m.cachedInfo != nil && time.Since(m.cachedAt) < m.cacheDuration {
		return m.cachedInfo, nil
	}

	platform, arch := DetectPlatform()
	info, err := m.source.FetchLatest(ctx, platform, arch)
	if err != nil {
		// 请求失败时返回过期缓存
		if m.cachedInfo != nil {
			return m.cachedInfo, nil
		}
		return nil, err
	}

	m.mu.Lock()
	m.cachedInfo = info
	m.cachedAt = time.Now()
	m.mu.Unlock()
	return info, nil
}

// ErrNpmManaged npm 分发形态拒绝自更新（stable 文本进 errmarkers 注册表，
// update api 以 409 发射——包装器/前端按此文案给出 npm 更新指引）
var ErrNpmManaged = errors.New(errmarkers.UpdateNpmManaged)

// ApplyUpdate 执行更新（下载+启动子进程）
// Failed/RolledBack 视为可重试终态：上次失败不阻断本次（Reset 语义内联）
func (m *Manager) ApplyUpdate(ctx context.Context, info *ReleaseInfo, currentVersion string, port int, progressCB ProgressCallback) error {
	// npm 分发形态（P-20261102-2）：node_modules 里的文件归 npm 管——自更新
	// 原位替换会让 npm 版本记账漂移（下次 npm update 把旧版盖回来）。在动
	// 状态机之前就拒绝，错误面给出 npm 更新指引
	if IsNpmManaged(m.binaryPath) {
		return ErrNpmManaged
	}

	m.mu.Lock()
	if m.status != StatusIdle && m.status != StatusChecking && m.status != StatusFailed && m.status != StatusRolledBack {
		m.mu.Unlock()
		return fmt.Errorf("update already in progress: %s", m.status)
	}
	m.status = StatusDownloading
	m.progress = 0
	m.total = info.FileSize
	m.version = info.Version
	m.errMsg = ""
	m.mu.Unlock()

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
	if err := m.download(ctx, info.DownloadURL, newBinary, progressCB); err != nil {
		// 下载失败清理：半截文件与本次临时目录都不留给下次（重试从干净状态开始）
		os.RemoveAll(tmpDir)
		m.fail("download failed: " + err.Error())
		return err
	}

	_ = os.Chmod(newBinary, 0755)

	// 完整性/真实性校验（安全 backlog A5）：签名验签优先，其次 sha256 比对，
	// 两者皆无默认拒绝。校验失败即删除下载产物，不进入替换流程
	if err := verifyUpdate(newBinary, info); err != nil {
		os.RemoveAll(tmpDir)
		m.fail("update verification failed: " + err.Error())
		return fmt.Errorf("update verification failed: %w", err)
	}

	m.mu.Lock()
	m.status = StatusReplacing
	m.mu.Unlock()

	pid := os.Getpid()
	if err := LaunchUpdateSubprocess(m.binaryPath, newBinary, port, pid, m.dataDir, info.Version, currentVersion); err != nil {
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

// download 下载文件（带可选进度回调）。响应 ctx 取消与停滞检测
// downloadClient 下载专用：出站守卫 Transport（https + 拒绝内网/保留地址），
// 不设整体超时——大文件下载的停滞检测由下方 read 循环负责
var downloadClient = &http.Client{Transport: newSafeTransport()}

func (m *Manager) download(ctx context.Context, url, dest string, progressCB ProgressCallback) error {
	// 下载地址来自更新源 API 响应（非本地配置）：同样强制 https 公网，
	// 防响应被篡改后把二进制拉取指向内网/本机
	if err := ValidatePublicHTTPSURL(url); err != nil {
		return err
	}
	// 停滞看门狗：Body.Read 阻塞期间循环顶部的 lastProgress 检查永不执行（历史
	// 缺陷——检测点在阻塞读之前等于失效），由 watchdog 在 stall 超时后 cancel
	// 请求强制解开 Read，循环顶/读错误分支再区分「外层取消」与「停滞」
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

	watchdog := time.AfterFunc(downloadStallTimeout, cancel)
	defer watchdog.Stop()
	body := &stallResetBody{ReadCloser: resp.Body, reset: func() { watchdog.Reset(downloadStallTimeout) }}

	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()

	buf := make([]byte, 32*1024)
	var written int64
	var lastUpdate time.Time
	lastProgress := time.Now()
	for {
		// 响应取消 + 停滞检测兜底（看门狗触发时由下方分支给出准确报错）
		if err := dctx.Err(); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("download stalled: no data for %s", downloadStallTimeout)
		}
		if time.Since(lastProgress) > downloadStallTimeout {
			return fmt.Errorf("download stalled: no data for %s", downloadStallTimeout)
		}
		n, readErr := body.Read(buf)
		if n > 0 {
			if _, wErr := f.Write(buf[:n]); wErr != nil {
				return wErr
			}
			written += int64(n)
			lastProgress = time.Now()
			// 采样更新进度，避免频繁加锁
			if now := time.Now(); now.Sub(lastUpdate) > 200*time.Millisecond {
				m.mu.Lock()
				m.progress = written
				m.mu.Unlock()
				lastUpdate = now
				if progressCB != nil {
					progressCB(written, resp.ContentLength)
				}
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if dctx.Err() != nil {
				return fmt.Errorf("download stalled: no data for %s", downloadStallTimeout)
			}
			return readErr
		}
	}

	// 最终进度更新
	m.mu.Lock()
	m.progress = written
	m.mu.Unlock()
	if progressCB != nil {
		progressCB(written, resp.ContentLength)
	}
	return nil
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

// DownloadToFile 下载文件到指定路径（无进度回调）
func (m *Manager) DownloadToFile(ctx context.Context, url, dest string) error {
	return m.download(ctx, url, dest, nil)
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

// CopyFile 复制文件（导出，供 main.go 等复用）
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

// LaunchUpdateSubprocess 启动 _do_update 子进程执行二进制替换。
// env 正名 CODECOMBO_UPDATE_* + 旧名 SIMPLE_CODING_UPDATE_* 双写一个版本期：
// 跨版本矩阵「旧中心二进制下载新包后以新二进制 _do_update 拉起」时 env 由
// 旧代码下发旧名，新代码 getenvOr 双读兜底（同版本子进程读正名）
func LaunchUpdateSubprocess(currentBinary, newBinary string, port, pid int, dataDir, version, prevVersion string) error {
	cmd := exec.Command(newBinary, "_do_update", currentBinary, newBinary, fmt.Sprintf("%d", port), fmt.Sprintf("%d", pid))
	cmd.Env = append(os.Environ(),
		envUpdateDataDir+"="+dataDir,
		envUpdateVersion+"="+version,
		envUpdatePrevVer+"="+prevVersion,
		envUpdateDataDirOld+"="+dataDir,
		envUpdateVersionOld+"="+version,
		envUpdatePrevVerOld+"="+prevVersion,
	)
	return cmd.Start()
}
