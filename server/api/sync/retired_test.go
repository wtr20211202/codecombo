package sync

import (
	"archive/zip"
	"bytes"
	"context"
	"strings"
	"testing"

	"codecombo/server/store"
)

// ── 笔记单元退役（P-20261108-3 单库化）的 sync 面防线：笔记改为项目无关的
// 全局库、不再随实例同步。mixed-version 回流（旧对端仍产出/推送 notes 与
// notes-multi 单元）四面显式化——打包拒绝 / 落位拒收 / plan 标 retired 不可
// 勾选 / 执行点名逐个记失败——杜绝「旧包直写项目作用域键、新 UI 看不见」的
// 静默半态（P-20261107-2a 复审#4 同类）──

// oldPeerNotesZip 旧对端形态的笔记单元包（u0 notes.json 默认篇载荷 + u1
// notes-multi.json 多篇载荷——P-20261107-2 时代 packNotesUnit/packNotesMultiUnit 产物）
func oldPeerNotesZip(t *testing.T) ([]byte, *TransferMeta) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w0, err := zw.Create("u0/notes.json")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w0.Write([]byte(`{"content":"# old peer default note","updatedAt":"2026-11-01T00:00:00Z"}`))
	w1, err := zw.Create("u1/notes-multi.json")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w1.Write([]byte(`{"version":1,"notes":[{"id":"n1","title":"T","content":"old multi","createdAt":"2026-11-01T00:00:00Z","updatedAt":"2026-11-01T00:00:00Z"}]}`))
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	meta := &TransferMeta{Units: []TransferUnit{
		{Key: "notes:alpha", Kind: UnitNotes, Name: "alpha", DirName: "alpha"},
		{Key: "notes-multi:alpha", Kind: UnitNotesMulti, Name: "alpha", DirName: "alpha"},
	}}
	return buf.Bytes(), meta
}

// TestRetiredNotesUnits_PackRejected 本端打包拒绝退役单元（旧对端来拉/误点名都
// 显式失败，不回空包静默成功）
func TestRetiredNotesUnits_PackRejected(t *testing.T) {
	setupSyncEnv(t)
	src := newProjectDir(t, "alpha")
	writeTree(t, src, map[string]string{"a.txt": "x"})
	seedProject(t, "p1", "alpha", src)

	payloads, errs := resolveUnitPayloads([]string{"notes:alpha", "notes-multi:alpha"}, false)
	if len(payloads) != 0 || len(errs) != 2 {
		t.Fatalf("retired units must not resolve: payloads=%d errs=%v", len(payloads), errs)
	}
	for _, e := range errs {
		if !strings.Contains(e, "retired") {
			t.Errorf("error should name the retirement: %q", e)
		}
	}
}

// TestRetiredNotesUnits_LandRejected mixed-version 回流防线：旧对端推来的笔记
// 单元落位侧显式拒收（单元结果带错误回告推送方标红），项目作用域与全局库零写入
func TestRetiredNotesUnits_LandRejected(t *testing.T) {
	setupSyncEnv(t)
	src := newProjectDir(t, "alpha")
	writeTree(t, src, map[string]string{"a.txt": "x"})
	seedProject(t, "p1", "alpha", src)

	body, meta := oldPeerNotesZip(t)
	lr, err := landUnits(context.Background(), bytes.NewReader(body), meta, t.TempDir(), nil)
	if err != nil {
		t.Fatalf("landUnits: %v", err)
	}
	if len(lr.Units) != 2 {
		t.Fatalf("expected 2 unit results, got %+v", lr.Units)
	}
	for _, u := range lr.Units {
		if u.OK || !strings.Contains(u.Error, "retired") {
			t.Errorf("retired unit %s must be rejected with explicit error, got %+v", u.Key, u)
		}
	}
	if notes, _ := store.Get().MultiNotes.List("p1"); len(notes) != 0 {
		t.Errorf("rejected landing must not write project-scope notes, got %d", len(notes))
	}
	if notes, _ := store.Get().MultiNotes.List(store.GlobalNotesScope); len(notes) != 0 {
		t.Errorf("rejected landing must not write global notes either, got %d", len(notes))
	}
}

// TestRetiredNotesUnits_PlanMarksRetired 旧对端 manifest 携带笔记单元 → plan 行
// 标 retired（action=skip、不勾选、不计总量；旧账本基线不参与判定）；定时同步
// 选单元面（含镜像档）同样排除
func TestRetiredNotesUnits_PlanMarksRetired(t *testing.T) {
	local := &ManifestResponse{Units: []UnitEntry{
		{Key: "project:a", Kind: UnitProject, Name: "a", Fingerprint: "L1", Exists: true},
	}}
	peer := &ManifestResponse{Units: []UnitEntry{
		{Key: "project:a", Kind: UnitProject, Name: "a", Fingerprint: "P1", Exists: true},
		{Key: "notes:a", Kind: UnitNotes, ProjectKey: "project:a", Name: "a · 笔记", Fingerprint: "N1", Size: 100, Files: 1, Exists: true},
		{Key: "notes-multi:a", Kind: UnitNotesMulti, ProjectKey: "project:a", Name: "a · 笔记库", Fingerprint: "M1", Size: 200, Files: 1, Exists: true},
	}, DiskFree: 1 << 30}
	ledger := map[string]store.SyncLedgerEntry{
		"notes:a": {UnitKey: "notes:a", LocalFP: "N0", PeerFP: "N0"},
	}
	plan := planFromManifests(local, peer, ledger, nil, []string{"crons"})
	retired := 0
	for _, row := range plan.Rows {
		if !IsRetiredKind(row.Kind) {
			continue
		}
		retired++
		if row.State != PlanRetired || row.Action != PlanSkip || row.Selected {
			t.Errorf("retired row must be state=retired/action=skip/unselected: %+v", row)
		}
	}
	if retired != 2 {
		t.Fatalf("expected 2 retired rows (explicit, not hidden), got %d: %+v", retired, plan.Rows)
	}
	for _, row := range plan.Rows {
		if row.Selected && IsRetiredKind(row.Kind) {
			t.Error("retired rows must not count toward totals")
		}
	}
	for _, dir := range []string{store.SyncCronDirPull, store.SyncCronDirPush} {
		for _, policy := range []string{store.SyncPolicySafe, store.SyncPolicyPeerMirror, store.SyncPolicyLocalMirror} {
			units, _ := selectUnitsForPolicy(plan, dir, policy)
			for _, k := range units {
				if isRetiredUnitKey(k) {
					t.Errorf("cron selection (%s/%s) must exclude retired unit %s", dir, policy, k)
				}
			}
		}
	}
}

// TestRetiredNotesUnits_ExecuteFailsExplicitly 执行请求点名退役单元（旧 UI 记忆/
// agent/定时旧键）：不发起传输、不落位，逐个记失败——单元行 Error 文案 + 结果
// 红点；整批只含退役单元时 outcome=failed
func TestRetiredNotesUnits_ExecuteFailsExplicitly(t *testing.T) {
	setupSyncEnv(t)
	peer := newPeerStub(t, &ManifestResponse{DiskFree: 1 << 30})
	inst := registerPeer(t, peer.server.URL)

	res, err := executeSync(ExecuteRequest{
		InstanceIDs: []string{inst.ID},
		Units:       []string{"notes:alpha", "notes-multi:alpha"},
	}, "pull", "manual")
	if err != nil {
		t.Fatalf("executeSync: %v", err)
	}
	if len(res.Units) != 2 {
		t.Fatalf("expected 2 unit results, got %+v", res.Units)
	}
	for _, u := range res.Units {
		if u.OK || u.Skipped || !strings.Contains(u.Error, "retired") {
			t.Errorf("retired unit must fail explicitly: %+v", u)
		}
	}
	if len(peer.gotGet) != 0 {
		t.Errorf("retired units must not hit the peer, got GET keys %v", peer.gotGet)
	}
	snap := currentProgress()
	if snap == nil || snap.Outcome != "failed" {
		t.Fatalf("job outcome should be failed, got %+v", snap)
	}
	for _, u := range snap.Units {
		if u.State != "failed" || !strings.Contains(u.Error, "retired") {
			t.Errorf("progress unit row must carry failed state + error text: %+v", u)
		}
	}
}
