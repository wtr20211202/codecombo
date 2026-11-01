package files

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"codecombo/server/kernel"
)

// 自环标记双路径回归（P-20261005-15）：原子写与上传的落盘都是「tmp 先建、
// rename 到位」两段，fsnotify 的 Create 事件先落在 tmp 上——只标最终路径时，
// tmp 名（保留目标前缀，.env → .env.sc-tmp-*，敏感名模式照样命中）会被外部
// 写入观测误记为真外部（e2e 实测假阳性：.env 的每次 API 保存都多记一条
// .env.sc-tmp-* 审计+通知）。断言发布序列恰为 {最终路径, tmp 路径}，且 tmp
// 名带 .sc-tmp- 前缀形态；载荷路径与发布口同口径（反斜杠归一为 /）

// captureSelfWriteMarks 把包级 publisher 换成记录总线，返回 (快照读取函数)。
// Cleanup 恢复 nil（本包测试串行执行，无 t.Parallel，包级变量无竞态暴露面）
func captureSelfWriteMarks(t *testing.T) func() []string {
	t.Helper()
	var mu sync.Mutex
	var marks []string
	bus := kernel.NewEventBus()
	bus.Subscribe(TopicFileSelfWrite, func(env kernel.Envelope) {
		if m, ok := env.Payload.(map[string]string); ok {
			mu.Lock()
			marks = append(marks, m["path"])
			mu.Unlock()
		}
	})
	publisher = bus
	t.Cleanup(func() { publisher = nil })
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), marks...)
	}
}

// slash 归一（与 markSelfWrite 发布口径一致），Windows 反斜杠路径对齐用
func slashNorm(p string) string { return strings.ReplaceAll(p, `\`, `/`) }

func TestAtomicWriteFile_MarksFinalAndTmpPaths(t *testing.T) {
	marks := captureSelfWriteMarks(t)
	abs := filepath.Join(t.TempDir(), ".env")
	if err := atomicWriteFile(abs, []byte("SELF=2\n")); err != nil {
		t.Fatalf("atomicWriteFile: %v", err)
	}
	got := marks()
	if len(got) != 2 {
		t.Fatalf("publishes = %d (%v), want 2 (final + tmp)", len(got), got)
	}
	if got[0] != slashNorm(abs) {
		t.Errorf("first mark = %q, want final path %q", got[0], slashNorm(abs))
	}
	if !strings.HasPrefix(got[1], slashNorm(abs)+".sc-tmp-") {
		t.Errorf("second mark = %q, want tmp with prefix %q", got[1], slashNorm(abs)+".sc-tmp-")
	}
	if data, err := os.ReadFile(abs); err != nil || string(data) != "SELF=2\n" {
		t.Errorf("atomic write content broken: %q err=%v", data, err)
	}
}

func TestUploadFiles_MarksTmpAndTargetPaths(t *testing.T) {
	r, projPath := setupUploadTest(t)
	marks := captureSelfWriteMarks(t)
	w := doUpload(t, r, ".env", "UP=1\n")
	if w.Code != http.StatusOK {
		t.Fatalf("upload status = %d, body %s", w.Code, w.Body.String())
	}
	target := slashNorm(filepath.Join(projPath, ".env"))
	got := marks()
	if len(got) != 2 {
		t.Fatalf("publishes = %d (%v), want 2 (tmp + target)", len(got), got)
	}
	if !strings.HasPrefix(got[0], target+".sc-tmp-") {
		t.Errorf("first mark = %q, want tmp with prefix %q", got[0], target+".sc-tmp-")
	}
	if got[1] != target {
		t.Errorf("second mark = %q, want target %q", got[1], target)
	}
	if data, err := os.ReadFile(filepath.Join(projPath, ".env")); err != nil || string(data) != "UP=1\n" {
		t.Errorf("upload content broken: %q err=%v", data, err)
	}
}
