// 数据目录一次性搬迁引擎（P-20261025-1 运行时标识切换）：
// ~/.simple-coding（旧默认）→ ~/.codecombo（新默认）。
//
// 设计要点（评审定稿三闸 + 实施补强）：
//
//  1. skip 规则（实机缺陷修正，2026-10-25）：迁移路由三形态——
//     默认路径解析（无显式 env）、显式 env 等于旧默认形态（远端旧 systemd
//     unit 显式下发 SC_DATA_DIR=~/.simple-coding）、显式 env 等于新默认
//     （restart-real 启动器传 -d ~/.codecombo）**都走迁移**；只有显式指向
//     真外部路径（e2e 的 .e2e-data、多目录用户）才跳过直用。初版实现把
//     「解析结果 ≠ 旧默认」一律早退 skip，默认路径与显式新默认全被误判为
//     外部路径——真实形态下迁移引擎整个死代码（服务日志零迁移记录、旧目录
//     原地不动、实例以空数据目录启动，用户数据看似全丢）。
//  2. 进程存活预检：rename 前读旧目录内 pid 文件（新旧两个名字都查）探测
//     旧实例——存活即拒绝迁移。Linux 下旧进程按旧路径续写会在 rename 后重建
//     旧目录，master-key/凭据库/锁 token 双份漂移（比丢失更危险）；Windows 下
//     打开中的句柄会让 rename 必败（sharing violation）。拒绝时错误信息附 pid
//     供用户复核（PID 复用的保守误拒面：宁拒不迁，不迁错）。
//  3. 原子 rename 快路径 + 逐条目合并恢复路径：目标目录已存在（远端升级链
//     先装新二进制到 ~/.codecombo/bin 造成的脚手架目录、或迁移中断残留）时
//     走逐条目 move 合并，旧目录内容为准（同名冲突 = 目标侧文件让位改名保
//     留，两份都不丢）；合并幂等可续跑（中断后下次启动继续）。
//  4. 迁移成功后环境中性化：显式 env 为旧默认形态时改写 CC_DATA_DIR 指向新
//     目录并摘除 SC_DATA_DIR——否则本进程与派生子进程（更新子进程/helper）
//     按旧路径续写会在原地重建空旧目录（双目录漂移）。
//
// 纪律红线：本引擎只允许由生产入口（main.go 启动序列）对真实家目录调用；
// 测试一律传临时目录走 migrateLegacyDataDir 纯函数，绝不触碰真实
// ~/.simple-coding（worktree/CI 无家目录写权限预期也不依赖）。
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"codecombo/server/proc"
)

// pidFileName 新版 pid 文件名（与 main.go pidFilePath / app 写入侧同一字面量，
// 改名须三处同改——有意不加跨包常量避免 config→app 反向依赖）
const pidFileName = "codecombo.pid"

// legacyPidFileName 旧版 pid 文件名（迁移预检/残留清理消费）
const legacyPidFileName = "simple-coding.pid"

// 迁移错误分类：调用方（main.go）按类型决定「致命退出」还是「告警续跑」
var (
	// ErrLegacyInstanceRunning 旧实例存活，拒绝迁移（--serve 应退出重试）
	ErrLegacyInstanceRunning = errors.New("legacy instance still running")
	// ErrMigrationRetryable 迁移遇到可重试失败（Windows 句柄占用等），关闭
	// 占用方后重启即可续跑
	ErrMigrationRetryable = errors.New("data dir migration retryable")
)

// LegacyInstanceError 迁移被拒绝/失败的富错误：附旧目录与检出 pid，
// CLI/启动日志据此给出可行动的提示
type LegacyInstanceError struct {
	Kind    error  // ErrLegacyInstanceRunning / ErrMigrationRetryable / 其他
	Legacy  string // 旧数据目录路径
	PID     int    // 预检检出的存活 pid（0 = 无 pid 信息）
	Detail  string // 底层错误文本
	Buttons string // 附加建议（如 Windows「关闭会话后重试」）
}

func (e *LegacyInstanceError) Error() string {
	msg := e.Kind.Error() + ": legacy data dir " + e.Legacy
	if e.PID > 0 {
		msg += fmt.Sprintf(" (pid %d appears alive — verify and stop it first)", e.PID)
	}
	if e.Detail != "" {
		msg += ": " + e.Detail
	}
	if e.Buttons != "" {
		msg += "; " + e.Buttons
	}
	return msg
}

func (e *LegacyInstanceError) Unwrap() error { return e.Kind }

// EnsureDataDirMigrated 生产入口的一次性迁移检查（幂等：迁移完成后旧目录
// 不存在，后续调用零成本返回）。必须在 config.Load / 任何 DataDir 消费者之前
// 调用（main.go 启动序列 applyDataDirFlag 之后）。返回错误不改变任何状态，
// 调用方决定退出或降级——刻意不内置 os.Exit，保持包可测。
func EnsureDataDirMigrated() error {
	legacy := LegacyDefaultDir()
	if legacy == "" {
		return nil // 主目录不可得（极径）：无从谈起迁移
	}
	newTarget := newDefaultDir()
	if newTarget == "" || samePath(newTarget, legacy) {
		return nil // 主目录不可得：无迁移目标，按旧路径续跑
	}
	overridden := false
	if os.Getenv("CC_DATA_DIR") != "" || os.Getenv("SC_DATA_DIR") != "" {
		overridden = true
	}
	// 迁移路由（见文件头 skip 规则）：默认解析 / 显式旧默认形态 / 显式新默认
	// 都指向迁移目标本身，必须走迁移；只有显式真外部路径才与旧目录无血缘、
	// 跳过直用。初版在此处按「解析结果 ≠ 旧默认」一律早退——默认路径与
	// 显式新默认（restart-real 传 -d ~/.codecombo）全被误判为外部路径，
	// 真实形态下迁移永不触发（实机缺陷 2026-10-25）
	target, skip := resolveMigrationTarget(legacy, DataDir(), newTarget, overridden)
	if skip {
		return nil
	}
	if err := migrateLegacyDataDir(legacy, target); err != nil {
		return err
	}
	if overridden {
		// 环境中性化：本进程与全部派生子进程此后解析到新目录
		_ = os.Setenv("CC_DATA_DIR", target)
		_ = os.Unsetenv("SC_DATA_DIR")
		legacyEnvUsed.Store(false) // env 已收敛到正名，不触发旧名回落告警
	}
	return nil
}

// resolveMigrationTarget 迁移路由（纯函数，可单测）：返回 (迁移目标, skip)。
//   - 默认解析（无显式 env）：目标恒为新默认目录（legacy 不存在时引擎内 no-op）
//   - 显式 env 等于旧默认形态（远端旧 systemd unit）：目标为新默认目录，走迁移
//   - 显式 env 等于新默认（restart-real 启动器 -d ~/.codecombo）：同上，走迁移
//   - 显式 env 指向其余路径（e2e 的 .e2e-data / 多目录用户）：skip 直用
func resolveMigrationTarget(legacy, resolved, newDefault string, overridden bool) (string, bool) {
	if !overridden || samePath(resolved, legacy) || samePath(resolved, newDefault) {
		return newDefault, false
	}
	return resolved, true
}

// newDefaultDir 新默认数据目录（主目录不可得返回空串）
func newDefaultDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".codecombo")
}

// samePath 路径同判：Clean 后字符串比较；Windows 文件系统大小写不敏感，
// 追加 EqualFold（不引入卷 ID/符号链接解析的重量级语义）
func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// migrateLegacyDataDir 迁移核心（纯函数，legacy→target 均为显式路径，
// 单测与副本实测一律走这里）。五态：
//  1. 旧目录不存在 → no-op（新装/已迁移）
//  2. 旧目录存在 + 目标不存在 → 原子 rename
//  2b. 旧目录存在 + 目标为空壳（仅空目录，如 CLI 预创建骨架）→ 清壳后原子 rename
//  3. 旧目录存在 + 目标存在（含实际内容）→ 逐条目合并（远端升级脚手架/中断恢复）
//  4. 旧实例存活 → 拒绝（ErrLegacyInstanceRunning）
func migrateLegacyDataDir(legacy, target string) error {
	if legacy == "" || target == "" || samePath(legacy, target) {
		return nil
	}
	li, err := os.Stat(legacy)
	if err != nil || !li.IsDir() {
		return nil // 旧目录不存在（或同名文件非目录：不碰）
	}
	// 进程存活预检（闸 b）：旧目录里新旧两个名字的 pid 文件都查
	if pid := livePidInDir(legacy); pid > 0 {
		return &LegacyInstanceError{Kind: ErrLegacyInstanceRunning, Legacy: legacy, PID: pid}
	}
	ti, terr := os.Stat(target)
	if terr == nil && ti.IsDir() {
		// 空壳特例（防线①，实机缺陷配套）：目标是仅含空目录的壳（CLI stop/
		// start 的 config.Load 在迁移落位前 MkdirAll 预创建的 <dir>/data 骨架）
		// 时不含任何用户数据——清壳后走原子 rename 快路径，让 stop→start 启动
		// 链也保持与「目标不存在」一致的原子迁移语义；清壳失败（权限/竞态）
		// 落回下方逐条目合并，不阻塞迁移
		if isEmptyDirShell(target) {
			if rerr := os.RemoveAll(target); rerr != nil {
				slog.Warn("data dir migration: failed to clear pre-created empty shell, falling back to merge", "dir", target, "err", rerr)
			} else if rerr := os.Rename(legacy, target); rerr != nil {
				// 壳已清、旧目录原封未动：盘面与「目标不存在」等价，下次启动重试
				return &LegacyInstanceError{Kind: ErrMigrationRetryable, Legacy: legacy, Detail: rerr.Error(),
					Buttons: windowsHint()}
			} else {
				slog.Info("data dir migrated (atomic rename, pre-created empty shell cleared)", "from", legacy, "to", target)
				return nil
			}
		}
		// 目标已存在：合并路径（幂等可续跑）
		if merr := mergeDir(legacy, target); merr != nil {
			return &LegacyInstanceError{Kind: ErrMigrationRetryable, Legacy: legacy, Detail: merr.Error(),
				Buttons: windowsHint()}
		}
		// 合并完旧目录应为空；移除失败仅告警（空壳残留无害，下次启动续清）
		if rerr := os.Remove(legacy); rerr != nil && !os.IsNotExist(rerr) {
			slog.Warn("data dir migration: legacy dir left behind (will retry next start)", "dir", legacy, "err", rerr)
		} else {
			slog.Info("data dir migration merged into existing target", "from", legacy, "to", target)
		}
		return nil
	}
	if terr == nil {
		// 目标路径存在但不是目录：异常盘面，拒绝盲迁
		return &LegacyInstanceError{Kind: ErrMigrationRetryable, Legacy: legacy,
			Detail: "target exists and is not a directory: " + target}
	}
	// 快路径：原子 rename（同卷目录 rename 三平台均为原子操作）
	if rerr := os.Rename(legacy, target); rerr != nil {
		return &LegacyInstanceError{Kind: ErrMigrationRetryable, Legacy: legacy, Detail: rerr.Error(),
			Buttons: windowsHint()}
	}
	slog.Info("data dir migrated (atomic rename)", "from", legacy, "to", target)
	return nil
}

// livePidInDir 读目录下新旧两个名字的 pid 文件，返回首个存活 pid（文件缺失
// 或 pid 已死返回 0）。pid 文件首行即 pid（写侧 app.go writePIDFile 约定）
func livePidInDir(dir string) int {
	for _, name := range []string{pidFileName, legacyPidFileName} {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		line := strings.SplitN(strings.TrimSpace(string(data)), "\n", 2)[0]
		var pid int
		if _, err := fmt.Sscanf(line, "%d", &pid); err != nil || pid <= 0 {
			continue
		}
		if proc.Alive(pid) {
			return pid
		}
	}
	return 0
}

// isEmptyDirShell 目录是否为「空壳」：没有任何非目录条目（文件/符号链接等，
// DirEntry.IsDir 按 lstat 语义指向目录的链接也判非目录），且子目录全部递归
// 为空——config.Load 预创建的数据目录骨架（<dir>/data）即此形态。任何实际
// 文件存在即非空壳（含真实数据的双目录走合并路径，两份都不丢）
func isEmptyDirShell(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if !e.IsDir() || !isEmptyDirShell(filepath.Join(dir, e.Name())) {
			return false
		}
	}
	return true
}

// mergeDir 把 src 目录内容逐条目 move 进 dst（幂等可续跑）：
//   - dst 缺该条目 → rename 直入；
//   - 双侧同为目录 → 递归合并；
//   - 同名冲突 → src（旧目录=用户真实数据）为准，dst 侧文件让位改名
//     <name>.codecombo-premerge 保留，两份都不丢（冲突只可能来自盘面
//     异常态，让位比覆盖诚实）。
func mergeDir(src, dst string) error {
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		s := filepath.Join(src, e.Name())
		d := filepath.Join(dst, e.Name())
		di, derr := os.Stat(d)
		switch {
		case os.IsNotExist(derr):
			if rerr := os.Rename(s, d); rerr != nil {
				return fmt.Errorf("move %s: %w", e.Name(), rerr)
			}
		case e.IsDir() && di.IsDir():
			if merr := mergeDir(s, d); merr != nil {
				return merr
			}
			// 子目录搬空后移除壳（失败留痕不阻塞——外层空壳清理兜底）
			if rerr := os.Remove(s); rerr != nil && !os.IsNotExist(rerr) {
				slog.Warn("data dir migration: empty subdir left behind", "dir", s, "err", rerr)
			}
		case di.IsDir() || e.IsDir():
			// 目录 vs 文件冲突：文件侧让位（任何一侧被覆盖都可能丢数据）
			aside := d + ".codecombo-premerge"
			if rerr := os.Rename(d, aside); rerr != nil {
				return fmt.Errorf("set aside %s: %w", e.Name(), rerr)
			}
			slog.Warn("data dir migration: name conflict, target side set aside", "path", d, "aside", aside)
			if rerr := os.Rename(s, d); rerr != nil {
				return fmt.Errorf("move %s: %w", e.Name(), rerr)
			}
		default:
			// 双侧同名文件：src 让 dst 侧让位，src 内容为准（见函数头注释）
			aside := d + ".codecombo-premerge"
			if rerr := os.Rename(d, aside); rerr != nil {
				return fmt.Errorf("set aside %s: %w", e.Name(), rerr)
			}
			if rerr := os.Rename(s, d); rerr != nil {
				return fmt.Errorf("move %s: %w", e.Name(), rerr)
			}
			slog.Warn("data dir migration: file conflict, legacy copy wins (target copy kept aside)", "path", d, "aside", aside)
		}
	}
	return nil
}

// windowsHint Windows 专属重试提示（sharing violation 的可行动出路）
func windowsHint() string {
	if runtime.GOOS == "windows" {
		return "close running sessions/processes holding the directory open, then start again"
	}
	return ""
}

// RemoveLegacyPidFile 启动期旧名 pid 文件残留清理（app.go 写入新名前调用；
// 迁移把旧目录整体搬来时旧 pid 文件随之而来，留着会误导旧版 CLI 的兜底扫描）
func RemoveLegacyPidFile() {
	_ = os.Remove(filepath.Join(DataDir(), legacyPidFileName))
}

// OpenLegacyPidCompat 在 dirs 中按「新名→旧名」顺序查找 pid 文件（CLI stop/
// status 兼容查找运行中的旧版实例：迁移被拒（旧实例存活）时新名文件必然
// 不存在，只有旧目录旧名文件可寻）。返回首个存在的路径，全缺返回空串
func OpenLegacyPidCompat(dirs ...string) string {
	for _, dir := range dirs {
		for _, name := range []string{pidFileName, legacyPidFileName} {
			p := filepath.Join(dir, name)
			if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
				return p
			}
		}
	}
	return ""
}
