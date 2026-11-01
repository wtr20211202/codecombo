package store

// 分享访客留言附表（P-20261006-13）：分享访客页的轻量双向回流——访客附言
// 落库，主人侧管理器聚合可见（只读回流，回复是 IM 的活，不做聊天）。
//
// 车道 1 结构化状态（每条留言一文档，禁止单文档装整个数组）。生命周期与
// 分享一体：**随分享撤销/过期级联删除**（shareRepo.Delete/CleanupExpired
// 收口）+ 短链轮换迁键（Rotate 后留言跟记录走）+ 孤儿对账兜底（崩溃窗口
// 残留由 GCOrphans 清算，带宽限期防与在途轮换/级联竞态）。每 token 条数
// 封顶即保留策略（append 型 kind 的保留纪律）——留言是「看完就处理」的
// 协作瞬态，不是档案柜。

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"
)

const (
	// shareMsgKind DocumentStore kind（一留言一文档）
	shareMsgKind = "sharemsgs"

	// ShareMsgMaxPerToken 单条分享的留言条数上限（保留策略）：普通协作量级
	// 十条以内，50 条封顶防垃圾灌水把附表撑成无界增长；超限逐最旧裁剪
	ShareMsgMaxPerToken = 50

	// MaxShareMessageRunes 单条留言文本的 rune 上限（提案口径「≤500 字」）：
	// 附言是一次性提问/反馈不是论坛帖，限长即防灌水的第一道闸（写入侧
	// 访客服务与管理面共用此表）
	MaxShareMessageRunes = 500

	// MaxShareNicknameRunes 访客自报昵称的 rune 上限（可选字段，短昵称即可）
	MaxShareNicknameRunes = 24

	// MaxShareMessageCollabRunes 协作通道开启（Share.Collab，P-20261024-1）
	// 时单条留言的 rune 上限：500→2000——贴错误日志/栈帧/配置段是测试协作的
	// 主场景，500 rune 装不下一段报错现场；频控沿用（垃圾载荷不消耗配额），
	// 限长翻倍只放宽「一次说清楚」的空间。缺省关 = 存量分享沿用 500（零迁移）
	MaxShareMessageCollabRunes = 2000
)

// ShareMessage 一条访客留言。Text 存原文（上限内），渲染面（访客页
// textContent / 管理面板 Vue 插值）两侧都是转义渲染——存储态零 HTML，
// 不存在注入面
type ShareMessage struct {
	ID string `json:"id"`
	// Token 所属分享短链（冗余落库：键内也含 token 前缀，字段供消费方
	// 直读与轮换迁键时改写）
	Token string `json:"token"`
	// Nickname 访客自报昵称（可选；空 = 匿名）。控制字符由写入侧清洗
	Nickname string `json:"nickname,omitempty"`
	Text     string `json:"text"`
	// CreatedAt 留言时点（管理面板/访客页展示排序依据；键内时间戳与之一致，
	// 键序即时序）
	CreatedAt time.Time `json:"createdAt"`
}

// ShareMessageStore 分享访客留言附表（token 键，生命周期随分享）。
// 未知/已撤销/已过期的分享 → ErrNotFound（留言不得借死链还魂——写入与
// 清账竞态时以分享记录存活为准）
type ShareMessageStore interface {
	// Add 追加一条留言（每条都是新文档，无幂等语义）。条数超
	// ShareMsgMaxPerToken 时逐最旧裁剪并同步分享记录计数
	Add(token, nickname, text string, now time.Time) (*ShareMessage, error)
	// List 按新到旧返回该分享的留言，至多 limit 条（limit ≤ 0 = 全量，
	// 总量仍受 ShareMsgMaxPerToken 约束）
	List(token string, limit int) ([]ShareMessage, error)
	// Delete 主人单删一条（id 不属于该 token → ErrNotFound）
	Delete(token, id string) error
	// Clear 清空该分享全部留言，返回删除条数
	Clear(token string) (int, error)
	// GCOrphans 孤儿对账兜底（装配层巡检调用）：删除「token 不再对应存活
	// 分享」且超过宽限期的留言（级联删除/轮换迁键崩溃窗口的残留清算）。
	// isLive 注入存活判定（只有分享记录有发言权），返回清理条数
	GCOrphans(isLive func(token string) bool, now time.Time) (int, error)
}

type shareMsgRepo struct {
	doc DocumentStore
	// shares 分享记录读写（同包装配：存活校验与计数 RMW 都落在这里，
	// 不经全局 Store——repo 只认构造注入的协作对象）
	shares *shareRepo
}

func newShareMsgRepo(doc DocumentStore, shares *shareRepo) *shareMsgRepo {
	return &shareMsgRepo{doc: doc, shares: shares}
}

// msgKey 文档键 = token + "-" + id。token 是 base36 固长 16（无分隔符歧义），
// id 首段是 19 位量级的 UnixNano（字典序 = 时间序），尾段 4 位随机防同
// 纳秒碰撞。filestore 键黑名单（/\:、点前缀、..）全不沾
func msgKey(token, id string) string { return token + "-" + id }

// newMsgID 时序 id：UnixNano（2262 年前恒定 19 位）+ "-" + 4 位 base36 随机
// 尾。键序即时序是 List 免排序读取的基础，勿改为变长时间戳
func newMsgID(now time.Time) string {
	var buf [4]byte
	_, _ = rand.Read(buf[:])
	suffix := new(big.Int).SetBytes(buf[:]).Text(36)
	if len(suffix) < 4 {
		suffix = strings.Repeat("0", 4-len(suffix)) + suffix
	}
	return strconv.FormatInt(now.UnixNano(), 10) + "-" + suffix
}

// Add 追加留言。写入顺序：分享存活校验 → 建留言文档 → 裁剪 → RMW 分享记录
// 计数。计数随最后一次写对齐（含裁剪后的真实存量）——访客 POST 是低频写，
// 与管理面低频写共享 RMW 间隙的既有取舍（RecordHits 同款债务，不新增面）
func (r *shareMsgRepo) Add(token, nickname, text string, now time.Time) (*ShareMessage, error) {
	if token == "" {
		return nil, fmt.Errorf("%w: share message requires token", ErrInvalidArg)
	}
	sh, err := r.liveShare(token)
	if err != nil {
		return nil, err
	}
	msg := &ShareMessage{
		ID:        newMsgID(now),
		Token:     token,
		Nickname:  nickname,
		Text:      text,
		CreatedAt: now,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("marshal share message: %w", err)
	}
	if err := r.doc.Create(shareMsgKind, msgKey(token, msg.ID), data); err != nil {
		return nil, err
	}
	r.setCount(sh, r.trim(token))
	return msg, nil
}

// List 该分享的留言（新到旧）。与写路径同口径的存活前置——未知/已撤销/
// 已过期 → ErrNotFound（死链没有可列的留言面）。键序为时间正序，倒排输出
// 与计数消费方（管理面板/通知摘要）的「最新在前」直觉一致
func (r *shareMsgRepo) List(token string, limit int) ([]ShareMessage, error) {
	if _, err := r.liveShare(token); err != nil {
		return nil, err
	}
	keys, err := r.keys(token)
	if err != nil {
		return nil, err
	}
	out := make([]ShareMessage, 0, len(keys))
	for i := len(keys) - 1; i >= 0; i-- {
		data, err := r.doc.Get(shareMsgKind, keys[i])
		if err != nil {
			continue
		}
		var m ShareMessage
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		out = append(out, m)
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out, nil
}

// Delete 主人单删。id 非空即键内段（键前缀已锚定 token，无跨分享指认面）
func (r *shareMsgRepo) Delete(token, id string) error {
	if id == "" {
		return fmt.Errorf("%w: invalid message id", ErrInvalidArg)
	}
	sh, err := r.liveShare(token)
	if err != nil {
		return err
	}
	if err := r.doc.Delete(shareMsgKind, msgKey(token, id)); err != nil {
		return err
	}
	r.decCount(sh)
	return nil
}

// Clear 清空该分享全部留言（主人侧一键清账），返回删除条数。计数投影
// 同步归零（删除与计数同一次写语义，角标不留「幽灵 N」）
func (r *shareMsgRepo) Clear(token string) (int, error) {
	sh, err := r.liveShare(token)
	if err != nil {
		return 0, err
	}
	removed, err := r.deleteAll(token)
	if err != nil {
		return removed, err
	}
	r.setCount(sh, 0)
	return removed, nil
}

// ── 生命周期级联（shareRepo 调用；不校验分享存活——调用点即分享消亡点） ──

// deleteAll 删除某 token 名下全部留言文档，返回删除条数。级联删除与清账
// 共用：失败逐条跳过（孤儿对账兜底，绝不阻断分享撤销主流程）
func (r *shareMsgRepo) deleteAll(token string) (int, error) {
	keys, err := r.keys(token)
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, k := range keys {
		if r.doc.Delete(shareMsgKind, k) == nil {
			removed++
		}
	}
	return removed, nil
}

// migrateToken 短链轮换迁键（Rotate 后留言跟记录走）：id 不变、键与记录
// 内 Token 字段改写。先建后删（建失败留旧键由孤儿对账兜底，绝不丢留言）
func (r *shareMsgRepo) migrateToken(oldToken, newToken string) {
	keys, err := r.keys(oldToken)
	if err != nil {
		return
	}
	for _, k := range keys {
		id := strings.TrimPrefix(k, oldToken+"-")
		data, err := r.doc.Get(shareMsgKind, k)
		if err != nil {
			continue
		}
		var m ShareMessage
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		m.Token = newToken
		nd, err := json.Marshal(m)
		if err != nil {
			continue
		}
		if r.doc.Create(shareMsgKind, msgKey(newToken, id), nd) != nil {
			continue
		}
		_ = r.doc.Delete(shareMsgKind, k)
	}
}

// gcMsgOrphansGrace 孤儿对账宽限期：级联删除与轮换迁键都是「分享键变更 +
// 留言键跟进」的两段写，崩溃窗口会留下短暂孤儿。宽限期内不清算——防把
// 在途迁移的中间态误删（丢访客留言）；过期孤儿由下一轮巡检收走
const gcMsgOrphansGrace = time.Hour

// GCOrphans 孤儿对账兜底：删除「token 不再对应存活分享」且超过宽限期的
// 留言。isLive 由装配层注入（存活的判定只有分享记录本身有发言权）。
// 返回清理条数；List 失败直接返回（不清账——keep 集不可信宁可不删）
func (r *shareMsgRepo) GCOrphans(isLive func(token string) bool, now time.Time) (int, error) {
	keys, _, err := r.doc.List(shareMsgKind, ListOpts{})
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, k := range keys {
		dash := strings.IndexByte(k, '-')
		if dash <= 0 {
			continue
		}
		token := k[:dash]
		if isLive(token) {
			continue
		}
		data, err := r.doc.Get(shareMsgKind, k)
		if err != nil {
			continue
		}
		var m ShareMessage
		if json.Unmarshal(data, &m) != nil || m.CreatedAt.IsZero() {
			// 解析不出时点的文档无法判宽限期：跳过留观，不盲删
			continue
		}
		if now.Sub(m.CreatedAt) < gcMsgOrphansGrace {
			continue
		}
		if r.doc.Delete(shareMsgKind, k) == nil {
			removed++
		}
	}
	return removed, nil
}

// ── 内部工具 ──

// SeedShareMessageForTest 直插一条留言文档（仅测试：伪造孤儿/超宽限态——
// 正常写入必须走 Add 的存活校验与时钟，本入口绕过两者以便对账测试构造
// 「分享键已消亡、留言残留」的崩溃窗口中间态）
func SeedShareMessageForTest(doc DocumentStore, m *ShareMessage) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return newShareMsgRepo(doc, nil).doc.Create(shareMsgKind, msgKey(m.Token, m.ID), data)
}

// keys 该 token 名下的留言键（字典升序 = 时间正序）
func (r *shareMsgRepo) keys(token string) ([]string, error) {
	keys, _, err := r.doc.List(shareMsgKind, ListOpts{Prefix: token + "-"})
	if err != nil {
		return nil, err
	}
	return keys, nil
}

// trim 条数裁剪（保留策略）：超 ShareMsgMaxPerToken 逐最旧删除，返回裁剪
// 后存量。调用点在 Add 建档之后——总有一条新增进账
func (r *shareMsgRepo) trim(token string) int {
	keys, err := r.keys(token)
	if err != nil {
		return 0
	}
	excess := len(keys) - ShareMsgMaxPerToken
	for i := 0; i < excess; i++ {
		_ = r.doc.Delete(shareMsgKind, keys[i])
	}
	if excess > 0 {
		return len(keys) - excess
	}
	return len(keys)
}

// liveShare 分享记录存活校验（写入/删除/清空的前置）：不存在/已过期一律
// ErrNotFound——过期未及清账的记录对访客面已死亡（lookup 同口径），不接受
// 借尸还魂
func (r *shareMsgRepo) liveShare(token string) (*Share, error) {
	sh, err := r.shares.getLive(token)
	if err != nil {
		return nil, ErrNotFound
	}
	return sh, nil
}

// setCount / decCount 分享记录上的留言计数 RMW（管理列表「留言 N」角标的
// O(1) 数据源——列表响应不再逐分享扫附表）。记录已消亡时静默跳过（级联
// 竞态窗口内计数无消费方）
func (r *shareMsgRepo) setCount(sh *Share, n int) { r.writeCount(sh, n) }

func (r *shareMsgRepo) decCount(sh *Share) {
	n := sh.MessageCount - 1
	if n < 0 {
		n = 0
	}
	r.writeCount(sh, n)
}

func (r *shareMsgRepo) writeCount(sh *Share, n int) {
	if sh.MessageCount == n {
		return
	}
	sh.MessageCount = n
	if data, err := json.Marshal(sh); err == nil {
		_ = r.doc.Update(shareKind, sh.Token, data)
	}
}
