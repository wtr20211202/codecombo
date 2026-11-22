package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"codecombo/server/config"
)

// ── kind=terminal 直播分享的 repo 面（体量守卫拆分，P-20261118-9） ──
//
// share.go 已超 1500 行体量守卫阈值（基线登记，只许减不许增）；本文件把
// 「终端直播」这一 kind 的专属 repo 方法整族迁出：创建（幂等重建/轮换感知）、
// token 派生键、按会话检索、会话改名级联。函数零丢失零改写（纯搬移）——
// 行为语义的权威注释随各自函数走。frozen/cast/session 快照族的创建与检索
// 仍在 share.go（createTermFrozen/createCast/createSession 等），勿在本文件
// 扩快照族——本文件只收「活流」语义的 terminal kind。

// createTerminal 终端只读直播分享（P-20261003-306）。与 snippet 同构的三点：
// 不绑项目文件系统（ProjectID/Path 清空，锚点是 TerminalID）、token 从会话
// ID 确定性派生（同一会话重复开直播得到同一短链，幂等重建不续期——倒计时
// 是安全边界）、默认 TTL 创建即定（TerminalLiveTTL 30 分钟，可显式覆盖，
// 上限 TerminalLiveTTLMax）。既有记录按 (kind, terminalId) 定位（轮换感知，
// createFile 的目标扫描同款）。Name 展示名由调用方给（缺省会话 ID 兜底）
//
// 永久挡（P-20261119-5，用户定向推翻「直播无永久档」旧决策）：terminal 的
// 零值 ExpiresAt 在本函数会被强补 30 分钟默认（与 createFile 的「零值=永久」
// 语义不同），故显式永久经 Share.Permanent 瞬态标记表达——置位时豁免默认补挂
// 与 24h 钳，落库即零值（记录与 token 不过期；直播态本身仍随会话：会话关闭
// 访客页「已结束」，tmux 跨重启恢复即复活）。未过滤记录的显式永久同样合法
// （【用户定向修订】2026-11-19：unfiltered+permanent 不再 400 硬禁，撤销兜底
// 即可）——Permanent 置位时一并豁免 clampUnfilteredExpiry（否则组合在 store
// 层被静默降级 24h、永久档形同虚设）；非显式路径维持既有钳制语义不变
func (r *shareRepo) createTerminal(s Share) (*Share, error) {
	if s.TerminalID == "" {
		return nil, fmt.Errorf("%w: terminal share requires terminalId", ErrInvalidArg)
	}
	s.ProjectID, s.Path, s.IsDir = "", "", false
	s.Paths = nil
	// 直播是持续流语义，与「看一眼即焚」相斥（P-20261006-27：创建面已拒绝，
	// 这里兜底清防未来调用方绕过 API 直入 store——一次性字段对直播无意义）
	s.ViewOnce, s.ViewedAt = false, time.Time{}
	// 开放直入创建面语义（P-20261121-1 统一收编修订）：请求显式携带 Writable=true
	// 即合法出生——创建弹层的访客输入快捷选择是 owner 显式 opt-in，与行内开关
	// 同闸（口令门强制在 API 面：无门记录必携 passphrase 补设，缺门 400——
	// 「可写从不悄悄出生」的实质是「不经 owner 显式选择不出现在请求里」，显式
	// 请求满足该实质；比旧「创建面一律清零」放宽一档，缺省不带字段 = false
	// 零变化）。其余 kind 的创建面兜底清不变（组合语义：可写仅 live 形态）
	if s.Name == "" {
		s.Name = s.TerminalID
	}
	if s.Permanent {
		// 显式永久：零值即永不过期，跳过默认补挂与 24h 钳，也未过滤记录一并
		// 豁免下方 clampUnfilteredExpiry（【用户定向修订】2026-11-19：显式
		// 选择=用户意志+撤销兜底；Store 层唯一的「零值≠默认」豁免点）
		s.ExpiresAt = time.Time{}
	} else {
		if s.ExpiresAt.IsZero() {
			s.ExpiresAt = time.Now().Add(TerminalLiveTTL)
		}
		if d := time.Until(s.ExpiresAt); d > TerminalLiveTTLMax {
			s.ExpiresAt = time.Now().Add(TerminalLiveTTLMax)
		}
		// 未过滤直播（P-20261106-9）独立钳制：与 TerminalLiveTTLMax 当前同值，
		// 但不随直播上限未来放宽而放宽——原样暴露的上限是独立安全边界。
		// 仅非显式路径走到这里（显式永久已上方返回零值，不再静默降级）
		clampUnfilteredExpiry(&s)
	}
	if old := r.findTerminalBySession(s.TerminalID); old != nil {
		if !old.Expired(time.Now()) {
			// 幂等命中：请求带新口令哈希 = 主动加/改门，覆写生效（与 snippet
			// 同款；不带 = 保持既有口令）；watermark 同为可变展示设置，请求值
			// 覆写（管理面缺省传 true——不带该字段的重建回到缺省开基线）。
			// Unfiltered 刻意不覆写（P-20261106-9 创建时定死）：已分发直播链
			// 的遮蔽语义不可在访客不知情下翻转，改配置须撤销重建——调用方按
			// 返回记录（非请求值）接线馈线，生效配置单一事实源在记录
			changed := false
			if s.PassphraseHash != "" && s.PassphraseHash != old.PassphraseHash {
				old.PassphraseHash = s.PassphraseHash
				changed = true
			}
			if s.Watermark != old.Watermark {
				old.Watermark = s.Watermark
				changed = true
			}
			if changed {
				if data, err := json.Marshal(*old); err == nil {
					_ = r.doc.Update(shareKind, old.Token, data)
				}
			}
			return old, nil
		}
		// 命中已过期但未被清理 ticker 扫走的记录：删旧重建（新时钟周期，
		// 落回零代际 token）——snippet 同款，不给过期直播借尸还魂
		_ = r.doc.Delete(shareKind, old.Token)
	}
	s.Token = DeriveShareToken(config.MasterKey(), terminalTokenNamespace, terminalTokenKey(&s), 0)
	if s.CreatedAt.IsZero() {
		s.CreatedAt = time.Now()
	}
	data, err := json.Marshal(s)
	if err != nil {
		return nil, fmt.Errorf("marshal share: %w", err)
	}
	if err := r.doc.Create(shareKind, s.Token, data); err != nil {
		return nil, err
	}
	return &s, nil
}

// terminalTokenKey 终端直播 token 派生键（创建/轮换/幂等重建三处同源，
// P-20261106-9）：遮蔽直播 = 会话 ID 原值（存量短链零变化）；未过滤直播追加
// terminalUnfilteredKeySuffix——两模式恒不同链
func terminalTokenKey(s *Share) string {
	if s.Unfiltered {
		return s.TerminalID + terminalUnfilteredKeySuffix
	}
	return s.TerminalID
}

// findTerminalBySession 按 (kind=terminal, TerminalID) 定位存活直播记录
// （轮换感知的 get-or-create 定位；按 token 找会漏掉已轮换记录）。刻意不按
// 遮蔽模式区分：一个会话同一时刻至多一条直播（主播侧徽标/「结束直播」一键
// 撤销都以会话为单位），模式不同的重复请求命中既有记录（创建时定死）
func (r *shareRepo) findTerminalBySession(terminalID string) *Share {
	shares, err := r.List()
	if err != nil {
		return nil
	}
	for i := range shares {
		if shares[i].Kind == ShareKindTerminal && shares[i].TerminalID == terminalID {
			return &shares[i]
		}
	}
	return nil
}

// RenameTerminalShares 终端会话重命名的分享侧级联（P-20261118-9）：把该会话
// 的直播分享记录展示名同步为会话新名——分享记录 Name 是创建时的会话名快照
// （handlers.go 创建链 `Name: sess.Name`），此前改名不级联，访客页标题与管理
// 面分享名永久滞留旧名。只级联 kind=terminal 的直播记录（frozen/cast/session
// 快照族不碰——定格语义，展示名本就是创建时点的一部分）。执行面循
// findTerminalBySession 的 List 自遍历先例（「一个会话同一时刻至多一条直播」
// 不变量下批量面至多 1 条，全量遍历开销与该先例同量级）；逐条 RMW
// （Get→覆写→Update，SetCollab 同款）。终态语义：
//   - 记录不存在/已过期/写入间隙被撤销 → 跳过不报错（良性竞态：撤销/过期
//     即死亡，名字无从谈起，ErrNotFound 跳过即正确态）
//   - 其余写失败（存储故障）→ 返回首个错误（rename 主流程尽力而为，不阻断）
func (r *shareRepo) RenameTerminalShares(terminalID, name string) error {
	shares, err := r.List()
	if err != nil {
		return err
	}
	var firstErr error
	for i := range shares {
		s := &shares[i]
		if s.Kind != ShareKindTerminal || s.TerminalID != terminalID || s.Name == name {
			continue
		}
		cur, err := r.Get(s.Token)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				continue // 写入间隙被撤销/过期清账：跳过即正确态
			}
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if cur.Expired(time.Now()) {
			continue
		}
		if cur.Name == name {
			continue
		}
		cur.Name = name
		data, merr := json.Marshal(cur)
		if merr != nil {
			if firstErr == nil {
				firstErr = merr
			}
			continue
		}
		if uerr := r.doc.Update(shareKind, cur.Token, data); uerr != nil {
			if errors.Is(uerr, ErrNotFound) {
				continue // 写入间隙被撤销：同上，跳过即正确态
			}
			if firstErr == nil {
				firstErr = uerr
			}
		}
	}
	return firstErr
}
