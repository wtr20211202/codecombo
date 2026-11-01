// 损坏文档统一隔离语义（P-20261004-76）：file-per-doc JSON 架构天然抗损
// （单文档爆炸半径），但损坏处置历史上语义不一——List Match 填充静默跳过、
// Patch/patchFile 把解析错误原样上抛、Get 返回的坏字节由各 Repo 自行回落
// （默认值/空对象/报错），损坏文件永留原地、每次命中重付解析失败且无迹可循。
//
// 统一语义：读到非法 JSON 内容 → 改名 <name>.corrupt-<纳秒时间戳> 留证 +
// slog.Warn → 调用方统一走既有 not-found 回落；下一次写覆盖式重建新文档
// （写路径既有语义零改动：Update 只看存在性、Create 看到隔离后的空位）。
//
// 降级：改名失败（只读目录 / Windows 杀软或索引器占用——重试一次后仍失败）
// 仅 Warn 不阻断读，调用方拿到的行为与改动前完全一致——宁可原地重复踩错，
// 也不因隔离失败丢数据。
//
// 红线豁免说明：这是「读路径禁止写盘副作用」的显式例外——隔离不是迁移
// （不转换数据、无格式升级、单次幂等、失败可退化），属存储层自愈，
// 已在 CLAUDE.md 持久化三车道节与 docs/PERSISTENCE_LANES.md 检查清单登记。
package filestore

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"time"
)

// corruptSuffix 隔离文件后缀（后接纳秒时间戳防同秒碰撞）。注意隔离名不得以
// .json 结尾，否则仍会被 List/Count 当作文档枚举出来
const corruptSuffix = ".corrupt-"

// renameCorrupt 改名留证（时间戳到纳秒，唯一命名无需存在性检查）。
// Windows 上杀软/索引器对刚关闭的文件短暂占用会令改名失败——50ms 后重试一次；
// 仍失败返回错误，由调用方决定降级（仅 Warn，不阻断读）
func (s *fileDocStore) renameCorrupt(path string) (string, error) {
	corrupt := path + corruptSuffix + time.Now().Format("20060102-150405.000000000")
	if err := os.Rename(path, corrupt); err != nil {
		time.Sleep(50 * time.Millisecond)
		if err = os.Rename(path, corrupt); err != nil {
			return "", err
		}
	}
	return corrupt, nil
}

// quarantineInPlace 写锁内就地隔离（Patch/PatchBatch 专用——调用方已持 kind
// 写锁与目录锁，文件内容即本临界区所读，无需重读双检）。成功返回 true。
func (s *fileDocStore) quarantineInPlace(kind, key, path, op string) bool {
	corrupt, err := s.renameCorrupt(path)
	if err != nil {
		slog.Warn("filestore: corrupt document rename failed, left in place", "kind", kind, "key", key, "op", op, "err", err)
		return false
	}
	slog.Warn("filestore: corrupt document quarantined", "kind", kind, "key", key, "op", op, "file", filepath.Base(corrupt))
	return true
}

// quarantineCorrupt 隔离单个损坏文档（Get 专用）：升写锁+目录锁后重读双检——
// 读（RLock）与隔离（写锁）之间并发写者可能已覆盖为新文档，只有仍然非法的
// 内容才允许改名，防误隔离刚写入的有效数据
func (s *fileDocStore) quarantineCorrupt(kind, key, op string) bool {
	mu := s.kindMu(kind)
	mu.Lock()
	defer mu.Unlock()
	defer s.lockKindDir(kind)()

	path, err := s.keyPath(kind, key)
	if err != nil {
		return false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false // 已消失（并发删除/隔离）——无事可做
	}
	if json.Valid(data) {
		return false // 并发写者已重建有效文档
	}
	return s.quarantineInPlace(kind, key, path, op)
}

// quarantineBatch 隔离一批损坏文档（List/GetBatch 专用）：扫描阶段持 RLock、
// 改名须写锁，故扫描完成后整批一次升锁。锁内逐个重读双检（同 quarantineCorrupt，
// 防误隔离并发写入的新文档）。全部命中只发一条汇总 Warn——通知/实例等列表接口
// 高频轮询，坏文档未隔离前每轮都命中，逐条 Warn 会刷屏。
// 返回成功隔离的 key 集合（调用方据此决定降级回填）。
func (s *fileDocStore) quarantineBatch(kind string, keys []string, op string) map[string]bool {
	mu := s.kindMu(kind)
	mu.Lock()
	defer mu.Unlock()
	defer s.lockKindDir(kind)()

	done := make(map[string]bool, len(keys))
	var quarantined []string
	for _, key := range keys {
		path, err := s.keyPath(kind, key)
		if err != nil {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			continue // 已消失
		}
		if json.Valid(data) {
			continue // 并发写者已重建
		}
		corrupt, err := s.renameCorrupt(path)
		if err != nil {
			slog.Warn("filestore: corrupt document rename failed, left in place", "kind", kind, "key", key, "op", op, "err", err)
			continue
		}
		done[key] = true
		quarantined = append(quarantined, key+"→"+filepath.Base(corrupt))
	}
	if len(quarantined) > 0 {
		slog.Warn("filestore: corrupt documents quarantined during scan", "kind", kind, "op", op, "keys", quarantined)
	}
	return done
}
