package store_test

// 协作通道/申请通道开关（P-20261024-1，P-20261121-1 统一收编）store 层语义：
// SetCollab/SetGuestInput 的 RMW 单字段覆写（其余字段原样）、过期记录拒绝
// （与 Rotate 同口径）、缺省零迁移（collab 缺省关；GuestInputOff 反向极性
// ——缺省零值=申请通道开，默认在场定案）

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
	if created.Collab || created.GuestInputOff {
		t.Fatal("new share must default to collab off + guest-input channel on (存量零迁移/默认在场)")
	}

	// 开启：单字段覆写，其余字段原样（CreatedAt/Hits 不动）
	on, err := st.SetCollab(created.Token, true)
	if err != nil {
		t.Fatalf("set collab on: %v", err)
	}
	if !on.Collab || on.GuestInputOff {
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

func TestShareStoreGuestInputToggle(t *testing.T) {
	st := newShareStoreForTest(t)
	created, err := st.Create(store.Share{ProjectID: "p1", ProjectName: "demo", Path: "a.txt", Name: "a"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// 反向极性（必改1 纪律锁）：SetGuestInput(false) 落 GuestInputOff=true
	//（owner 显式关，与「旧缺省 false=关」可区分）；SetGuestInput(true) 清零
	off, err := st.SetGuestInput(created.Token, false)
	if err != nil || !off.GuestInputOff || off.Collab {
		t.Fatalf("guest-input off: %+v err=%v", off, err)
	}
	// 与协作通道互不联动
	if _, err := st.SetCollab(created.Token, true); err != nil {
		t.Fatalf("collab on: %v", err)
	}
	got, _ := st.Get(created.Token)
	if !got.Collab || !got.GuestInputOff {
		t.Fatalf("independent toggles wrong: %+v", got)
	}
	if _, err := st.SetGuestInput(created.Token, true); err != nil {
		t.Fatalf("guest-input on failed: %v", err)
	}
	got, _ = st.Get(created.Token)
	if got.GuestInputOff || !got.Collab {
		t.Fatalf("guest-input on wrong: %+v", got)
	}
	// 未知 token → ErrNotFound
	if _, err := st.SetGuestInput("nope0123456789ab", true); !errors.Is(err, store.ErrNotFound) {
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
	if _, err := st.SetGuestInput(created.Token, false); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired guest-input toggle = %v, want ErrNotFound", err)
	}
}

// TestShareStoreLegacyDocWithoutCollabFields 旧数据面 + 新二进制（升级兼容
// 纪律的形态验证）：旧版本落库的 Share 文档没有 collab/guestInputOff 字段
// ——新二进制读出必须零值语义（collab 关；GuestInputOff 零值=申请通道开，
// P-20261121-1 默认在场定案的存量面：全部存量即得通道开，无需迁移），且
// SetCollab/SetGuestInput 可在其上增量操作（升级路径不要求清数据目录/迁移
// 标记）
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
	if got.Collab || got.GuestInputOff {
		t.Fatalf("legacy doc must read as collab off + guest-input channel on, got %+v", got)
	}
	if got.Hits != 3 {
		t.Fatalf("legacy fields must survive: hits = %d", got.Hits)
	}
	// 增量开启（升级路径）：RMW 落库后读回为开——旧记录无需迁移即可用新能力
	if _, err := st.Share.SetCollab("2315s8zyxrj82squ", true); err != nil {
		t.Fatalf("set collab on legacy share: %v", err)
	}
	re, _ := st.Share.Get("2315s8zyxrj82squ")
	if !re.Collab || re.GuestInputOff {
		t.Fatalf("legacy share collab on wrong: %+v", re)
	}
	// 存量记录显式关通道（新开关承载）：反向极性字段落库可辨
	if _, err := st.Share.SetGuestInput("2315s8zyxrj82squ", false); err != nil {
		t.Fatalf("set guest-input off legacy share: %v", err)
	}
	re, _ = st.Share.Get("2315s8zyxrj82squ")
	if !re.GuestInputOff {
		t.Fatalf("legacy share guest-input off wrong: %+v", re)
	}
	if re.Hits != 3 {
		t.Fatalf("RMW must not touch legacy hits: %d", re.Hits)
	}
}
