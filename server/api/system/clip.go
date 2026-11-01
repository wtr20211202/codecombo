package system

import (
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"codecombo/server/api/opschannel"
	shared "codecombo/server/api/shared"

	"github.com/gin-gonic/gin"
)

// 跨设备剪贴板中继（P-20261002-32）：本服务是自托管中心化服务，同一服务的
// 多端（PC / 平板浏览器）天然共享一个后端——「PC 复制 → 平板粘贴」不再需要
// 微信/邮件发给自己。形态：
//
//	POST /api/clip  {"content", "origin"?}  内容写入内存单槽（最新一条覆写旧条）
//	  → 成功即 opschannel 广播 clipboard.arrived（其他已解锁设备顶栏 toast 点击取走）
//	GET  /api/clip                          读取即焚：取走即清槽，防内容驻留
//
// 隐私三重缓解（内容常含密钥/口令）：内存不落盘（零车道占用）、TTL 5 分钟
// 到点自动清（timer + 读取侧双保险）、读取即焚（并发 GET 仅一个拿到内容）。
// 服务重启即清——语义本就是瞬态通道，可接受。鉴权沿全局 api 组中间件
//（LockMiddleware：仅解锁设备可读写）。
//
// 平台注记：纯内存字符串通道，无路径/进程/信号面，三平台行为一致。

const (
	// clipMaxBytes 内容字节上限（UTF-8）：剪贴板高频承载密钥/长命令，32KB
	// 覆盖「密钥/证书/长报错文本」主场景，同时给内存单槽一个硬上界。
	// 与前端 utils/clipRelay.ts 的 CLIP_MAX_BYTES 镜像，改一侧须同步另一侧
	clipMaxBytes = 32 * 1024
	// clipOriginMax 来源设备 id 上限（前端生成的随机 id，防御性截断防滥用）
	clipOriginMax = 128
	// clipBodyLimit 请求体解析上限：32KB 内容经 JSON 转义最坏可膨胀至 6 倍
	//（\uXXXX 形态），留足余量让解码后校验做权威拒绝，防畸形大包解析期占内存
	clipBodyLimit = 256 * 1024
)

// clipTTL 槽内存活时长，到点自动清。变量化供单测注入短时长
var clipTTL = 5 * time.Minute

// clipSlot 内存单槽：最新一条覆写旧条（多端共享「最近一次复制」的心智）。
// mutex 保护槽与 timer 的一致推进；timer 到点清槽是 TTL 的权威实现，
// GET 侧的过期复核仅作兜底。TTL 回调带写入代次号：回调闭包捕获自己那次
// 写入的 gen，执行时 gen 已变（内容被覆写）则放行不清——不依赖 timer.Reset
// 的版本语义，任何 Go 版本下陈旧回调都无害
type clipSlot struct {
	mu      sync.Mutex
	content string
	origin  string
	size    int
	at      time.Time
	gen     uint64
	timer   *time.Timer
}

var clip = clipSlot{}

type clipPostRequest struct {
	Content string `json:"content"`
	Origin  string `json:"origin"`
}

// PostClip POST /api/clip：内容写入单槽并广播 clipboard.arrived。
// 空内容拒绝（空串没有中继语义）；超限 413；成功响应只回 size 不回显内容
// （发送端手里本来就有内容，回显徒增泄露面）。
// 广播载荷只带 origin/size/at——内容留在槽内等取，不上广播面
func PostClip(c *gin.Context) {
	shared.LimitBody(c, clipBodyLimit)
	var req clipPostRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		if shared.BodyTooLarge(err) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "clip content too large"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	// 权威校验按解码后的 UTF-8 字节：MaxBytesReader 只能挡请求体膨胀形态，
	// 32KB 语义必须落在内容本身上（前端 TextEncoder 同口径）
	size := len(req.Content)
	if utf8.RuneCountInString(req.Content) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "content is required"})
		return
	}
	if size > clipMaxBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "clip content too large"})
		return
	}
	origin := strings.TrimSpace(req.Origin)
	if len(origin) > clipOriginMax {
		origin = origin[:clipOriginMax]
	}

	now := time.Now()
	clip.put(req.Content, origin, size, now)

	opschannel.BroadcastEvent(opschannel.EventClipboardArrived, gin.H{
		"origin": origin,
		"size":   size,
		"at":     now.UnixMilli(),
	})
	c.JSON(http.StatusOK, gin.H{"ok": true, "size": size})
}

// GetClip GET /api/clip：读取即焚——槽内容随响应清空，后续 GET 得 404。
// 404 语义 = 槽空/已过期/已被取走（前端按「内容已被取走或已过期」提示，
// 不走全局错误 toast）
func GetClip(c *gin.Context) {
	content, origin, size, at, ok := clip.take()
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "clipboard empty or expired"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"content": content,
		"origin":  origin,
		"size":    size,
		"at":      at.UnixMilli(),
	})
}

// put 写入单槽并重排 TTL timer（每次写入都重排——「最新一条再活 5 分钟」）
func (s *clipSlot) put(content, origin string, size int, at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.content = content
	s.origin = origin
	s.size = size
	s.at = at
	s.gen++
	if s.timer != nil {
		s.timer.Stop()
	}
	g := s.gen
	s.timer = time.AfterFunc(clipTTL, func() { s.expireGen(g) })
}

// take 取走即焚：内容返回给唯一命中的读者，槽即时清空
func (s *clipSlot) take() (content, origin string, size int, at time.Time, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.content == "" || time.Since(s.at) > clipTTL {
		return "", "", 0, time.Time{}, false
	}
	content, origin, size, at = s.content, s.origin, s.size, s.at
	s.content, s.origin, s.size = "", "", 0
	// 读取即焚后 TTL 已无意义，停掉 timer（若回调已在途，gen 校验使其空转）
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	return content, origin, size, at, true
}

// expireGen TTL 到点清槽（timer 回调；与 put/take 经 mutex 串行化）。
// gen 不匹配 = 内容已被更新或槽已清，本回调是陈旧调度，不动槽
func (s *clipSlot) expireGen(g uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.gen != g {
		return
	}
	s.content, s.origin, s.size = "", "", 0
	s.timer = nil
}
