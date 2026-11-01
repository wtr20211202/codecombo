package sync

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/notification"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// 手动携密同步——传输编排与双端仪式（P-20261024-3 方案①④⑤）。
//
// 红线分层（提案方案①）：凭据档只走本文件的专用通道——
//   - 发起：ExecuteRequest.IncludeCredentials（前端缺省不勾）+ 手动 source；
//   - 定时/自动：executeSyncWithCtx credGuard 服务端硬拒（CredSyncManualOnly，
//     配置漂移也打不破——SyncCron 模型无该字段，此处再兜一层）；
//   - 对端面：POST units?mode=cred（收）/ GET units?keys=credentials&cred=1
//     （服务）均为 E2E 信封通道，未经配对与核对一律拒绝或暂存不落盘。
//
// 双端确认仪式：发起端勾选+确认对话框（前端）；接收端首次接收弹确认——
// 未确认不落盘，暂存密文 TTL 10min（credStash），确认后凭水位重验落盘。
// 首次携密强制证书指纹短码双端核对（CertVerifiedAt，内网不豁免）。

// credStagedTTL 接收端暂存窗口：确认仪式的人类时滞预算（提案定稿 10min）
const credStagedTTL = 10 * time.Minute

// credSendMu 发送序号读改写互斥：pushCredUnit（手动 job 串行，execMu 已保证）
// 与 serveCredVault（pull 服务面，随对端请求并发）可能同时推进同一对端条目的
// SendSeq——重复序号会被收端水位拒绝（安全侧失败，重试自愈），互斥锁把这一
// 重试面也消掉
var credSendMu sync.Mutex

// ── 红线守卫 ──

// credGuard 执行前置守卫：定时/自动路径携密一律硬拒；手动路径要求对端已配对
// 且本端完成首次指纹核对（双端各自记账，发起端核对先行）
func credGuard(req ExecuteRequest, source string) error {
	if !req.IncludeCredentials {
		// 未勾选时 units 里出现凭据单元 = 客户端语义走私（标志是唯一开关，
		// 一致性在此收口）
		for _, k := range req.Units {
			if k == UnitCredentials {
				return errf("credentials unit requires includeCredentials flag")
			}
		}
		return nil
	}
	if source != "manual" {
		return fmt.Errorf("%s", errmarkers.CredSyncManualOnly)
	}
	for _, id := range req.InstanceIDs {
		inst, ok := findInstance(id)
		if !ok {
			return errf("instance %s not registered", id)
		}
		key := pairingKeyOf(inst)
		if key == nil {
			return fmt.Errorf("%s: %s", errmarkers.CredSyncUnverified, inst.Name+" not paired")
		}
		st, err := store.Get().CredSync.Get(inst.ID)
		if err != nil || st.CertVerifiedAt.IsZero() {
			return fmt.Errorf("%s: %s", errmarkers.CredSyncUnverified, inst.Name)
		}
	}
	return nil
}

// ── 发送侧（push 发出 / pull 发起）──

// pushCredUnit 推送凭据档到单对端（execPush 的 credentials 单元分派）。
// staged=true 表示对端首次接收待人工确认——载荷已送达且全程密文，对推送方
// 按成功收口（结果行如实标注 staged）
func pushCredUnit(ctx context.Context, job *SyncJob, peer config.InstanceConfig) (staged bool, summary string, err error) {
	key := pairingKeyOf(peer)
	if key == nil {
		return false, "", fmt.Errorf("%s: %s", errmarkers.CredSyncUnverified, "peer not paired")
	}
	vault, err := buildCredVault()
	if err != nil {
		return false, "", err
	}
	credSendMu.Lock()
	state := credStateOf(peer.ID)
	state.SendSeq++
	seq := state.SendSeq
	env, err := sealCredVault(vault, key, "push", seq)
	credSendMu.Unlock()
	if err != nil {
		return false, "", err
	}
	body, err := json.Marshal(env)
	if err != nil {
		return false, "", err
	}
	hdr := http.Header{}
	resp, err := peerDo(ctx, http.MethodPost, peer.URL, peer.Token, "/api/sync/units?mode=cred", bytes.NewReader(body), hdr)
	if err != nil {
		return false, "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		rerr := peerRemoteUnreachable(err)
		return false, "", rerr
	}
	staged = resp.StatusCode == http.StatusAccepted
	if resp.StatusCode != http.StatusOK && !staged {
		e := errf("peer credential landing failed: status=%d %s", resp.StatusCode, truncateErrBody(raw))
		auditCredSystem(store.AuditSyncCredSend, "push", peer.Name, PairFp(key), false, credVaultSummary(vault), "peer rejected: "+truncateErrBody(raw))
		return false, "", e
	}
	// 序号只前进（staged 情形接收端水位在确认时才推进；发送侧重试序号单调）
	state.LastSyncAt = time.Now()
	state.LastDirection = "push"
	state.LastMeta = credVaultSummary(vault)
	_ = store.Get().CredSync.Save(*state)
	summary = credVaultSummary(vault)
	auditCredSystem(store.AuditSyncCredSend, "push", peer.Name, PairFp(key), staged, summary, "")
	return staged, summary, nil
}

// pullCredUnit 从对端拉取凭据档落地本端（execPull 的 credentials 单元分派；
// 发起端已在 credGuard 完成核对——落地即本端人工确认语义）。
// 服务侧（对端）只要求配对在场：载荷恒密文出域，保密性不依赖对端仪式态
// （详见 serveCredVault 注记）
func pullCredUnit(ctx context.Context, job *SyncJob, peer config.InstanceConfig) (summary string, err error) {
	key := pairingKeyOf(peer)
	if key == nil {
		return "", fmt.Errorf("%s: %s", errmarkers.CredSyncUnverified, "peer not paired")
	}
	fp := PairFp(key)
	hdr := http.Header{}
	hdr.Set(credPairFpHeader, fp)
	resp, err := peerDo(ctx, http.MethodGet, peer.URL, peer.Token,
		"/api/sync/units?keys="+UnitCredentials+"&cred=1", nil, hdr)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, credVaultMaxBytes))
	if err != nil {
		return "", peerRemoteUnreachable(err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", errf("peer credential serve failed: status=%d %s", resp.StatusCode, truncateErrBody(raw))
	}
	// 本端 = 接收侧：pull 方向水位去重 + 落地
	state := credStateOf(peer.ID)
	vault, err := openCredEnvelope(raw, map[string][]byte{fp: key}, state.RecvSeqFor("pull"))
	if err != nil {
		slogCredReject("cred pull open", credRejectReason(err))
		return "", err
	}
	if err := applyCredVaultLocal(vault); err != nil {
		return "", err
	}
	state.SetRecvSeq("pull", envelopeSeq(raw))
	state.LastSyncAt = time.Now()
	state.LastDirection = "pull"
	state.LastMeta = credVaultSummary(vault)
	_ = store.Get().CredSync.Save(*state)
	summary = credVaultSummary(vault)
	auditCredSystem(store.AuditSyncCredRecv, "pull", peer.Name, fp, false, summary, "")
	return summary, nil
}

// ── 接收侧（push 落位 / staged 仪式）──

// credStash 接收端暂存注册表（migrationStash 同款进程内形态；暂存体保持
// E2E 密文——确认前不落盘不解链，spool/磁盘零接触）
var credStash = struct {
	mu      sync.Mutex
	entries map[string]*credStagedEntry
}{entries: map[string]*credStagedEntry{}}

type credStagedEntry struct {
	ticket    string
	envelope  []byte // E2E 密文（确认前不解链）
	peerName  string // 发起对端名（通知/展示）
	pairFp    string // 配对指纹（确认时重验钥仍在场）
	summary   string // 计数元数据（解链预读——不 apply）
	arrivedAt time.Time
	expireAt  time.Time
}

func stashCred(e *credStagedEntry) {
	credStash.mu.Lock()
	defer credStash.mu.Unlock()
	sweepCredLocked()
	credStash.entries[e.ticket] = e
}

func popCredStaged(ticket string) *credStagedEntry {
	credStash.mu.Lock()
	defer credStash.mu.Unlock()
	sweepCredLocked()
	e := credStash.entries[ticket]
	if e == nil {
		return nil
	}
	delete(credStash.entries, ticket)
	if time.Now().After(e.expireAt) {
		return nil
	}
	return e
}

func listCredStaged() []credStagedEntry {
	credStash.mu.Lock()
	defer credStash.mu.Unlock()
	sweepCredLocked()
	out := make([]credStagedEntry, 0, len(credStash.entries))
	for _, e := range credStash.entries {
		out = append(out, *e)
	}
	return out
}

func sweepCredLocked() {
	now := time.Now()
	for t, e := range credStash.entries {
		if now.After(e.expireAt) {
			delete(credStash.entries, t)
		}
	}
}

// handleCredLand POST /api/sync/units?mode=cred —— 接收端落位入口：
// 已核对 → 开信封验水位落盘；未核对 → 密文暂存+通知（10min TTL），
// 确认后凭重验落盘（接收端首次仪式）
func handleCredLand(c *gin.Context) {
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, credVaultMaxBytes))
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "credential envelope unreadable", nil)
		return
	}
	keys, ok := pairingByFp()
	if !ok {
		shared.Error(c, http.StatusInternalServerError, "pairing key table inconsistent (duplicate fingerprint)", nil)
		return
	}
	// 信封头预读：选钥 + 找到本端侧的对端条目（仪式态/水位按条目记账）
	var head struct {
		PairFp string `json:"pairFp"`
		Dir    string `json:"dir"`
		Seq    int64  `json:"seq"`
	}
	if json.Unmarshal(body, &head) != nil || head.PairFp == "" {
		shared.Error(c, http.StatusBadRequest, errmarkers.CredSyncEnvelopeRejected, nil)
		return
	}
	key := keys[head.PairFp]
	if key == nil {
		shared.Error(c, http.StatusForbidden, errmarkers.CredSyncEnvelopeRejected, nil)
		return
	}
	peer := credPeerByFp(head.PairFp)
	if peer.ID == "" {
		shared.Error(c, http.StatusForbidden, errmarkers.CredSyncUnverified, nil)
		return
	}
	state := credStateOf(peer.ID)

	// 首次接收仪式：未核对不落盘——密文暂存 + 通知中心确认卡
	if state.CertVerifiedAt.IsZero() {
		vault, oerr := openCredEnvelope(body, keys, state.RecvSeqFor(head.Dir))
		if oerr != nil {
			// 密文无效不进暂存（防垃圾占位；对外统一拒绝文案防 oracle）
			slogCredReject("cred land open-before-stage", credRejectReason(oerr))
			shared.Error(c, http.StatusBadRequest, errmarkers.CredSyncEnvelopeRejected, nil)
			return
		}
		ticket := uuid.New().String()
		stashCred(&credStagedEntry{
			ticket: ticket, envelope: append([]byte(nil), body...),
			peerName: peer.Name, pairFp: head.PairFp,
			summary:   credVaultSummary(vault),
			arrivedAt: time.Now(), expireAt: time.Now().Add(credStagedTTL),
		})
		notifyCredStaged(peer.Name, credVaultSummary(vault))
		auditCredSystem(store.AuditSyncCredRecv, head.Dir, peer.Name, head.PairFp, true, credVaultSummary(vault), "staged ticket issued")
		c.JSON(http.StatusAccepted, gin.H{"data": gin.H{
			"staged": true, "ticket": ticket, "summary": credVaultSummary(vault),
		}})
		return
	}

	// 已核对：验水位 → 落盘
	vault, oerr := openCredEnvelope(body, keys, state.RecvSeqFor(head.Dir))
	if oerr != nil {
		slogCredReject("cred land open", credRejectReason(oerr))
		shared.Error(c, http.StatusBadRequest, errmarkers.CredSyncEnvelopeRejected, nil)
		return
	}
	if err := applyCredVaultLocal(vault); err != nil {
		shared.Error(c, http.StatusInternalServerError, "credential landing failed: "+err.Error(), nil)
		return
	}
	state.SetRecvSeq(head.Dir, head.Seq)
	state.LastSyncAt = time.Now()
	state.LastDirection = head.Dir
	state.LastMeta = credVaultSummary(vault)
	_ = store.Get().CredSync.Save(*state)
	auditCredSystem(store.AuditSyncCredRecv, head.Dir, peer.Name, head.PairFp, false, credVaultSummary(vault), "")
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"landed": true, "summary": credVaultSummary(vault)}})
}

// serveCredVault GET /api/sync/units?keys=credentials&cred=1 —— 服务端出域面
// （pull 方向对端拉取）：按请求头指纹选钥封 E2E 信封。载荷恒密文出域，
// 保密性只依赖配对钥（人工抄录交换，不在网络信道上）——故服务侧不要求
// 本端仪式态；仪式态把守的是「落盘」与「出域发起」两端的人审
func serveCredVault(c *gin.Context, fp string) {
	keys, ok := pairingByFp()
	if !ok {
		shared.Error(c, http.StatusInternalServerError, "pairing key table inconsistent (duplicate fingerprint)", nil)
		return
	}
	key := keys[fp]
	if key == nil {
		shared.Error(c, http.StatusForbidden, errmarkers.CredSyncUnverified, nil)
		return
	}
	peer := credPeerByFp(fp)
	vault, err := buildCredVault()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "build credential vault failed", err)
		return
	}
	credSendMu.Lock()
	state := credStateOf(peer.ID)
	state.SendSeq++
	seq := state.SendSeq
	env, err := sealCredVault(vault, key, "pull", seq)
	credSendMu.Unlock()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "seal credential vault failed", err)
		return
	}
	state.LastSyncAt = time.Now()
	state.LastDirection = "pull"
	state.LastMeta = credVaultSummary(vault)
	_ = store.Get().CredSync.Save(*state)
	auditCredSystem(store.AuditSyncCredSend, "pull", peer.Name, fp, false, credVaultSummary(vault), "")
	body, _ := json.Marshal(env)
	c.Header("Content-Type", "application/json")
	c.Status(http.StatusOK)
	_, _ = c.Writer.Write(body)
}

// ── 仪式端点（编排面）──

// PostCredVerify POST /api/sync/credentials/verify {instanceId} —— 首次携密
// 前的「证书指纹短码双端核对」确认落账（前端在对话框并排展示两端短码后调用；
// AgentGuard 高危表登记——agent 不得代触发携密链路，手册登记纯人工纪律）
func PostCredVerify(c *gin.Context) {
	var req struct {
		InstanceID string `json:"instanceId" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request body", nil)
		return
	}
	inst, ok := findInstance(req.InstanceID)
	if !ok || inst.IsLocal {
		shared.Error(c, http.StatusNotFound, "instance not found", nil)
		return
	}
	key := pairingKeyOf(inst)
	if key == nil {
		shared.Error(c, http.StatusBadRequest, errmarkers.CredSyncUnverified, nil)
		return
	}
	state := credStateOf(inst.ID)
	if state.CertVerifiedAt.IsZero() {
		state.CertVerifiedAt = time.Now()
		_ = store.Get().CredSync.Save(*state)
	}
	auditCredSystem(store.AuditSyncCred, "", inst.Name, PairFp(key), false, "", "cert fingerprint verified")
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"verified": true, "pairFp": PairFp(key)}})
}

// ListCredStaged GET /api/sync/credentials/staged —— 暂存清单（元数据，无密文）
func ListCredStaged(c *gin.Context) {
	items := listCredStaged()
	type stagedRow struct {
		Ticket    string `json:"ticket"`
		PeerName  string `json:"peerName"`
		PairFp    string `json:"pairFp"`
		Summary   string `json:"summary"`
		ArrivedAt string `json:"arrivedAt"`
		ExpiresAt string `json:"expiresAt"`
	}
	out := make([]stagedRow, 0, len(items))
	for _, e := range items {
		out = append(out, stagedRow{
			Ticket: e.ticket, PeerName: e.peerName, PairFp: e.pairFp,
			Summary: e.summary, ArrivedAt: e.arrivedAt.Format(time.RFC3339),
			ExpiresAt: e.expireAt.Format(time.RFC3339),
		})
	}
	c.JSON(http.StatusOK, gin.H{"data": out})
}

// ResolveCredStaged POST /api/sync/credentials/staged/:ticket/resolve {accept}
// —— 接收端确认仪式终审：accept → 凭水位重验落盘（暂存到确认之间若有更新
// 档已落盘，旧档水位重验拒绝——确认不是越权通道）；reject → 丢弃
func ResolveCredStaged(c *gin.Context) {
	var req struct {
		Accept *bool `json:"accept" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request body", nil)
		return
	}
	e := popCredStaged(c.Param("ticket"))
	if e == nil {
		shared.Error(c, http.StatusNotFound, "staged credential envelope expired or unknown", nil)
		return
	}
	if !*req.Accept {
		auditCredSystem(store.AuditSyncCredRecv, "", e.peerName, e.pairFp, false, e.summary, "staged rejected by user")
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"resolved": "rejected"}})
		return
	}
	peer := credPeerByName(e.peerName)
	keys, kok := pairingByFp()
	if !kok {
		shared.Error(c, http.StatusInternalServerError, "pairing key table inconsistent", nil)
		return
	}
	state := credStateOf(peer.ID)
	// 确认时刻重验：水位前进校验 + 钥仍在场（确认窗口内轮换配对即拒）
	vault, err := openCredEnvelope(e.envelope, keys, state.RecvSeqFor(envelopeDir(e.envelope)))
	if err != nil {
		slogCredReject("cred staged resolve re-open", credRejectReason(err))
		shared.Error(c, http.StatusBadRequest, errmarkers.CredSyncEnvelopeRejected, nil)
		return
	}
	if err := applyCredVaultLocal(vault); err != nil {
		shared.Error(c, http.StatusInternalServerError, "credential landing failed: "+err.Error(), nil)
		return
	}
	state.SetRecvSeq(envelopeDir(e.envelope), envelopeSeq(e.envelope))
	state.LastSyncAt = time.Now()
	state.LastDirection = envelopeDir(e.envelope)
	state.LastMeta = credVaultSummary(vault)
	_ = store.Get().CredSync.Save(*state)
	auditCredSystem(store.AuditSyncCredRecv, envelopeDir(e.envelope), e.peerName, e.pairFp, false, credVaultSummary(vault), "staged confirmed by user")
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"resolved": "accepted", "summary": credVaultSummary(vault)}})
}

// GetLocalCertInfo GET /api/sync/credentials/certinfo —— 本机服务证书指纹
// （首次携密核对仪式的双端比对数据源之一：对端经代理取本端点，与本端记录的
// 钉扎指纹对表）。HTTP-only 部署无证书 → certFp 空（仪式面如实呈现「无 TLS」）
func GetLocalCertInfo(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"certFp": localCertFingerprint(), "tls": localTLS.tlsOn,
	}})
}

// localCertFingerprint 本机服务证书 SHA-256 指纹（裸 hex 64 字符，与 peercert
// 钉扎库同编码——两端对表不做格式翻译）。证书读取失败按无 TLS 呈现（仪式面
// 不误导），失败原因进服务端日志
func localCertFingerprint() string {
	if !localTLS.tlsOn || localTLS.certFile == "" {
		return ""
	}
	data, err := os.ReadFile(localTLS.certFile)
	if err != nil {
		slog.Warn("cred sync certinfo: local cert unreadable", "err", err)
		return ""
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return ""
	}
	sum := sha256.Sum256(block.Bytes)
	return hex.EncodeToString(sum[:])
}

// ── 内部小件 ──

// credStateOf 读仪式态（无则零值档——读端只关心零值判断与水位）
func credStateOf(instanceID string) *store.CredSyncState {
	st, err := store.Get().CredSync.Get(instanceID)
	if err != nil {
		return &store.CredSyncState{InstanceID: instanceID}
	}
	return st
}

// credPeerByFp 指纹 → 本端侧对端条目（找不到返回零值档）
func credPeerByFp(fp string) config.InstanceConfig {
	insts, _ := store.Get().Instance.List()
	for _, inst := range insts {
		if inst.IsLocal {
			continue
		}
		if key := pairingKeyOf(inst); key != nil && PairFp(key) == fp {
			return inst
		}
	}
	return config.InstanceConfig{}
}

// credPeerByName 名字 → 对端条目（staged 确认链的弱引用回查；找不到按零值
// 档处置——信封重验兜底拒绝，不因改名漏放行）
func credPeerByName(name string) config.InstanceConfig {
	insts, _ := store.Get().Instance.List()
	for _, inst := range insts {
		if !inst.IsLocal && inst.Name == name {
			return inst
		}
	}
	return config.InstanceConfig{}
}

// applyCredVaultLocal 凭据档落地本端 store（恒 merge：已有键保留本机，新键
// 补入——携密通道不开覆盖语义，防受损对端静默替换本端凭据；迁移包 overwrite
// 档是显式人工勾选的独立面）。落位走 store encrypt-on-write 既有链
func applyCredVaultLocal(vault *CredVault) error {
	if _, _, err := applyCredentialsBlock(policyMerge, vault.Credentials); err != nil {
		return err
	}
	if _, _, err := applyTokensBlock(policyMerge, vault.Tokens); err != nil {
		return err
	}
	return nil
}

// auditCredSystem 携密同步系统侧审计（后台执行无 gin 上下文走裸 Append 口；
// Detail 只记计数元数据 + pairFp 短指纹 + staged 标记——凭据明文/配对码绝不入账）
func auditCredSystem(action, dir, peer, fp string, staged bool, summary, note string) {
	if s := store.Get(); s != nil {
		st := "N"
		if staged {
			st = "Y"
		}
		d := fmt.Sprintf("dir=%s peer=%s pairFp=%s staged=%s %s", dir, peer, fp, st, summary)
		if note != "" {
			d += " note=" + note
		}
		s.Audit.Append(store.AuditEvent{Action: action, Result: store.AuditResultSuccess, Detail: d})
	}
}

// notifyCredStaged 首次接收暂存通知（确认卡直达同步中心——暂存卡在那里终审）
func notifyCredStaged(peerName, summary string) {
	store.Get().Notification.Add(notification.Notification{
		Type:     "warning",
		Category: notification.CategoryTask,
		TitleKey: CredSyncStagedTitleKey,
		Title:    fmt.Sprintf("收到来自「%s」的密钥凭据档，待确认", peerName),
		Body:     summary,
		MsgParams: map[string]any{
			"peer": peerName,
		},
		Action:        "open-sync-center",
		ActionPayload: "",
	})
}

// slogCredReject 服务端日志记内部拒绝原因（对外恒统一文案——排障与防 oracle
// 分流：日志给人，响应给信道）
func slogCredReject(where, reason string) {
	slog.Warn("cred sync envelope rejected", "where", where, "reason", reason)
}

// envelopeDir / envelopeSeq 从密文头预读方向与序号（不解链——确认链重验用）
func envelopeDir(raw []byte) string {
	var h struct {
		Dir string `json:"dir"`
	}
	if json.Unmarshal(raw, &h) != nil {
		return ""
	}
	return h.Dir
}

func envelopeSeq(raw []byte) int64 {
	var h struct {
		Seq int64 `json:"seq"`
	}
	if json.Unmarshal(raw, &h) != nil {
		return 0
	}
	return h.Seq
}
