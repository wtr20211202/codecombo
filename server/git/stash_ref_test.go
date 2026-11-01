package git

import (
	"errors"
	"strings"
	"testing"
)

// stash 稳定 hash 引用（P-20261003-264）git 层：
//   - GetStashes 每条下发完整 stash commit OID（与 git 自身 %H 一致）
//   - hash → 当前栈位解析在 drop 导致的 index 漂移后仍指向原条目
//   - 已 drop 的 hash 明确返回 ErrStashEntryGone（悬空 commit 仍可被裸 apply，
//     不允许静默套用绕过栈位语义）
//   - hash 缺省原样返回 index（index 入口渐进兼容）

// stashListHashes 取 git 权威 hash 序列（stash@{0} 起）
func stashListHashes(t *testing.T, repo string) []string {
	t.Helper()
	out, err := execGit(repo, "stash", "list", "--format=%H")
	if err != nil {
		t.Fatalf("stash list --format=%%H: %v", err)
	}
	var hashes []string
	for _, line := range strings.Split(out, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			hashes = append(hashes, line)
		}
	}
	return hashes
}

func TestGetStashes_IncludesStableHash(t *testing.T) {
	repo := stashShowFixture(t)
	stashes, err := GetStashes(repo)
	if err != nil {
		t.Fatalf("GetStashes: %v", err)
	}
	if len(stashes) != 2 {
		t.Fatalf("len(stashes) = %d, want 2", len(stashes))
	}
	want := stashListHashes(t, repo)
	if len(want) != len(stashes) {
		t.Fatalf("hash count = %d, want %d", len(want), len(stashes))
	}
	for i, s := range stashes {
		if s.Hash != want[i] {
			t.Fatalf("stashes[%d].Hash = %q, want %q", i, s.Hash, want[i])
		}
		// SHA-1 40 / SHA-256 64——两种对象格式都接受
		if len(s.Hash) != 40 && len(s.Hash) != 64 {
			t.Fatalf("stashes[%d].Hash = %q, want 40/64 hex chars", i, s.Hash)
		}
	}
}

func TestResolveStashIndex_HashAnchorsAcrossShift(t *testing.T) {
	repo := stashShowFixture(t)
	stashes, err := GetStashes(repo)
	if err != nil {
		t.Fatalf("GetStashes: %v", err)
	}
	olderHash := stashes[1].Hash // index 1 = 先入栈的 older
	if stashes[1].Index != 1 {
		t.Fatalf("fixture assumption broken: older at index %d", stashes[1].Index)
	}

	// 并发标签页 drop 最新条目：older 从 index 1 前移到 0
	if err := StashDrop(repo, 0); err != nil {
		t.Fatalf("StashDrop(0): %v", err)
	}
	idx, err := ResolveStashIndex(repo, 999, olderHash) // 请求体里的旧 index 必须被忽略
	if err != nil {
		t.Fatalf("ResolveStashIndex: %v", err)
	}
	if idx != 0 {
		t.Fatalf("resolved index = %d, want 0 (hash anchors across shift)", idx)
	}
	diff, err := StashShow(repo, idx)
	if err != nil {
		t.Fatalf("StashShow: %v", err)
	}
	if !strings.Contains(diff, "older") || strings.Contains(diff, "newer") {
		t.Fatalf("hash resolved to wrong entry: %s", diff)
	}
}

func TestResolveStashIndex_DroppedHashRejected(t *testing.T) {
	repo := stashShowFixture(t)
	stashes, err := GetStashes(repo)
	if err != nil {
		t.Fatalf("GetStashes: %v", err)
	}
	hash := stashes[0].Hash
	if err := StashDrop(repo, 0); err != nil {
		t.Fatalf("StashDrop: %v", err)
	}

	// 对象仍是悬空 commit（裸 git stash apply <hash> 能套用）——解析层必须拒绝
	if _, err := execGit(repo, "stash", "apply", hash); err != nil {
		t.Logf("note: git itself rejected dangling hash apply: %v", err)
	}
	_, err = ResolveStashIndex(repo, -1, hash)
	if !errors.Is(err, ErrStashEntryGone) {
		t.Fatalf("err = %v, want ErrStashEntryGone", err)
	}
	if !strings.Contains(err.Error(), "stash entry no longer exists") {
		t.Fatalf("error text = %q, want stable marker for KNOWN_ERROR_I18N", err.Error())
	}
	// 旧 hash 失败不影响剩余条目
	if got := len(stashListHashes(t, repo)); got != 1 {
		t.Fatalf("stash count = %d, want 1", got)
	}
}

func TestResolveStashIndex_IndexFallback(t *testing.T) {
	repo := stashShowFixture(t)
	if idx, err := ResolveStashIndex(repo, 7, ""); err != nil || idx != 7 {
		t.Fatalf("index fallback = (%d, %v), want (7, nil)", idx, err)
	}
}
