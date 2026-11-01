package git

import (
	"errors"
	"strings"
	"testing"
	"time"

	"codecombo/server/model"
)

var errFake = errors.New("fake git failure")

// captureBroadcast 临时注入广播/路径解析钩子，捕获 broadcastFailure 推送的消息；
// 返回恢复函数
func captureBroadcast(t *testing.T) func() []model.WSMessage {
	t.Helper()
	oldBc, oldResolver := broadcastFn, pathResolverFn
	var captured []model.WSMessage
	broadcastFn = func(projectID string, msg model.WSMessage) { captured = append(captured, msg) }
	pathResolverFn = func(string) string { return "p1" }
	return func() []model.WSMessage {
		broadcastFn, pathResolverFn = oldBc, oldResolver
		return captured
	}
}

// 生效断言：git 失败广播的输出必须截断，防止 MB 级 stdout 复制给所有 WS 客户端
func TestBroadcastFailure_TruncatesHugeOutput(t *testing.T) {
	restore := captureBroadcast(t)
	defer restore()

	huge := strings.Repeat("x", 64*1024)
	broadcastFailure("grep -n q", "/fake/repo", huge, "err")

	msgs := restore()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 broadcast, got %d", len(msgs))
	}
	log, ok := msgs[0].Data.(model.CommandLog)
	if !ok {
		t.Fatalf("unexpected payload type %T", msgs[0].Data)
	}
	if len(log.Output) > 8*1024+32 {
		t.Fatalf("output not truncated: %d bytes", len(log.Output))
	}
	if !strings.Contains(log.Output, "[truncated]") {
		t.Fatal("truncation marker missing")
	}
}

func TestTruncateOutput_ShortPassThrough(t *testing.T) {
	in := "short"
	if got := truncateOutput(in); got != in {
		t.Fatalf("short output should pass through, got %q", got)
	}
}

// 生效断言：fetch 类操作只失效 ahead 缓存、保留 repoInfo 缓存——
// 否则 auto-fetch 每轮（默认 300s）都制造一次全项目冷扫描风暴
func TestMaybeInvalidateCaches_FetchOnlyInvalidatesAhead(t *testing.T) {
	const path = "/fake/repo"
	repoInfoCache.Store(path, repoInfoEntry{branch: "main", remoteURL: "https://x", at: time.Now()})
	aheadCache.Store(path, aheadEntry{ahead: 1, behind: 2, branch: "main", at: time.Now()})

	maybeInvalidateCaches(path, []string{"fetch", "origin"}, nil)

	if _, ok := aheadCache.Load(path); ok {
		t.Error("fetch must invalidate ahead cache")
	}
	if _, ok := repoInfoCache.Load(path); !ok {
		t.Error("fetch must NOT invalidate repoInfo cache")
	}
}

// pull 语义同 fetch（合并后本地分支才可能变；fetch 阶段只动远端引用）
func TestMaybeInvalidateCaches_PullOnlyInvalidatesAhead(t *testing.T) {
	const path = "/fake/repo2"
	repoInfoCache.Store(path, repoInfoEntry{branch: "main", at: time.Now()})
	aheadCache.Store(path, aheadEntry{branch: "main", at: time.Now()})

	maybeInvalidateCaches(path, []string{"pull"}, nil)

	if _, ok := aheadCache.Load(path); ok {
		t.Error("pull must invalidate ahead cache")
	}
	if _, ok := repoInfoCache.Load(path); !ok {
		t.Error("pull must NOT invalidate repoInfo cache")
	}
}

// 本地写操作仍然全量失效（提交后卡片信息与徽章必须即时刷新）
func TestMaybeInvalidateCaches_CommitInvalidatesBoth(t *testing.T) {
	const path = "/fake/repo3"
	repoInfoCache.Store(path, repoInfoEntry{branch: "main", at: time.Now()})
	aheadCache.Store(path, aheadEntry{branch: "main", at: time.Now()})

	maybeInvalidateCaches(path, []string{"commit", "-m", "x"}, nil)

	if _, ok := aheadCache.Load(path); ok {
		t.Error("commit must invalidate ahead cache")
	}
	if _, ok := repoInfoCache.Load(path); ok {
		t.Error("commit must invalidate repoInfo cache")
	}
}

func TestMaybeInvalidateCaches_FailureDoesNotInvalidate(t *testing.T) {
	const path = "/fake/repo4"
	aheadCache.Store(path, aheadEntry{branch: "main", at: time.Now()})
	maybeInvalidateCaches(path, []string{"commit", "-m", "x"}, errFake)
	if _, ok := aheadCache.Load(path); !ok {
		t.Error("failed git op must not invalidate cache")
	}
}

// 只读操作不失效
func TestMaybeInvalidateCaches_ReadOnlyNoop(t *testing.T) {
	const path = "/fake/repo5"
	aheadCache.Store(path, aheadEntry{branch: "main", at: time.Now()})
	maybeInvalidateCaches(path, []string{"status", "--porcelain"}, nil)
	if _, ok := aheadCache.Load(path); !ok {
		t.Error("read-only op must not invalidate cache")
	}
}
