package gitops

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// checkout 成功响应的 recoverableStash 字段（P-20261006-48）：真实 fixture 仓库
// 走完整请求链——无条目零字段 / pop 冲突保留条目在检出不匹配分支时不携带 /
// 切回原分支时携带（分支+消息+文件计数）。handler 测试钉住响应形状，匹配语义
// 细节在 server/git/checkout_autostash_test.go

func TestCheckoutBranch_RecoverableStashField(t *testing.T) {
	f := newFixtureRepo(t)
	// feature 分支把 a.txt 改成不同内容：main 侧对它的脏改动 pop 回 feature 必冲突
	f.run("checkout", "-qb", "feature")
	f.write("a.txt", "feature side\n")
	f.run("commit", "-qam", "feat: a.txt on feature")
	f.run("checkout", "main")

	r := setupGitopsTest(t, f)
	r.POST("/api/projects/:id/checkout", CheckoutBranch)
	r.POST("/api/projects/:id/stash/pop", StashPop)

	// ① 无条目零字段：干净栈检出，响应不带 recoverableStash 键（增量字段，
	//    旧前端忽略；无提示时也不得带空壳对象）
	w := post(r, "/api/projects/p1/checkout", `{"branch":"feature"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("checkout feature: status = %d body=%s", w.Code, w.Body.String())
	}
	if m := decodeJSONMap(t, w.Body.String()); hasKey(m, "recoverableStash") {
		t.Fatalf("empty stash list must omit recoverableStash, got %v", m["recoverableStash"])
	}
	post(r, "/api/projects/p1/checkout", `{"branch":"main"}`)

	// ② pop 冲突保留：autoStash 切走成功，保留条目 On main——检出目标 feature
	//    与条目归属分支不匹配，不携带（防把 main 的暂存恢复到 feature 重演冲突）
	f.write("a.txt", "main dirty\n")
	w = post(r, "/api/projects/p1/checkout", `{"branch":"feature","autoStash":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("autostash checkout: status = %d body=%s", w.Code, w.Body.String())
	}
	res := decodeJSONMap(t, w.Body.String())
	auto, _ := res["autoStash"].(map[string]any)
	if auto == nil || auto["stashKept"] != true {
		t.Fatalf("autoStash = %v, want stashKept=true (fixture relies on conflict)", res["autoStash"])
	}
	if hasKey(res, "recoverableStash") {
		t.Fatalf("kept entry belongs to main, checkout to feature must omit recoverableStash: %v", res["recoverableStash"])
	}

	// ③ 切回原分支携带：清掉冲突现场（reset --hard 不动 stash 栈），检出 main
	//    ——响应点名可恢复条目（分支=main、消息=写入端格式、文件计数≥1）
	f.run("reset", "--hard")
	w = post(r, "/api/projects/p1/checkout", `{"branch":"main"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("checkout back to main: status = %d body=%s", w.Code, w.Body.String())
	}
	res = decodeJSONMap(t, w.Body.String())
	rec, ok := res["recoverableStash"].(map[string]any)
	if !ok {
		t.Fatalf("checkout back to main must carry recoverableStash, body=%s", w.Body.String())
	}
	if rec["branch"] != "main" {
		t.Fatalf("recoverableStash.branch = %v, want main", rec["branch"])
	}
	if rec["message"] != "auto: checkout to feature" {
		t.Fatalf("recoverableStash.message = %v, want writer-side format", rec["message"])
	}
	if files, _ := rec["files"].(float64); files < 1 {
		t.Fatalf("recoverableStash.files = %v, want >= 1", rec["files"])
	}

	// ④ 一键恢复等价面：该条目按 index pop 在 main 干净落地（恢复链走既有
	//    /stash/pop 端点，此处钉住条目可用性）——变更回来、栈清空
	w = post(r, "/api/projects/p1/stash/pop", `{"index":0}`)
	if w.Code != http.StatusOK {
		t.Fatalf("stash pop: status = %d body=%s", w.Code, w.Body.String())
	}
	if got := f.read("a.txt"); got != "main dirty\n" {
		t.Fatalf("a.txt after pop = %q, want restored dirty content", got)
	}
	if out := strings.TrimSpace(f.run("stash", "list")); out != "" {
		t.Fatalf("stash list after pop = %q, want empty", out)
	}
}

func decodeJSONMap(t *testing.T, body string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(body), &m); err != nil {
		t.Fatalf("unmarshal %q: %v", body, err)
	}
	return m
}

func hasKey(m map[string]any, key string) bool {
	_, ok := m[key]
	return ok
}
