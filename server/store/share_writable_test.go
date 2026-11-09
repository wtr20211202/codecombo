package store_test

// 可写分享开关（P-20261106-8）store 层语义：SetWritable 的 RMW 单字段覆写
//（其余字段原样）、过期记录拒绝（与 Rotate 同口径）、创建面兜底清零
//（可写从不悄悄出生——owner 动作面是唯一开启路径）

import (
	"errors"
	"testing"

	"codecombo/server/store"
)

func TestShareStoreWritableToggle(t *testing.T) {
	st := newShareStoreForTest(t)
	created, err := st.Create(store.Share{ProjectID: "p1", ProjectName: "demo", Path: "a.txt", Name: "a"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.Writable {
		t.Fatal("new share must default to writable off (创建面兜底清)")
	}

	// 开启：单字段覆写，其余字段原样（CreatedAt/Hits 不动）
	on, err := st.SetWritable(created.Token, true)
	if err != nil {
		t.Fatalf("set writable on: %v", err)
	}
	if !on.Writable {
		t.Fatalf("writable on wrong: %+v", on)
	}
	if !on.CreatedAt.Equal(created.CreatedAt) {
		t.Fatal("RMW must not touch CreatedAt")
	}
	got, _ := st.Get(created.Token)
	if !got.Writable {
		t.Fatal("writable flag not persisted")
	}

	// 关闭：回收语义（记录仍在、字段归零）
	off, err := st.SetWritable(created.Token, false)
	if err != nil || off.Writable {
		t.Fatalf("writable off: %+v err=%v", off, err)
	}

	// 未知 token → ErrNotFound
	if _, err := st.SetWritable("nope0123456789ab", true); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown token = %v, want ErrNotFound", err)
	}
}

func TestShareStoreWritableCreateFaceCleared(t *testing.T) {
	st := newShareStoreForTest(t)
	// 创建请求直接携带 Writable=true（模拟未来调用方绕过 API 直入 store）：
	// 各形态创建面一律兜底清零——可写只能经 owner 动作面（confirm+口令门）
	// 开启，从不悄悄出生
	cases := []struct {
		name string
		in   store.Share
	}{
		{"file", store.Share{ProjectID: "p1", ProjectName: "d", Path: "x.txt", Name: "x", Writable: true}},
		{"snippet", store.Share{Kind: store.ShareKindSnippet, Name: "s", Content: "hello world", Writable: true}},
		{"terminal", store.Share{Kind: store.ShareKindTerminal, TerminalID: "sess-w", Name: "live", Writable: true}},
	}
	for _, tc := range cases {
		created, err := st.Create(tc.in)
		if err != nil {
			t.Fatalf("create %s: %v", tc.name, err)
		}
		if created.Writable {
			t.Fatalf("%s share must clear writable at create face", tc.name)
		}
	}
}
