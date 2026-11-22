package share

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"codecombo/server/store"
)

// ── 终端只读直播 SSE 推流（P-20261003-306；体量守卫拆分自 service.go，P-20261118-9） ──
//
// service.go 已超 1500 行体量守卫阈值（基线登记，只许减不许增）；本文件把
// 「/s/{token}/stream SSE 端点」子系统整块迁出：帧协议常量、handleStream
// （hello/tail/data/resize/rename/end 帧序）、直播源未装配的降级收场。
// 函数零丢失零改写（纯搬移）——帧序/对账/只读保证的权威注释随函数走；
// 测试在本包 stream_test.go（本次拆分后文件名与被测件终于同名）。

// ── 终端只读直播（P-20261003-306） ──

// sseKeepaliveInterval SSE 保活注释帧周期：代理/LB 对静默连接的空闲裁剪
// 通常在 30~60s，15s 注释帧（`: ping`）把连接钉在活跃侧；输出密集时该
// ticker 空转（select 随机就绪，注释帧不挤占数据帧的推送及时性）
const sseKeepaliveInterval = 15 * time.Second

// sseSizePollInterval 主机尺寸对账周期（P-20261107-4 渲染保真）：主人调整窗口
// 后访客栅格必须跟随（cols/rows 不符即 TUI 折行/光标定位错乱）。数据帧路径
// 逐帧对账（resize 引发的 SIGWINCH 重绘必然带输出，新尺寸先于重绘字节到达
// 访客），本 ticker 兜「调整后无输出」的静默窗口；Size 只是一次会话锁内读，
// 单 token 访客 ≤5 路，1s 周期开销可忽略
const sseSizePollInterval = time.Second

// handleStream 终端只读推流（SSE）：hello（尺寸/终态）→ tail（订阅点前
// 遮蔽尾流快照，base64）→ data*（实时遮蔽字节）→ end（馈线终结）；主机
// 尺寸变化时插入 resize 帧（{"cols","rows"}，P-20261107-4——先于新尺寸下
// 重绘的字节送达，访客按主机栅格渲染）；会话改名时插入 rename 帧
// （{"name"}，P-20261118-9——与 resize 同一 1s 对账 tick，访客页标题跟随）。
// 载荷一律 struct + json.Marshal 单行序列化（helloFrame/renameFrame 定字段
// 序纪律）——会话名可含换行/控制字符（binding:required 无格式限制），手工
// 裸拼会把帧撕裂；Marshal 对 <0x20 字节强制 \u 转义，SSE 行结构恒完整
// 字节帧一律 base64：PTY 输出是任意字节流，多字节 UTF-8 字符可被 4KB 分片
// 劈开，SSE 的 text 语义要求 UTF-8 合法——base64 让帧边界与字节边界解耦。
// 访客额度（单 token 并发 ≤ MaxGuestsPerToken）由直播源把守，超限 429。
// 严格只读：本端点只写不读（忽略请求体），终端输出流没有反向通道——
// 访客面写入端点只触独立数据面（/gate 口令验证 P-20261006-25、/view 一次性
// 确认 P-20261020-3、/messages 访客留言附表、/drop 素材上行与 /direct/*
// 直通输入档 P-20261024-1——直通输入走独立的会话写入授权链，不经直播流；
// 未开协作的分享无任何写入端点）
func (s *Service) handleStream(w http.ResponseWriter, r *http.Request) {
	sh, herr := s.lookup(r, r.PathValue("token"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	if sh.Kind != store.ShareKindTerminal {
		// 文件/片段分享没有流语义（不是 405——路由面语义上该端点存在，
		// 是该记录形态不可直播）
		writeJSONError(w, errUnrenderable)
		return
	}
	if s.live == nil {
		// 直播源未装配（测试/降级部署）：按已终结流语义收场，不 5xx
		s.writeSSEEnd(w, r)
		return
	}
	sub, err := s.live.Subscribe(sh.Token, sh.TerminalID, sh.Unfiltered)
	if err != nil {
		writeJSONErrorStatus(w, http.StatusTooManyRequests, "guest_limit")
		return
	}
	defer sub.Release()

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSONErrorStatus(w, http.StatusInternalServerError, "streaming_unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	// 禁代理缓冲（nginx 同名头约定），SSE 帧即时到达访客
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	// 每帧一个写超时：半死连接的 Write 无 deadline 会永久阻塞
	//（proxy/ws.go 泄漏事故同款教训），http.ResponseController 帧粒度控时，
	// 不牵连整条连接的生命周期
	rc := http.NewResponseController(w)
	writeEvent := func(event, data string) bool {
		_ = rc.SetWriteDeadline(time.Now().Add(30 * time.Second))
		if _, err := io.WriteString(w, "event: "+event+"\ndata: "+data+"\n\n"); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	// hello：终端尺寸 + 是否已终结 + 分享名（P-20261118-9，访客页据此校准
	// h1/标签页标题）；tail：订阅点前快照。顺序先于实时订阅消费——订阅点登记
	// 在 Subscribe 内部与快照同锁完成，快照与此后的实时通道无重叠无缝隙。
	// struct 序列化定字段序（map 序列化按键序漂移，访客端解析虽无感，
	// e2e 断言与日志对账都需要稳定帧形态）
	type helloFrame struct {
		Cols  uint16 `json:"cols,omitempty"`
		Rows  uint16 `json:"rows,omitempty"`
		Ended bool   `json:"ended"`
		Name  string `json:"name,omitempty"`
	}
	cols, rows := sub.Size()
	hb, _ := json.Marshal(helloFrame{Cols: cols, Rows: rows, Ended: sub.Ended(), Name: sub.Name()})
	if !writeEvent("hello", string(hb)) {
		return
	}
	if len(sub.Tail()) > 0 {
		if !writeEvent("tail", base64.StdEncoding.EncodeToString(sub.Tail())) {
			return
		}
	}

	// syncSize 主机尺寸对账（P-20261107-4）：与上次下发值不同即补 resize 帧；
	// 0 尺寸（会话不可读）不下发——访客保持现栅格，不被打回默认网格
	type sizeFrame struct {
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	// syncName 会话改名对账（P-20261118-9）：与 syncSize 同一 tick 同构——
	// 实时读会话显示名，与上次下发值不同即补 rename 帧（载荷 struct 单行
	// 序列化，换行/控制字符名转义见 handleStream 头注）
	type renameFrame struct {
		Name string `json:"name"`
	}
	name := sub.Name()
	syncSize := func() bool {
		c, r := sub.Size()
		if c == 0 || r == 0 || (c == cols && r == rows) {
			return true
		}
		cols, rows = c, r
		sb, _ := json.Marshal(sizeFrame{Cols: c, Rows: r})
		return writeEvent("resize", string(sb))
	}
	syncName := func() bool {
		n := sub.Name()
		if n == "" || n == name {
			return true
		}
		name = n
		nb, _ := json.Marshal(renameFrame{Name: n})
		return writeEvent("rename", string(nb))
	}

	keepalive := time.NewTicker(sseKeepaliveInterval)
	defer keepalive.Stop()
	sizePoll := time.NewTicker(sseSizePollInterval)
	defer sizePoll.Stop()
	for {
		select {
		case data, ok := <-sub.Live():
			if !ok {
				return
			}
			// 尺寸先于字节：resize 后的重绘按新栅格落屏
			if !syncSize() {
				return
			}
			if len(data) > 0 && !writeEvent("data", base64.StdEncoding.EncodeToString(data)) {
				return
			}
		case <-sizePoll.C:
			if !syncSize() {
				return
			}
			if !syncName() {
				return
			}
		case <-sub.Done():
			// 馈线终结（会话关闭/撤销/慢消费踢出）：终结前的最后一批字节
			// 可能仍在通道里，非阻塞排干再收场
			for {
				select {
				case data, ok := <-sub.Live():
					if ok && len(data) > 0 {
						if !writeEvent("data", base64.StdEncoding.EncodeToString(data)) {
							return
						}
						continue
					}
				default:
				}
				writeEvent("end", "{}")
				return
			}
		case <-r.Context().Done():
			return
		case <-keepalive.C:
			// SSE 注释帧保活（`: ping` 对 EventSource 透明）
			_ = rc.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// writeSSEEnd 直播源未装配时的降级流：一帧 hello(ended) + end 即关
func (s *Service) writeSSEEnd(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSONErrorStatus(w, http.StatusInternalServerError, "streaming_unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "event: hello\ndata: {\"ended\":true}\n\n")
	_, _ = io.WriteString(w, "event: end\ndata: {}\n\n")
	flusher.Flush()
}
