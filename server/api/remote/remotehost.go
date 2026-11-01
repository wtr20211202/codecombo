package remote

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/remoteterminal"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

func ListRemoteHosts(c *gin.Context) {
	hosts, err := store.Get().RemoteHost.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "remote host operation failed", err)
		return
	}
	for i := range hosts {
		hosts[i].Password = ""
		hosts[i].PemContent = ""
	}
	c.JSON(http.StatusOK, gin.H{"data": hosts})
}

type createRemoteHostReq struct {
	Name       string `json:"name" binding:"required"`
	Host       string `json:"host" binding:"required"`
	Port       int    `json:"port"`
	User       string `json:"user" binding:"required"`
	AuthType   string `json:"authType" binding:"required"`
	Protocol   string `json:"protocol"`
	Password   string `json:"password"`
	SshKeyID   string `json:"sshKeyId"`
	PemContent string `json:"pemContent"`
	// HostKeyVerifyDisabled per-host 关闭 SSH 主机密钥 TOFU 校验（内网完全信任场景）
	HostKeyVerifyDisabled bool `json:"hostKeyVerifyDisabled"`
}

func CreateRemoteHost(c *gin.Context) {
	var req createRemoteHostReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "remote host operation failed", err)
		return
	}
	rh, err := store.Get().RemoteHost.Create(config.RemoteHost{
		Name:                  req.Name,
		Host:                  req.Host,
		Port:                  req.Port,
		User:                  req.User,
		AuthType:              req.AuthType,
		Protocol:              req.Protocol,
		SshKeyID:              req.SshKeyID,
		Password:              req.Password,
		PemContent:            req.PemContent,
		HostKeyVerifyDisabled: req.HostKeyVerifyDisabled,
	})
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "remote host operation failed", err)
		return
	}
	// 审计入账：只记 host 摘要，密码/PEM 绝不入账
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditHostCreate,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s (%s@%s:%d)", req.Name, req.User, req.Host, req.Port),
	})
	rh.Password = ""
	rh.PemContent = ""
	c.JSON(http.StatusOK, gin.H{"data": rh})
}

type updateRemoteHostReq struct {
	Name       string `json:"name"`
	Host       string `json:"host"`
	Port       int    `json:"port"`
	User       string `json:"user"`
	AuthType   string `json:"authType"`
	Protocol   string `json:"protocol"`
	Password   string `json:"password"`
	SshKeyID   string `json:"sshKeyId"`
	PemContent string `json:"pemContent"`
	// HostKeyVerifyDisabled 用指针区分「未传」与「显式改回开启（false）」——
	// 布尔关开关必须能从 true 改回 false（其余字段沿用非零即更新的惯例）
	HostKeyVerifyDisabled *bool `json:"hostKeyVerifyDisabled"`
}

func UpdateRemoteHost(c *gin.Context) {
	id := c.Param("id")
	existing, err := store.Get().RemoteHost.Get(id)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "remote host operation failed", err)
		return
	}
	var req updateRemoteHostReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "remote host operation failed", err)
		return
	}
	prevHost, prevPort := existing.Host, existing.Port
	if req.Name != "" {
		existing.Name = req.Name
	}
	if req.Host != "" {
		existing.Host = req.Host
	}
	if req.Port != 0 {
		existing.Port = req.Port
	}
	if req.User != "" {
		existing.User = req.User
	}
	if req.AuthType != "" {
		existing.AuthType = req.AuthType
	}
	if req.Protocol != "" {
		existing.Protocol = req.Protocol
	}
	if req.Password != "" {
		existing.Password = req.Password
	}
	if req.SshKeyID != "" {
		existing.SshKeyID = req.SshKeyID
	}
	if req.PemContent != "" {
		existing.PemContent = req.PemContent
	}
	if req.HostKeyVerifyDisabled != nil {
		existing.HostKeyVerifyDisabled = *req.HostKeyVerifyDisabled
	}
	// 主机地址/端口变更后旧钉扎指纹成了孤儿（键为 host:port）：级联清除，
	// 新地址由下次连接重新 TOFU（与删除主机的级联同语义）
	if existing.Host != prevHost || existing.Port != prevPort {
		_ = store.Get().SSHHostKey.Delete(prevHost, prevPort)
	}
	if err := store.Get().RemoteHost.Save(*existing); err != nil {
		shared.Error(c, http.StatusBadRequest, "remote host operation failed", err)
		return
	}
	// 主机配置/凭据变更级联出池（P-20261005-159）：旧连接即时失效，下次借出
	// 按新配置重新拨号+TOFU 校验（与上方指纹孤儿清理的级联同语义）
	FlushPoolHost(id)
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditHostUpdate,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s (%s@%s:%d)", existing.Name, existing.User, existing.Host, existing.Port),
	})
	existing.Password = ""
	existing.PemContent = ""
	c.JSON(http.StatusOK, gin.H{"data": existing})
}

// DeleteRemoteHost 删除远程主机
func DeleteRemoteHost(c *gin.Context) {
	id := c.Param("id")
	// 先取记录（级联清理需要 host:port 摘要），再删除
	existing, err := store.Get().RemoteHost.Get(id)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "remote host operation failed", err)
		return
	}
	if err := store.Get().RemoteHost.Delete(id); err != nil {
		shared.Error(c, http.StatusNotFound, "remote host operation failed", err)
		return
	}
	// 级联关闭该主机的全部远程终端会话（凭据已删，残留连接只会拨号失败/挂着无用）
	if m := remoteterminal.GetManager(); m != nil {
		m.KillHostSessions(id)
	}
	// 级联关闭该主机的全部 SSH 隧道（P-20261004-5：凭据已删，残留隧道只会
	// 重连失败/白占监听口与上限名额）
	tunnels.CloseHost(id)
	// 级联出池（P-20261005-159：凭据已删，池内旧连接即时失效）
	FlushPoolHost(id)
	// 状态缓存同步失效，防止已删主机在 /status 里残留
	invalidateHostStatus(id)
	// 诊断历史级联清理（host 一文档，随主机同生命周期）
	store.Get().DiagHist.Delete(id)
	// git 对照的远端路径记忆级联清理（P-20261004-34，host+project 键控条目）
	store.Get().RemoteGitPath.DeleteHost(id)
	// SSH 主机指纹钉扎级联清理（TOFU 键为 host:port，重连自动重新首录）
	_ = store.Get().SSHHostKey.Delete(existing.Host, existing.Port)
	// 审计入账：Detail 拼「name (id)」（P-20261003-133 对象名自明化）——删除后
	// 凭据已消失，翻台账只见 id 无从对机；name 为用户输入有界（与上方 create/
	// update 点同口径不另设钳制），id 保留全量供按 id 检索旧台账/外部系统对账
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditHostDelete,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s (%s)", existing.Name, id),
	})
	// 通知中心即时回执（P-20261003-54）：与审计点同位旁挂——审计事后留证、
	// 通知即时感知（主机凭据整体消失属需立即知晓的安全事件）。类别 warning
	// 落入 webhook 默认 important 范围外发手机；标题含对象名，来源 IP 用
	// 审计同源的 ClientIP，零新增采集
	store.Get().Notification.Add(notification.Notification{
		Type:      "warning",
		Category:  notification.CategorySystem,
		TitleKey:  "audit.notify.hostDelete.title",
		BodyKey:   "audit.notify.hostDelete.body",
		Title:     fmt.Sprintf("远程主机已删除：%s", existing.Name),
		Body:      fmt.Sprintf("%s (%s@%s:%d) 已被删除，来源 IP %s", existing.Name, existing.User, existing.Host, existing.Port, c.ClientIP()),
		MsgParams: map[string]any{"name": existing.Name, "user": existing.User, "host": existing.Host, "port": existing.Port, "ip": c.ClientIP()},
	})
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// exportedSSHKey 导出文件里的 SSH 私钥条目（明文 PEM，随信封整体加密）。
// v2 起私钥随主机一并导出：sshKeyId 引用型主机换机迁移不再断链
type exportedSSHKey struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Fingerprint string `json:"fingerprint"`
	Algo        string `json:"algo"`
	PrivatePem  string `json:"privatePem"`
}

// exportPayload 信封加密前的明文载荷
type exportPayload struct {
	Hosts   []config.RemoteHost `json:"hosts"`
	SshKeys []exportedSSHKey    `json:"sshKeys,omitempty"`
}

// ExportRemoteHosts POST /api/remotehosts/export {passphrase} —— 导出全部主机（口令加密信封）
// 明文载荷（主机凭据 + 被引用的 SSH 私钥）整体经口令 AES-256-GCM 加密后下载，
// 文件本身不含任何明文凭据；安全性取决于口令强度，口令遗失无法恢复，前端需明确提示
func ExportRemoteHosts(c *gin.Context) {
	var req struct {
		Passphrase string `json:"passphrase" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "passphrase required", err)
		return
	}
	if len(req.Passphrase) < 8 {
		shared.Error(c, http.StatusBadRequest, "passphrase too short (min 8)", nil)
		return
	}
	hosts, err := store.Get().RemoteHost.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "remote host operation failed", err)
		return
	}
	// List 不解密（性能）；导出必须逐条 Get 拿明文凭据
	out := make([]config.RemoteHost, 0, len(hosts))
	keyIDs := make(map[string]struct{})
	for i := range hosts {
		h, err := store.Get().RemoteHost.Get(hosts[i].ID)
		if err != nil {
			continue
		}
		out = append(out, *h)
		if h.SshKeyID != "" {
			keyIDs[h.SshKeyID] = struct{}{}
		}
	}
	// 被引用的 SSH 私钥一并导出（按引用去重；单个取失败跳过，不影响整体）
	keys := make([]exportedSSHKey, 0, len(keyIDs))
	for id := range keyIDs {
		sk, err := store.Get().SshKey.GetByID(id)
		if err != nil {
			continue
		}
		pemStr, err := store.Get().SshKey.GetPrivatePem(id)
		if err != nil {
			continue
		}
		keys = append(keys, exportedSSHKey{
			ID:          sk.ID,
			Name:        sk.Name,
			Fingerprint: sk.Fingerprint,
			Algo:        sk.Algo,
			PrivatePem:  pemStr,
		})
	}
	payload, err := json.Marshal(exportPayload{Hosts: out, SshKeys: keys})
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "marshal export payload", err)
		return
	}
	env, err := config.EncryptWithPassphrase(payload, []byte(req.Passphrase))
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "encrypt export file", err)
		return
	}
	// 审计入账：整机凭据批量导出是高价值安全事件（只记数量，口令/凭据绝不入账）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditHostExport,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%d hosts, %d ssh keys", len(out), len(keys)),
	})
	name := "remotehosts-export-" + time.Now().Format("20060102-150405") + ".json"
	c.Header("Content-Type", "application/json")
	// 下载头统一净化 helper（P-20261003-109）：名字虽是服务端常量，头形态
	// （ASCII 兜底 + RFC 5987）与全站下载端点保持一致
	c.Header("Content-Disposition", shared.ContentDispositionFile(name))
	_, _ = c.Writer.Write(env)
}

// ImportRemoteHosts POST /api/remotehosts/import {file, passphrase?}
// file 为口令加密信封（需 passphrase 解密）或旧版明文主机数组（向后兼容）。
// 逐条重新落盘：ID 重建、凭据重新加密；SSH 私钥按指纹去重导入并重映射 sshKeyId。
// 返回导入数量；个别失败项回报，不中断整体
func ImportRemoteHosts(c *gin.Context) {
	var req struct {
		File       json.RawMessage `json:"file"`
		Passphrase string          `json:"passphrase"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || len(req.File) == 0 {
		shared.Error(c, http.StatusBadRequest, "invalid import payload", err)
		return
	}
	var hosts []config.RemoteHost
	var sshKeys []exportedSSHKey
	var env config.PassphraseEnvelope
	isEnvelope := json.Unmarshal(req.File, &env) == nil && env.Format == config.EnvelopeFormat
	if isEnvelope {
		if req.Passphrase == "" {
			shared.Error(c, http.StatusBadRequest, "passphrase required for encrypted export", nil)
			return
		}
		payload, err := config.DecryptWithPassphrase(req.File, []byte(req.Passphrase))
		if err != nil {
			// 稳定原文收口 errmarkers 注册表（P-20261004-29）：底层 crypto 错误
			// 原文不同串，此处是 handler 侧对外契约
			shared.Error(c, http.StatusBadRequest, errmarkers.WrongPassphraseExport, nil)
			return
		}
		var pl exportPayload
		if err := json.Unmarshal(payload, &pl); err != nil {
			shared.Error(c, http.StatusBadRequest, "invalid export payload", err)
			return
		}
		hosts, sshKeys = pl.Hosts, pl.SshKeys
	} else {
		var legacy []config.RemoteHost
		if err := json.Unmarshal(req.File, &legacy); err != nil {
			shared.Error(c, http.StatusBadRequest, "invalid import payload: not a host array or encrypted envelope", err)
			return
		}
		hosts = legacy
	}
	if len(hosts) == 0 {
		shared.Error(c, http.StatusBadRequest, "empty import payload", nil)
		return
	}
	if len(hosts) > 500 {
		shared.Error(c, http.StatusBadRequest, "too many hosts (max 500)", nil)
		return
	}
	// 先导 SSH 私钥：按指纹去重（同钥不重复入库），oldId → newId 映射供主机重定向。
	// 单个失败只记日志；引用它的主机保持旧引用，拨号前会被拦截提示重新录入
	keyIDMap := make(map[string]string, len(sshKeys))
	for _, k := range sshKeys {
		if k.ID == "" || k.PrivatePem == "" {
			continue
		}
		if exist, err := store.Get().SshKey.FindByFingerprint(k.Fingerprint); err == nil && exist != nil {
			keyIDMap[k.ID] = exist.ID
			continue
		}
		name := k.Name
		if name == "" {
			name = "imported"
		}
		pub, err := store.Get().SshKey.Import(name, []byte(k.PrivatePem))
		if err != nil {
			slog.Warn("remotehost import: skip invalid ssh key", "name", name, "error", err)
			continue
		}
		keyIDMap[k.ID] = pub.ID
	}
	imported, failed := 0, make([]gin.H, 0)
	for _, h := range hosts {
		if h.Name == "" || h.Host == "" || h.User == "" {
			failed = append(failed, gin.H{"name": h.Name, "error": "missing required field (name/host/user)"})
			continue
		}
		switch h.AuthType {
		case config.AuthTypePassword, config.AuthTypeSshKey, config.AuthTypePem:
		default:
			failed = append(failed, gin.H{"name": h.Name, "error": "invalid authType: " + h.AuthType})
			continue
		}
		if newID, ok := keyIDMap[h.SshKeyID]; ok {
			h.SshKeyID = newID
		}
		h.ID = "" // 重建 ID，避免与既有记录冲突
		h.CreatedAt = time.Time{}
		h.UpdatedAt = time.Time{}
		if _, err := store.Get().RemoteHost.Create(h); err != nil {
			failed = append(failed, gin.H{"name": h.Name, "error": err.Error()})
			continue
		}
		imported++
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditHostImport,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%d imported, %d failed", imported, len(failed)),
	})
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"imported": imported, "legacy": !isEnvelope, "failed": failed}})
}

// DuplicateRemoteHost POST /api/remotehosts/:id/duplicate —— 复制主机（XShell 式
// 会话管理：复制/粘贴会话）。凭据复制在服务端完成：Get 返回解密后的明文，
// Create 重新加密落盘；响应按惯例不回传敏感字段明文。
// 可选 body {name}：副本自定义名称，缺省原名 + " 副本"。
func DuplicateRemoteHost(c *gin.Context) {
	id := c.Param("id")
	src, err := store.Get().RemoteHost.Get(id)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "remote host not found", nil)
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	_ = c.ShouldBindJSON(&req) // body 可选

	dup := *src
	dup.ID = "" // Create 生成新 ID
	if name := strings.TrimSpace(req.Name); name != "" {
		dup.Name = name
	} else {
		dup.Name = src.Name + " 副本"
	}
	dup.CreatedAt = time.Time{}
	dup.UpdatedAt = time.Time{}
	created, err := store.Get().RemoteHost.Create(dup)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "remote host operation failed", err)
		return
	}
	created.Password = ""
	created.PemContent = ""
	// 复制=凭据再落一份（create 形态），与 CRUD 同组入账
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditHostCreate,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s (%s@%s:%d) [duplicate]", created.Name, created.User, created.Host, created.Port),
	})
	c.JSON(http.StatusCreated, gin.H{"data": created})
}

type TestRemoteHostConnectionResp struct {
	OK     bool   `json:"ok"`
	OS     string `json:"os,omitempty"`
	Arch   string `json:"arch,omitempty"`
	Whoami string `json:"whoami,omitempty"`
	Error  string `json:"error,omitempty"`
}
