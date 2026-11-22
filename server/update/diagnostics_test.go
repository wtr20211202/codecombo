package update

// P-20261116-1-S3 定向验证：诊断面收口——①失败结案 ExecStart 路径快照
// （存在=权限位+大小 / 缺席=ABSENT+stat 原文，随 saveResult 非 success 落一行
// update.log；成功结案不落防噪声）+ ②双文件职责头注（update.log 与
// update-restart.log 各自仅首次创建写一行，O_APPEND 串接再开不重复刷屏）。
// 全部经 stubUpdateLogger 注入与临时目录实证（本包测试纪律），绝不探测真实
// 实例、不真实 spawn 换包进程。本包测试无 t.Parallel，包级插桩安全

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSaveResultFailureSnapshotsExecStartStatus 失败结案快照（在场盘面）：
// 结果文件写盘前落一行 ExecStart 路径实盘状态，含权限位与大小——回滚收尾后
// 的盘面终态一眼可诊
func TestSaveResultFailureSnapshotsExecStartStatus(t *testing.T) {
	buf := stubUpdateLogger(t)
	dd := t.TempDir()
	cur := filepath.Join(dd, "codecombo")
	if err := os.WriteFile(cur, []byte("OLD"), 0755); err != nil {
		t.Fatal(err)
	}
	ctx := &updateContext{currentBinary: cur, backup: cur + ".bak", dd: dd, version: "v2", prevVersion: "v1"}

	ctx.saveResult("rolled_back", "health check failed")

	log := buf.String()
	if !strings.Contains(log, "case closed") || !strings.Contains(log, cur) {
		t.Fatalf("snapshot line with path missing, log = %q", log)
	}
	if !strings.Contains(log, "mode=") || !strings.Contains(log, "size=3 bytes") {
		t.Fatalf("snapshot must carry mode and size, log = %q", log)
	}
	if strings.Contains(log, "ABSENT") {
		t.Fatalf("present binary must not be reported absent, log = %q", log)
	}
}

// TestSaveResultFailureSnapshotAbsentBinary 结案时 ExecStart 路径缺席＝事故
// 盘面（beta.7→beta.8 事故形态）：快照行如实 ABSENT 并携带 stat 原文——
// 本案事故若有此行当时即知 ENOENT
func TestSaveResultFailureSnapshotAbsentBinary(t *testing.T) {
	buf := stubUpdateLogger(t)
	dd := t.TempDir()
	cur := filepath.Join(dd, "codecombo")
	ctx := &updateContext{currentBinary: cur, backup: cur + ".bak", dd: dd, version: "v2", prevVersion: "v1"}

	ctx.saveResult("rolled_back", "health check failed")

	log := buf.String()
	if !strings.Contains(log, "ABSENT") || !strings.Contains(log, cur) {
		t.Fatalf("absent snapshot line missing, log = %q", log)
	}
}

// TestSaveResultSuccessSkipsSnapshot 成功结案不落快照（盘面无疑点，防每次
// 更新噪声行）
func TestSaveResultSuccessSkipsSnapshot(t *testing.T) {
	buf := stubUpdateLogger(t)
	dd := t.TempDir()
	cur := filepath.Join(dd, "codecombo")
	_ = os.WriteFile(cur, []byte("NEW"), 0755)
	ctx := &updateContext{currentBinary: cur, backup: cur + ".bak", dd: dd, version: "v2", prevVersion: "v1"}

	ctx.saveResult("success", "")

	if strings.Contains(buf.String(), "case closed") {
		t.Fatalf("success closing must not log a snapshot, log = %q", buf.String())
	}
}

// TestOpenAppendLogHeaderOnlyOnFirstCreate openAppendLog 头注语义：首次创建
// 写一行头注，既有文件再开（O_APPEND 串接下一轮）不重复、已落内容保全
func TestOpenAppendLogHeaderOnlyOnFirstCreate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "svc.log")
	f, err := openAppendLog(path, "# duty note")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString("one\n")
	_ = f.Close()

	f, err = openAppendLog(path, "# duty note")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString("two\n")
	_ = f.Close()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	if got := strings.Count(s, "# duty note"); got != 1 {
		t.Fatalf("header count = %d, want exactly 1 (creation only), file = %q", got, s)
	}
	if s != "# duty note\none\ntwo\n" {
		t.Fatalf("file = %q, want header first line + appended content preserved", s)
	}
}

// TestInitLoggerWritesUpdateLogHeader initLogger 接线：update.log 首次创建
// 落职责头注，二次初始化（下一轮更新 O_APPEND 串接）头注不重复
func TestInitLoggerWritesUpdateLogHeader(t *testing.T) {
	orig := updateLogger
	// 手工 MkdirTemp 而非 t.TempDir：initLogger 打开的句柄挂在包级
	// updateLogger 里无关闭口（Windows 句柄未释放时 RemoveAll 必失败），
	// 清理尽力而为、残留交 OS 临时目录回收。cleanup 注册顺序即 LIFO 执行
	// 顺序：先注册 RemoveAll（最后执行），后注册还原（先执行——引用先释放）
	dd, err := os.MkdirTemp("", "updlog-test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dd) })
	t.Cleanup(func() { updateLogger = orig })

	initLogger(dd)
	initLogger(dd) // 第二轮更新串接同文件

	data, err := os.ReadFile(filepath.Join(dd, "logs", "update.log"))
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	if got := strings.Count(s, updateLogHeader); got != 1 {
		t.Fatalf("update.log header count = %d, want exactly 1, file = %q", got, s)
	}
	if !strings.HasPrefix(s, updateLogHeader+"\n") {
		t.Fatalf("header must be the first line, file starts = %q", s)
	}
}

// TestDaemonStdoutWritesRestartLogHeader daemonStdout 接线：update-restart.log
// 首次创建落职责头注，多次 bare spawn 串接不重复、输出保全
func TestDaemonStdoutWritesRestartLogHeader(t *testing.T) {
	dd := t.TempDir()
	f1 := daemonStdout(dd)
	_, _ = f1.WriteString("[run1] output\n")
	_ = f1.Close()
	f2 := daemonStdout(dd)
	_, _ = f2.WriteString("[run2] output\n")
	_ = f2.Close()

	data, err := os.ReadFile(filepath.Join(dd, "logs", "update-restart.log"))
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	if got := strings.Count(s, restartLogHeader); got != 1 {
		t.Fatalf("header count = %d, want exactly 1, file = %q", got, s)
	}
	if !strings.HasPrefix(s, restartLogHeader+"\n") {
		t.Fatalf("header must be the first line, file = %q", s)
	}
	if !strings.Contains(s, "[run1] output") || !strings.Contains(s, "[run2] output") {
		t.Fatalf("output across runs must be preserved, file = %q", s)
	}
}
