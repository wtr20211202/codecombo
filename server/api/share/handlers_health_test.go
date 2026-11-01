package shareapi

// 管理列表健康投影（P-20261020-10）：health 是纯响应字段（不落库），
// live 目标 / 项目根 / 冻结副本三轴矩阵 + 快照族（terminal-frozen/cast/
// session）副本缺失判定。坏链必须按异常投影，绝不让列表请求 500。

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"codecombo/server/config"
	"codecombo/server/share"
	"codecombo/server/store"
)

// healthOf 列表响应里按 token 取 health（行不存在返回空串）
func healthOf(t *testing.T, out map[string]any, token string) string {
	t.Helper()
	row := findRow(t, out, token)
	if row == nil {
		return ""
	}
	h, _ := row["health"].(string)
	return h
}

// TestListSharesHealthFileMatrix live/frozen 文件分享的健康矩阵：
//   - live 目标删除 → target_missing；项目根删除/项目记录删除 → project_gone
//   - frozen 只看快照副本：目标删除不影响；副本删除 → snapshot_missing；
//     项目整项删除后冻结链仍按定格内容可用（不误报 project_gone）
func TestListSharesHealthFileMatrix(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newAdminRouter(t)
	st := store.Get()

	// 种子第二项目 p2：用于验证「项目删除后冻结链仍 ok」
	p2dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(p2dir, "keep.txt"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := st.Project.Create(config.ProjectConfig{ID: "p2", Name: "frozen-only", Path: p2dir}); err != nil {
		t.Fatalf("seed p2: %v", err)
	}
	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p2","path":"keep.txt","mode":"frozen"}`)
	if code != http.StatusOK {
		t.Fatalf("frozen create status = %d body=%v", code, out)
	}
	frozenP2 := toString(out["data"].(map[string]any)["token"])

	// p1：live + frozen 同目标
	code, out = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("live create status = %d body=%v", code, out)
	}
	liveToken := toString(out["data"].(map[string]any)["token"])
	code, out = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"frozen"}`)
	if code != http.StatusOK {
		t.Fatalf("frozen create status = %d body=%v", code, out)
	}
	frozenToken := toString(out["data"].(map[string]any)["token"])

	code, out = doJSON(r, http.MethodGet, "/api/share", "")
	if code != http.StatusOK {
		t.Fatalf("list status = %d", code)
	}
	if got := healthOf(t, out, liveToken); got != ShareHealthOK {
		t.Fatalf("live health = %q, want ok", got)
	}
	if got := healthOf(t, out, frozenToken); got != ShareHealthOK {
		t.Fatalf("frozen health = %q, want ok", got)
	}
	if got := healthOf(t, out, frozenP2); got != ShareHealthOK {
		t.Fatalf("frozen p2 health = %q, want ok", got)
	}

	// live 目标删除：live = target_missing，frozen 副本不受影响
	p1, err := st.Project.GetByID("p1")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(p1.Path, "note.txt")); err != nil {
		t.Fatal(err)
	}
	_, out = doJSON(r, http.MethodGet, "/api/share", "")
	if got := healthOf(t, out, liveToken); got != ShareHealthTargetMissing {
		t.Fatalf("live health after target delete = %q, want target_missing", got)
	}
	if got := healthOf(t, out, frozenToken); got != ShareHealthOK {
		t.Fatalf("frozen health after target delete = %q, want ok (snapshot copy)", got)
	}

	// frozen 副本删除 → snapshot_missing
	if err := share.DeleteFrozenSnapshot(frozenNative("p1", "note.txt")); err != nil {
		t.Fatal(err)
	}
	_, out = doJSON(r, http.MethodGet, "/api/share", "")
	if got := healthOf(t, out, frozenToken); got != ShareHealthSnapshotMissing {
		t.Fatalf("frozen health after snapshot delete = %q, want snapshot_missing", got)
	}

	// 目标恢复后项目根删除 → project_gone（项目记录仍在，路径不可用）
	if err := os.WriteFile(filepath.Join(p1.Path, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(p1.Path); err != nil {
		t.Fatal(err)
	}
	_, out = doJSON(r, http.MethodGet, "/api/share", "")
	if got := healthOf(t, out, liveToken); got != ShareHealthProjectGone {
		t.Fatalf("live health after project root delete = %q, want project_gone", got)
	}

	// 项目记录删除 → project_gone；冻结链不随项目消失（快照自包含）
	if err := st.Project.Delete("p2"); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(p2dir); err != nil {
		t.Fatal(err)
	}
	_, out = doJSON(r, http.MethodGet, "/api/share", "")
	if got := healthOf(t, out, liveToken); got != ShareHealthProjectGone {
		t.Fatalf("live health after project delete = %q, want project_gone", got)
	}
	if got := healthOf(t, out, frozenP2); got != ShareHealthOK {
		t.Fatalf("frozen health after project delete = %q, want ok (snapshot self-contained)", got)
	}
}

// TestListSharesHealthSnapshotKinds 快照族健康：terminal-frozen/cast/session
// 副本在盘 = ok，目录缺失 = snapshot_missing；snippet/terminal 恒 ok
// （无文件目标可 stat——片段内容随记录落库，直播内容源是会话语义）
func TestListSharesHealthSnapshotKinds(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newAdminRouter(t)
	st := store.Get()

	term, err := st.Share.Create(store.Share{
		Kind: store.ShareKindTermFrozen, TerminalID: "t1", ContentHash: "hash1", Name: "term",
	})
	if err != nil {
		t.Fatal(err)
	}
	cast, err := st.Share.Create(store.Share{
		Kind: store.ShareKindCast, RecordingID: "rec1", Name: "cast",
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := st.Share.Create(store.Share{
		Kind: store.ShareKindSession, SessionID: "sess1", Name: "session",
	})
	if err != nil {
		t.Fatal(err)
	}
	snippet, err := st.Share.Create(store.Share{
		Kind: store.ShareKindSnippet, Content: "snippet body", Name: "snippet",
	})
	if err != nil {
		t.Fatal(err)
	}
	terminal, err := st.Share.Create(store.Share{
		Kind: store.ShareKindTerminal, TerminalID: "live1", Name: "live terminal",
	})
	if err != nil {
		t.Fatal(err)
	}

	// 快照落盘（三形态共用 SnapshotsRoot）
	termNative := store.TermFrozenNativeToken(config.MasterKey(), "t1", "hash1")
	castNative := store.CastNativeToken(config.MasterKey(), "rec1")
	sessNative := store.SessionNativeToken(config.MasterKey(), "sess1")
	if err := share.WriteTermFrozenSnapshot(termNative, []byte("output")); err != nil {
		t.Fatal(err)
	}
	if err := share.WriteCastSnapshot(castNative, []byte(`{"version":2}`)); err != nil {
		t.Fatal(err)
	}
	if err := share.WriteSessionSnapshot(sessNative, []byte(`{"entries":[]}`)); err != nil {
		t.Fatal(err)
	}

	_, out := doJSON(r, http.MethodGet, "/api/share", "")
	for token, want := range map[string]string{
		term.Token: ShareHealthOK, cast.Token: ShareHealthOK, session.Token: ShareHealthOK,
		snippet.Token: ShareHealthOK, terminal.Token: ShareHealthOK,
	} {
		if got := healthOf(t, out, token); got != want {
			t.Fatalf("health[%s] = %q, want %q", token, got, want)
		}
	}

	// 副本目录逐个删除 → snapshot_missing
	for _, native := range []string{termNative, castNative, sessNative} {
		if err := share.DeleteFrozenSnapshot(native); err != nil {
			t.Fatal(err)
		}
	}
	_, out = doJSON(r, http.MethodGet, "/api/share", "")
	for _, token := range []string{term.Token, cast.Token, session.Token} {
		if got := healthOf(t, out, token); got != ShareHealthSnapshotMissing {
			t.Fatalf("health[%s] after snapshot delete = %q, want snapshot_missing", token, got)
		}
	}
	// 无文件锚点的形态不受快照缺失影响
	for _, token := range []string{snippet.Token, terminal.Token} {
		if got := healthOf(t, out, token); got != ShareHealthOK {
			t.Fatalf("health[%s] = %q, want ok", token, got)
		}
	}
}
