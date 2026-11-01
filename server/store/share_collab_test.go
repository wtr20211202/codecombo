package store_test

// 协作通道开关（P-20261024-1）store 层语义：SetCollab/SetDirectInput 的
// RMW 单字段覆写（其余字段原样）、过期记录拒绝（与 Rotate 同口径）、
// 缺省关闭的存量零迁移

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

func TestShareStoreCollabToggle(t *testing.T) {
	st := newShareStoreForTest(t)
	created, err := st.Create(store.Share{ProjectID: "p1", ProjectName: "demo", Path: "docs", Name: "docs", IsDir: true})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.Collab || created.DirectInput {
		t.Fatal("new share must default to collab/direct-input off (存量零迁移)")
	}

	// 开启：单字段覆写，其余字段原样（CreatedAt/Hits 不动）
	on, err := st.SetCollab(created.Token, true)
	if err != nil {
		t.Fatalf("set collab on: %v", err)
	}
	if !on.Collab || on.DirectInput {
		t.Fatalf("collab on wrong: %+v", on)
	}
	if !on.CreatedAt.Equal(created.CreatedAt) {
		t.Fatal("RMW must not touch CreatedAt")
	}
	got, _ := st.Get(created.Token)
	if !got.Collab {
		t.Fatal("collab flag not persisted")
	}

	// 关闭：回收语义（记录仍在、字段归零）
	off, err := st.SetCollab(created.Token, false)
	if err != nil || off.Collab {
		t.Fatalf("collab off: %+v err=%v", off, err)
	}

	// 未知 token → ErrNotFound
	if _, err := st.SetCollab("nope0123456789ab", true); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown token = %v, want ErrNotFound", err)
	}
}

func TestShareStoreDirectInputToggle(t *testing.T) {
	st := newShareStoreForTest(t)
	created, err := st.Create(store.Share{ProjectID: "p1", ProjectName: "demo", Path: "a.txt", Name: "a"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	on, err := st.SetDirectInput(created.Token, true)
	if err != nil || !on.DirectInput || on.Collab {
		t.Fatalf("direct on: %+v err=%v", on, err)
	}
	// 与协作通道互不联动：开直通不带上协作，反之亦然
	if _, err := st.SetCollab(created.Token, true); err != nil {
		t.Fatalf("collab on: %v", err)
	}
	got, _ := st.Get(created.Token)
	if !got.Collab || !got.DirectInput {
		t.Fatalf("independent toggles wrong: %+v", got)
	}
	if _, err := st.SetDirectInput(created.Token, false); err != nil || got == nil {
		t.Fatalf("direct off failed")
	}
	got, _ = st.Get(created.Token)
	if got.DirectInput || !got.Collab {
		t.Fatalf("direct off wrong: %+v", got)
	}
	// 未知 token → ErrNotFound
	if _, err := st.SetDirectInput("nope0123456789ab", true); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown token = %v, want ErrNotFound", err)
	}
}

func TestShareStoreCollabExpiredRejected(t *testing.T) {
	st := newShareStoreForTest(t)
	created, err := st.Create(store.Share{
		ProjectID: "p1", ProjectName: "demo", Path: "b.txt", Name: "b",
		ExpiresAt: time.Now().Add(-time.Minute),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := st.SetCollab(created.Token, true); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired collab toggle = %v, want ErrNotFound", err)
	}
	if _, err := st.SetDirectInput(created.Token, true); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired direct toggle = %v, want ErrNotFound", err)
	}
}

// TestShareStoreLegacyDocWithoutCollabFields 旧数据面 + 新二进制（升级兼容
// 纪律的形态验证）：旧版本落库的 Share 文档没有 collab/directInput 字段——
// 新二进制读出必须零值关（存量语义零变化），且 SetCollab 可在其上增量开启
// （升级路径不要求清数据目录/迁移标记）
func TestShareStoreLegacyDocWithoutCollabFields(t *testing.T) {
	fdir := t.TempDir()
	fs := filestore.New(fdir)
	st := store.New(fs)
	// 旧形态 JSON：P-20261024-1 之前的字段集（无 collab/directInput），
	// token 取 gen-0 金标（TestDeriveShareTokenStableAndDistinct 同值）。
	// expiresAt 动态远期：本用例考「存量记录增量开新字段」，过期拒绝语义
	// 由 TestShareStoreCollabExpiredRejected 专考——硬编码日期是定时炸弹
	// （原 2026-10-31T10:00:00Z 过期日一过，SetCollab 的过期拒绝即误伤本用例）
	legacy := fmt.Sprintf(`{"token":"2315s8zyxrj82squ","projectId":"p1","projectName":"demo","path":"docs/readme.md","name":"readme","kind":"file","createdAt":"2026-10-01T10:00:00Z","expiresAt":%q,"hits":3}`,
		time.Now().AddDate(100, 0, 0).UTC().Format(time.RFC3339))
	if err := fs.Create("shares", "2315s8zyxrj82squ", []byte(legacy)); err != nil {
		t.Fatalf("seed legacy doc: %v", err)
	}
	got, err := st.Share.Get("2315s8zyxrj82squ")
	if err != nil {
		t.Fatalf("get legacy share: %v", err)
	}
	if got.Collab || got.DirectInput {
		t.Fatalf("legacy doc must read as both switches off, got %+v", got)
	}
	if got.Hits != 3 {
		t.Fatalf("legacy fields must survive: hits = %d", got.Hits)
	}
	// 增量开启（升级路径）：RMW 落库后读回为开——旧记录无需迁移即可用新能力
	if _, err := st.Share.SetCollab("2315s8zyxrj82squ", true); err != nil {
		t.Fatalf("set collab on legacy share: %v", err)
	}
	re, _ := st.Share.Get("2315s8zyxrj82squ")
	if !re.Collab || re.DirectInput {
		t.Fatalf("legacy share collab on wrong: %+v", re)
	}
	if re.Hits != 3 {
		t.Fatalf("RMW must not touch legacy hits: %d", re.Hits)
	}
}
