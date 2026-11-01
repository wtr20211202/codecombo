package sync

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"strings"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 配对密钥（P-20261024-3 方案③）：手动携密同步的端到端加密根。32B 随机，
// 双端各自 master-key 静态加密落盘（instance store Save 链 EncryptToken 同款）；
// 交换协议 = 与实例 Token 同通道的人工抄录（对端实例页同屏展示 pairing 码，
// 用户抄到本端录入——out-of-band 不走网络，配对窗口 MITM 无从截获）。
//
// 职责分离：认证用实例 Token（Bearer），加密用 pairing key（HKDF 派生会话钥）
// ——Token 泄露不等于凭据明文泄露。任一端重置（rotate/删除）即需重新配对：
// pairFp 变更后旧信封对端解不开（统一拒绝文案），UI 以 pairFp 不一致提示重录。
//
// API 面纪律：pairing 码明文只在「生成/轮换」响应时刻一次性出现，此后任何
// 读面只出 pairFp 短指纹（SHA-256 前 8 字节 hex，识别/双端核对用，非机密）。

// pairingKeyBytes 配对密钥字节数（AES-256 根）
const pairingKeyBytes = 32

// PairFp 配对密钥短指纹（16 hex 字符）。双端核对短码与信封钥选择器同源：
// 信封 header 携 pairFp，收端按指纹在本地配对钥表中选钥（实例条目 ID 两端
// 各自命名空间不互通，指纹是唯一跨端稳定键）
func PairFp(pairingKey []byte) string {
	sum := sha256.Sum256(pairingKey)
	return hex.EncodeToString(sum[:8])
}

// normalizePairingCode 配对码录入归一：大小写不敏感、任意分隔符（空格/连字符）
// 剥离——抄录仪式的人因容错。返回空串 = 形态非法
func normalizePairingCode(code string) string {
	code = strings.ToLower(strings.TrimSpace(code))
	if code == "" {
		return ""
	}
	var b strings.Builder
	for _, r := range code {
		if r == '-' || r == ' ' || r == '\t' {
			continue
		}
		b.WriteRune(r)
	}
	out := b.String()
	// hex 64 字符（32B）；录入期校验防笔误静默成不可解密钥（双端到携密时
	// 才发现 = 最差的失败时机）
	if len(out) != pairingKeyBytes*2 {
		return ""
	}
	if _, err := hex.DecodeString(out); err != nil {
		return ""
	}
	return out
}

// genPairingCode 生成新配对密钥：code = hex 64 字符 8 位分组展示形态，raw = 原始字节
func genPairingCode() (code string, raw []byte, err error) {
	raw = make([]byte, pairingKeyBytes)
	if _, err = rand.Read(raw); err != nil {
		return "", nil, err
	}
	h := hex.EncodeToString(raw)
	var groups []string
	for i := 0; i < len(h); i += 8 {
		groups = append(groups, h[i:i+8])
	}
	return strings.Join(groups, "-"), raw, nil
}

// auditPairing 配对动作审计（只记 pairFp/动作/对端名——配对码明文绝不如账）
func auditPairing(c *gin.Context, action, result, detail string) {
	middleware.AuditAppend(c, store.AuditEvent{
		Action: action, Result: result, IP: c.ClientIP(), Detail: detail,
	})
}

// ── handlers（编排面：前端解锁令牌；generate 入 AgentGuard 高危表——配对钥
// 轮换是携密信任根变更，agent 不得代操作，手册登记纯人工纪律）──

// GetPairingStatus GET /api/sync/pairing —— 全部远程实例的配对状态（无明文钥）
func GetPairingStatus(c *gin.Context) {
	insts, err := store.Get().Instance.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "instance list failed", err)
		return
	}
	states, _ := store.Get().CredSync.List()
	byID := map[string]store.CredSyncState{}
	for _, s := range states {
		byID[s.InstanceID] = s
	}
	type pairingRow struct {
		InstanceID     string `json:"instanceId"`
		Name           string `json:"name"`
		URL            string `json:"url"`
		Paired         bool   `json:"paired"`
		PairFp         string `json:"pairFp,omitempty"`
		CertVerified   bool   `json:"certVerified"`
		CertVerifiedAt string `json:"certVerifiedAt,omitempty"`
		// PeerCertFp 本端钉扎的对端证书指纹（TOFU 首连记录；首次携密核对仪式
		// 的本端比对数据源——与对端 certinfo 自报指纹对表。HTTP 对端/未连接为空）
		PeerCertFp string `json:"peerCertFp,omitempty"`
		// LastSyncAt / LastDirection / LastMeta 上次携密同步（同步中心展示面）
		LastSyncAt    string `json:"lastCredSyncAt,omitempty"`
		LastDirection string `json:"lastCredDirection,omitempty"`
		LastMeta      string `json:"lastCredMeta,omitempty"`
	}
	out := make([]pairingRow, 0, len(insts))
	for _, inst := range insts {
		if inst.IsLocal || inst.PairingKey == "" {
			continue
		}
		raw, derr := config.DecryptToken(inst.PairingKey)
		if derr != nil || raw == "" {
			continue // 钥不可解（数据目录搬迁等）：按未配对处置，不炸清单
		}
		row := pairingRow{
			InstanceID: inst.ID, Name: inst.Name, URL: inst.URL,
			Paired: true, PairFp: PairFp([]byte(raw)),
		}
		// 钉扎指纹查表（尽力而为：URL 解析失败/未 pin 过留空，仪式面对空态
		// 如实呈现「尚未连接或无 TLS」）
		if u, perr := url.Parse(inst.URL); perr == nil && u.Hostname() != "" {
			if fp, ok, _ := store.Get().PeerCert.GetFingerprint(u.Hostname()); ok {
				row.PeerCertFp = fp
			}
		}
		if s, ok := byID[inst.ID]; ok {
			row.CertVerified = !s.CertVerifiedAt.IsZero()
			if !s.CertVerifiedAt.IsZero() {
				row.CertVerifiedAt = s.CertVerifiedAt.Format(time.RFC3339)
			}
			if !s.LastSyncAt.IsZero() {
				row.LastSyncAt = s.LastSyncAt.Format(time.RFC3339)
				row.LastDirection = s.LastDirection
				row.LastMeta = s.LastMeta
			}
		}
		out = append(out, row)
	}
	c.JSON(http.StatusOK, gin.H{"data": out})
}

// PostPairingGenerate POST /api/sync/pairing/:instanceId/generate —— 生成/轮换
// 配对密钥，响应一次性携带明文配对码（展示后不可再取；轮换即重置仪式态）
func GeneratePairing(c *gin.Context) {
	inst, ok := findInstance(c.Param("instanceId"))
	if !ok || inst.IsLocal {
		shared.Error(c, http.StatusNotFound, "instance not found", nil)
		return
	}
	code, raw, err := genPairingCode()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "generate pairing code failed", err)
		return
	}
	// 规范形态统一：落盘与指纹恒以 64 位 hex 字符串字节为钥材料（与 SetPairing
	// 录入链同形态——配对码 A 生成侧与 B 录入侧的 pairFp 必须同源可比）
	inst.PairingKey = hex.EncodeToString(raw)
	inst.UpdatedAt = time.Now().Format(time.RFC3339)
	if err := store.Get().Instance.Save(inst); err != nil {
		shared.Error(c, http.StatusInternalServerError, "save pairing key failed", err)
		return
	}
	fp := PairFp([]byte(inst.PairingKey))
	// 轮换后仪式态重置：新钥 = 新信任根，旧核对态/序号水位作废（防旧水位
	// 吞新钥低序号信封的重放窗口）
	_ = store.Get().CredSync.Delete(inst.ID)
	auditPairing(c, store.AuditSyncCred, store.AuditResultSuccess,
		"pairing=rotate pairFp="+fp+" peer="+inst.Name)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"pairingCode": code, "pairFp": fp,
	}})
}

// PostPairingSet PUT /api/sync/pairing/:instanceId —— 录入对端抄来的配对码
// （人工抄录通道的本端落点； 录入成功即配对成立，仪式态清零待首携核对）
func SetPairing(c *gin.Context) {
	var req struct {
		Code string `json:"code" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "code required", nil)
		return
	}
	inst, ok := findInstance(c.Param("instanceId"))
	if !ok || inst.IsLocal {
		shared.Error(c, http.StatusNotFound, "instance not found", nil)
		return
	}
	norm := normalizePairingCode(req.Code)
	if norm == "" {
		shared.Error(c, http.StatusBadRequest, "invalid pairing code format (expect 64 hex chars)", nil)
		return
	}
	inst.PairingKey = norm
	inst.UpdatedAt = time.Now().Format(time.RFC3339)
	if err := store.Get().Instance.Save(inst); err != nil {
		shared.Error(c, http.StatusInternalServerError, "save pairing key failed", err)
		return
	}
	_ = store.Get().CredSync.Delete(inst.ID)
	auditPairing(c, store.AuditSyncCred, store.AuditResultSuccess,
		"pairing=set pairFp="+PairFp([]byte(norm))+" peer="+inst.Name)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"pairFp": PairFp([]byte(norm))}})
}

// DeletePairing DELETE /api/sync/pairing/:instanceId —— 解除配对（双端对称
// 语义：本端删除后携密路径即拒绝；对端侧 pairFp 失配同样拒绝——重置即需
// 重新配对确认，提案风险节口径）
func ClearPairing(c *gin.Context) {
	inst, ok := findInstance(c.Param("instanceId"))
	if !ok || inst.IsLocal {
		shared.Error(c, http.StatusNotFound, "instance not found", nil)
		return
	}
	inst.PairingKey = ""
	inst.UpdatedAt = time.Now().Format(time.RFC3339)
	if err := store.Get().Instance.Save(inst); err != nil {
		shared.Error(c, http.StatusInternalServerError, "clear pairing key failed", err)
		return
	}
	_ = store.Get().CredSync.Delete(inst.ID)
	auditPairing(c, store.AuditSyncCred, store.AuditResultSuccess,
		"pairing=clear peer="+inst.Name)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"cleared": true}})
}

// pairingKeyOf 本端某对端条目的配对钥（解密后明文）；未配对返回 nil
func pairingKeyOf(inst config.InstanceConfig) []byte {
	if inst.PairingKey == "" {
		return nil
	}
	raw, err := config.DecryptToken(inst.PairingKey)
	if err != nil || raw == "" {
		return nil
	}
	return []byte(raw)
}

// pairingByFp 全部远程实例条目按 pairFp 索引（收端按信封指纹选钥的唯一入口；
// 短指纹 8 字节碰撞面在「个位级实例数×同钥唯一性」假设下可忽略，命中多条
// 视为配置异常拒绝服务——不静默取第一条）
func pairingByFp() (map[string][]byte, bool) {
	insts, err := store.Get().Instance.List()
	if err != nil {
		return nil, false
	}
	out := map[string][]byte{}
	for _, inst := range insts {
		if inst.IsLocal {
			continue
		}
		raw := pairingKeyOf(inst)
		if raw == nil {
			continue
		}
		fp := PairFp(raw)
		if _, dup := out[fp]; dup {
			return nil, false // 同指纹多钥：拒服务不猜
		}
		out[fp] = raw
	}
	return out, true
}
