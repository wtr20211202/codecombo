package share

// 分享访客留言板（P-20261006-13）：分享访客页底部的轻量双向回流——访客
// 附言落附表（store.ShareMessage，token 键、随分享撤销/过期级联删除），
// 主人侧管理器聚合可见（只读回流：回复是 IM 的活，不做聊天）。
//
// 出域面新增的写入端点，攻击面按提案收敛为四道防线：
//   - 限长：文本 ≤ store.MaxShareMessageRunes、昵称 ≤ store.MaxShareNicknameRunes，
//     请求体限幅（gateBodyLimit 同量级口径）；昵称控制字符清洗；
//   - 频控：middleware.RateLimiter 固定窗口双维度——(token, IP) 每分钟
//     guestMsgMaxPerIP 条防单点刷屏，token 全局每分钟 guestMsgMaxPerToken
//     条防多 IP 合围（口令门错口令限流同款复用）；
//   - 转义渲染：存储态零 HTML，访客页 textContent 写入、管理面板 Vue
//     插值转义——零注入面；
//   - 主人可单删/清空（管理面 DELETE 端点），垃圾内容有出清通道。
//
// 写路径纪律：留言本体必须同步落库（POST 的响应即持久化回执，不像计数
// 可攒批）；新留言的「通知中心入账」是副作用旁路——攒内存由装配层随既有
// 3s flush 批量入账（viewaudit.go 同款两段式），访客响应路径不背第二笔盘。

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/store"
)

const (
	// guestMsgBodyLimit 留言提交体读取上限：500 rune 文本 + 24 rune 昵称的
	// JSON 至多几 KB，16KiB 已是数十倍余量；上限防把写入端点当读体通道滥用
	guestMsgBodyLimit = 16 << 10

	// guestMsgMaxPerIP / guestMsgMaxPerToken 频控参数：每 (token, IP) 每分钟
	// 5 条（正常访客写一条 question 远够，刷屏即 429）；token 全局 30 条/分
	// 防多 IP 合围灌顶（触发即整链降温 1 分钟，误伤面 = 该分享的全体访客，
	// 故全局阈值放宽到协作量级之上）
	guestMsgMaxPerIP    = 5
	guestMsgMaxPerToken = 30
	guestMsgWindow      = time.Minute

	// guestMsgListLimit 访客页/通知摘要取留言的条数上限（附表侧还有
	// store.ShareMsgMaxPerToken 硬顶，这里是单次请求的读取面收敛）
	guestMsgListLimit = 50

	// guestNoteTextRunes 通知正文里留言摘录的 rune 宽度：一行判断「谁在问
	// 什么」，全文在管理面板看
	guestNoteTextRunes = 80
)

// MessageBoard 留言附表的最小面（store.ShareMessageStore 的结构性子集，
// 装配层注入；测试可替换——ShareLookup/ProjectRoots 同款接口注入先例）
type MessageBoard interface {
	Add(token, nickname, text string, now time.Time) (*store.ShareMessage, error)
	List(token string, limit int) ([]store.ShareMessage, error)
}

// msgRateLimiter 留言频控：两枚独立固定窗口（middleware.RateLimiter 复用，
// key = 维度拼接）。IsLimited 前置拒绝 + Hit 计数与口令门失败限流同构
type msgRateLimiter struct {
	perIP    *middleware.RateLimiter
	perToken *middleware.RateLimiter
}

func newMsgRateLimiter() *msgRateLimiter {
	return &msgRateLimiter{
		perIP:    middleware.NewRateLimiter(guestMsgMaxPerIP, guestMsgWindow),
		perToken: middleware.NewRateLimiter(guestMsgMaxPerToken, guestMsgWindow),
	}
}

// allow 校验该请求是否可写一条留言：任一维度超限即拒。Hit 返回递增后的
// 计数，> max 即本条起超限（口令门失败限流同款「计数即判定」语义——第
// max+1 条被拒，窗口末自然解封）；IsLimited 前置短路已处限流态的请求。
// 计数只对通过载荷校验的请求发生（垃圾不消耗配额，校验在 handler 内先行）
func (m *msgRateLimiter) allow(token string, r *http.Request) bool {
	if m == nil {
		return true
	}
	ip := guestClientIP(r)
	key := token + "\x00" + ip
	if m.perIP.IsLimited(key) || m.perToken.IsLimited(token) {
		return false
	}
	return m.perIP.Hit(key) <= guestMsgMaxPerIP && m.perToken.Hit(token) <= guestMsgMaxPerToken
}

// retryAfter 当前该请求的最早可重试秒数（两维度窗口末的较大者，向上取整；
// 无限流态返回 0——调用方只在 429 分支取值）
func (m *msgRateLimiter) retryAfter(token string, r *http.Request) int {
	if m == nil {
		return 0
	}
	ip := guestClientIP(r)
	end := m.perIP.ExpireAt(token + "\x00" + ip)
	if t2 := m.perToken.ExpireAt(token); t2.After(end) {
		end = t2
	}
	if end.IsZero() {
		return 0
	}
	remain := int64(time.Until(end).Seconds() + 0.999)
	if remain < 1 {
		remain = 1
	}
	return int(remain)
}

// guestClientIP 访客来源 IP（viewaudit.clientIPOf 同口径：不信任 X-Forwarded-For
// ——访客子服务直曝无代理信任配置面，RemoteAddr 是唯一能担保的来路事实）
func guestClientIP(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// ── 端点 ──

// handleGuestMessagesGet GET /s/{token}/messages（gateGuard 后）：该分享的
// 留言列表（新到旧，至多 guestMsgListLimit 条）。访客页展开留言区时取数
// ——只读回流可见性：自己的留言落库即见，他人的留言同屏（留言本是给
// 「所有拿到链接的人」看的协作面，与主人侧同源同权）
func (s *Service) handleGuestMessagesGet(w http.ResponseWriter, r *http.Request) {
	sh, herr := s.lookup(r, r.PathValue("token"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	msgs, count := s.guestMessages(sh.Token)
	writeJSON(w, map[string]any{"messages": msgs, "count": count})
}

// guestMessages 取留言（附表未装配降级为空列表——测试/降级部署零 panic）
func (s *Service) guestMessages(token string) ([]store.ShareMessage, int) {
	if s.msgs == nil {
		return []store.ShareMessage{}, 0
	}
	list, err := s.msgs.List(token, guestMsgListLimit)
	if err != nil {
		return []store.ShareMessage{}, 0
	}
	return list, len(list)
}

// handleGuestMessagePost POST /s/{token}/messages（gateGuard 后）：访客留言
// 写入。口令分享的访客须持有效门会话（守卫层收口，与内容子资源同门）。
// 校验链：体限幅 → JSON 解析 → 昵称清洗（控制字符折叠为空格 + rune 截断）
// → 文本非空 + rune 上限（协作通道开启 500→2000，P-20261024-1——贴错误
// 日志/栈帧/配置段是测试协作的主场景，频控沿用）→ 频控 → 附表 Add（分享
// 已撤销/过期 → 404 不借尸还魂）。成功回执即持久化回执（响应携带落库后的
// 完整留言）
func (s *Service) handleGuestMessagePost(w http.ResponseWriter, r *http.Request) {
	sh, herr := s.lookup(r, r.PathValue("token"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	var req struct {
		Nickname string `json:"nickname"`
		Text     string `json:"text"`
	}
	body := json.NewDecoder(http.MaxBytesReader(w, r.Body, guestMsgBodyLimit))
	if err := body.Decode(&req); err != nil {
		writeJSONErrorStatus(w, http.StatusBadRequest, "invalid_request")
		return
	}
	nick := sanitizeGuestNickname(req.Nickname)
	text := sanitizeGuestText(req.Text)
	// 限长按记录开关取档：协作通道开启 2000（store.MaxShareMessageCollabRunes），
	// 缺省 500（存量语义零变化）——「最大 500 字」占位文案由页面 boot 态
	// SC.msgMax 同步下发（guestBoardJS 单一消费），服务端校验是唯一权威
	maxRunes := store.MaxShareMessageRunes
	if sh.Collab {
		maxRunes = store.MaxShareMessageCollabRunes
	}
	if runes := utf8.RuneCountInString(text); runes == 0 || runes > maxRunes {
		writeJSONErrorStatus(w, http.StatusBadRequest, "invalid_message")
		return
	}
	if !s.msgLimit.allow(sh.Token, r) {
		// 与口令门限流同一出口契约：429 + Retry-After（客户端重试节奏的
		// 唯一依据）
		if ra := s.msgLimit.retryAfter(sh.Token, r); ra > 0 {
			w.Header().Set("Retry-After", strconv.Itoa(ra))
		}
		writeJSONErrorStatus(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	if s.msgs == nil {
		writeJSONErrorStatus(w, http.StatusServiceUnavailable, "unavailable")
		return
	}
	msg, err := s.msgs.Add(sh.Token, nick, text, time.Now())
	if err != nil {
		// 附表 Add 的 ErrNotFound = 分享在守卫与写入之间被撤销/过期清账：
		// 404 与访客面其余端点同语义；其余错误按存储故障 500（诚实降级，
		// 不把存储故障伪装成死链）
		if errors.Is(err, store.ErrNotFound) {
			writeJSONErrorStatus(w, http.StatusNotFound, "share_not_found")
			return
		}
		s.logger.Warn("share guest message add failed", "token", TokenSummary(sh.Token), "err", err)
		writeJSONErrorStatus(w, http.StatusInternalServerError, "internal_error")
		return
	}
	s.notes.Add(guestNote(sh, msg))
	writeJSON(w, map[string]any{"message": msg})
}

// sanitizeGuestNickname 昵称清洗：控制字符（含 \t/\r）折叠为空格、trim、
// rune 截断——昵称是单行展示位（管理面板/访客页/通知摘要），控制字符只会
// 渲染成不可预测的空白（snippet 标题清洗同款）
func sanitizeGuestNickname(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if runes := []rune(s); len(runes) > store.MaxShareNicknameRunes {
		return string(runes[:store.MaxShareNicknameRunes])
	}
	return s
}

// sanitizeGuestText 留言正文清洗：\r\n/\r 归一 \n（跨平台换行语义一致），
// 其余控制字符剔除（防审计/日志/展示面的不可见字符注入），trim 收尾。
// 长度校验在清洗后进行（handler 内 rune 计数），上限内文本原样存储
func sanitizeGuestText(s string) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, string(utf8.RuneError))
	}
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '\n':
			b.WriteByte('\n')
		case r == '\t':
			b.WriteString("  ")
		case r < 0x20 || r == 0x7f:
			// 其余控制字符剔除
		default:
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}

// ── 新留言通知回流（主人侧「可选入通知中心」） ──

// guestNotesMaxPending 通知攒批上限：留言风暴时的内存护栏（逐出最旧保最新，
// viewaudit 同款有损降级——丢弃量冲刷时留日志，绝不阻塞访客响应）
const guestNotesMaxPending = 128

// GuestNoteBuffer 新留言通知聚合器（Service 持有；零值可用——nil 接收者
// 各方法安全直通，ViewAuditBuffer 同款）。访客响应路径只攒内存，装配层
// 经既有 share-flush tick 批量入账通知中心 + Stop 兜底
type GuestNoteBuffer struct {
	mu      sync.Mutex
	pending []notification.Notification
	dropped int
}

// Add 攒一条新留言通知（访客响应路径内调用，只动内存）
func (b *GuestNoteBuffer) Add(n notification.Notification) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.pending) >= guestNotesMaxPending {
		b.pending = b.pending[1:]
		b.dropped++
	}
	b.pending = append(b.pending, n)
}

// Drain 取走攒下的全部通知与逐出计数（冲刷与写入互斥；取走即清，失败
// 不回灌——与审计冲刷同一取舍）
func (b *GuestNoteBuffer) Drain() (notes []notification.Notification, dropped int) {
	if b == nil {
		return nil, 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	out := b.pending
	dropped = b.dropped
	b.pending = nil
	b.dropped = 0
	return out, dropped
}

// guestNote 构造新留言通知（主人侧回流事件的入账形态）：模板键 + 参数供
// 前端按界面语言渲染（P-20261001-30 惯例），Title/Body 中文原文兜底无模板
// 消费方（API 直读/webhook）；Action=panel:share-manager 点开即分享管理器
// （留言面板所在）。留言摘录按 rune 截断防 Detail 无界
func guestNote(sh *store.Share, msg *store.ShareMessage) notification.Notification {
	nick := msg.Nickname
	if nick == "" {
		nick = guestNoteAnonNick
	}
	text := msg.Text
	if runes := []rune(text); len(runes) > guestNoteTextRunes {
		text = string(runes[:guestNoteTextRunes]) + "…"
	}
	return notification.Notification{
		Type:          "info",
		Category:      notification.CategorySystem,
		TitleKey:      "share.msg.notify.title",
		BodyKey:       "share.msg.notify.body",
		Title:         "分享收到新留言",
		Body:          "「" + sh.Name + "」" + nick + "：" + text,
		Time:          msg.CreatedAt,
		MsgParams:     map[string]any{"name": sh.Name, "nick": nick, "text": text},
		Action:        "panel",
		ActionPayload: "share-manager",
	}
}

// guestNoteAnonNick 通知摘要里的匿名访客占位（语言中立的字形占位，避免
// 「来自 的留言」空洞——i18n 全词由前端模板键承载，此处只兜底拼接）
const guestNoteAnonNick = "（匿名访客）"

// FlushGuestNotes 把攒下的新留言通知批量入账（apply = store.Notification.Add，
// 装配层注入——本包不反向依赖通知存储，MessageBoard 同款接口注入先例）。
// 装配层定时调用 + Module.Stop 兜底各一次（FlushHits/FlushViewAudits 同节奏
// 同收口）。apply 为 nil 时直接清空（测试/关停场景）
func (s *Service) FlushGuestNotes(apply func(notification.Notification)) int {
	notes, dropped := s.notes.Drain()
	if dropped > 0 {
		s.logger.Warn("share guest note buffer overflowed, oldest dropped", "dropped", dropped)
	}
	for _, n := range notes {
		if apply == nil {
			continue
		}
		apply(n)
	}
	return len(notes)
}

// ── 访客页留言区共享资产（三形态统一挂载） ──

// boardMsgMaxDefault / boardMsgMaxCollab 留言板上限的两档（boot 态 SC.msgMax
// 下发——guestBoardJS 单一消费点，服务端校验是唯一权威；协作通道开启升档
// 见 handleGuestMessagePost）
const (
	boardMsgMaxDefault = 500
	boardMsgMaxCollab  = 2000
)

// boardMsgMax 留言板上限取档（协作通道开启 → 2000，其余 500）
func boardMsgMax(collab bool) int {
	if collab {
		return boardMsgMaxCollab
	}
	return boardMsgMaxDefault
}

// guestBoardCSS 留言区样式（三页模板以 {{.BoardCSS}} 注入 <style>；变量取
// 各页同源的 :root 主题 token，零新增依赖）。列表内部滚动 + 折叠形态，
// 不与内容区抢高度
const guestBoardCSS = `
.gb-root{flex-shrink:0;margin-top:10px;background:var(--card);border:1px solid var(--border);
border-radius:12px;overflow:hidden}
.gb-head{display:flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;
color:var(--text);padding:9px 14px;font-size:12.5px;font-weight:600;cursor:pointer;text-align:left}
.gb-head:hover{background:var(--hover)}
.gb-head .gb-cnt{color:var(--muted);font-weight:400;font-variant-numeric:tabular-nums}
.gb-head .gb-arrow{margin-left:auto;color:var(--muted);transition:transform .15s}
.gb-root.open .gb-arrow{transform:rotate(180deg)}
.gb-body{display:none;padding:0 14px 12px}
.gb-root.open .gb-body{display:block}
.gb-list{max-height:200px;overflow:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
.gb-item{border:1px solid var(--border);border-radius:8px;padding:7px 10px;background:var(--hover)}
.gb-item .gb-meta{display:flex;gap:8px;align-items:baseline;margin-bottom:2px}
.gb-item .gb-nick{font-size:12px;font-weight:600;color:var(--accent)}
.gb-item .gb-time{font-size:11px;color:var(--muted)}
.gb-item .gb-text{font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text)}
.gb-empty{color:var(--muted);font-size:12px;text-align:center;padding:10px 0}
.gb-form{display:flex;flex-direction:column;gap:7px}
.gb-form input,.gb-form textarea{border:1px solid var(--border);border-radius:8px;background:var(--hover);
color:var(--text);padding:7px 10px;font-size:12.5px;outline:none;font-family:inherit;resize:vertical}
.gb-form input:focus,.gb-form textarea:focus{border-color:var(--accent)}
.gb-form textarea{min-height:56px}
.gb-form .gb-foot{display:flex;align-items:center;gap:8px}
.gb-form .gb-counter{color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.gb-form button{margin-left:auto;border:none;background:linear-gradient(135deg,var(--accent),var(--accent2));
color:#fff;padding:6px 18px;border-radius:999px;font-size:12px;cursor:pointer}
.gb-form button:disabled{opacity:.6;cursor:default}
.gb-status{font-size:11.5px;color:var(--muted);min-height:1em}
.gb-status.err{color:#d64545}
.gb-status.ok{color:#2e9e5b}
@media print{.gb-root{display:none!important}}
`

// guestBoardJS 留言区脚本（三页模板以 {{.BoardJS}} 注入主 script 尾部——
// 依赖页面已有的 SC boot 常量与 t() 字典函数）。全部用户字符串经
// textContent 写入（零 HTML 拼接）；取数只发生在首次展开（克制：无轮询）
const guestBoardJS = `
(function mountGuestBoard(){
  const wrap = document.querySelector('.wrap');
  if (!wrap) return;
  const root = document.createElement('section');
  root.className = 'gb-root';
  root.setAttribute('data-testid', 'gb-root');
  const head = document.createElement('button');
  head.type = 'button'; head.className = 'gb-head';
  head.setAttribute('data-testid', 'gb-toggle');
  const ttl = document.createElement('span'); ttl.textContent = t('gbTitle');
  const cnt = document.createElement('span'); cnt.className = 'gb-cnt';
  const arrow = document.createElement('span'); arrow.className = 'gb-arrow'; arrow.textContent = '▾';
  head.append(ttl, cnt, arrow);
  const body = document.createElement('div'); body.className = 'gb-body';
  const list = document.createElement('div'); list.className = 'gb-list';
  const empty = document.createElement('div'); empty.className = 'gb-empty';
  empty.textContent = t('gbEmpty');
  const form = document.createElement('div'); form.className = 'gb-form';
  const msgMax = SC.msgMax > 0 ? SC.msgMax : 500;
  const nick = document.createElement('input');
  nick.maxLength = 24; nick.placeholder = t('gbNick'); nick.autocomplete = 'off';
  nick.setAttribute('data-testid', 'gb-nick');
  const ta = document.createElement('textarea');
  ta.maxLength = msgMax; ta.placeholder = t('gbPh');
  ta.setAttribute('data-testid', 'gb-text');
  const foot = document.createElement('div'); foot.className = 'gb-foot';
  const counter = document.createElement('span'); counter.className = 'gb-counter'; counter.textContent = '0/' + msgMax;
  const send = document.createElement('button'); send.type = 'button'; send.textContent = t('gbSend');
  send.setAttribute('data-testid', 'gb-send'); send.disabled = true;
  const status = document.createElement('div'); status.className = 'gb-status'; status.setAttribute('data-testid', 'gb-status');
  foot.append(counter, send);
  form.append(nick, ta, foot, status);
  body.append(list, form);
  root.append(head, body);
  const footer = wrap.querySelector('.footer');
  if (footer) wrap.insertBefore(root, footer); else wrap.appendChild(root);

  let loaded = false;
  let msgCount = 0;
  function setStatus(msg, kind){
    status.textContent = msg || '';
    status.className = 'gb-status' + (kind ? ' ' + kind : '');
  }
  function fmtTime(iso){
    try {
      return new Intl.DateTimeFormat(SC.lang === 'zh' ? 'zh-CN' : 'en-US',
        { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
    } catch (e) { return ''; }
  }
  function renderItem(m, atTop){
    const item = document.createElement('div'); item.className = 'gb-item';
    item.setAttribute('data-testid', 'gb-item');
    const meta = document.createElement('div'); meta.className = 'gb-meta';
    const nk = document.createElement('span'); nk.className = 'gb-nick';
    nk.textContent = m.nickname || t('gbAnon');
    const tm = document.createElement('span'); tm.className = 'gb-time'; tm.textContent = fmtTime(m.createdAt);
    const tx = document.createElement('div'); tx.className = 'gb-text'; tx.textContent = m.text;
    meta.append(nk, tm); item.append(meta, tx);
    if (atTop && list.firstChild) list.insertBefore(item, list.firstChild);
    else list.appendChild(item);
  }
  function refreshCount(n){ msgCount = n; cnt.textContent = n > 0 ? '· ' + n : ''; }
  async function loadList(){
    try {
      const res = await fetch('/s/' + SC.token + '/messages');
      if (!res.ok) return;
      const data = await res.json();
      const msgs = data.messages || [];
      list.replaceChildren();
      msgs.forEach(m => renderItem(m, false));
      if (!msgs.length) list.appendChild(empty);
      refreshCount(data.count != null ? data.count : msgs.length);
    } catch (e) { /* 取数失败保持空态，表单仍可用 */ }
  }
  head.onclick = () => {
    const open = root.classList.toggle('open');
    if (open && !loaded) { loaded = true; loadList(); }
  };
  ta.oninput = () => {
    counter.textContent = [...ta.value].length + '/' + msgMax;
    // 空文本禁发（占位反馈在按钮态，不发错误文案）；粘贴超限仍由提交侧兜底
    send.disabled = ![...ta.value.trim()].length;
  };
  send.onclick = async () => {
    const text = ta.value;
    const n = [...text].length;
    if (!n || n > msgMax) { setStatus(t('gbFailed'), 'err'); return; }
    send.disabled = true;
    const old = send.textContent; send.textContent = t('gbSending');
    setStatus('');
    try {
      const res = await fetch('/s/' + SC.token + '/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: nick.value, text })
      });
      if (res.status === 429) { setStatus(t('gbLimited'), 'err'); return; }
      if (!res.ok) { setStatus(t('gbFailed'), 'err'); return; }
      const data = await res.json();
      if (data.message) {
        const emptyEl = list.querySelector('.gb-empty');
        if (emptyEl) emptyEl.remove();
        renderItem(data.message, true);
        refreshCount(msgCount + 1);
      }
      ta.value = ''; nick.value = ''; counter.textContent = '0/' + msgMax; send.disabled = true;
      setStatus(t('gbSent'), 'ok');
      setTimeout(() => { if (status.classList.contains('ok')) setStatus(''); }, 3000);
    } catch (e) {
      setStatus(t('gbFailed'), 'err');
    } finally {
      send.disabled = false; send.textContent = old;
    }
  };
})();
`
