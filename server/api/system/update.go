package system

import (
	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/model"
	"codecombo/server/peercert"
	"codecombo/server/store"
	"codecombo/server/update"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// CheckUpdate 检查更新
func CheckUpdate(c *gin.Context) {
	mgr := update.GetManager()
	info, err := mgr.CheckUpdate(c.Request.Context(), buildVersion)
	if err != nil {
		// 检查失败细分（beta.2 误报实锚）：曾把一切错误吞成 hasUpdate:false，
		// 前端再依「分发源字段为空」猜成「未配置更新源」——stable 通道只有
		// prerelease 时的 404 也走了这条路，误导用户手填本已内置的源
		resp := model.CheckUpdateResponse{
			CurrentVersion: buildVersion,
			HasUpdate:      false,
		}
		switch {
		case errors.Is(err, update.ErrNoStableRelease):
			resp.ChannelEmpty = true
		case strings.Contains(err.Error(), errmarkers.UpdateSourceNotConfigured):
			resp.SourceMissing = true
		default:
			resp.CheckError = err.Error()
		}
		c.JSON(http.StatusOK, gin.H{"data": resp})
		return
	}
	if info == nil {
		// 坏源返回 nil,nil（err==nil 但无数据）：归入检查失败，防炸
		c.JSON(http.StatusOK, gin.H{"data": model.CheckUpdateResponse{
			CurrentVersion: buildVersion,
			HasUpdate:      false,
			CheckError:     "update source returned no data",
		}})
		return
	}

	resp := model.CheckUpdateResponse{
		CurrentVersion: buildVersion,
		LatestVersion:  info.Version,
		HasUpdate:      update.HasUpdate(buildVersion, info.Version),
		Changelog:      info.Changelog,
		DownloadURL:    info.DownloadURL,
		FileSize:       info.FileSize,
	}
	// 伴随校验资产拉取失败旗标（P-20261109-9，channelEmpty 同款 omitempty 先例）：
	// 只在有更新且已注定被校验拒绝时置位——「更新将被拒」提示必须是真话
	//（逃生门开着 / 另一校验资产可用时不报）；判定与 ApplyUpdate 下载前拒绝同源
	if resp.HasUpdate {
		if update.CompanionPreflight(info) != nil {
			resp.CompanionFetchFailed = true
			resp.CompanionFetchError = info.CompanionFetchError()
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": resp})
}

// updateRetryable 终态失败可重试：Failed/RolledBack 不算"进行中"，
// 否则一次失败后用户再点更新会一直 409（只能手动清状态）
func updateRetryable(st update.UpdateStatusResult) bool {
	return st.Status == update.StatusIdle || st.Status == update.StatusChecking ||
		st.Status == update.StatusFailed || st.Status == update.StatusRolledBack
}

// ApplyUpdate 受理更新（P-20261109-10 异步化）：快校验（在途闸门/版本检查/
// npm 形态）同步裁决，受理即 202——下载/校验/拉起换包子进程在后台跑完，进度
// 经 GET /updates/status 轮询，开始/失败/完成经通知中心入账（服务端单一发射）。
// 同步形态的历史缺陷（WriteTimeout 60s × axios 30s 全盲窗）见 Manager.StartUpdate。
// 伴随校验资产重拉后仍未取到（P-20261109-9）同属受理前拒绝：走下方通用 500，
// 响应原文即 errmarkers.UpdateCompanionFetchFailedTemplate 形态（三态原因 +
// 逃生门指引，前端 KNOWN_ERROR_I18N 本地化）
func ApplyUpdate(c *gin.Context) {
	mgr := update.GetManager()
	st := mgr.GetStatus()
	if !updateRetryable(st) {
		shared.Error(c, http.StatusConflict, fmt.Sprintf("update already in progress: %s", st.Status), nil)
		return
	}
	if st.Status == update.StatusFailed || st.Status == update.StatusRolledBack {
		mgr.Reset() // 清掉上次失败的 errMsg/进度，从干净状态重试
	}

	info, err := mgr.CheckUpdate(c.Request.Context(), buildVersion)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "check update failed: failed", err)
		return
	}

	if !update.HasUpdate(buildVersion, info.Version) {
		shared.Error(c, http.StatusBadRequest, "already up to date", nil)
		return
	}

	cfg := store.Get().Settings.Get()
	port := cfg.Server.Port
	if port == 0 {
		port = 9999
	}

	if err := mgr.StartUpdate(info, buildVersion, port); err != nil {
		// npm 分发形态（P-20261102-2）：node_modules 归 npm 管，自更新拒绝
		// 409 + 注册表稳定文案（前端 KNOWN_ERROR_I18N 映射双语指引）。检查更新
		// 不拦——npm 用户仍能在 UI 看到新版本，只是应用动作换指引。
		// 在途闸门竞态（上方 GetStatus 与受理之间被并发请求抢先受理）同 409
		if errors.Is(err, update.ErrNpmManaged) || errors.Is(err, update.ErrUpdateInProgress) {
			shared.Error(c, http.StatusConflict, err.Error(), nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "Update operation failed", err)
		return
	}

	// 202 Accepted：已受理、在后台进行（CLI `codecombo update` 同认 200/202）。
	// 版本取状态机受理值：受理前的伴随重拉（P-20261109-9）可能换成比上方缓存
	// 检查更新的 release；状态机未带版本（受理后被并发清状态的极窄窗）回落 info
	accepted := info.Version
	if v := mgr.GetStatus().Version; v != "" {
		accepted = v
	}
	c.JSON(http.StatusAccepted, gin.H{"message": "update started", "version": accepted})
}

// GetUpdateStatus 查询更新状态
func GetUpdateStatus(c *gin.Context) {
	mgr := update.GetManager()
	st := mgr.GetStatus()

	resp := model.UpdateStatusResponse{
		Status:       string(st.Status),
		Progress:     st.Progress,
		Total:        st.Total,
		ResumedBytes: st.ResumedBytes,
		Version:      st.Version,
		Error:        st.ErrMsg,
	}

	// 终态或空闲时检查结果文件
	switch st.Status {
	case update.StatusIdle, update.StatusSuccess, update.StatusFailed, update.StatusRolledBack:
		if result, _ := update.LoadUpdateResult(config.DataDir()); result != nil {
			resp.Result = result.Status
			resp.ResultError = result.Error
			resp.ResultAt = result.Timestamp
			resp.Version = result.Version
		}
	}

	c.JSON(http.StatusOK, gin.H{"data": resp})
}

// GetUpdateProxyStatus 更新链出站档位只读透出（P-20261110-1 S6）：对更新目标
// （github.com 口径）当前生效的档位 explicit/env/sysdetect/direct + 生效代理地址 +
// 探测开关态 + 最近一次探测结果（地址/来源/时刻）。任何代理地址回显前脱敏
// userinfo（相对 GET /settings 无泄露增量）；?refresh=1 先按探测挂点语义即时探测
// 一次（写快照、非热路径；开关关仍零探测）。agent 代诊断「更新走哪条路」的原语；
// 鉴权姿态同 GET /updates/status、GET /settings（全局 api 组，无额外 token 门）
func GetUpdateProxyStatus(c *gin.Context) {
	refresh, _ := strconv.ParseBool(c.Query("refresh"))
	// 实时快照（探测结果随挂点刷新）：禁缓存，中间层/浏览器不得复用旧档位
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"data": update.CurrentProxyStatus(c.Request.Context(), refresh)})
}

// DeleteUpdateStatus 前端确认已读取更新结果。在途更新（下载/校验/替换/重启）
// 拒绝 409 不清（P-20261109-10）：Reset 会把下载中的状态机抹回 idle，受理闸门
// 随即放行并发的第二次更新——中心链「先 clearStatus 再拉取」与自更新跨标签
// 并发即此形态
func DeleteUpdateStatus(c *gin.Context) {
	mgr := update.GetManager()
	if st := mgr.GetStatus(); st.Status.InFlight() {
		shared.Error(c, http.StatusConflict, fmt.Sprintf("update already in progress: %s", st.Status), nil)
		return
	}
	_ = update.ClearUpdateResult(config.DataDir())
	mgr.Reset()
	c.JSON(http.StatusOK, gin.H{"message": "update status cleared"})
}

// ApplyUpdateFromCenter 子实例从中心实例拉取更新
// 推荐传 parentInstanceId：中心地址与凭据由本机存储解析（实例列表接口出于
// 安全不出 token，前端曾因此永远带不上凭据——中心锁定时必 423）。
// centerUrl/centerToken 仍兼容接收（旧客户端/手动脚本直填场景）
func ApplyUpdateFromCenter(c *gin.Context) {
	var req struct {
		CenterURL        string `json:"centerUrl"`
		CenterToken      string `json:"centerToken"`
		ParentInstanceID string `json:"parentInstanceId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Update operation failed", err)
		return
	}

	// 按上级实例 ID 从本机存储解析中心地址与凭据（单一事实源在服务端）
	if req.ParentInstanceID != "" {
		if instances, err := store.Get().Instance.List(); err == nil {
			for _, inst := range instances {
				if inst.ID == req.ParentInstanceID {
					req.CenterURL = inst.URL
					req.CenterToken = inst.Token
					break
				}
			}
		}
	}
	if req.CenterURL == "" {
		shared.Error(c, http.StatusBadRequest, "parentInstanceId or centerUrl required", nil)
		return
	}

	mgr := update.GetManager()
	st := mgr.GetStatus()
	if !updateRetryable(st) {
		shared.Error(c, http.StatusConflict, fmt.Sprintf("update already in progress: %s", st.Status), nil)
		return
	}
	if st.Status == update.StatusFailed || st.Status == update.StatusRolledBack {
		mgr.Reset()
	}

	// 校验中心地址可解析（http/https + host 非空）：畸形 URL 会让 NewRequest
	// 返回 nil，配 token 时 Header.Set 直接 nil 指针 panic。
	// 不用 ValidatePublicHTTPSURL：中心实例常部署在局域网，公网强校验会误伤
	u, perr := url.Parse(req.CenterURL)
	if perr != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		shared.Error(c, http.StatusBadRequest, "invalid centerUrl", nil)
		return
	}

	// 从中心下载二进制
	platform, arch := update.DetectPlatform()
	downloadURL := fmt.Sprintf("%s/api/updates/serve-binary?os=%s&arch=%s", strings.TrimRight(req.CenterURL, "/"), platform, arch)

	httpReq, nerr := http.NewRequest(http.MethodGet, downloadURL, nil)
	if nerr != nil {
		shared.Error(c, http.StatusBadRequest, "invalid centerUrl", nerr)
		return
	}
	if req.CenterToken != "" {
		httpReq.Header.Set("Authorization", "Bearer "+req.CenterToken)
	}

	// 实例间 TLS：默认 TOFU 指纹校验，开启 tlsVerifyPeer 后走系统信任库
	client := &http.Client{
		Timeout:   5 * time.Minute,
		Transport: &http.Transport{TLSClientConfig: peercert.TLSConfig()},
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "failed to download from center: failed", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		// 中心侧 423（锁定且 token 无效）/401（token 失效）是可自助修复的状态，
		// 转成 502 透传可行动提示。不能原样透传 423 状态码：前端 423 拦截器会
		// 误判为「本机被锁」而切换锁定屏
		if resp.StatusCode == http.StatusLocked || resp.StatusCode == http.StatusUnauthorized {
			shared.Error(c, http.StatusBadGateway,
				"center is locked or its API token is invalid: re-issue the token on the center instance, update this instance's token, or unlock the center",
				fmt.Errorf("center returned %d: %s", resp.StatusCode, string(body)))
			return
		}
		shared.Error(c, http.StatusInternalServerError, fmt.Sprintf("center returned %d: %s", resp.StatusCode, string(body)), nil)
		return
	}

	// 保存到临时文件
	tmpDir := filepath.Join(config.DataDir(), "tmp", "update-from-center")
	_ = os.MkdirAll(tmpDir, 0755)
	exePath := getExePath()
	newBinary := filepath.Join(tmpDir, filepath.Base(exePath))
	out, err := os.Create(newBinary)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "create temp file failed: failed", err)
		return
	}
	if _, err := io.Copy(out, resp.Body); err != nil {
		out.Close()
		os.Remove(newBinary)
		shared.Error(c, http.StatusInternalServerError, "write temp file failed: failed", err)
		return
	}
	out.Close()
	_ = os.Chmod(newBinary, 0755)

	cfg := store.Get().Settings.Get()
	port := cfg.Server.Port
	if port == 0 {
		port = 9999
	}

	pid := os.Getpid()
	if err := update.LaunchUpdateSubprocess(exePath, newBinary, port, pid, config.DataDir(), "center", buildVersion); err != nil {
		os.Remove(newBinary)
		shared.Error(c, http.StatusInternalServerError, "start update process failed: failed", err)
		return
	}

	// 触发本进程优雅退出：换包子进程 waitForProcess(本 pid) 依赖旧进程退出
	// 才继续替换二进制——漏掉这一步（历史缺陷）子进程等 30s 必超时标记 failed。
	// 500ms 延迟在 RestartViaHook 内，确保本 200 响应先写出
	update.RestartViaHook()

	c.JSON(http.StatusOK, gin.H{"message": "update from center started"})
}

// serveBinaryParamRe serve-binary 的 os/arch 查询参数白名单：仅字母数字，
// 杜绝把参数拼进本地分发路径时的路径穿越
var serveBinaryParamRe = regexp.MustCompile(`^[a-zA-Z0-9]{1,16}$`)

// localServeBinary 返回本地已有的对应平台二进制路径（不存在返回空串）。
// 查找顺序：
//  1. 远程部署配置的本地二进制目录（设置 → 远程部署 → 本地二进制目录，
//     文件名约定 codecombo-<os>-<arch>[.exe]，与部署扫描同一约定）——
//     管理员为远程部署维护的分发包直接复用，零额外配置；
//     simple-coding-<os>-<arch>[.exe] 旧名回落（过渡期目录混存两代名，P-20261025-1）
//  2. 专用分发目录 <DataDir>/serve-binaries/<os>-<arch>/{codecombo,simple-coding}
//     （显式覆盖用，新名优先旧名回落）
//
// 都没有则返回空串，由调用方继续走更新源
func localServeBinary(osParam, archParam string) string {
	if !serveBinaryParamRe.MatchString(osParam) || !serveBinaryParamRe.MatchString(archParam) {
		return ""
	}
	if cfg, err := store.Get().DeployConfig.Get(); err == nil && cfg.BinaryDir != "" {
		for _, prefix := range []string{"codecombo-", "simple-coding-"} {
			file := filepath.Join(cfg.BinaryDir, prefix+osParam+"-"+archParam)
			if fi, err := os.Stat(file); err == nil && fi.Mode().IsRegular() {
				return file
			}
			fileExe := file + ".exe"
			if fi, err := os.Stat(fileExe); err == nil && fi.Mode().IsRegular() {
				return fileExe
			}
		}
	}
	for _, base := range []string{"codecombo", "simple-coding"} {
		file := filepath.Join(config.DataDir(), "serve-binaries", osParam+"-"+archParam, base)
		if fi, err := os.Stat(file); err == nil && fi.Mode().IsRegular() {
			return file
		}
	}
	return ""
}

// ServeBinary 中心实例提供二进制下载
func ServeBinary(c *gin.Context) {
	osParam := c.Query("os")
	archParam := c.Query("arch")
	if osParam == "" || archParam == "" {
		shared.Error(c, http.StatusBadRequest, "os and arch parameters required", nil)
		return
	}

	platform, arch := update.DetectPlatform()
	if osParam == platform && archParam == arch {
		c.Header("Content-Type", "application/octet-stream")
		c.File(getExePath())
		return
	}

	// 跨平台：优先本地分发目录（离线/内网场景）——管理员把对应平台二进制预置到
	// <DataDir>/serve-binaries/<os>-<arch>/{codecombo,simple-coding}（新名优先），
	// 中心无需访问外网更新源
	// 即可给子实例出包；目录没有再走更新源
	if file := localServeBinary(osParam, archParam); file != "" {
		c.Header("Content-Type", "application/octet-stream")
		c.File(file)
		return
	}

	// 从更新源下载并缓存（文件名含版本号，发布新版自动失效）
	cfg := store.Get().Settings.Get()
	if cfg.Server.UpdateURL == "" {
		// 稳定原文收口 errmarkers 注册表（P-20261004-29），与 update.Manager 双发射点同串
		shared.Error(c, http.StatusNotFound, errmarkers.UpdateSourceNotConfigured, nil)
		return
	}

	source, srcErr := update.NewGitHubSource(cfg.Server.UpdateURL)
	if srcErr != nil {
		shared.Error(c, http.StatusBadRequest, "invalid update source: "+srcErr.Error(), nil)
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
	defer cancel()

	info, err := source.FetchLatest(ctx, osParam, archParam)
	if err != nil {
		shared.Error(c, http.StatusNotFound, fmt.Sprintf(errmarkers.CenterBinaryMissingTemplate, osParam, archParam), nil)
		return
	}

	cacheDir := filepath.Join(config.DataDir(), "tmp", fmt.Sprintf("serve-%s-%s", osParam, archParam))
	_ = os.MkdirAll(cacheDir, 0755)
	// 缓存文件名随正名（临时缓存可再生，CleanServeCache 滚动清理；旧名缓存
	// 文件成为孤儿后自然过期）
	cacheFile := filepath.Join(cacheDir, fmt.Sprintf("codecombo-v%s", info.Version))

	if _, err := os.Stat(cacheFile); err != nil {
		mgr := update.GetManager()
		tmpFile := cacheFile + ".downloading"
		if err := mgr.DownloadToFile(ctx, info.DownloadURL, tmpFile); err != nil {
			os.Remove(tmpFile)
			shared.Error(c, http.StatusInternalServerError, "download failed", nil)
			return
		}
		_ = os.Rename(tmpFile, cacheFile)
	}

	c.Header("Content-Type", "application/octet-stream")
	c.File(cacheFile)
}

// SetupUpdateSource 已迁入 update 模块 Init（roadmap M1.2/M2.1：启动期
// setter 式装配点消除），更新源改由内核 StartAll 前统一装配

var exePathCache string

func getExePath() string {
	if exePathCache == "" {
		exePath, _ := os.Executable()
		exePathCache = exePath
	}
	return exePathCache
}
