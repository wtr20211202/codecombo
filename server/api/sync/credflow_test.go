package sync

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 手动携密同步单测（P-20261024-3 拆解步骤 ⑥ 服务端面）：
//   - E2E 信封：往返 / 篡改拒绝 / 重放拒绝 / 钥不配拒绝 / AAD 绑定；
//   - 红线守卫：cron 源携密硬拒 / units 走私拒绝 / 未配对未核对拒绝；
//   - 构造性隔离：凭据单元不进默认 manifest、不进 plan 范围、不进 zip 打包面；
//   - 双端仪式：接收端未核对暂存不落盘 → 确认落盘 → 重放拒绝 → 审计入账。

const testPairingHex = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"

// pairLocalWithSeed 本端为某对端条目录入配对钥（测试直落 store——录入链
// SetPairing 的格式归一由 TestPairingCodeNormalize 覆盖）
func pairLocalWithSeed(t *testing.T, instID string) []byte {
	t.Helper()
	// 配对钥的内存规范形态 = 64 位十六进制字符串字节（SetPairing 归一后的
	// 落盘/读链形态——HKDF ikm 接受任意字节串，不需要解码回 32B 原料）
	raw := []byte(testPairingHex)
	all, _ := store.Get().Instance.List()
	for _, in := range all {
		if in.ID == instID {
			in.PairingKey = testPairingHex
			if err := store.Get().Instance.Save(in); err != nil {
				t.Fatal(err)
			}
			return raw
		}
	}
	t.Fatalf("instance %s not found", instID)
	return nil
}

// TestCredEnvelopeRoundtripAndRejections 信封链核心安全属性
func TestCredEnvelopeRoundtripAndRejections(t *testing.T) {
	key := []byte(testPairingHex)
	vault := &CredVault{Schema: credVaultSchema, Version: credVaultVersion, Host: "src"}

	env, err := sealCredVault(vault, key, "push", 1)
	if err != nil {
		t.Fatal(err)
	}
	if env.PairFp != PairFp(key) || env.Seq != 1 || env.Dir != "push" {
		t.Fatalf("envelope metadata mismatch: %+v", env)
	}
	raw, _ := json.Marshal(env)

	// 往返
	got, err := openCredEnvelope(raw, map[string][]byte{PairFp(key): key}, 0)
	if err != nil {
		t.Fatalf("roundtrip open: %v", err)
	}
	if got.Schema != credVaultSchema || got.Host != "src" {
		t.Fatalf("vault payload mismatch: %+v", got)
	}

	// 篡改密文 → 拒绝（统一文案）
	var te CredEnvelope
	_ = json.Unmarshal(raw, &te)
	ct, _ := base64.StdEncoding.DecodeString(te.Ciphertext)
	ct[0] ^= 0xff
	te.Ciphertext = base64.StdEncoding.EncodeToString(ct)
	traw, _ := json.Marshal(te)
	if _, err := openCredEnvelope(traw, map[string][]byte{PairFp(key): key}, 0); err == nil || err.Error() != errmarkers.CredSyncEnvelopeRejected {
		t.Fatalf("tampered envelope must reject with unified text, got %v", err)
	}

	// 重放（水位回退）→ 拒绝
	if _, err := openCredEnvelope(raw, map[string][]byte{PairFp(key): key}, 1); err == nil {
		t.Fatal("replayed seq must be rejected by watermark")
	}

	// 钥不配 → 拒绝
	other := []byte("ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100")
	if _, err := openCredEnvelope(raw, map[string][]byte{PairFp(other): other}, 0); err == nil {
		t.Fatal("wrong key must be rejected")
	}

	// AAD 绑定（改 dir 元数据）→ 拒绝
	var de CredEnvelope
	_ = json.Unmarshal(raw, &de)
	de.Dir = "pull"
	dreraw, _ := json.Marshal(de)
	if _, err := openCredEnvelope(dreraw, map[string][]byte{PairFp(key): key}, 0); err == nil {
		t.Fatal("AAD-bound metadata change must be rejected")
	}
}

// TestCredGuardRedLine 红线守卫三岔
func TestCredGuardRedLine(t *testing.T) {
	setupSyncEnv(t)
	inst := registerPeer(t, "http://127.0.0.1:1")

	// ① cron 源携密：硬拒（配置漂移也打不破）
	if err := credGuard(ExecuteRequest{InstanceIDs: []string{inst.ID}, IncludeCredentials: true}, "cron"); err == nil ||
		!strings.Contains(err.Error(), errmarkers.CredSyncManualOnly) {
		t.Fatalf("cron credential sync must hard-reject, got %v", err)
	}
	// ② units 走私（开关未开但 units 带凭据键）：拒绝
	if err := credGuard(ExecuteRequest{InstanceIDs: []string{inst.ID}, Units: []string{UnitCredentials}}, "manual"); err == nil {
		t.Fatal("credentials unit without flag must be rejected")
	}
	// ③ 未配对：拒绝
	if err := credGuard(ExecuteRequest{InstanceIDs: []string{inst.ID}, IncludeCredentials: true}, "manual"); err == nil ||
		!strings.Contains(err.Error(), errmarkers.CredSyncUnverified) {
		t.Fatalf("unpaired peer must reject with unverified marker, got %v", err)
	}
	// ④ 已配对未核对：拒绝
	pairLocalWithSeed(t, inst.ID)
	if err := credGuard(ExecuteRequest{InstanceIDs: []string{inst.ID}, IncludeCredentials: true}, "manual"); err == nil ||
		!strings.Contains(err.Error(), errmarkers.CredSyncUnverified) {
		t.Fatalf("paired-but-unverified peer must reject, got %v", err)
	}
	// ⑤ 配对 + 核对：放行
	st, _ := store.Get().CredSync.Get(inst.ID)
	if st == nil {
		st = &store.CredSyncState{InstanceID: inst.ID}
	}
	st.CertVerifiedAt = time.Now()
	if err := store.Get().CredSync.Save(*st); err != nil {
		t.Fatal(err)
	}
	if err := credGuard(ExecuteRequest{InstanceIDs: []string{inst.ID}, IncludeCredentials: true}, "manual"); err != nil {
		t.Fatalf("paired+verified should pass, got %v", err)
	}
	// ⑥ 不携密的普通请求恒放行
	if err := credGuard(ExecuteRequest{InstanceIDs: []string{inst.ID}, Units: []string{"project:x"}}, "cron"); err != nil {
		t.Fatalf("plain cron request must pass, got %v", err)
	}
}

// TestCredUnitStructurallyExcluded 构造性隔离：默认 manifest / plan 范围 /
// zip 打包面三处都不出现凭据单元
func TestCredUnitStructurallyExcluded(t *testing.T) {
	setupSyncEnv(t)
	// 播种凭据（红线断言载荷）
	if err := store.Get().Credential.Save(&store.Credential{
		Host: "github.com", Username: "u", Secret: "sc-redline-secret-42",
		AuthType: store.AuthTypeBasic, Status: store.StatusActive,
	}); err != nil {
		t.Fatal(err)
	}
	m := buildLocalManifest()
	for _, u := range m.Units {
		if u.Kind == UnitCredentials {
			t.Fatal("credentials unit must not appear in default manifest")
		}
	}
	if strings.Contains(mustJSON(&m), "sc-redline-secret-42") {
		t.Fatal("red line: credential secret leaked into manifest payload")
	}
	if _, errs := resolveUnitPayloads([]string{UnitCredentials}, false); len(errs) == 0 {
		t.Fatal("zip pack face must refuse credentials unit")
	}
	if unitInScope(UnitCredentials, map[string]bool{}, map[string]bool{}) {
		t.Fatal("credentials unit must be out of plan scope")
	}
}

// TestSyncCronModelHasNoCredentialField 配置面结构红线：SyncCron 模型不存在
// 任何携密字段（「配置面不出现该选项」不是 UI 隐藏而是模型层缺失）
func TestSyncCronModelHasNoCredentialField(t *testing.T) {
	typ := reflect.TypeOf(store.SyncCron{})
	for i := 0; i < typ.NumField(); i++ {
		name := strings.ToLower(typ.Field(i).Name)
		tag := strings.ToLower(typ.Field(i).Tag.Get("json"))
		if strings.Contains(name, "cred") || strings.Contains(name, "secret") ||
			strings.Contains(tag, "cred") || strings.Contains(tag, "secret") {
			t.Fatalf("SyncCron must not expose credential-carrying field: %s", typ.Field(i).Name)
		}
	}
}

// TestPairingCodeNormalize 录入归一：大小写/分隔符容错 + 非法形态拒绝
func TestPairingCodeNormalize(t *testing.T) {
	want := strings.ToLower(testPairingHex)
	for _, in := range []string{
		strings.ToUpper(testPairingHex),
		testPairingHex[:8] + "-" + testPairingHex[8:16] + " " + testPairingHex[16:],
		want,
	} {
		if got := normalizePairingCode(in); got != want {
			t.Fatalf("normalize %q -> %q, want %q", in, got, want)
		}
	}
	for _, bad := range []string{"", "abc", testPairingHex[:63], testPairingHex[:62] + "zz"} {
		if got := normalizePairingCode(bad); got != "" {
			t.Fatalf("invalid code %q must be rejected, got %q", bad, got)
		}
	}
}

// TestPairingKeyEncryptedAtRest 配对钥落盘必为 enc: 态（存储文档原文无明文；
// List 读链会把 enc: 解回明文——静态断言必须读 filestore 原始文档字节）
func TestPairingKeyEncryptedAtRest(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	dataDir := t.TempDir()
	store.SetDefault(store.New(filestore.New(dataDir)))
	t.Cleanup(func() { store.SetDefault(nil) })
	inst := registerPeer(t, "http://127.0.0.1:2")
	pairLocalWithSeed(t, inst.ID)
	// 存储原文检查：<dataDir>/data/instances/<id>.json 含 enc: 态而非明文
	raw, err := os.ReadFile(filepath.Join(dataDir, "data", "instances", inst.ID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		PairingKey string `json:"pairingKey"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.PairingKey == "" || !config.IsEncrypted(doc.PairingKey) {
		t.Fatalf("pairing key must be stored enc:-prefixed, got %q", doc.PairingKey)
	}
	if doc.PairingKey == testPairingHex {
		t.Fatal("pairing key stored as plaintext")
	}
	// 读链往返：List 解回明文，配对钥可用性成立
	all, _ := store.Get().Instance.List()
	for _, in := range all {
		if in.ID == inst.ID && in.PairingKey != testPairingHex {
			t.Fatalf("List decrypt roundtrip mismatch: %q", in.PairingKey)
		}
	}
}

// TestCredLandCeremonyEndToEnd 接收端双端仪式全链（gin handler 实测）：
// 未核对 → 202 暂存不落盘 + 通知 → 确认落盘 → 重放拒绝 → 篡改拒绝 → 审计
func TestCredLandCeremonyEndToEnd(t *testing.T) {
	setupSyncEnv(t)
	gin.SetMode(gin.TestMode)
	inst := registerPeer(t, "http://127.0.0.1:3")
	key := pairLocalWithSeed(t, inst.ID)

	r := gin.New()
	r.POST("/api/sync/units", PostUnitsZip)
	r.GET("/api/sync/credentials/staged", ListCredStaged)
	r.POST("/api/sync/credentials/staged/:ticket/resolve", ResolveCredStaged)

	vault := &CredVault{
		Schema: credVaultSchema, Version: credVaultVersion, Host: "src",
		Credentials: &MigrationCredentials{Git: []*store.Credential{{
			Host: "gitlab.example.com", Username: "u", Secret: "vault-secret-1",
			AuthType: store.AuthTypeBasic, Status: store.StatusActive,
		}}},
		Tokens: &MigrationTokens{AgentToken: "sca_test0000000000000000000000000000000000000000000000000000test"},
	}
	env, err := sealCredVault(vault, key, "push", 1)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(env)

	// ① 未核对接收：202 暂存，store 无新凭据，通知在账
	w := postJSON(r, "/api/sync/units?mode=cred", body)
	if w.Code != http.StatusAccepted {
		t.Fatalf("first receive must stage (202), got %d %s", w.Code, w.Body.String())
	}
	if cr, _ := store.Get().Credential.List(); len(cr) != 0 {
		t.Fatal("staged envelope must not land before confirmation")
	}
	if ns := store.Get().Notification.List(50); len(ns) == 0 {
		t.Fatal("staged receive must raise a confirmation notification")
	}
	var stagedResp struct {
		Data struct {
			Staged  bool   `json:"staged"`
			Ticket  string `json:"ticket"`
			Summary string `json:"summary"`
		} `json:"data"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &stagedResp)
	if !stagedResp.Data.Staged || stagedResp.Data.Ticket == "" {
		t.Fatalf("staged response malformed: %s", w.Body.String())
	}
	if !strings.Contains(stagedResp.Data.Summary, "git=1") {
		t.Fatalf("summary must carry counts metadata: %q", stagedResp.Data.Summary)
	}

	// ② 确认落盘：凭据与 agent token 进 store（merge 语义）
	w = postJSON(r, "/api/sync/credentials/staged/"+stagedResp.Data.Ticket+"/resolve", []byte(`{"accept":true}`))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "accepted") {
		t.Fatalf("resolve accept failed: %d %s", w.Code, w.Body.String())
	}
	creds, _ := store.Get().Credential.List()
	found := false
	for _, cr := range creds {
		if cr.Host == "gitlab.example.com" && config.DecryptIfNeeded(cr.Secret) == "vault-secret-1" {
			found = true
		}
	}
	if !found {
		t.Fatal("confirmed vault must land into credential store (decrypt-on-read equal)")
	}
	if mt := store.Get().AgentToken.Meta(); !mt.Exists {
		t.Fatal("confirmed vault must land agent token")
	}

	// ③ 重放同一信封：水位已前进 → 拒绝（已核对链路直落 → 400 统一文案）
	w = postJSON(r, "/api/sync/units?mode=cred", body)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), errmarkers.CredSyncEnvelopeRejected) {
		t.Fatalf("replay after landing must reject, got %d %s", w.Code, w.Body.String())
	}

	// ④ 篡改信封：拒绝
	tam := bytes.Clone(body)
	tam[len(tam)-3] ^= 0xff
	w = postJSON(r, "/api/sync/units?mode=cred", tam)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), errmarkers.CredSyncEnvelopeRejected) {
		t.Fatalf("tampered envelope must reject, got %d %s", w.Code, w.Body.String())
	}

	// ⑤ 双端审计入账（recv 侧 staged/confirm 两笔）且凭据明文绝不入账
	events, _, _ := store.Get().Audit.List(100, 0)
	recv := 0
	for _, e := range events {
		if e.Action == store.AuditSyncCredRecv {
			recv++
			if strings.Contains(e.Detail, "vault-secret-1") {
				t.Fatal("red line: credential secret in audit detail")
			}
		}
	}
	if recv < 2 {
		t.Fatalf("audit must record staged + confirmed recv events, got %d", recv)
	}
}

// TestCredServePullFlow pull 方向服务面：凭 pairFp 头选钥封 E2E 信封；
// 发起端开信封落地（merge）+ 水位记账
func TestCredServePullFlow(t *testing.T) {
	setupSyncEnv(t)
	gin.SetMode(gin.TestMode)
	inst := registerPeer(t, "http://127.0.0.1:4")
	key := pairLocalWithSeed(t, inst.ID)
	fp := PairFp(key)

	if err := store.Get().Credential.Save(&store.Credential{
		Host: "bit.example.com", Username: "u2", Secret: "pull-secret-1",
		AuthType: store.AuthTypeBasic, Status: store.StatusActive,
	}); err != nil {
		t.Fatal(err)
	}

	r := gin.New()
	r.GET("/api/sync/units", GetUnitsZip)

	// 无指纹头 → 403（凭据面拒绝）
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/sync/units?keys=credentials&cred=1", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("serve without pair fp must reject, got %d", w.Code)
	}
	// 错指纹 → 403
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/sync/units?keys=credentials&cred=1", nil)
	req.Header.Set(credPairFpHeader, "0000000000000000")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("serve with wrong fp must reject, got %d", w.Code)
	}
	// 正确指纹 → E2E 信封（响应不含任何明文秘密）
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/sync/units?keys=credentials&cred=1", nil)
	req.Header.Set(credPairFpHeader, fp)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("serve with paired fp must succeed, got %d %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "pull-secret-1") {
		t.Fatal("red line: served envelope must not contain plaintext secrets")
	}
	// 发起端解链落地（pull 方向水位记账）
	state := credStateOf(inst.ID)
	got, err := openCredEnvelope(w.Body.Bytes(), map[string][]byte{fp: key}, state.RecvSeqFor("pull"))
	if err != nil {
		t.Fatalf("initiator open served envelope: %v", err)
	}
	if got.Credentials == nil || len(got.Credentials.Git) != 1 {
		t.Fatalf("served vault payload mismatch: %+v", got.Credentials)
	}
	if err := applyCredVaultLocal(got); err != nil {
		t.Fatal(err)
	}
	creds, _ := store.Get().Credential.List()
	n := 0
	for _, cr := range creds {
		if cr.Host == "bit.example.com" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("merge landing expected exactly one bit.example.com entry, got %d", n)
	}
}

// postJSON gin 测试小件
func postJSON(r http.Handler, path string, body []byte) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}
