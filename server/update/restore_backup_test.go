package update

// P-20261116-1-S2 定向验证：回滚盘面恢复加固面——防丢失窗顺序（坏包挪开→
// 备份归位→清残件，任意时刻 ExecStart 路径都有文件）/ 备份归位 rename 失败
// 的 CopyFile+Chmod 0755 回退链 / 备份缺席双态（已恢复幂等成功 vs 事故盘面
// 响亮报错）/ killAndRollback 收尾校验（缺失再恢复一轮，失败并入结果文件
// 透出）。rename 故障经 restoreRenameFn 注入——跨平台无法用纯文件系统手段
// 可靠构造「rename 失败而复制可用」（两者同需目录写权限）；全部经取值口注入
// （本包测试纪律），绝不真实 spawn 换包进程。本包测试无 t.Parallel，
// 包级插桩安全

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// stubRestoreRename 注入 rename 故障：failWhen(old, new) 命中的调用返回权限
// 错误，其余透传真实 os.Rename。测试结束还原
func stubRestoreRename(t *testing.T, failWhen func(oldpath, newpath string) bool) {
	orig := restoreRenameFn
	t.Cleanup(func() { restoreRenameFn = orig })
	restoreRenameFn = func(oldpath, newpath string) error {
		if failWhen(oldpath, newpath) {
			return os.ErrPermission
		}
		return os.Rename(oldpath, newpath)
	}
}

// TestRestoreBackupLossWindowOrder 防丢失窗顺序的正常路径：恢复后 ExecStart
// 路径=旧包内容、备份已消耗（rename 归位语义）、无 .stale-tmp 残件
func TestRestoreBackupLossWindowOrder(t *testing.T) {
	buf := stubUpdateLogger(t)
	dd := t.TempDir()
	cur := filepath.Join(dd, "codecombo")
	_ = os.WriteFile(cur, []byte("NEW"), 0755)
	_ = os.WriteFile(cur+".bak", []byte("OLD"), 0755)
	ctx := &updateContext{currentBinary: cur, backup: cur + ".bak"}

	if err := ctx.restoreBackup(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(mustRead(t, cur)) != "OLD" {
		t.Fatal("backup not restored over the swapped binary")
	}
	if _, err := os.Stat(cur + ".bak"); !os.IsNotExist(err) {
		t.Fatalf("backup must be consumed by rename-in-place, stat err = %v", err)
	}
	if _, err := os.Stat(cur + ".stale-tmp"); !os.IsNotExist(err) {
		t.Fatalf("stale-tmp must be cleaned up, stat err = %v", err)
	}
	if strings.Contains(buf.String(), "rollback restore") {
		t.Fatalf("healthy restore must stay quiet, log = %q", buf.String())
	}
}

// TestRestoreBackupCopyFallbackWhenPlacementRenameFails 备份归位 rename 失败
// 的回退链：CopyFile(.bak→当前)+Chmod 0755 把旧包放回 ExecStart 路径，.bak
// 有意保留（复制语义弱于 rename，保住最后一份旧包），错误不外抛
func TestRestoreBackupCopyFallbackWhenPlacementRenameFails(t *testing.T) {
	stubUpdateLogger(t)
	dd := t.TempDir()
	cur := filepath.Join(dd, "codecombo")
	_ = os.WriteFile(cur, []byte("NEW"), 0755)
	_ = os.WriteFile(cur+".bak", []byte("OLD"), 0755)
	ctx := &updateContext{currentBinary: cur, backup: cur + ".bak"}
	stubRestoreRename(t, func(_, newpath string) bool { return newpath == cur })

	if err := ctx.restoreBackup(); err != nil {
		t.Fatalf("copy fallback must recover, got error: %v", err)
	}
	if string(mustRead(t, cur)) != "OLD" {
		t.Fatal("copy fallback did not place the old binary")
	}
	if _, err := os.Stat(cur + ".bak"); err != nil {
		t.Fatalf(".bak must be kept on the copy path (last-resort copy), stat err = %v", err)
	}
	if _, err := os.Stat(cur + ".stale-tmp"); !os.IsNotExist(err) {
		t.Fatalf("stale-tmp must still be cleaned up, stat err = %v", err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(cur)
		if err != nil || info.Mode().Perm() != 0755 {
			t.Fatalf("copy path must chmod 0755, got %v (stat err %v)", info.Mode(), err)
		}
	}
}

// TestRestoreBackupMoveAsideFailureContinues 挪开坏包失败不阻断：事故盘面
// （当前文件缺席）与可继续场景都照样归位备份——归位才是回滚的目的
func TestRestoreBackupMoveAsideFailureContinues(t *testing.T) {
	stubUpdateLogger(t)
	dd := t.TempDir()
	cur := filepath.Join(dd, "codecombo")
	_ = os.WriteFile(cur, []byte("NEW"), 0755)
	_ = os.WriteFile(cur+".bak", []byte("OLD"), 0755)
	ctx := &updateContext{currentBinary: cur, backup: cur + ".bak"}
	stubRestoreRename(t, func(_, newpath string) bool { return newpath == cur+".stale-tmp" })

	if err := ctx.restoreBackup(); err != nil {
		t.Fatalf("move-aside failure must not block restore, got: %v", err)
	}
	if string(mustRead(t, cur)) != "OLD" {
		t.Fatal("backup not restored over the swapped binary")
	}
	if _, err := os.Stat(cur + ".stale-tmp"); !os.IsNotExist(err) {
		t.Fatal("failed move-aside must not leave a stale-tmp behind")
	}
}

// TestRestoreBackupIdempotentWhenBackupConsumed 备份已消耗且当前文件在场＝
// 上轮已恢复：幂等成功且不碰当前文件——事故的直接回归（旧实现此处会先
// Remove 当前文件再静默吞掉 rename 失败，把刚恢复的旧包删没）
func TestRestoreBackupIdempotentWhenBackupConsumed(t *testing.T) {
	buf := stubUpdateLogger(t)
	dd := t.TempDir()
	cur := filepath.Join(dd, "codecombo")
	_ = os.WriteFile(cur, []byte("OLD"), 0755)
	ctx := &updateContext{currentBinary: cur, backup: cur + ".bak"}

	if err := ctx.restoreBackup(); err != nil {
		t.Fatalf("already-restored state must be a no-op success, got: %v", err)
	}
	if string(mustRead(t, cur)) != "OLD" {
		t.Fatal("idempotent call must not touch the restored binary")
	}
	if !strings.Contains(buf.String(), "already restored") {
		t.Fatalf("idempotent path must be logged, log = %q", buf.String())
	}
}

// TestRestoreBackupLoudErrorWhenBothAbsent 备份与 ExecStart 路径皆缺席＝事故
// 盘面：响亮报错（updateLogf 留痕 + 错误返回供调用方并入结果文件），不再
// 无声留坑
func TestRestoreBackupLoudErrorWhenBothAbsent(t *testing.T) {
	buf := stubUpdateLogger(t)
	dd := t.TempDir()
	cur := filepath.Join(dd, "codecombo")
	ctx := &updateContext{currentBinary: cur, backup: cur + ".bak"}

	err := ctx.restoreBackup()
	if err == nil {
		t.Fatal("both-absent disk state must surface an error")
	}
	if !strings.HasPrefix(err.Error(), "rollback restore failed") {
		t.Fatalf("error = %q, want rollback restore failed prefix", err.Error())
	}
	if !strings.Contains(buf.String(), err.Error()) {
		t.Fatalf("error must be logged loudly, log = %q", buf.String())
	}
}

// TestEnsureRollbackBinaryReRestoresWhenMissing 收尾校验的再恢复轮：ExecStart
// 路径缺席时从备份再恢复一轮（restoreBackup 幂等语义复用），恢复成功则
// errMsg 原样返回（无「回滚盘面恢复失败」并入）
func TestEnsureRollbackBinaryReRestoresWhenMissing(t *testing.T) {
	stubUpdateLogger(t)
	dd := t.TempDir()
	cur := filepath.Join(dd, "codecombo")
	_ = os.WriteFile(cur+".bak", []byte("OLD"), 0755)
	ctx := &updateContext{currentBinary: cur, backup: cur + ".bak"}

	if got := ctx.ensureRollbackBinary("health check failed"); got != "health check failed" {
		t.Fatalf("errMsg = %q, want unchanged after successful re-restore", got)
	}
	if string(mustRead(t, cur)) != "OLD" {
		t.Fatal("re-restore round did not place the old binary")
	}
}

// TestEnsureRollbackBinarySurfacesWhenNothingToRestore 收尾校验的最终失败态：
// 备份与 ExecStart 路径皆缺席（事故终态），再恢复轮失败的原因必须并入
// errMsg 供 saveResult 透出
func TestEnsureRollbackBinarySurfacesWhenNothingToRestore(t *testing.T) {
	stubUpdateLogger(t)
	dd := t.TempDir()
	cur := filepath.Join(dd, "codecombo")
	ctx := &updateContext{currentBinary: cur, backup: cur + ".bak"}

	got := ctx.ensureRollbackBinary("health check failed")
	if !strings.Contains(got, "health check failed; rollback restore failed") {
		t.Fatalf("errMsg = %q, want original cause + restore failure merged", got)
	}
}

// TestKillAndRollbackIncidentDiskStateRestoresAndSpans 事故盘面端到端回归
// （bare 形态）：ExecStart 路径二进制已缺席 + 备份在场时，killAndRollback
// 仍能把旧包归位并重拉旧包——结果文件错误只含原始健康检查原因（盘面恢复
// 成功不掺恢复失败噪声）
func TestKillAndRollbackIncidentDiskStateRestoresAndSpans(t *testing.T) {
	p := stubRestartSeams(t)
	stubUpdateLogger(t)
	t.Setenv(envUpdateSupervise, string(superviseBare))
	dd := t.TempDir()
	cur := filepath.Join(dd, "codecombo")
	_ = os.WriteFile(cur+".bak", []byte("OLD"), 0755)
	ctx := &updateContext{currentBinary: cur, backup: cur + ".bak", port: 9999, dd: dd, spawnedPID: 777}

	ctx.killAndRollback("health check failed")

	if string(mustRead(t, cur)) != "OLD" {
		t.Fatal("incident disk state must be restored from backup")
	}
	if p.spawnCalls != 1 || p.spawnBinary != cur {
		t.Fatalf("spawn = %d (binary %q), want exactly one re-spawn of the restored path", p.spawnCalls, p.spawnBinary)
	}
	res, err := LoadUpdateResult(dd)
	if err != nil || res == nil {
		t.Fatalf("load result: %v (nil=%v)", err, res == nil)
	}
	if res.Status != "rolled_back" || res.Error != "health check failed" {
		t.Fatalf("result = %s / %q, want rolled_back with the original cause only", res.Status, res.Error)
	}
}

// TestKillAndRollbackSurfacesRestoreFailureInResult 回滚盘面恢复失败必须透出
// （事故链「起不来且二进制没了」的可见性根治面）：备份与 ExecStart 路径皆
// 缺席时结果文件如实携带「rollback restore failed」两层原因，重拉仍尽力尝试
func TestKillAndRollbackSurfacesRestoreFailureInResult(t *testing.T) {
	p := stubRestartSeams(t)
	stubUpdateLogger(t)
	t.Setenv(envUpdateSupervise, string(superviseBare))
	dd := t.TempDir()
	cur := filepath.Join(dd, "codecombo")
	ctx := &updateContext{currentBinary: cur, backup: cur + ".bak", port: 9999, dd: dd, spawnedPID: 777}

	ctx.killAndRollback("health check failed")

	res, err := LoadUpdateResult(dd)
	if err != nil || res == nil {
		t.Fatalf("load result: %v (nil=%v)", err, res == nil)
	}
	if res.Status != "rolled_back" {
		t.Fatalf("status = %s, want rolled_back", res.Status)
	}
	if !strings.Contains(res.Error, "health check failed") || !strings.Contains(res.Error, "rollback restore failed") {
		t.Fatalf("result error = %q, want original cause + loud restore failure", res.Error)
	}
	if p.spawnCalls != 1 {
		t.Fatalf("spawn = %d, want best-effort re-spawn still attempted", p.spawnCalls)
	}
}
