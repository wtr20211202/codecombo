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
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// CheckUpdate 检查更新
func CheckUpdate(c *gin.Context) {
	mgr := update.GetManager()
	info, err := mgr.CheckUpdate(c.Request.Context(), buildVersion)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"data": model.CheckUpdateResponse{
			CurrentVersion: buildVersion,
			HasUpdate:      false,
		}})
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": model.CheckUpdateResponse{
		CurrentVersion: buildVersion,
		LatestVersion:  info.Version,
		HasUpdate:      update.HasUpdate(buildVersion, info.Version),
		Changelog:      info.Changelog,
		DownloadURL:    info.DownloadURL,
		FileSize:       info.FileSize,
	}})
}

// updateRetryable 终态失败可重试：Failed/RolledBack 不算"进行中"，
// 否则一次失败后用户再点更新会一直 409（只能手动清状态）
func updateRetryable(st update.UpdateStatusResult) bool {
	return st.Status == update.StatusIdle || st.Status == update.StatusChecking ||
		st.Status == update.StatusFailed || st.Status == update.StatusRolledBack
}

// ApplyUpdate 执行更新
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

	if err := mgr.ApplyUpdate(c.Request.Context(), info, buildVersion, port, nil); err != nil {
		// npm 分发形态（P-20261102-2）：node_modules 归 npm 管，自更新拒绝
		// 409 + 注册表稳定文案（前端 KNOWN_ERROR_I18N 映射双语指引）。检查更新
		// 不拦——npm 用户仍能在 UI 看到新版本，只是应用动作换指引
		if errors.Is(err, update.ErrNpmManaged) {
			shared.Error(c, http.StatusConflict, err.Error(), nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "Update operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "update started"})
}

// GetUpdateStatus 查询更新状态
func GetUpdateStatus(c *gin.Context) {
	mgr := update.GetManager()
	st := mgr.GetStatus()

	resp := model.UpdateStatusResponse{
		Status:   string(st.Status),
		Progress: st.Progress,
		Total:    st.Total,
		Version:  st.Version,
		Error:    st.ErrMsg,
	}

	// 终态或空闲时检查结果文件
	switch st.Status {
	case update.StatusIdle, update.StatusSuccess, update.StatusFailed, update.StatusRolledBack:
		if result, _ := update.LoadUpdateResult(config.DataDir()); result != nil {
			resp.Result = result.Status
			resp.ResultError = result.Error
			resp.Version = result.Version
		}
	}

	c.JSON(http.StatusOK, gin.H{"data": resp})
}

// DeleteUpdateStatus 前端确认已读取更新结果
func DeleteUpdateStatus(c *gin.Context) {
	_ = update.ClearUpdateResult(config.DataDir())
	update.GetManager().Reset()
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
