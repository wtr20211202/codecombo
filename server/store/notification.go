package store

import (
	"encoding/json"
	"sort"
	"sync"
	"time"

	"codecombo/server/config"
	"codecombo/server/notification"

	"github.com/google/uuid"
)

// NotificationStore 通知存储——基于 DocumentStore
type NotificationStore interface {
	List(limit int) []notification.Notification
	Add(n notification.Notification)
	MarkAllRead()
	MarkRead(id string)
	Dismiss(id string)
	DismissMany(ids []string)
	Clear()
	// Snooze 稍后提醒（P-20261003-36）：给条目打 SnoozeUntil 标记，until 零值
	// = 取消延后（恢复原位次与原已读态）。条目不存在返回 false
	Snooze(id string, until time.Time) bool
	// RemountDue 到期重挂巡检：SnoozeUntil 非空且已到点的条目清标记、置未读、
	// 时间戳前移到 now（列表按时间倒序 → 重挂即置顶），返回本巡检轮重挂的
	// 条目供调用方经 /ws/notifications 广播 snoozeDue。无到期条目零写盘
	RemountDue(now time.Time) []notification.Notification
	GetPrefs() notification.Prefs
	SavePrefs(p notification.Prefs) error
	// MigrateLegacyWebhookURL 存量明文 webhook URL 启动期重加密落盘
	//（P-20261002-31；组合根启动期调用一次，读路径保持只读——车道纪律）
	MigrateLegacyWebhookURL() (int, error)
}

type notificationRepo struct {
	doc   DocumentStore
	prefs notification.Prefs
	// out 出站广播口：Add 落库后经组合根装配发布到事件总线（可为 nil，单测环境）
	out func(n notification.Notification)

	// listCache List 的 3s TTL 读缓存：前端 App 启动与每次实例切换都调
	// /api/notifications，无缓存时每次是全目录 N+1 文件读 + 反序列化（通知目录
	// 近 200 条时即 200 次读）。任何写操作置空缓存，TTL 窗口内的陈旧与
	// projectRepo/instanceRepo 的读缓存同级
	mu      sync.RWMutex
	cache   []notification.Notification
	cacheAt time.Time
}

const notificationListTTL = 3 * time.Second

// notificationMax 通知条目上限（与前端通知中心 200 条封顶一致）：Add 后裁剪
// 最旧条目，防止长运行实例的通知文件无界累积（List 为全目录读取，条目越多
// 越慢）
const notificationMax = 200

// listCached 带缓存的 List 主体（limit=0 表示全量，供缓存复用）
func (r *notificationRepo) listCached() []notification.Notification {
	r.mu.RLock()
	if r.cache != nil && time.Since(r.cacheAt) < notificationListTTL {
		out := r.cache
		r.mu.RUnlock()
		return out
	}
	r.mu.RUnlock()

	keys, _, _ := r.doc.List("notifications", ListOpts{})
	result := make([]notification.Notification, 0, len(keys))
	for _, key := range keys {
		data, _ := r.doc.Get("notifications", key)
		var n notification.Notification
		if json.Unmarshal(data, &n) == nil {
			result = append(result, n)
		}
	}
	// 按时间降序（最新的在前），与旧实现一致
	sort.Slice(result, func(i, j int) bool { return result[i].Time.After(result[j].Time) })

	// 惰性修剪：保留最近 200 条，删除多余的
	if len(result) > 200 {
		for _, n := range result[200:] {
			_ = r.doc.Delete("notifications", n.ID)
		}
		result = result[:200]
	}

	r.mu.Lock()
	r.cache = result
	r.cacheAt = time.Now()
	r.mu.Unlock()
	return result
}

// invalidateCache 任何写操作后调用（置空即可，下次 List 重建）
func (r *notificationRepo) invalidateCache() {
	r.mu.Lock()
	r.cache = nil
	r.mu.Unlock()
}

func (r *notificationRepo) List(limit int) []notification.Notification {
	result := r.listCached()
	if limit > 0 && len(result) > limit {
		result = result[:limit]
	}
	return result
}

func (r *notificationRepo) Add(n notification.Notification) {
	// 检查类别偏好与项目静音（P-20261003-168）：类别开关 AND 项目×类别二维
	// 静音——任一命中即不入账（同点判定，站内/WS 广播/webhook 外发一并静默，
	// 后续消费方都只见已入账条目）
	prefs := r.GetPrefs()
	if !prefs.IsEnabled(n.Category) || prefs.IsProjectMuted(n.ProjectID, n.Category) {
		return
	}

	if n.ID == "" {
		n.ID = uuid.New().String()
	}
	if n.Time.IsZero() {
		n.Time = time.Now()
	}
	data, _ := json.Marshal(n)
	_ = r.doc.Create("notifications", n.ID, data)
	// 通知为有界资源：每次 Add 后裁剪到上限（前端通知中心同为 200 条封顶）。
	// trimOldest 此前从未被调用——长运行实例的通知文件无界累积，且 List 为
	// 全目录读取，条目越多 GET /api/notifications 越慢
	r.trimOldest("notifications", notificationMax)
	r.invalidateCache()

	// 出站广播：经组合根装配的口发布到事件总线（notify 模块订阅后桥回 WS）；
	// 未装配（单测）时静默跳过
	if r.out != nil {
		r.out(n)
	}
}

// trimOldest 保留最近 limit 条记录，按 Time 字段排序删除最早的
func (r *notificationRepo) trimOldest(kind string, limit int) {
	keys, total, _ := r.doc.List(kind, ListOpts{})
	if total <= limit {
		return
	}
	type item struct {
		key  string
		time time.Time
	}
	items := make([]item, 0, len(keys))
	for _, key := range keys {
		data, err := r.doc.Get(kind, key)
		if err != nil {
			continue
		}
		var n notification.Notification
		if json.Unmarshal(data, &n) != nil {
			continue
		}
		items = append(items, item{key: key, time: n.Time})
	}
	// 按时间升序，最早的在前面
	sort.Slice(items, func(i, j int) bool { return items[i].time.Before(items[j].time) })
	// 删除最早的
	for i := 0; i < len(items)-limit; i++ {
		_ = r.doc.Delete(kind, items[i].key)
	}
}

func (r *notificationRepo) MarkAllRead() {
	keys, _, _ := r.doc.List("notifications", ListOpts{})
	patches := make(map[string]map[string]any, len(keys))
	for _, key := range keys {
		data, err := r.doc.Get("notifications", key)
		if err != nil {
			continue
		}
		var n notification.Notification
		if json.Unmarshal(data, &n) != nil || n.Read {
			continue
		}
		patches[key] = map[string]any{"read": true}
	}
	if len(patches) > 0 {
		_ = r.doc.PatchBatch("notifications", patches)
		r.invalidateCache()
	}
}

func (r *notificationRepo) MarkRead(id string) {
	_ = r.doc.Patch("notifications", id, map[string]any{"read": true})
	r.invalidateCache()
}

func (r *notificationRepo) Dismiss(id string) {
	_ = r.doc.Delete("notifications", id)
	r.invalidateCache()
}

// DismissMany 批量移除：通知中心同类聚合后一键清除整组（重复通知可上百条，
// 逐条 dismiss 会打上百个请求）。一次失效缓存即可
func (r *notificationRepo) DismissMany(ids []string) {
	for _, id := range ids {
		_ = r.doc.Delete("notifications", id)
	}
	r.invalidateCache()
}

func (r *notificationRepo) Clear() {
	_ = r.doc.Clear("notifications")
	r.invalidateCache()
}

// Snooze 稍后提醒打标/取消（P-20261003-36）：读改写整条记录而非 Patch——
// until 零值要「清字段」而 Patch 只能覆写键值，指针 nil 语义经整记录往返最直白。
// 只动 SnoozeUntil，其余字段（含原 Read 态）原样保留：取消延后即恢复原状
func (r *notificationRepo) Snooze(id string, until time.Time) bool {
	data, err := r.doc.Get("notifications", id)
	if err != nil {
		return false
	}
	var n notification.Notification
	if json.Unmarshal(data, &n) != nil {
		return false
	}
	if until.IsZero() {
		n.SnoozeUntil = nil
	} else {
		n.SnoozeUntil = &until
	}
	out, err := json.Marshal(n)
	if err != nil {
		return false
	}
	if r.doc.Update("notifications", id, out) != nil {
		return false
	}
	r.invalidateCache()
	return true
}

// RemountDue 到期重挂巡检（P-20261003-36，notify 模块分钟 ticker 调用）：
// 候选经 3s TTL 缓存粗筛（绝大多数轮次零候选零写盘），命中者逐条重 Get 最新
// 记录再判定——粗筛到改写之间用户可能刚重新 Snooze（缓存还停在旧到期时刻），
// 以陈旧副本为底整记录改写会把新到期时刻抹掉、条目立刻重挂，重 Get 消除该竞态
func (r *notificationRepo) RemountDue(now time.Time) []notification.Notification {
	var due []string
	for _, n := range r.listCached() {
		if n.SnoozeUntil == nil || n.SnoozeUntil.After(now) {
			continue // 未延后 / 延后中未到点
		}
		due = append(due, n.ID)
	}
	if len(due) == 0 {
		return nil
	}
	remounted := make([]notification.Notification, 0, len(due))
	for _, id := range due {
		data, err := r.doc.Get("notifications", id)
		if err != nil {
			continue
		}
		var n notification.Notification
		// 以最新记录为准：取消（标记清空）或重新延后到未来（粗筛后用户又
		// Snooze 了更晚时刻）都回避本轮，只有仍到期才重挂
		if json.Unmarshal(data, &n) != nil || n.SnoozeUntil == nil || n.SnoozeUntil.After(now) {
			continue
		}
		n.SnoozeUntil = nil
		n.Read = false
		n.Time = now
		out, err := json.Marshal(n)
		if err != nil {
			continue
		}
		if r.doc.Update("notifications", id, out) != nil {
			continue
		}
		remounted = append(remounted, n)
	}
	if len(remounted) > 0 {
		r.invalidateCache()
	}
	return remounted
}

func (r *notificationRepo) GetPrefs() notification.Prefs {
	if r.prefs.Enabled != nil {
		return r.prefs
	}
	// 从 DocumentStore 加载持久化偏好
	data, err := r.doc.Get("notifprefs", "default")
	if err == nil {
		var stored notification.Prefs
		if json.Unmarshal(data, &stored) == nil {
			// webhook URL 含推送密钥：存储态 enc: 加密，内存/API 态明文
			//（历史明文 URL 由 DecryptIfNeeded 原样兼容，启动期迁移补加密）
			stored.Webhook.URL = config.DecryptIfNeeded(stored.Webhook.URL)
			r.prefs = stored
			return r.prefs
		}
	}
	r.prefs = notification.DefaultPrefs()
	return r.prefs
}

func (r *notificationRepo) SavePrefs(p notification.Prefs) error {
	r.prefs = p
	// 落盘前加密 webhook URL；内存缓存保持明文（API 回读与转发器都用明文）
	stored := p
	stored.Webhook.URL = config.EncryptIfNeeded(p.Webhook.URL)
	data, _ := json.Marshal(stored)
	return r.doc.Upsert("notifprefs", "default", data)
}

// MigrateLegacyWebhookURL 存量明文 webhook URL 启动期重加密（同 sshkey
// MigrateLegacyPem 模式：迁移类写盘副作用只在启动期发生）。幂等：已加密/
// 为空时不动。直接操作文档，不经 GetPrefs 缓存
func (r *notificationRepo) MigrateLegacyWebhookURL() (int, error) {
	data, err := r.doc.Get("notifprefs", "default")
	if err != nil {
		return 0, nil // 无存量偏好即无迁移
	}
	var stored notification.Prefs
	if json.Unmarshal(data, &stored) != nil {
		return 0, nil
	}
	if stored.Webhook.URL == "" || config.IsEncrypted(stored.Webhook.URL) {
		return 0, nil
	}
	enc := config.EncryptIfNeeded(stored.Webhook.URL)
	if enc == stored.Webhook.URL {
		return 0, nil // 加密失败原样返回，不写半态
	}
	stored.Webhook.URL = enc
	out, _ := json.Marshal(stored)
	if err := r.doc.Update("notifprefs", "default", out); err != nil {
		return 0, err
	}
	return 1, nil
}
