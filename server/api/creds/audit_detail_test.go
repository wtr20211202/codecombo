package creds

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// P-20261003-133 审计 Detail 对象名自明化：破坏性删除点 Detail 拼「名 (id)」，
// 翻台账不再只见裸 id。单测直连 handler（路径参数手动注入，securitynotify 同款）。

func setupAuditDetailStore(t *testing.T) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
}

// deleteWithID 以 DELETE + :id 路径参数直连调用 handler
func deleteWithID(handler gin.HandlerFunc, id string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodDelete, "/api/x/"+id, nil)
	c.Params = gin.Params{{Key: "id", Value: id}}
	handler(c)
	return w
}

// lastAuditDetailOf 取指定 action 最新一条审计的 Detail（List 时间倒序，最新在前）
func lastAuditDetailOf(t *testing.T, action string) string {
	t.Helper()
	events, _, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	for _, e := range events {
		if e.Action == action {
			return e.Detail
		}
	}
	t.Fatalf("audit log should record %s, got %+v", action, events)
	return ""
}

func TestDeleteGitCredentialAuditDetailSelfDescribing(t *testing.T) {
	setupAuditDetailStore(t)
	cred := &store.Credential{
		Host:     "git.example.com",
		Platform: "generic",
		Username: "deploy-bot",
		AuthType: store.AuthTypeBasic,
		Status:   store.StatusActive,
		Secret:   "s3cret-not-in-detail",
	}
	if err := store.Get().Credential.Save(cred); err != nil {
		t.Fatalf("seed credential: %v", err)
	}

	w := deleteWithID(DeleteGitCredential, cred.ID)
	if w.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", w.Code, w.Body.String())
	}
	// 凭据的「名」= username@host（与 save 点同口径），拼「名 (id)」；
	// Secret 任何形态不得入账
	want := fmt.Sprintf("%s@%s (%s)", "deploy-bot", "git.example.com", cred.ID)
	if got := lastAuditDetailOf(t, store.AuditCredDelete); got != want {
		t.Fatalf("detail = %q, want %q", got, want)
	}
	events, _, _ := store.Get().Audit.List(10, 0)
	for _, e := range events {
		if strings.Contains(e.Detail, "s3cret-not-in-detail") {
			t.Fatalf("secret material leaked into audit: %+v", e)
		}
	}
}

func TestDeleteSshKeyAuditDetailSelfDescribing(t *testing.T) {
	setupAuditDetailStore(t)
	meta, _, err := store.Get().SshKey.Generate("ci-deploy-key", "ed25519")
	if err != nil {
		t.Fatalf("seed ssh key: %v", err)
	}

	w := deleteWithID(DeleteSshKey, meta.ID)
	if w.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", w.Code, w.Body.String())
	}
	want := fmt.Sprintf("%s (%s)", "ci-deploy-key", meta.ID)
	if got := lastAuditDetailOf(t, store.AuditSSHKeyDelete); got != want {
		t.Fatalf("detail = %q, want %q", got, want)
	}
}
