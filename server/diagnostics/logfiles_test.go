package diagnostics

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 按日日志选择：窗口内新→旧、同日前缀取新前缀、缺失日期进缺席清单
func TestSelectDailyLogs(t *testing.T) {
	dir := t.TempDir()
	write := func(name string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("codecombo-2026-11-22.log")
	write("simple-coding-2026-11-22.log") // 同日旧前缀：应被新前缀顶掉
	write("codecombo-2026-11-20.log")
	write("codecombo-notadate.log") // 非法日期段：跳过

	now := time.Date(2026, 11, 22, 12, 0, 0, 0, time.Local)
	found, absent := selectDailyLogs(dir, 3, now)
	if len(found) != 2 {
		t.Fatalf("found = %+v, want 2 files", found)
	}
	if found[0].base != "codecombo-2026-11-22.log" {
		t.Fatalf("found[0] = %s, want today's codecombo file (new prefix wins)", found[0].base)
	}
	if found[1].base != "codecombo-2026-11-20.log" {
		t.Fatalf("found[1] = %s, want 2026-11-20 (new→old order)", found[1].base)
	}
	if len(absent) != 1 || absent[0] != "codecombo-2026-11-21.log" {
		t.Fatalf("absent = %v, want the missing 2026-11-21 day", absent)
	}
}

// 通配：收 *.log、排除半成品/zip、已见基名跳过
func TestWildcardLogsSkipsPartials(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"extra.log", "half.part.log", "half.tmp.log", "bundle.zip", "sub.log",
		"codecombo-2026-11-19.log"} {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{"sub.log": true}
	got := wildcardLogs(dir, seen)
	// 窗口外的按日日志（selectDailyLogs 管的那族）不得从通配兜回来——
	// 否则默认 3 天在留存 15 天的实例上会静默变成全量
	if len(got) != 1 || got[0].base != "extra.log" {
		t.Fatalf("wildcard = %+v, want only extra.log", got)
	}
}

// 截断：>16MiB 才真截断（8~16MiB 头+尾已覆盖全文件 → 按全带处理）；
// seam 显式行、失败证据在尾（尾部标记必留）
func TestTruncationHeadTail(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.log")
	size, err := writeBigLog(path, 17<<20)
	if err != nil {
		t.Fatal(err)
	}

	inc := planInclusion(path, size)
	if inc.full {
		t.Fatalf("17MiB file must be truncated (size=%d)", size)
	}
	omitted := inc.omittedBytes(size)
	if omitted <= 0 {
		t.Fatalf("omittedBytes = %d, want > 0", omitted)
	}
	if inc.head < 1<<20 || inc.head > 3<<20 {
		t.Fatalf("head = %d, want ~2MiB", inc.head)
	}
	if size-inc.tailAt < 10<<20 {
		t.Fatalf("tail = %d, want the bulk of the file (tail-biased)", size-inc.tailAt)
	}

	rc, err := openRaw(path, size, inc, NewRedactor(dir, true))
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(rc)
	_ = rc.Close()
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	if !strings.Contains(s, "HEADMARK-TOP") {
		t.Fatal("head marker missing — startup evidence must survive truncation")
	}
	if !strings.Contains(s, "[TRUNCATED ") || !strings.Contains(s, " bytes omitted]") {
		t.Fatal("seam line missing — truncation must be explicit")
	}
	if !strings.Contains(s, "TAILMARK-END") {
		t.Fatal("tail marker missing — failure evidence lives at the end")
	}
	if strings.Contains(s, "MIDDLEMARK") {
		t.Fatal("middle bytes should have been omitted")
	}
}

// 8~16MiB 区间的文件：头+尾已覆盖全文件，如实按全带处理（不写 seam 假装截断）
func TestPlanInclusionMidSizeIsWhole(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mid.log")
	size, err := writeBigLog(path, 9<<20)
	if err != nil {
		t.Fatal(err)
	}
	if inc := planInclusion(path, size); !inc.full {
		t.Fatalf("9MiB file = %+v, want full inclusion (head+tail already covers it)", inc)
	}
}

// writeBigLog 生成带头部/中部/尾部唯一标记的大文件
func writeBigLog(path string, size int64) (int64, error) {
	f, err := os.Create(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	w := bufio.NewWriterSize(f, 1<<20)
	filler := strings.Repeat("f", 100) + "\n"
	var written int64
	write := func(s string) {
		n, _ := w.WriteString(s)
		written += int64(n)
	}
	write("HEADMARK-TOP\n")
	// 中部标记落在 2.5MiB：>16MiB 文件的省略窗 = (头对齐点 ~2MiB,
	// 尾起点 ~size-14MiB)——17MiB 时约 [2MiB, 3MiB]，2.5MiB 正在窗里
	mid := int64(5 << 19)
	wroteMiddle := false
	for written < size {
		if !wroteMiddle && written >= mid {
			write("MIDDLEMARK\n")
			wroteMiddle = true
			continue
		}
		write(filler)
	}
	write("TAILMARK-END\n")
	if err := w.Flush(); err != nil {
		return 0, err
	}
	st, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}

// 分析器：级别计数/模块归一/errors 分节 + 2 万行封顶逻辑（用较小样本验证分节）
func TestAnalyzerCountsAndErrors(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "x.log")
	body := strings.Join([]string{
		`time=2026-11-22T10:00:00Z level=INFO msg="boot: started"`,
		`time=2026-11-22T10:00:01Z level=DEBUG msg="watch: event"`,
		`time=2026-11-22T10:00:02Z level=WARN msg="git: slow"`,
		`time=2026-11-22T10:00:03Z level=ERROR msg="update: failed" token=supersecret`,
		`plain line`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	an := newAnalyzer(NewRedactor(dir, true))
	st := an.analyze("logs/x.log", path, int64(len(body)))
	if st.lines != 5 {
		t.Fatalf("lines = %d, want 5", st.lines)
	}
	if st.levels["INFO"] != 1 || st.levels["DEBUG"] != 1 || st.levels["WARN"] != 1 || st.levels["ERROR"] != 1 || st.levels["other"] != 1 {
		t.Fatalf("levels = %v", st.levels)
	}
	if st.modules["boot"] != 1 || st.modules["watch"] != 1 || st.modules["update"] != 1 {
		t.Fatalf("modules = %v", st.modules)
	}
	errs := renderErrors(an)
	if !strings.Contains(errs, "## logs/x.log") {
		t.Fatalf("errors.txt missing file section: %q", errs)
	}
	if !strings.Contains(errs, "level=WARN") || !strings.Contains(errs, "level=ERROR") {
		t.Fatalf("errors.txt missing WARN/ERROR lines: %q", errs)
	}
	if !strings.Contains(errs, "token=***") {
		t.Fatal("errors.txt must mask sensitive values")
	}
	if strings.Contains(errs, "supersecret") {
		t.Fatal("raw token leaked into errors.txt")
	}
	summary := renderLogSummary([]logStats{st})
	if !strings.Contains(summary, "modules: boot=1") && !strings.Contains(summary, "boot=1") {
		t.Fatalf("summary missing module tally: %q", summary)
	}
}

// 头部对齐辅助：确保 seam 不把行切成两截（对拍 indexByte/lastIndexByte）
func TestSnapHelpers(t *testing.T) {
	if got := indexByte([]byte("ab\ncd"), '\n'); got != 2 {
		t.Fatalf("indexByte = %d", got)
	}
	if got := lastIndexByte([]byte("ab\ncd"), '\n'); got != 2 {
		t.Fatalf("lastIndexByte = %d", got)
	}
	if got := indexByte([]byte("abcd"), '\n'); got != -1 {
		t.Fatalf("indexByte missing = %d, want -1", got)
	}
}
