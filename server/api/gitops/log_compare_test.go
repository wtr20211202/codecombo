package gitops

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// ── 分支比较弹层的提交区间（P-20261003-233）──
// GET /log?range=compare&from&to[&unique=1]：
//   - unique=1 → from..to 单向（仅 to 独有）
//   - 缺省 → from...to 对称差（双向全量）
//   - 基线缺失（from 不可解析）→ 200 + to 全量 + noBase 标志（P-151 noUpstream 同款增量标志）
//   - to 缺参 → 400
//
// 断言取「成员集合」而非行序：对称差两侧按提交时间排序，fixtureRepo.run 无
// env 注入口、夹具同秒提交的相对序不跨平台保证——集合语义与序无关，精确序
// 断言归 server/git TestGetCompareLog（那里提交时间已钉死）。

// setupCompareLogTest 分叉双分支夹具：newFixtureRepo 落 c1→c2 后，feature 自 c2
// 分叉，main 再进 c3——对称差 = {c3, f1, f2}，单向 = {f1, f2}。
// 空提交（--allow-empty）即可——区间 log 只看拓扑不看内容
func setupCompareLogTest(t *testing.T) *fixtureRepo {
	t.Helper()
	f := newFixtureRepo(t)
	f.run("branch", "feature")
	f.run("commit", "--allow-empty", "-m", "c3: main side")
	f.run("switch", "feature")
	f.run("commit", "--allow-empty", "-m", "f1: feature one")
	f.run("commit", "--allow-empty", "-m", "f2: feature two")
	f.run("switch", "main")
	return f
}

// compareSubjects 提取响应体提交主题行集合
func compareSubjects(t *testing.T, w *httptest.ResponseRecorder) map[string]bool {
	t.Helper()
	body := decodeBody(t, w)
	data, _ := body["data"].([]any)
	out := make(map[string]bool, len(data))
	for _, item := range data {
		m, _ := item.(map[string]any)
		msg, _ := m["message"].(string)
		out[msg] = true
	}
	return out
}

func TestCompareRangeHandler(t *testing.T) {
	f := setupCompareLogTest(t)
	r := setupLogTest(t, f)

	// unique=1：仅 feature 侧独有（f1/f2），不含 main 侧 c3 与共同祖先 c1/c2
	w := get(r, "/api/projects/p1/log?range=compare&from=main&to=feature&unique=1")
	if w.Code != http.StatusOK {
		t.Fatalf("unique: status = %d, body=%s", w.Code, w.Body.String())
	}
	got := compareSubjects(t, w)
	if len(got) != 2 || !got["f1: feature one"] || !got["f2: feature two"] {
		t.Fatalf("unique: want {f1,f2}, got %v", got)
	}
	body := decodeBody(t, w)
	if _, has := body["noBase"]; has {
		t.Fatalf("unique: want noBase absent, got %s", w.Body.String())
	}

	// 缺省对称差：两侧独有全量（c3/f1/f2），共同祖先 c1/c2 不在列
	w = get(r, "/api/projects/p1/log?range=compare&from=main&to=feature")
	got = compareSubjects(t, w)
	if len(got) != 3 || !got["c3: main side"] || !got["f1: feature one"] || !got["f2: feature two"] {
		t.Fatalf("symmetric: want {c3,f1,f2}, got %v", got)
	}

	// 基线缺失：from 不可解析 → 200 + to 全量（c1/c2/f1/f2）+ noBase 标志
	w = get(r, "/api/projects/p1/log?range=compare&from=ghost-branch&to=feature&unique=1")
	if w.Code != http.StatusOK {
		t.Fatalf("no-base: status = %d, body=%s", w.Code, w.Body.String())
	}
	got = compareSubjects(t, w)
	if len(got) != 4 || !got["c1"] || !got["c2"] || !got["f1: feature one"] || !got["f2: feature two"] {
		t.Fatalf("no-base: want full history {c1,c2,f1,f2}, got %v", got)
	}
	body = decodeBody(t, w)
	if body["noBase"] != true {
		t.Fatalf("no-base: want noBase=true, got %s", w.Body.String())
	}

	// to 缺参 → 400
	w = get(r, "/api/projects/p1/log?range=compare&from=main")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing to: want 400, got %d", w.Code)
	}
}
