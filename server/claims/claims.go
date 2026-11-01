// Package claims 项目跨实例同目录双开检测（P-20261003-3）：同一工作目录被多个
// 多实例（Codecombo）同时作为项目管理时，git/watcher/通知三面都会并发踩踏
// （各持一份 fsnotify 与 auto-fetch，git index/refs 互踢、文件变更双推送）。
//
// 检测机制：「谁正打开这个目录」落成项目 .git 内的 claim 文件。.git 是两个
// 实例对同一目录唯一必然共享的锚点——各实例数据目录互不可见（每实例一份
// SC_DATA_DIR），跨挂载路径（Windows D:\repo ↔ WSL /mnt/d/repo）也只有目录
// 本身共享；.git 内文件对 git status 与文件树不可见，不污染用户工作区
// （既有先例：git hook 注入写 .git/hooks）。启动全量 claim + 心跳续期 +
// 退出清理，扫描发现他实例的存活 claim 即入账通知中心显式知情。
//
// claim 文件形态：<gitdir>/simple-coding/project-claims/<instanceId>.json，
// 内容 {instanceId, port, startedAt, updatedAt}。文件名用 instanceId 而非
// 提案原文的 hash(path)：同一目录内 path 恒定，按实例分文件才能多实例共存
// （hash 文件名会被后写者覆盖）。instanceId 是数据目录级持久身份（见
// InstanceID），实例崩溃重启不换号——自己的残留 claim 不会幻报成他实例；
// updatedAt 由心跳刷新，超过 staleAfter 的视为崩溃残留，扫描时顺手清理。
package claims

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

// claimRelDir claim 目录相对 gitdir 的固定路径（本系统命名空间避免与 git
// 自身目录及其他工具冲突）。
// legacyClaimRelDir 为 P-20261025-1 标识切换前的旧命名空间：claim 是心跳级
// 瞬态数据（30s 续期/3min 残留回收），不做一次性搬迁——扫描面对新旧两个目录
// 取并集（跨版本双实例同项目并行的互见性保住），写入恒落新目录，旧目录随
// 残留回收自然清空
const (
	claimRelDir       = "codecombo/project-claims"
	legacyClaimRelDir = "simple-coding/project-claims"
)

// 心跳与残留判定：claim 每 30s 续期一次，3 个分钟级容错窗内无续期即视为
// 崩溃残留（SIGKILL/断电走不到退出清理，staleness 是唯一回收路径）。
// 机器休眠唤醒后本实例首个心跳会重写文件，自愈此期间的误判
const (
	HeartbeatEvery = 30 * time.Second
	StaleAfter     = 3 * time.Minute
)

// Claim 单实例对某项目目录的占用凭证
type Claim struct {
	InstanceID string    `json:"instanceId"`
	Port       int       `json:"port"`
	StartedAt  time.Time `json:"startedAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// Peer 扫描命中的他实例 claim 摘要
type Peer struct {
	InstanceID string
	Port       int
	StartedAt  time.Time
}

// ResolveGitDir 解析项目路径对应的 git 目录（claim 锚点）：
// 常规仓库 <p>/.git 是目录；linked worktree / submodule 下是指针文件
// （"gitdir: <path>"，路径可能相对）。非 git 目录返回 ""（无锚点不参与
// 双开检测——损害面集中在 git 操作，非 git 工作区跳过是接受的边界）
func ResolveGitDir(projectPath string) string {
	gitPath := filepath.Join(projectPath, ".git")
	info, err := os.Stat(gitPath)
	if err != nil {
		return ""
	}
	if info.IsDir() {
		return gitPath
	}
	// 指针文件：读首行 "gitdir: <target>"（文件极小，4KB 截断防御异常内容）
	f, err := os.Open(gitPath)
	if err != nil {
		return ""
	}
	defer f.Close()
	buf := make([]byte, 4096)
	n, _ := f.Read(buf)
	target := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(buf[:n])), "gitdir:"))
	if target == "" {
		return ""
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(projectPath, target)
	}
	if ti, err := os.Stat(target); err == nil && ti.IsDir() {
		return target
	}
	return ""
}

// ClaimDir gitdir 下的 claim 目录（写入锚点，恒为新命名空间）
func ClaimDir(gitDir string) string {
	return filepath.Join(gitDir, filepath.FromSlash(claimRelDir))
}

// claimScanDirs gitdir 下的 claim 扫描目录清单（新命名空间在前，旧命名空间
// 兼容期并入——跨版本双实例同项目的双开检测互见）
func claimScanDirs(gitDir string) []string {
	return []string{
		ClaimDir(gitDir),
		filepath.Join(gitDir, filepath.FromSlash(legacyClaimRelDir)),
	}
}

// WriteClaim 原子写入本实例的 claim 文件（tmp+rename：崩溃不留半截 JSON，
// 他实例读坏文件只会误判「无冲突」漏报而非误报）
func WriteClaim(gitDir string, c Claim) error {
	if gitDir == "" || c.InstanceID == "" {
		return fmt.Errorf("claims: gitDir and instanceId are required")
	}
	dir := ClaimDir(gitDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.Marshal(c)
	if err != nil {
		return err
	}
	final := filepath.Join(dir, c.InstanceID+".json")
	tmp := final + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, final)
}

// ScanGitDir 扫描 gitdir 内他实例的存活 claim：跳过本实例自己的文件；
// 超过 StaleAfter 未续期的他实例文件是崩溃残留，顺手清理（写方下一个
// 心跳会重建文件，误清自愈）；损坏文件跳过不清理（可能正被并发写）
func ScanGitDir(gitDir, selfInstanceID string, now time.Time) ([]Peer, error) {
	var peers []Peer
	for _, dir := range claimScanDirs(gitDir) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			path := filepath.Join(dir, e.Name())
			data, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			var c Claim
			if err := json.Unmarshal(data, &c); err != nil || c.InstanceID == "" {
				continue
			}
			if c.InstanceID == selfInstanceID {
				continue
			}
			if now.Sub(c.UpdatedAt) > StaleAfter {
				_ = os.Remove(path)
				continue
			}
			peers = append(peers, Peer{InstanceID: c.InstanceID, Port: c.Port, StartedAt: c.StartedAt})
		}
	}
	return peers, nil
}

// ListClaims 只读列举 gitdir 内全部合法 claim（含本实例自己的与残留的）——
// 实例族总览（P-20261003-56）的聚合数据源。与 ScanGitDir 的分工：那是冲突
// 检测语义（跳过自己 + 惰性清残留，读路径带清理副作用）；族表需要完整快照
// （残留要显死态给用户手动清理，不能被读取顺手删掉），故独立只读口，
// 互不取代。损坏文件跳过不清理（可能正被并发写，同 ScanGitDir 口径）
func ListClaims(gitDir string) ([]Claim, error) {
	var out []Claim
	for _, dir := range claimScanDirs(gitDir) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				continue
			}
			var c Claim
			if err := json.Unmarshal(data, &c); err != nil || c.InstanceID == "" {
				continue
			}
			out = append(out, c)
		}
	}
	return out, nil
}

// RemoveClaim 移除某实例在某 gitdir 的 claim（退出/项目移除清理、族表残留
// 清理）；文件不存在视为已清理。对 claimScanDirs 全目录清：扫描面（ListClaims/
// ScanGitDir）对新旧命名空间取并集，聚合得出的残留 claim 必须清得掉——只删
// 新目录会让旧命名空间的死实例残留在族表上永远清不掉（清理口与扫描面同源）
func RemoveClaim(gitDir, instanceID string) error {
	if gitDir == "" || instanceID == "" {
		return nil
	}
	for _, dir := range claimScanDirs(gitDir) {
		err := os.Remove(filepath.Join(dir, instanceID+".json"))
		if err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// InstanceID 数据目录级持久实例身份：首个需要 claim 的时刻生成并落
// <dataDir>/instance-id，此后重启复用同一身份——崩溃重启后本实例重写
// 自己的旧 claim 文件（同名覆盖），不会把自己上一世的残留幻报成他实例。
// 跨实例冲突判定依赖「不同数据目录 ≠ 同一身份」：两个实例各自生成，
// 天然不同
func InstanceID(dataDir string) (string, error) {
	path := filepath.Join(dataDir, "instance-id")
	if data, err := os.ReadFile(path); err == nil {
		if id := strings.TrimSpace(string(data)); id != "" {
			return id, nil
		}
	}
	id := uuid.New().String()
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(id), 0o644); err != nil {
		return "", err
	}
	return id, nil
}
