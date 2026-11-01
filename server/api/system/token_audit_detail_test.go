package system

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// P-20261003-133 审计 Detail 对象名自明化：token 撤销点 Detail 拼「name (id)」，
// 翻台账不再只见裸 id。单测直连 handler（路径参数手动注入，securitynotify 同款）。
func TestDeleteTokenAuditDetailSelfDescribing(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	_, cfg, err := store.Get().Token.Generate("deploy-ci", 0)
	if err != nil {
		t.Fatalf("seed token: %v", err)
	}

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodDelete, "/api/tokens/"+cfg.ID, nil)
	c.Params = gin.Params{{Key: "id", Value: cfg.ID}}
	DeleteToken(c)
	if w.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", w.Code, w.Body.String())
	}

	events, _, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatalf("list audit: %v", err)
	}
	for _, e := range events {
		if e.Action != store.AuditTokenRevoke {
			continue
		}
		if want := fmt.Sprintf("%s (%s)", "deploy-ci", cfg.ID); e.Detail != want {
			t.Fatalf("detail = %q, want %q", e.Detail, want)
		}
		return
	}
	t.Fatalf("audit log should record token revoke, got %+v", events)
}
