package remote

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// 主机状态点三态语义：AuthOK 粘性保持 + MarkAuthOK 升级 + invalidate 清除
func TestHostStatusAuthOKSemantics(t *testing.T) {
	t.Cleanup(func() {
		statusMu.Lock()
		statusCache = map[string]hostStatus{}
		statusMu.Unlock()
	})

	const id = "sc_rh_test"

	// 1) TCP 探测 online：无认证语义 → authOk=false（黄色）
	applyProbeResult(id, hostStatus{State: "online", LastCheck: 1})

	// 探测覆盖不改变既有认证结论（粘性）
	applyProbeResult(id, hostStatus{State: "online", LastCheck: 2})
	statusMu.RLock()
	st := statusCache[id]
	statusMu.RUnlock()
	if st.State != "online" || st.AuthOK {
		t.Fatalf("tcp-only state = %+v, want online + authOk=false", st)
	}

	// 2) 一次真实认证成功（MarkAuthOK）→ 升级为绿，且粘性跨探测保持
	MarkAuthOK(id)
	applyProbeResult(id, hostStatus{State: "online", LastCheck: 3})
	statusMu.RLock()
	st = statusCache[id]
	statusMu.RUnlock()
	if st.State != "online" || !st.AuthOK {
		t.Fatalf("after MarkAuthOK = %+v, want online + authOk=true", st)
	}

	// 3) 状态端点透出 authOk 字段
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodGet, "/api/remotehosts/status", nil)
	GetRemoteHostsStatus(c)
	if !strings.Contains(w.Body.String(), `"authOk":true`) {
		t.Fatalf("status endpoint missing authOk=true: %s", w.Body.String())
	}

	// 4) 主机编辑（凭据可能已变）→ 清缓存回退黄色语义
	invalidateHostStatus(id)
	statusMu.RLock()
	_, existed := statusCache[id]
	statusMu.RUnlock()
	if existed {
		t.Fatal("invalidate should drop cached status")
	}
}
