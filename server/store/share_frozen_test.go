package store_test

// 冻结分享（P-20261003-320）store 层语义：独立命名空间派生（live/frozen 同
// 目标双记录并存）、默认 30 天 TTL、幂等不刷新倒计时、rotate 换链且零代际
// 目录键稳定（副本不动）

import (
	"errors"
	"testing"
	"time"

	"codecombo/server/store"
)

func TestShareStoreFrozenCreate(t *testing.T) {
	st := newShareStoreForTest(t)

	// frozen 与 live 同目标互不挤占：两条独立记录、不同 token
	live, err := st.Create(store.Share{ProjectID: "p1", ProjectName: "demo", Path: "docs", Name: "docs", IsDir: true})
	if err != nil {
		t.Fatalf("create live: %v", err)
	}
	frozen, err := st.Create(store.Share{ProjectID: "p1", ProjectName: "demo", Path: "docs", Name: "docs", IsDir: true, Frozen: true})
	if err != nil {
		t.Fatalf("create frozen: %v", err)
	}
	if frozen.Token == live.Token {
		t.Fatal("frozen and live shares of the same target must derive distinct tokens")
	}
	if !frozen.Frozen || live.Frozen {
		t.Fatal("frozen flag round-trip broken")
	}

	// 默认 TTL：frozen 创建即定 30 天（±1min 时钟容差）；live 保持零值永久
	if frozen.ExpiresAt.IsZero() {
		t.Fatal("frozen share must get a default TTL")
	}
	d := time.Until(frozen.ExpiresAt)
	if d > store.FrozenTTL || d < store.FrozenTTL-time.Minute {
		t.Fatalf("frozen default TTL = %v, want ~%v", d, store.FrozenTTL)
	}
	if !live.ExpiresAt.IsZero() {
		t.Fatal("live share must stay permanent by default")
	}

	// 幂等重建：同目标 frozen 返回同一 token，CreatedAt/ExpiresAt 不刷新
	//（倒计时是安全边界），Frozen 标记保留
	again, err := st.Create(store.Share{ProjectID: "p1", ProjectName: "demo", Path: "docs", Name: "docs2", IsDir: true, Frozen: true, ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatalf("recreate frozen: %v", err)
	}
	if again.Token != frozen.Token {
		t.Fatal("idempotent frozen create changed token")
	}
	if !again.ExpiresAt.Equal(frozen.ExpiresAt) {
		t.Fatal("idempotent frozen create must keep original expiry (no silent renewal)")
	}

	// Get-by-token 回读 frozen 标记
	got, err := st.Get(frozen.Token)
	if err != nil || !got.Frozen {
		t.Fatalf("get frozen: %v %+v", err, got)
	}
}

func TestShareStoreFrozenRotateKeepsNativeDirKey(t *testing.T) {
	st := newShareStoreForTest(t)

	frozen, err := st.Create(store.Share{ProjectID: "p1", ProjectName: "demo", Path: "docs/a.md", Name: "a.md", Frozen: true})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	native := store.FrozenNativeToken([]byte("pepper"), "p1", "docs/a.md")

	// 零代际键稳定：目录名锚点与创建代际无关
	if store.FrozenNativeToken([]byte("pepper"), "p1", "docs/a.md") != native {
		t.Fatal("native dir key must be deterministic")
	}

	rotated, err := st.Rotate(frozen.Token)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if rotated.Token == frozen.Token || rotated.Rotate != 1 {
		t.Fatalf("rotate did not advance generation: %+v", rotated)
	}
	// 轮换后零代际派生值不变——快照目录不随 rotate 迁移
	if store.FrozenNativeToken([]byte("pepper"), "p1", "docs/a.md") != native {
		t.Fatal("rotate must not change the native dir key")
	}
	// 旧链失效、新链可读、Frozen 标记随记录走
	if _, err := st.Get(frozen.Token); err != store.ErrNotFound {
		t.Fatal("old token should be gone after rotate")
	}
	got, err := st.Get(rotated.Token)
	if err != nil || !got.Frozen {
		t.Fatalf("get rotated: %v %+v", err, got)
	}
}

// ── 多路径冻结分享（P-20261008-1）：集合键幂等、单路径隔离、rotate 换链
// 副本键稳定、非法集合拒绝 ──

func TestShareStoreFrozenBatchCreateAndIdempotency(t *testing.T) {
	st := newShareStoreForTest(t)

	first, err := st.Create(store.Share{
		ProjectID: "p1", ProjectName: "demo",
		Paths: []string{"src/b.ts", "docs/a.md"},
		Name:  "a.md +1", Frozen: true,
	})
	if err != nil {
		t.Fatalf("create batch: %v", err)
	}
	// 集合规范化：排序（顺序无关幂等）、Path 清空、默认 30 天 TTL
	if first.Path != "" {
		t.Fatalf("batch share Path should be empty, got %q", first.Path)
	}
	if len(first.Paths) != 2 || first.Paths[0] != "docs/a.md" || first.Paths[1] != "src/b.ts" {
		t.Fatalf("paths not canonicalized: %v", first.Paths)
	}
	if d := time.Until(first.ExpiresAt); d > store.FrozenTTL || d < store.FrozenTTL-time.Minute {
		t.Fatalf("batch frozen default TTL = %v, want ~%v", d, store.FrozenTTL)
	}

	// 同集合不同顺序 + 重复项 → 同一条链，CreatedAt/ExpiresAt 不刷新
	again, err := st.Create(store.Share{
		ProjectID: "p1", ProjectName: "demo",
		// 反斜杠形态与正斜杠同义、"." 段被丢弃（CanonicalSharePaths 归一），
		// 重复项去重
		Paths: []string{`src\b.ts`, `docs\.\a.md`, "src/b.ts"},
		Name:  "a.md +1", Frozen: true, ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("recreate batch: %v", err)
	}
	if again.Token != first.Token {
		t.Fatalf("order-insensitive idempotency broken: %s vs %s", again.Token, first.Token)
	}
	if !again.CreatedAt.Equal(first.CreatedAt) || !again.ExpiresAt.Equal(first.ExpiresAt) {
		t.Fatal("idempotent batch create must keep CreatedAt/ExpiresAt")
	}

	// 单路径 batch 与同路径单文件 frozen 是两条独立链（命名空间隔离）
	single, err := st.Create(store.Share{ProjectID: "p1", Path: "docs/a.md", Name: "a.md", Frozen: true})
	if err != nil {
		t.Fatalf("create single frozen: %v", err)
	}
	oneBatch, err := st.Create(store.Share{ProjectID: "p1", Paths: []string{"docs/a.md"}, Name: "a.md", Frozen: true})
	if err != nil {
		t.Fatalf("create single-item batch: %v", err)
	}
	if oneBatch.Token == single.Token {
		t.Fatal("single-item batch must not collide with single-path frozen share")
	}

	// 非法集合：上跳段 / 空集合 / live 模式（MVP 仅 frozen）
	if _, err := st.Create(store.Share{ProjectID: "p1", Paths: []string{"../secret"}, Frozen: true}); !errors.Is(err, store.ErrInvalidArg) {
		t.Fatalf("traversal paths should be rejected, got %v", err)
	}
	if _, err := st.Create(store.Share{ProjectID: "p1", Paths: []string{""}, Frozen: true}); !errors.Is(err, store.ErrInvalidArg) {
		t.Fatalf("empty paths should be rejected, got %v", err)
	}
	if _, err := st.Create(store.Share{ProjectID: "p1", Paths: []string{"docs/a.md"}}); !errors.Is(err, store.ErrInvalidArg) {
		t.Fatalf("live batch should be rejected, got %v", err)
	}
}

func TestShareStoreFrozenBatchRotateKeepsNativeDirKey(t *testing.T) {
	st := newShareStoreForTest(t)
	paths := []string{"docs/a.md", "src/b.ts"}
	rec, err := st.Create(store.Share{ProjectID: "p1", Paths: paths, Name: "a.md +1", Frozen: true})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	native := store.FrozenBatchNativeToken([]byte("pepper"), "p1", paths)

	rotated, err := st.Rotate(rec.Token)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if rotated.Token == rec.Token {
		t.Fatal("rotate must change token")
	}
	if len(rotated.Paths) != 2 || rotated.Paths[0] != "docs/a.md" || rotated.Paths[1] != "src/b.ts" {
		t.Fatalf("rotate must preserve paths: %v", rotated.Paths)
	}
	if got := store.FrozenBatchNativeToken([]byte("pepper"), "p1", rotated.Paths); got != native {
		t.Fatalf("native dir key must be generation-stable: %s vs %s", got, native)
	}
	if _, err := st.Get(rec.Token); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("old token should be gone after rotate, got %v", err)
	}
}
