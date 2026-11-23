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
	"log/slog"
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
			// 安装形态旗标（P-20261113-4-S1）：npm 装法点更新必被 409 拒，与检查
			// 是否成功无关——失败路径同样如实携带
			NpmManaged: mgr.NpmManaged(),
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
		ReleaseURL:     info.ReleaseURL,
		// npm 分发形态（P-20261113-4-S1）：检查端点不被 npm 门控（npm 用户照常
		// 看到新版本徽标），形态旗标随响应透出、面板据此主动提示「更新请走 npm」
		//——不在点更新被 409 拦下时才后知后觉。判定与 ApplyUpdate 拒绝闸同源
		//（mgr.NpmManaged → IsNpmManaged）
		NpmManaged: mgr.NpmManaged(),
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
	c.JSON(http.StatusOK, gin.H{"data": updateStatusData()})
}

// updateStatusData 更新状态全字段投影（GET /updates/status 与诊断包共用——
// 诊断包不另造更新状态读路径，两处形态天然同源）。
// 终态或空闲时并读结果文件（update-result.json 的 Status/Error/Timestamp/
// Version 覆盖内存态）：结果文件是跨重启的持久证据，内存态只在本次进程内有效
func updateStatusData() model.UpdateStatusResponse {
	mgr := update.GetManager()
	st := mgr.GetStatus()

	resp := model.UpdateStatusResponse{
		Status:       string(st.Status),
		Progress:     st.Progress,
		Total:        st.Total,
		ResumedBytes: st.ResumedBytes,
		Version:      st.Version,
		Error:        st.ErrMsg,
		// 安装形态旗标（P-20261113-4-S1）：面板只消费 check 响应，status 面为
		// agent 经状态端点感知安装形态留口（npm 形态更新请走包管理器）
		NpmManaged: mgr.NpmManaged(),
		// 当前运行版本（P-20261122-5）：前端 unknown 结局据此判定「服务可达但
		// 版本<目标=更新未完成仍为旧版本」
		BuildVersion: buildVersion,
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
	return resp
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
	// 结果文件清不掉=下次 GET /updates/status 仍读到它（用户「已确认」后横幅
	// 复活，再点还是清不掉）；前端两处调用点都静默吞错，服务端日志是唯一
	// 诊断面（P-20261122-12 审计）。如实 500 而非假 200：受理闸门/mgr 状态
	// 一律不动（不声称已清除）。shared.Error 对非空 err 落 slog.Error，
	// 日志与响应一次收口（不重复打两行）
	if err := update.ClearUpdateResult(config.DataDir()); err != nil {
		shared.Error(c, http.StatusInternalServerError, "clear update result failed", err)
		return
	}
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
	if err := os.MkdirAll(tmpDir, 0755); err != nil {
		slog.Warn("create update temp dir failed", "dir", tmpDir, "err", err)
	}
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
	if err := os.Chmod(newBinary, 0755); err != nil {
		// POSIX 上无执行位的新二进制会让换包子进程起不来（现象是活性握手
		// 秒死，根因被掩盖）——此处留痕直指 chmod（P-20261122-12）
		slog.Warn("chmod update binary failed", "path", newBinary, "err", err)
	}

	cfg := store.Get().Settings.Get()
	port := cfg.Server.Port
	if port == 0 {
		port = 9999
	}

	pid := os.Getpid()
	// 活性握手（P-20261122-5）随 LaunchUpdateSubprocess 内置：spawn 后最多等
	// subprocessHandshakeDefault（10s）的证据窗——本请求同步承受该窗（失败路径
	// 最长约 10s，远低于前端该端点 5 分钟超时）。握手失败即中止：不触发下方
	// RestartViaHook（主进程不退出=服务维持安全态），500 带原因；devMode 下 err
	// 详情含 outcome 与 darwin quarantine 自救指引原文。
	// publicMsg 不写死「exited immediately」（P-20261122-9）：握手失败两形态——
	// 子进程已退出（exited(exit status N)/signal）与窗满仍无声（alive but silent，
	// 慢盘/大目录 EnsureDataDirMigrated 递归 merge 足以越过 10s）。写死前者是假话，
	// 统一按「未确认启动」措辞（真实死因在 err 详情与 update-subprocess.log）。
	// durable 判死留痕（主日志 + update-subprocess.log 裁决行）在
	// LaunchUpdateSubprocess 单一裁决点完成，本链与自更新链共用
	if err := launchSubprocessFn(exePath, newBinary, port, pid, config.DataDir(), "center", buildVersion); err != nil {
		os.Remove(newBinary)
		msg := "start update process failed: failed"
		if errors.Is(err, update.ErrSubprocessDied) {
			msg = "update subprocess did not confirm startup: failed"
		}
		shared.Error(c, http.StatusInternalServerError, msg, err)
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

// launchSubprocessFn 中心链换包子进程拉起取值口（默认
// update.LaunchUpdateSubprocess，活性握手 P-20261122-5 内置）：单测替换以覆盖
// 「握手失败中止」路径——测试绝不真实 spawn 换包进程（护栏同 update 包
// launchUpdateSubprocessFn 注入先例，manager_retry_test.go）
var launchSubprocessFn = update.LaunchUpdateSubprocess

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
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		slog.Warn("create serve-binary cache dir failed", "dir", cacheDir, "err", err)
	}
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
		if err := os.Rename(tmpFile, cacheFile); err != nil {
			os.Remove(tmpFile)
			// 下载成功但缓存落位失败：继续 c.File(cacheFile) 只会给出无解释的
			// 404（用户以为下载失败）——如实 500。日志含目标平台（rename 语义
			// 随平台异：Windows 跨卷/占用、POSIX 目录占位），响应侧传 nil err
			// 防同一失败打两行（P-20261122-12）
			slog.Error("serve-binary cache place failed", "targetOs", osParam, "arch", archParam, "err", err)
			shared.Error(c, http.StatusInternalServerError, "cache binary failed", nil)
			return
		}
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
