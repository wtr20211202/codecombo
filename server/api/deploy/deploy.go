package deploy

import (
	"context"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"codecombo/server/api/remote"
	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/deploy"
	"codecombo/server/ftpclient"
	"codecombo/server/sshclient"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// deployerInfoResp 前端展示用
type deployerInfoResp struct {
	ID            string             `json:"id"`
	Name          string             `json:"name"`
	Category      string             `json:"category"`
	Description   string             `json:"description"`
	DependsOn     []string           `json:"dependsOn"`
	Steps         []string           `json:"steps"`
	AllowMultiple bool               `json:"allowMultiple"`
	ParamsSchema  []deploy.ParamSpec `json:"paramsSchema"`
}

// ListDeployers 列出所有注册的 Deployer
func ListDeployers(c *gin.Context) {
	all := deploy.List()
	out := make([]deployerInfoResp, 0, len(all))
	for _, d := range all {
		out = append(out, deployerInfoResp{
			ID:            d.ID(),
			Name:          d.Name(),
			Category:      d.Category(),
			Description:   d.Description(),
			DependsOn:     nonNilStrings(d.DependsOn()),
			Steps:         nonNilStrings(d.Steps()),
			AllowMultiple: d.AllowMultiple(),
			ParamsSchema:  nonNilParams(d.ParamsSchema()),
		})
	}
	c.JSON(http.StatusOK, gin.H{"data": out})
}

// nonNilStrings 把 nil 切片转空切片，避免 JSON 序列化为 null 导致前端迭代报错
func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// nonNilParams 同上，针对 ParamSpec 切片
func nonNilParams(p []deploy.ParamSpec) []deploy.ParamSpec {
	if p == nil {
		return []deploy.ParamSpec{}
	}
	return p
}

// platformBinaryResp 已发现的本地二进制
type platformBinaryResp struct {
	FileName  string `json:"fileName"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	SizeBytes int64  `json:"sizeBytes"`
}

// ScanBinaries 扫描本地二进制目录，返回发现的平台列表
func ScanBinaries(c *gin.Context) {
	cfg, err := store.Get().DeployConfig.Get()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "scan binaries failed", err)
		return
	}
	if cfg.BinaryDir == "" {
		c.JSON(http.StatusOK, gin.H{"data": []platformBinaryResp{}})
		return
	}
	info, err := os.Stat(cfg.BinaryDir)
	if err != nil || !info.IsDir() {
		c.JSON(http.StatusOK, gin.H{"data": []platformBinaryResp{}})
		return
	}
	entries, err := os.ReadDir(cfg.BinaryDir)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "scan binaries failed", err)
		return
	}
	out := make([]platformBinaryResp, 0)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		// 产物名双认（P-20261025-1）：codecombo-* 正名优先，simple-coding-* 旧名
		// 回落（管理员 dist 目录过渡期混存两代名）
		if !strings.HasPrefix(name, "codecombo-") && !strings.HasPrefix(name, "simple-coding-") {
			continue
		}
		osName, arch := parsePlatformFromBinaryName(name)
		if osName == "" {
			continue
		}
		fi, _ := e.Info()
		out = append(out, platformBinaryResp{
			FileName: name, OS: osName, Arch: arch, SizeBytes: fi.Size(),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].FileName < out[j].FileName
	})
	c.JSON(http.StatusOK, gin.H{"data": out})
}

// parsePlatformFromBinaryName 从文件名解析 os/arch
// 输入形如 codecombo-linux-amd64 / simple-coding-linux-amd64（旧名回落）、
// codecombo-darwin-arm64.exe 等
func parsePlatformFromBinaryName(name string) (string, string) {
	name = strings.TrimPrefix(name, "codecombo-")
	name = strings.TrimPrefix(name, "simple-coding-")
	name = strings.TrimSuffix(name, ".exe")
	parts := strings.Split(name, "-")
	if len(parts) < 2 {
		return "", ""
	}
	// darwin-arm64 → ["darwin", "arm64"]；windows-amd64 → ["windows", "amd64"]
	return parts[0], parts[1]
}

// TestRemoteHostConnection 测试连接 + 返回 whoami/uname 信息
// FTP 主机：登录成功 + 拿当前目录即为连通（无 SSH 执行能力）
func TestRemoteHostConnection(c *gin.Context) {
	id := c.Param("id")
	rh, err := store.Get().RemoteHost.Get(id)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "remote host not found", err)
		return
	}
	// 手动测试连接后乐观刷新在线状态缓存（徽章立即反映真实连通性）
	defer remote.NotifyStatusProbe()
	probeRemoteHost(c, id, rh)
}

// TestRemoteHostConnectionByParams POST /api/remotehosts/test
// 用「未保存」的表单参数直接测试连通性（新增/编辑远程主机弹窗的「测试连接」按钮）：
// body 传 host/port/user/protocol/authType 与凭据（sshKeyId 引用已有密钥，pem 明文），
// 编辑已有主机时附 id——凭据留空按「保持原值」语义回填已存凭据（与编辑保存一致，
// 复制主机改 IP 后直接测试不再误报 password is empty）。连接目标与有效凭据均与已存
// 一致时按 id 探测（真实认证成功升级在线徽章），其余情况不写状态缓存。
// 探测语义与已保存主机的 TestRemoteHostConnection 完全一致
func TestRemoteHostConnectionByParams(c *gin.Context) {
	var req struct {
		ID         string `json:"id"`
		Host       string `json:"host"`
		Port       int    `json:"port"`
		User       string `json:"user"`
		Protocol   string `json:"protocol"`
		AuthType   string `json:"authType"`
		Password   string `json:"password"`
		SshKeyID   string `json:"sshKeyId"`
		PemContent string `json:"pemContent"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request body", err)
		return
	}
	if strings.TrimSpace(req.Host) == "" || strings.TrimSpace(req.User) == "" {
		shared.Error(c, http.StatusBadRequest, "host and user are required", nil)
		return
	}
	if req.Port <= 0 {
		req.Port = 22
	}
	if req.AuthType == "" {
		req.AuthType = "password"
	}
	// 凭据留空 = 保持原值（与更新保存同语义）：回填已存凭据再探测；
	// 回填后与已存主机完全一致 → 等价按 id 探测
	probeID := ""
	if req.ID != "" {
		if stored, err := store.Get().RemoteHost.Get(req.ID); err == nil {
			if req.Password == "" {
				req.Password = stored.Password
			}
			if req.PemContent == "" {
				req.PemContent = stored.PemContent
			}
			if req.SshKeyID == "" {
				req.SshKeyID = stored.SshKeyID
			}
			if req.Host == stored.Host && req.Port == stored.Port && req.User == stored.User &&
				req.Protocol == stored.Protocol && req.AuthType == stored.AuthType &&
				req.Password == stored.Password && req.PemContent == stored.PemContent &&
				req.SshKeyID == stored.SshKeyID {
				probeID = req.ID
				defer remote.NotifyStatusProbe()
			}
		}
	}
	rh := config.RemoteHost{
		Host: req.Host, Port: req.Port, User: req.User,
		Protocol: req.Protocol, AuthType: req.AuthType,
		Password: req.Password, SshKeyID: req.SshKeyID, PemContent: req.PemContent,
	}
	probeRemoteHost(c, probeID, &rh)
}

// probeRemoteHost 连通性探测公共实现（id 非空时标记 auth-ok 供在线徽章缓存用）。
// FTP：登录 + 取当前目录；SSH：解析凭据 → 拨号 → whoami/uname
func probeRemoteHost(c *gin.Context, id string, rh *config.RemoteHost) {
	if rh.IsFTP() {
		fc, ferr := ftpclient.Dial(ftpclient.ConnectOptions{
			Host: rh.Host, Port: rh.Port, User: rh.User,
			Password: rh.Password, Timeout: 15 * time.Second,
		})
		if ferr != nil {
			c.JSON(http.StatusOK, remote.TestRemoteHostConnectionResp{Error: ferr.Error()})
			return
		}
		defer func() { _ = fc.Quit() }()
		if id != "" {
			remote.MarkAuthOK(id)
		}
		pwd, perr := fc.CurrentDir()
		if perr != nil {
			c.JSON(http.StatusOK, remote.TestRemoteHostConnectionResp{OK: true, OS: "ftp"})
			return
		}
		c.JSON(http.StatusOK, remote.TestRemoteHostConnectionResp{OK: true, OS: "ftp", Whoami: pwd})
		return
	}

	if err := remote.ResolveRemoteHostAuth(rh); err != nil {
		c.JSON(http.StatusOK, remote.TestRemoteHostConnectionResp{Error: err.Error()})
		return
	}
	client, err := sshclient.Dial(sshclient.ConnectOptions{
		Host: rh.Host, Port: rh.Port, User: rh.User,
		Auth:            sshclient.AuthMethodFor(rh.AuthType, rh.Password, rh.PemContent),
		SkipHostKeyTOFU: rh.HostKeyVerifyDisabled,
	})
	if err != nil {
		c.JSON(http.StatusOK, remote.TestRemoteHostConnectionResp{Error: err.Error()})
		return
	}
	defer client.Close()
	if id != "" {
		remote.MarkAuthOK(id)
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()
	out, _ := client.Exec(ctx, sshclient.ExecOptions{Cmd: "whoami && uname -s && uname -m"}, nil)
	resp := remote.TestRemoteHostConnectionResp{OK: out != nil && out.ExitCode == 0}
	if resp.OK && len(out.Stdout) >= 3 {
		resp.Whoami = strings.TrimSpace(out.Stdout[0])
		resp.OS = strings.TrimSpace(out.Stdout[1])
		resp.Arch = strings.TrimSpace(out.Stdout[2])
	}
	if !resp.OK {
		resp.Error = "command failed"
	}
	c.JSON(http.StatusOK, resp)
}
