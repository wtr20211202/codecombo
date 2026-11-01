package deploy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/deploy"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// nilSliceDeployer 模拟 ParamsSchema/DependsOn/Steps 全部返回 nil 的 deployer
type nilSliceDeployer struct{}

func (nilSliceDeployer) ID() string                                        { return "test_nil_slice" }
func (nilSliceDeployer) Name() string                                      { return "test" }
func (nilSliceDeployer) Category() string                                  { return deploy.CategoryInit }
func (nilSliceDeployer) Description() string                               { return "test" }
func (nilSliceDeployer) DependsOn() []string                               { return nil }
func (nilSliceDeployer) Steps() []string                                   { return nil }
func (nilSliceDeployer) AllowMultiple() bool                               { return false }
func (nilSliceDeployer) ParamsSchema() []deploy.ParamSpec                  { return nil }
func (nilSliceDeployer) Deploy(context.Context, deploy.DeployParams) error { return nil }

// TestListDeployers_NilSlicesSerializeAsEmptyArrays 回归一个真实线上 bug：
// 多个 deployer（claude_code/init_user/simple_coding）的 ParamsSchema 返回 nil，
// JSON 序列化为 null，前端 for...of null 触发 "paramsSchema is not iterable" 错误。
// 要求：handler 必须把所有 nil slice 字段序列化为空数组 []。
func TestListDeployers_NilSlicesSerializeAsEmptyArrays(t *testing.T) {
	deploy.Register(nilSliceDeployer{})

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/deployers", ListDeployers)

	req := httptest.NewRequest(http.MethodGet, "/deployers", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	// 解析为 generic map，区分 null 和 [] —— unmarshal 到 map[string]any 后
	// JSON null 是 nil，JSON [] 是 []any
	var resp struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	var found bool
	for _, d := range resp.Data {
		if d["id"] != "test_nil_slice" {
			continue
		}
		found = true
		for _, field := range []string{"paramsSchema", "dependsOn", "steps"} {
			v, ok := d[field]
			if !ok {
				t.Errorf("field %s missing in response", field)
				continue
			}
			arr, isArr := v.([]any)
			if !isArr {
				t.Errorf("field %s = %T (%v), want [] (got null from nil slice)", field, v, v)
				continue
			}
			if len(arr) != 0 {
				t.Errorf("field %s has %d items, want 0", field, len(arr))
			}
		}
	}
	if !found {
		t.Fatal("test_nil_slice deployer not found in response")
	}
}

// ============== TestRemoteHostConnectionByParams 凭据回填 ==============

// testConnRouter 表单直测端点测试 router（需主机存储初始化）
func testConnRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	dir := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	store.SetDefault(store.New(filestore.New(dir)))
	t.Cleanup(func() { store.SetDefault(nil) })

	r := gin.New()
	r.POST("/api/remotehosts/test", TestRemoteHostConnectionByParams)
	return r
}

func doTestConn(r *gin.Engine, body string) string {
	t := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/remotehosts/test", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(t, req)
	return t.Body.String()
}

// TestByParams_KeepsStoredCredsOnChangedTarget 编辑场景回归：复制/编辑主机后仅改连接
// 目标、凭据留空 → 服务端按「保持原值」回填已存凭据再拨号。此前空密码直测必然误报
// "build auth methods: password is empty"，与保存语义（留空 = 保持原密码）自相矛盾
func TestByParams_KeepsStoredCredsOnChangedTarget(t *testing.T) {
	r := testConnRouter(t)
	rh, err := store.Get().RemoteHost.Create(config.RemoteHost{
		Name: "src", Host: "127.0.0.1", Port: 1, User: "root",
		AuthType: config.AuthTypePassword, Password: "secret",
	})
	if err != nil {
		t.Fatalf("create host: %v", err)
	}

	// 只改端口、密码留空：应回填已存密码并真实拨号到新目标（127.0.0.1:2 拒连），
	// 而不是在本地凭据校验处被 "password is empty" 拦下
	body := doTestConn(r, `{"id":"`+rh.ID+`","host":"127.0.0.1","port":2,"user":"root","authType":"password"}`)
	if strings.Contains(body, "password is empty") {
		t.Fatalf("stored-password fallback not applied: %s", body)
	}
	if !strings.Contains(body, "ssh dial 127.0.0.1:2") {
		t.Fatalf("expected dial attempt to changed target, got: %s", body)
	}
}

// TestByParams_IdentityUnchangedUsesStoredCreds id + 表单与已存完全一致 + 凭据留空：
// 等价于按 id 探测（走已存凭据拨号，且真实认证成功可升级在线徽章）
func TestByParams_IdentityUnchangedUsesStoredCreds(t *testing.T) {
	r := testConnRouter(t)
	rh, err := store.Get().RemoteHost.Create(config.RemoteHost{
		Name: "src", Host: "127.0.0.1", Port: 1, User: "root",
		AuthType: config.AuthTypePassword, Password: "secret",
	})
	if err != nil {
		t.Fatalf("create host: %v", err)
	}

	body := doTestConn(r, `{"id":"`+rh.ID+`","host":"127.0.0.1","port":1,"user":"root","authType":"password"}`)
	if strings.Contains(body, "password is empty") {
		t.Fatalf("stored-password fallback not applied: %s", body)
	}
	if !strings.Contains(body, "ssh dial 127.0.0.1:1") {
		t.Fatalf("expected dial attempt to stored target, got: %s", body)
	}
}

// TestByParams_PemFallback 编辑 pem 主机不回填明文：留空回填已存私钥内容
// （此处为非法内容 → 解析报错），而非 "pem content is empty" 拦截
func TestByParams_PemFallback(t *testing.T) {
	r := testConnRouter(t)
	rh, err := store.Get().RemoteHost.Create(config.RemoteHost{
		Name: "src", Host: "127.0.0.1", Port: 1, User: "root",
		AuthType: config.AuthTypePem, PemContent: "not a valid pem",
	})
	if err != nil {
		t.Fatalf("create host: %v", err)
	}

	body := doTestConn(r, `{"id":"`+rh.ID+`","host":"127.0.0.1","port":1,"user":"root","authType":"pem"}`)
	if strings.Contains(body, "pem content is empty") {
		t.Fatalf("stored-pem fallback not applied: %s", body)
	}
	if !strings.Contains(body, "parse private key") {
		t.Fatalf("expected stored pem to reach key parsing, got: %s", body)
	}
}

// TestByParams_EmptyPasswordWithoutID 新增主机（无 id）：凭据留空仍按空测，
// 报错保持原有 "password is empty"
func TestByParams_EmptyPasswordWithoutID(t *testing.T) {
	r := testConnRouter(t)
	body := doTestConn(r, `{"host":"127.0.0.1","port":1,"user":"root","authType":"password"}`)
	if !strings.Contains(body, "password is empty") {
		t.Fatalf("expected empty-password error without id, got: %s", body)
	}
}
