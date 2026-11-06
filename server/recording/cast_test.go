package recording

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/mask"
)

// cast 遮蔽断言语料（原 mask_test.go 同包 fixtures，模式族独立成包后本地化；
// 与 server/mask/mask_test.go sampleToken 同款：sca_ + 16 字节 hex）
const (
	testSampleToken = "sca_8f3a2b1c4d5e4f6a8b7c9d0e1f2a3b4c"
	testTokenMask   = "***"
)

// cast 写盘单测：asciinema v2 header + 事件行 + 写盘前遮蔽
func TestCastWriter_HeaderAndEvents(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	start := time.Now()
	w, err := newCastWriter("sc_rec_test1", 120, 40, start)
	if err != nil {
		t.Fatalf("newCastWriter: %v", err)
	}
	if err := w.writeOutput([]byte("hello "+testSampleToken+"\r\n"), mask.NewMasker()); err != nil {
		t.Fatalf("writeOutput: %v", err)
	}
	if err := w.flushTail(mask.NewMasker()); err != nil {
		t.Fatalf("flushTail: %v", err)
	}
	if err := w.close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	b, err := os.ReadFile(CastPath("sc_rec_test1"))
	if err != nil {
		t.Fatalf("read cast: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) != 2 {
		t.Fatalf("cast lines = %d, want 2 (header + event)", len(lines))
	}
	var header struct {
		Version   int    `json:"version"`
		Width     uint16 `json:"width"`
		Height    uint16 `json:"height"`
		Timestamp int64  `json:"timestamp"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &header); err != nil {
		t.Fatalf("header invalid json: %v", err)
	}
	if header.Version != 2 || header.Width != 120 || header.Height != 40 {
		t.Fatalf("header = %+v", header)
	}
	var ev []any
	if err := json.Unmarshal([]byte(lines[1]), &ev); err != nil {
		t.Fatalf("event invalid json: %v", err)
	}
	if len(ev) != 3 || ev[1] != "o" {
		t.Fatalf("event shape = %v", ev)
	}
	text, _ := ev[2].(string)
	if strings.Contains(text, testSampleToken) {
		t.Fatalf("token persisted to disk: %q", text)
	}
	if !strings.Contains(text, testTokenMask) {
		t.Fatalf("mask missing on disk: %q", text)
	}
	if !strings.Contains(text, "hello") {
		t.Fatalf("plain text lost: %q", text)
	}
}

// 同名重录覆盖（O_TRUNC）：录制 ID 唯一，防御性断言不留旧内容
func TestCastWriter_TruncateOnRecreate(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	w1, err := newCastWriter("sc_rec_test2", 80, 24, time.Now())
	if err != nil {
		t.Fatalf("newCastWriter: %v", err)
	}
	_ = w1.writeOutput([]byte("old"), mask.NewMasker())
	_ = w1.close()

	w2, err := newCastWriter("sc_rec_test2", 80, 24, time.Now())
	if err != nil {
		t.Fatalf("newCastWriter: %v", err)
	}
	defer w2.close()
	b, _ := os.ReadFile(CastPath("sc_rec_test2"))
	if strings.Contains(string(b), "old") {
		t.Fatalf("stale content survived: %q", string(b))
	}
}

// ArtifactsDir 跟随 SC_DATA_DIR（测试隔离与多实例数据目录）
func TestArtifactsDirFollowsDataDir(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CC_DATA_DIR", dir)
	// DataDir 归一（P-20261106 短名尾巴修复）后长形态是设计目标：runner TMP
	// 短名（RUNNER~1）下期望前缀须同型归一，三形态容忍家族（踩坑 #5）
	wantPrefix := config.EvalSymlinksNormalized(filepath.Join(dir, "artifacts"))
	if got := ArtifactsDir(); !strings.HasPrefix(got, wantPrefix) {
		t.Fatalf("ArtifactsDir = %q, want under %q", got, wantPrefix)
	}
}
