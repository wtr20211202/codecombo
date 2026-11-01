package remote

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// setupImportExportStore 独立临时数据目录 + 全局 Store 装配（用后清空）。
// 返回数据目录路径，供落盘内容断言
func setupImportExportStore(t *testing.T) string {
	t.Helper()
	gin.SetMode(gin.TestMode)
	dir := filepath.Join(t.TempDir(), "data")
	store.SetDefault(store.New(filestore.New(dir)))
	t.Cleanup(func() { store.SetDefault(nil) })
	return dir
}

// doJSON 直连 handler 的 JSON 请求
func doJSON(t *testing.T, handler gin.HandlerFunc, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request: %v", err)
		}
		rdr = bytes.NewReader(b)
	}
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(method, path, rdr)
	if body != nil {
		c.Request.Header.Set("Content-Type", "application/json")
	}
	handler(c)
	return w
}

// seedHosts 种子数据：1 台密码主机 + 1 台密钥型主机（引用新生成的 SSH key）
func seedHosts(t *testing.T) string {
	t.Helper()
	pub, _, err := store.Get().SshKey.Generate("seed-key", "ed25519")
	if err != nil {
		t.Fatalf("generate ssh key: %v", err)
	}
	if _, err := store.Get().RemoteHost.Create(config.RemoteHost{
		Name: "alpha", Host: "192.168.1.10", User: "root",
		AuthType: config.AuthTypePassword, Password: "pw-plain",
	}); err != nil {
		t.Fatalf("seed password host: %v", err)
	}
	if _, err := store.Get().RemoteHost.Create(config.RemoteHost{
		Name: "beta", Host: "192.168.1.11", User: "root",
		AuthType: config.AuthTypeSshKey, SshKeyID: pub.ID,
	}); err != nil {
		t.Fatalf("seed sshkey host: %v", err)
	}
	return pub.ID
}

func exportEnvelope(t *testing.T) []byte {
	t.Helper()
	w := doJSON(t, ExportRemoteHosts, http.MethodPost, "/api/remotehosts/export",
		map[string]string{"passphrase": "test-pass-01"})
	if w.Code != http.StatusOK {
		t.Fatalf("export status = %d, body = %s", w.Code, w.Body.String())
	}
	return w.Body.Bytes()
}

// TestExportEncryptedEnvelope 导出为加密信封：明文不泄漏、私钥随行、短口令拒绝
func TestExportEncryptedEnvelope(t *testing.T) {
	setupImportExportStore(t)
	oldKeyID := seedHosts(t)

	raw := exportEnvelope(t)
	if bytes.Contains(raw, []byte("alpha")) || bytes.Contains(raw, []byte("pw-plain")) {
		t.Fatal("envelope leaks plaintext host/password")
	}
	payload, err := config.DecryptWithPassphrase(raw, []byte("test-pass-01"))
	if err != nil {
		t.Fatalf("decrypt with passphrase: %v", err)
	}
	var pl exportPayload
	if err := json.Unmarshal(payload, &pl); err != nil {
		t.Fatalf("payload not valid: %v", err)
	}
	if len(pl.Hosts) != 2 {
		t.Fatalf("hosts = %d, want 2", len(pl.Hosts))
	}
	found := false
	for _, k := range pl.SshKeys {
		if k.ID == oldKeyID && k.PrivatePem != "" {
			found = true
		}
	}
	if !found {
		t.Fatal("referenced ssh key not exported with private pem")
	}

	w := doJSON(t, ExportRemoteHosts, http.MethodPost, "/api/remotehosts/export",
		map[string]string{"passphrase": "short"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("short passphrase status = %d, want 400", w.Code)
	}
}

// TestImportRoundtripRebuildsIDsAndRemapsSSHKey 换机模拟：新机导入后 ID 重建、
// sshKeyId 重映射到新钥、同指纹不重复入库；错误口令 400
func TestImportRoundtripRebuildsIDsAndRemapsSSHKey(t *testing.T) {
	setupImportExportStore(t)
	oldKeyID := seedHosts(t)
	env := exportEnvelope(t)

	// 模拟换机：全新空 store
	store.SetDefault(store.New(filestore.New(filepath.Join(t.TempDir(), "data"))))

	// 错误口令 → 400，且不落任何数据
	wBad := doJSON(t, ImportRemoteHosts, http.MethodPost, "/api/remotehosts/import",
		map[string]any{"file": json.RawMessage(env), "passphrase": "wrong-pass-99"})
	if wBad.Code != http.StatusBadRequest {
		t.Fatalf("wrong passphrase status = %d, want 400", wBad.Code)
	}
	if hosts, _ := store.Get().RemoteHost.List(); len(hosts) != 0 {
		t.Fatal("failed decrypt must not import anything")
	}

	importEnvelope := func() (int, int) {
		w := doJSON(t, ImportRemoteHosts, http.MethodPost, "/api/remotehosts/import",
			map[string]any{"file": json.RawMessage(env), "passphrase": "test-pass-01"})
		if w.Code != http.StatusOK {
			t.Fatalf("import status = %d, body = %s", w.Code, w.Body.String())
		}
		var res struct {
			Data struct {
				Imported int     `json:"imported"`
				Legacy   bool    `json:"legacy"`
				Failed   []gin.H `json:"failed"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
			t.Fatalf("unmarshal import response: %v", err)
		}
		if res.Data.Legacy {
			t.Fatal("envelope import must not be marked legacy")
		}
		return res.Data.Imported, len(res.Data.Failed)
	}

	imported, failedCnt := importEnvelope()
	if imported != 2 || failedCnt != 0 {
		t.Fatalf("imported = %d, failed = %d, want 2/0", imported, failedCnt)
	}

	// 私钥重建为新 ID，指纹去重后恰 1 把
	keys, _ := store.Get().SshKey.ListPublic()
	if len(keys) != 1 {
		t.Fatalf("keys = %d, want 1", len(keys))
	}
	if keys[0].ID == oldKeyID {
		t.Fatal("ssh key must be rebuilt with a new id")
	}
	hosts, _ := store.Get().RemoteHost.List()
	for i := range hosts {
		h, err := store.Get().RemoteHost.Get(hosts[i].ID)
		if err != nil {
			t.Fatalf("get imported host: %v", err)
		}
		if h.ID == "" || h.CreatedAt.IsZero() {
			t.Fatal("host id/timestamp must be rebuilt")
		}
		if h.AuthType == config.AuthTypeSshKey && h.SshKeyID != keys[0].ID {
			t.Fatalf("sshkey host %s: sshKeyId = %s, want remapped to %s", h.Name, h.SshKeyID, keys[0].ID)
		}
	}

	// 同信封再导一次：主机照常入库，同指纹私钥不得重复
	imported2, failed2 := importEnvelope()
	if imported2 != 2 || failed2 != 0 {
		t.Fatalf("second import = %d/%d, want 2/0", imported2, failed2)
	}
	if keys2, _ := store.Get().SshKey.ListPublic(); len(keys2) != 1 {
		t.Fatalf("keys after re-import = %d, want 1 (fingerprint dedup)", len(keys2))
	}
}

// TestImportLegacyPlaintextArray 旧版明文数组兼容导入：legacy 标记 + 凭据加密落盘
func TestImportLegacyPlaintextArray(t *testing.T) {
	dataDir := setupImportExportStore(t)
	legacy := []config.RemoteHost{{
		Name: "legacy-1", Host: "10.0.0.5", User: "deploy",
		AuthType: config.AuthTypePassword, Password: "plain-pw",
	}}
	w := doJSON(t, ImportRemoteHosts, http.MethodPost, "/api/remotehosts/import",
		map[string]any{"file": legacy})
	if w.Code != http.StatusOK {
		t.Fatalf("legacy import status = %d, body = %s", w.Code, w.Body.String())
	}
	var res struct {
		Data struct {
			Imported int     `json:"imported"`
			Legacy   bool    `json:"legacy"`
			Failed   []gin.H `json:"failed"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !res.Data.Legacy || res.Data.Imported != 1 || len(res.Data.Failed) != 0 {
		t.Fatalf("legacy result = %+v", res.Data)
	}
	// Get 返回的是解密态；明文不得出现在磁盘落盘文件中
	var leaked bool
	_ = filepath.WalkDir(dataDir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if b, rerr := os.ReadFile(path); rerr == nil && bytes.Contains(b, []byte("plain-pw")) {
			leaked = true
		}
		return nil
	})
	if leaked {
		t.Fatal("plaintext password found on disk; must be encrypted at rest")
	}
}

// TestImportValidationFailures 缺必填字段/非法 authType 进 failed，合法项不受影响
func TestImportValidationFailures(t *testing.T) {
	setupImportExportStore(t)
	bad := []config.RemoteHost{
		{Name: "", Host: "10.0.0.1", User: "u", AuthType: config.AuthTypePassword},
		{Name: "no-user", Host: "10.0.0.2", User: "", AuthType: config.AuthTypePassword},
		{Name: "bad-auth", Host: "10.0.0.3", User: "u", AuthType: "telnet"},
		{Name: "ok-1", Host: "10.0.0.9", User: "u", AuthType: config.AuthTypePassword, Password: "p"},
	}
	w := doJSON(t, ImportRemoteHosts, http.MethodPost, "/api/remotehosts/import",
		map[string]any{"file": bad})
	if w.Code != http.StatusOK {
		t.Fatalf("import status = %d", w.Code)
	}
	var res struct {
		Data struct {
			Imported int     `json:"imported"`
			Failed   []gin.H `json:"failed"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if res.Data.Imported != 1 || len(res.Data.Failed) != 3 {
		t.Fatalf("imported = %d, failed = %d, want 1/3", res.Data.Imported, len(res.Data.Failed))
	}
}
