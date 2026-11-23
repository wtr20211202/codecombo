package update

// 失败路径必产日志断言（P-20261122-12 必改4）：更新链两处「失败无迹」修复的
// 可执行证据——①结果文件写失败（整条观察链的唯一事实源，写失败曾完全静默）；
// ②回滚后重拉失败（服务无进程，曾只留一句 rollback 无二次失败原因）。
// 全部经 stubUpdateLogger + 取值口注入（本包测试纪律），不真实 spawn。

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestSaveResultWriteFailureLeavesLog 结果文件写失败必须落 update.log：
// 结果文件是主进程 / 前端判定更新结局的唯一来源，写失败时用户只能看到
// 「更新无结局」——日志是唯一可诊断面。
func TestSaveResultWriteFailureLeavesLog(t *testing.T) {
	buf := stubUpdateLogger(t)
	dd := t.TempDir()
	// 目录占位同名路径：os.WriteFile(dataDir/update-result.json) 必失败
	// （三平台一致），无需依赖磁盘满/权限等外部条件
	if err := os.MkdirAll(filepath.Join(dd, "update-result.json"), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx := &updateContext{
		currentBinary: filepath.Join(dd, "codecombo"),
		backup:        filepath.Join(dd, "codecombo") + ".bak",
		dd:            dd,
		version:       "v2.0.0",
		prevVersion:   "v1.9.0",
	}

	ctx.saveResult("rolled_back", "health check failed")

	log := buf.String()
	if !strings.Contains(log, "write update result failed") {
		t.Fatalf("结果文件写失败无留痕，log = %q", log)
	}
	if !strings.Contains(log, "status=rolled_back") || !strings.Contains(log, "update-result.json") {
		t.Fatalf("留痕应含状态与失败路径（可反查），log = %q", log)
	}
}

// TestKillAndRollbackKillFailureLeavesLog 健康检查失败回滚时击杀坏新进程失败
// 必须留痕：结果文件只会写 rolled_back 本因，杀不掉=坏进程仍占端口，
// 两种事故终态必须能在 update.log 里区分（P-20261122-12）。
func TestKillAndRollbackKillFailureLeavesLog(t *testing.T) {
	buf := stubSyncLogger(t)
	stubRestartSeams(t)
	origKill := killByPIDFn
	t.Cleanup(func() { killByPIDFn = origKill })
	killByPIDFn = func(int) error { return errors.New("access denied") }

	dd := t.TempDir()
	cur := filepath.Join(dd, "codecombo")
	if err := os.WriteFile(cur, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx := &updateContext{
		currentBinary: cur,
		backup:        cur + ".bak",
		dd:            dd,
		spawnedPID:    999,
		version:       "v2.0.0",
		prevVersion:   "v1.9.0",
	}

	ctx.killAndRollback("health check failed")

	log := buf.String()
	if !strings.Contains(log, "kill spawned new-version process 999 failed") || !strings.Contains(log, "access denied") {
		t.Fatalf("击杀失败无留痕，log = %q", log)
	}
	if !strings.Contains(log, "kill and rollback: health check failed") {
		t.Fatalf("既有回滚留痕不应回退，log = %q", log)
	}
}

// TestRollbackRelaunchFailureLeavesLog 回滚重拉失败必须落 update.log：
// 盘面已回旧版但服务没有任何进程，属「回滚也未成功」的事故终态；errMsg
// 仍只承载原始失败原因（结果文件语义不变），二次失败进日志。
func TestRollbackRelaunchFailureLeavesLog(t *testing.T) {
	buf := stubSyncLogger(t)
	stubRestartSeams(t)
	origSpawn := spawnBareFn
	t.Cleanup(func() { spawnBareFn = origSpawn })
	spawnBareFn = func(string, []string, *os.ProcAttr) (int, error) {
		return 0, errors.New("spawn boom")
	}

	dd := t.TempDir()
	cur := filepath.Join(dd, "codecombo")
	if err := os.WriteFile(cur, []byte("OLD"), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx := &updateContext{
		currentBinary: cur,
		backup:        cur + ".bak",
		dd:            dd,
		version:       "v2.0.0",
		prevVersion:   "v1.9.0",
	}

	err := ctx.rollback("replace failed: disk full")
	if err == nil {
		t.Fatal("rollback 必须上抛原始失败")
	}
	if strings.Contains(err.Error(), "relaunch") {
		t.Fatalf("errMsg 只承载原始原因（结果文件契约不变），got %q", err.Error())
	}
	log := buf.String()
	if !strings.Contains(log, "relaunch after restore failed") || !strings.Contains(log, "spawn boom") {
		t.Fatalf("回滚重拉失败无留痕，log = %q", log)
	}
}
