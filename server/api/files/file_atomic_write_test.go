package files

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
)

// TestUniqueTmp_PrefixShapeAndUniqueness uniqueTmp 保留目标路径前缀，后缀为
// 16 位 hex 且批量生成不重复——并发保存各持各的 tmp 的前提
func TestUniqueTmp_PrefixShapeAndUniqueness(t *testing.T) {
	base := filepath.Join(t.TempDir(), "a.txt")
	seen := make(map[string]struct{}, 1000)
	for i := 0; i < 1000; i++ {
		tmp, err := uniqueTmp(base)
		if err != nil {
			t.Fatalf("uniqueTmp: %v", err)
		}
		if !strings.HasPrefix(tmp, base+".sc-tmp-") {
			t.Fatalf("tmp = %q, want prefix %q", tmp, base+".sc-tmp-")
		}
		suffix := strings.TrimPrefix(tmp, base+".sc-tmp-")
		if !regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(suffix) {
			t.Fatalf("suffix = %q, want 16 hex chars", suffix)
		}
		if _, dup := seen[tmp]; dup {
			t.Fatalf("tmp %q generated twice in %d calls", tmp, i+1)
		}
		seen[tmp] = struct{}{}
	}
}

// TestWriteFile_ConcurrentSaves_ContentIntact 并发保存同一文件：各请求 tmp 唯一
// 不互踩（固定后缀下 A 的 rename 可能把 B 写一半的 tmp 抢走落盘），最终内容是
// 某一个请求的完整原文而非交错半截，且目录无 .sc-tmp-* 残留（成功者 rename 消费、
// 失败者走既有 Remove 清理）。
// 注：Windows 下多个 rename 并发替换同一目标文件本身会瞬时 Access denied
//（rename 目标竞态，与 tmp 命名正交、固定名时代同样存在，提案不改 rename 语义），
// 故允许个别 writer 因 rename 失败拿到 500——其 tmp 已被清理，不产生残留
func TestWriteFile_ConcurrentSaves_ContentIntact(t *testing.T) {
	r, projPath := setupConflictTest(t)
	target := filepath.Join(projPath, "concurrent.txt")

	const writers = 16
	payloads := make([]string, writers)
	for i := range payloads {
		payloads[i] = fmt.Sprintf("writer-%02d:%s", i, strings.Repeat("x", 512))
	}

	var wg sync.WaitGroup
	errs := make([]error, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body := `{"path":"concurrent.txt","content":"` + payloads[i] + `"}`
			w := doFileJSON(t, r, http.MethodPut, "/api/projects/proj-test/file", body)
			if w.Code != http.StatusOK {
				errs[i] = fmt.Errorf("writer %d: status = %d, body=%s", i, w.Code, w.Body.String())
			}
		}(i)
	}
	wg.Wait()

	// 非 rename 步骤的失败一律算失败（tmp 命名唯一化后不应出现写 tmp 失败）
	succeeded := 0
	for i, err := range errs {
		if err == nil {
			succeeded++
			continue
		}
		if !strings.Contains(err.Error(), `"error":"rename `) {
			t.Fatalf("writer %d failed at unexpected step: %v", i, err)
		}
	}
	if succeeded == 0 {
		t.Fatal("all writers failed, expected at least one to win the rename")
	}

	// 最终内容必须是某一个成功 writer 的完整 payload（rename 原子，不能交错截断）；
	// 旧固定后缀下的 tmp 互踩会在此暴露为半截/混合内容
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target after %d successful saves: %v", succeeded, err)
	}
	won := false
	for _, p := range payloads {
		if string(got) == p {
			won = true
			break
		}
	}
	if !won {
		t.Fatalf("disk content (len=%d) is not any writer's intact payload — tmp collision?", len(got))
	}

	// 每个请求只负责自己的 tmp：成功者 rename 消费、失败者 Remove 清理，
	// 全部完成后目录无 .sc-tmp-* 残留
	entries, err := os.ReadDir(projPath)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".sc-tmp-") {
			t.Fatalf("leftover tmp file: %s", e.Name())
		}
	}
}
