package shareapi

import (
	"net/http"
	"testing"
	"time"

	"codecombo/server/store"
)

// 访客留言管理面（P-20261006-13）端点纪律锁：列表投影（messages 计数角标）、
// 单删/清空 404 口径、撤销级联（列表 404 + 幂等重建空态幂等）。写入侧防线
// 在访客子服务（server/share/guestboard_test.go），此处只锁主人侧契约

func TestShareMessagesManagement(t *testing.T) {
	r := newAdminRouter(t)
	r.GET("/api/share/:token/messages", ListShareMessages)
	r.DELETE("/api/share/:token/messages", ClearShareMessages)
	r.DELETE("/api/share/:token/messages/:mid", DeleteShareMessage)

	// 建分享 + 两条留言（经 store 直写——写入侧在访客面单测覆盖）
	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("create status = %d body = %v", code, out)
	}
	token, _ := out["data"].(map[string]any)["token"].(string)
	st := store.Get()
	if _, err := st.ShareMsg.Add(token, "alice", "第一条", time.Now()); err != nil {
		t.Fatalf("seed msg1: %v", err)
	}
	m2, err := st.ShareMsg.Add(token, "", "第二条", time.Now())
	if err != nil {
		t.Fatalf("seed msg2: %v", err)
	}

	// 管理列表投影：messages 计数 = 2（角标 O(1) 数据源）
	_, out = doJSON(r, http.MethodGet, "/api/share", "")
	list, _ := out["data"].([]any)
	row, _ := list[0].(map[string]any)
	if n, _ := row["messages"].(float64); int(n) != 2 {
		t.Fatalf("list messages badge = %v, want 2", row["messages"])
	}

	// 留言列表：新到旧，形态完整
	code, out = doJSON(r, http.MethodGet, "/api/share/"+token+"/messages", "")
	if code != http.StatusOK {
		t.Fatalf("list messages status = %d", code)
	}
	msgs, _ := out["data"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("messages len = %d, want 2", len(msgs))
	}
	first, _ := msgs[0].(map[string]any)
	if first["text"] != "第二条" || first["nickname"] != nil {
		t.Fatalf("newest-first/anonymous wrong: %v", first)
	}

	// 单删：200；未知 id 404；计数角标同步 -1
	if code, _ = doJSON(r, http.MethodDelete, "/api/share/"+token+"/messages/"+m2.ID, ""); code != http.StatusOK {
		t.Fatalf("delete message status = %d", code)
	}
	if code, _ = doJSON(r, http.MethodDelete, "/api/share/"+token+"/messages/nope", ""); code != http.StatusNotFound {
		t.Fatalf("delete unknown message status = %d, want 404", code)
	}
	_, out = doJSON(r, http.MethodGet, "/api/share", "")
	list, _ = out["data"].([]any)
	row, _ = list[0].(map[string]any)
	if n, _ := row["messages"].(float64); int(n) != 1 {
		t.Fatalf("messages badge after delete = %v, want 1", row["messages"])
	}

	// 清空：200 + removed=1；再清 removed=0（第二次不取载荷——removed 已断言）
	code, out = doJSON(r, http.MethodDelete, "/api/share/"+token+"/messages", "")
	if code != http.StatusOK {
		t.Fatalf("clear status = %d", code)
	}
	if n, _ := out["removed"].(float64); int(n) != 1 {
		t.Fatalf("clear removed = %v, want 1", out["removed"])
	}
	if code, _ = doJSON(r, http.MethodDelete, "/api/share/"+token+"/messages", ""); code != http.StatusOK {
		t.Fatalf("clear again status = %d", code)
	}

	// 未知分享：列表/清空一律 404
	if code, _ = doJSON(r, http.MethodGet, "/api/share/zzzzzzzzzzzzzzzz/messages", ""); code != http.StatusNotFound {
		t.Fatalf("list unknown token = %d, want 404", code)
	}
	if code, _ = doJSON(r, http.MethodDelete, "/api/share/zzzzzzzzzzzzzzzz/messages", ""); code != http.StatusNotFound {
		t.Fatalf("clear unknown token = %d, want 404", code)
	}

	// 撤销级联：留言附表随记录消亡（重放同 token 的留言列表 404，幂等重建
	// 后计数归零——「随分享撤销级联删除」的管理面观测口径）
	if code, _ = doJSON(r, http.MethodDelete, "/api/share/"+token, ""); code != http.StatusOK {
		t.Fatalf("revoke status = %d", code)
	}
	if code, _ = doJSON(r, http.MethodGet, "/api/share/"+token+"/messages", ""); code != http.StatusNotFound {
		t.Fatalf("messages after revoke = %d, want 404", code)
	}
	code, out = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("recreate status = %d", code)
	}
	if data, _ := out["data"].(map[string]any); data["token"] != token {
		t.Fatalf("recreate token = %v, want same %s", data["token"], token)
	}
	code, out = doJSON(r, http.MethodGet, "/api/share/"+token+"/messages", "")
	if code != http.StatusOK {
		t.Fatalf("messages after recreate status = %d", code)
	}
	if msgs, _ := out["data"].([]any); len(msgs) != 0 {
		t.Fatalf("messages after revoke must be empty, got %d", len(msgs))
	}
}
