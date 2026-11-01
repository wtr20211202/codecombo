package git

// index.lock 遗留锁检测与一键清理（P-20261002-150）：
// git 写命令因 .git/index.lock 已存在而失败（进程崩溃/强杀遗留的死锁文件）时，
// 历史自救是「重启服务/手删 .git 内文件」。本文件把该自救收敛为一键修复：
//   - 检测（错误升级）：写命令失败且错误含 index.lock 时检查锁文件状态，
//     mtime 超过阈值（5 分钟，从紧——正在写入的锁 mtime 必新）判定为遗留锁，
//     错误原文追加稳定标记（IndexLockStaleMarker），前端按标记识别并出修复条
//   - 清理：CleanStaleIndexLock 以 mtime 双重校验防误删活锁（删掉正在使用的锁
//     会损坏并发中的 git 操作），仅遗留锁才动手
// 与写串行队列类预防（防并发写产生锁）互补：那条防新增，本条恢复既有。

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"codecombo/server/errmarkers"
)

// IndexLockStaleMarker 错误原文中的稳定英文标记：写命令失败且检测到遗留锁时
// 追加到错误尾部，前端按此子串映射本地化文案并点亮修复条
// （对齐 http.ts KNOWN_ERROR_I18N 的「服务端稳定英文原文 → 子串匹配」机制）。
// P-20261004-29 起文本唯一事实源在 errmarkers 注册表（跨端守卫对账基准），
// 此处保名别名，既有调用方零改动
const IndexLockStaleMarker = errmarkers.IndexLockStale

// ErrIndexLockFresh 清理端点拒绝删「锁龄未达阈值」的活锁（CleanStaleIndexLock
// 的误删保护分支，P-20261005-160 起携带哨兵供 handler 附结构化错误码
// git.index_lock_fresh）。文案保持原句式不变：该错误不进前端正则表（非跨端
// 文本标记），但原文对 agent 与排障日志可读
var ErrIndexLockFresh = errors.New("git index lock is fresh")

// indexLockStaleAge 遗留锁判定阈值：锁文件 mtime 距今超过该值视为遗留。
// 正在写入的锁生命周期是单条命令（秒级），5 分钟从紧不误判。var 便于单测注入
var indexLockStaleAge = 5 * time.Minute

// IndexLockInfo index.lock 锁状态快照
type IndexLockInfo struct {
	Path   string `json:"path"`   // 锁文件绝对路径
	AgeSec int64  `json:"ageSec"` // 锁龄（秒）
	Stale  bool   `json:"stale"`  // 是否达到遗留阈值
}

// DetectIndexLock 检测 workDir 仓库的 index.lock 状态；锁不存在（或仓库形态
// 无法解析）返回 nil。Stat 错误一律按「无锁」处理：边缘场景（权限等）不做
// 删除决策，宁可不动。gitdir 解析复用 resolveGitDir（merge.go，worktree 指针
// 文件同语义）且纯文件操作零子进程——本函数挂在写命令失败路径上，失败处理
// 不能再添进程开销
func DetectIndexLock(workDir string) *IndexLockInfo {
	if workDir == "" {
		return nil
	}
	gitDir, ok := resolveGitDir(workDir)
	if !ok {
		return nil
	}
	lockPath := filepath.Join(gitDir, "index.lock")
	fi, err := os.Stat(lockPath)
	if err != nil {
		return nil
	}
	age := time.Since(fi.ModTime())
	return &IndexLockInfo{
		Path:   lockPath,
		AgeSec: int64(age / time.Second),
		Stale:  age >= indexLockStaleAge,
	}
}

// CleanStaleIndexLock 清理 workDir 仓库的遗留 index.lock（一键修复入口）。
// mtime 双重校验防误删活锁：仅当锁存在且锁龄达到阈值才删除；锁不存在视为
// 已清理（幂等，removed=false 无错误）；未达阈值拒绝并返回含锁龄的明确错误
// （正在写入的锁被删会让并发中的 git 操作损坏索引）。removed=true 时 ageSec
// 为删除时的锁龄
func CleanStaleIndexLock(workDir string) (removed bool, ageSec int64, err error) {
	info := DetectIndexLock(workDir)
	if info == nil {
		return false, 0, nil
	}
	if !info.Stale {
		return false, info.AgeSec, fmt.Errorf("%w (%ds old), refusing to remove a possibly active lock", ErrIndexLockFresh, info.AgeSec)
	}
	if rmErr := os.Remove(info.Path); rmErr != nil {
		return false, info.AgeSec, fmt.Errorf("remove %s: %w", filepath.Base(info.Path), rmErr)
	}
	return true, info.AgeSec, nil
}

// indexLockWriteCommand 触发遗留锁检测的命令范围：错误上下文限定写命令
// （删除保护双闸之一）——读命令的 index.lock 报错不升级、不据此删锁。
// 以既有写命令分类为基（mutatingGitSubcommands），补上同样持有 index.lock
// 的 add（暂存）与 pull（合并落索引）
func indexLockWriteCommand(args []string) bool {
	sub := findSubcommand(args)
	return mutatingGitSubcommands[sub] || sub == "add" || sub == "pull"
}

// upgradeIndexLockError 写命令失败且错误含 index.lock 时的锁状态检测与错误升级：
// 锁文件存在且 mtime 超阈值（遗留锁）→ 错误原文追加稳定标记，前端识别后出
// 修复条。任一前置不满足（读命令/错误不含 index.lock/锁不存在或尚新）原样返回
func upgradeIndexLockError(workDir string, args []string, errStr string, orig error) error {
	if orig == nil || workDir == "" {
		return orig
	}
	if !strings.Contains(errStr, "index.lock") || !indexLockWriteCommand(args) {
		return orig
	}
	info := DetectIndexLock(workDir)
	if info == nil || !info.Stale {
		return orig
	}
	return fmt.Errorf("%w [%s: %ds old]", orig, IndexLockStaleMarker, info.AgeSec)
}
