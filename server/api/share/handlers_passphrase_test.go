package shareapi

import (
	"net/http"
	"strings"
	"testing"

	"codecombo/server/store"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

// 口令门管理面测试（P-20261006-25）：复用 handlers_test.go 的 newAdminRouter
// 装配（临时 store + 种子项目），本文件只需额外注册 /passphrase 路由。
func newPassRouter(t *testing.T) *gin.Engine {
	t.Helper()
	r := newAdminRouter(t)
	r.POST("/api/share/:token/passphrase", SetSharePassphrase)
	return r
}

// TestCreateShareWithPassphrase 创建带可选口令：落库为 bcrypt 哈希（明文/哈希
// 均不出现在响应）、响应带 hasPassphrase、不带口令的创建不携带该字段
func TestCreateShareWithPassphrase(t *testing.T) {
	r := newPassRouter(t)

	// 带口令创建：响应 hasPassphrase=true，响应体无口令值
	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","passphrase":"open sesame"}`)
	if code != http.StatusOK {
		t.Fatalf("create status = %d, body = %v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	if data == nil {
		t.Fatalf("missing data: %v", out)
	}
	if data["hasPassphrase"] != true {
		t.Fatalf("hasPassphrase = %v, want true", data["hasPassphrase"])
	}
	// 口令明文不出现在任何响应字段（哈希也永不外发——投影只报有无）
	for k, v := range data {
		if s, ok := v.(string); ok && strings.Contains(s, "open sesame") {
			t.Fatalf("field %q leaks the passphrase: %q", k, s)
		}
	}

	// 落库侧：bcrypt 哈希可验明文，且不是明文本身
	rec, err := store.Get().Share.Get(data["token"].(string))
	if err != nil {
		t.Fatalf("get created: %v", err)
	}
	if rec.PassphraseHash == "" || rec.PassphraseHash == "open sesame" {
		t.Fatalf("stored passphrase not bcrypt-hashed: %q", rec.PassphraseHash)
	}
	if bcrypt.CompareHashAndPassword([]byte(rec.PassphraseHash), []byte("open sesame")) != nil {
		t.Fatal("stored hash does not verify against the request passphrase")
	}

	// 不带口令创建（幂等命中同链）：响应不新增 hasPassphrase 之外的口令字段，
	// 且不得拆掉既有门（store 层语义端到端再核一遍）
	code, out = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("plain create status = %d", code)
	}
	plain, _ := out["data"].(map[string]any)
	if plain["token"] != data["token"] {
		t.Fatalf("idempotent recreate token drift: %v vs %v", plain["token"], data["token"])
	}
	if plain["hasPassphrase"] != true {
		t.Fatalf("idempotent recreate must keep the gate: %v", plain)
	}

	// 超长口令：400（bcrypt 72 字节静默截断是 footgun，入口显式拒绝）
	long := strings.Repeat("x", 200)
	if code, _ := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","passphrase":"`+long+`"}`); code != http.StatusBadRequest {
		t.Fatalf("oversized passphrase status = %d, want 400", code)
	}
}

// TestSetSharePassphraseEndpoint 改/移除端点：更换（落库+响应投影）、联动
// rotate 换链（旧 token 失效、门随记录走）、移除、未知 token 404、snippet 同端点
func TestSetSharePassphraseEndpoint(t *testing.T) {
	r := newPassRouter(t)

	// 裸链接创建 → 设门
	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("create status = %d", code)
	}
	tok := out["data"].(map[string]any)["token"].(string)

	code, out = doJSON(r, http.MethodPost, "/api/share/"+tok+"/passphrase", `{"passphrase":"pw-1"}`)
	if code != http.StatusOK {
		t.Fatalf("set passphrase status = %d, body = %v", code, out)
	}
	if out["data"].(map[string]any)["hasPassphrase"] != true {
		t.Fatalf("set response missing hasPassphrase: %v", out)
	}
	if rec, _ := store.Get().Share.Get(tok); rec.PassphraseHash == "" {
		t.Fatal("hash not persisted after set")
	}

	// 改门 + 联动 rotate：返回新 token（≠旧），门随记录走，旧 token 不可解析
	code, out = doJSON(r, http.MethodPost, "/api/share/"+tok+"/passphrase", `{"passphrase":"pw-2","rotate":true}`)
	if code != http.StatusOK {
		t.Fatalf("set+rotate status = %d, body = %v", code, out)
	}
	next := out["data"].(map[string]any)
	newTok, _ := next["token"].(string)
	if newTok == "" || newTok == tok {
		t.Fatalf("rotate must yield fresh token: %v", next)
	}
	if next["hasPassphrase"] != true {
		t.Fatalf("rotated record lost the gate: %v", next)
	}
	if _, err := store.Get().Share.Get(tok); err == nil {
		t.Fatal("old token still resolvable after rotate")
	}

	// 移除口令：hasPassphrase 消失、落库清空
	code, out = doJSON(r, http.MethodPost, "/api/share/"+newTok+"/passphrase", `{"passphrase":""}`)
	if code != http.StatusOK {
		t.Fatalf("remove passphrase status = %d", code)
	}
	if _, present := out["data"].(map[string]any)["hasPassphrase"]; present {
		t.Fatalf("removed record still carries hasPassphrase: %v", out)
	}
	if rec, _ := store.Get().Share.Get(newTok); rec.PassphraseHash != "" {
		t.Fatalf("remove not persisted: %q", rec.PassphraseHash)
	}

	// 未知 token → 404
	if code, _ := doJSON(r, http.MethodPost, "/api/share/zzzzzzzzzzzzzzzz/passphrase", `{"passphrase":"x"}`); code != http.StatusNotFound {
		t.Fatalf("unknown token status = %d, want 404", code)
	}

	// snippet 同端点（四形态统一）：设门生效
	code, out = doJSON(r, http.MethodPost, "/api/share/snippet", `{"content":"panic: boom"}`)
	if code != http.StatusOK {
		t.Fatalf("snippet create status = %d", code)
	}
	sTok := out["data"].(map[string]any)["token"].(string)
	code, out = doJSON(r, http.MethodPost, "/api/share/"+sTok+"/passphrase", `{"passphrase":"sn"}`)
	if code != http.StatusOK || out["data"].(map[string]any)["hasPassphrase"] != true {
		t.Fatalf("snippet set passphrase: %d %v", code, out)
	}
}

// TestSnippetCreateWithPassphrase 片段创建同参：响应带 hasPassphrase
func TestSnippetCreateWithPassphrase(t *testing.T) {
	r := newPassRouter(t)
	code, out := doJSON(r, http.MethodPost, "/api/share/snippet", `{"content":"panic: boom","passphrase":"pw"}`)
	if code != http.StatusOK {
		t.Fatalf("create status = %d, body = %v", code, out)
	}
	if out["data"].(map[string]any)["hasPassphrase"] != true {
		t.Fatalf("snippet hasPassphrase = %v, want true", out["data"])
	}
}
