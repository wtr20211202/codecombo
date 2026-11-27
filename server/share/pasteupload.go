package share

// 访客粘贴上传落盘链（P-20261122-1 必改1）：可写分享终端的能力对齐件——
// 主人端终端跑 claude code 时 Ctrl+V 粘图片/文件 → 压缩 → 上传落盘 → 路径
// 入输入行是完整链（server/api/terminal/terminal_paste_image.go），可写分享
// 访客此前只有纯文本键入没有这条链；本端点补上「访客设备上的文件交给主机」
// 的唯一通道（粘贴=字节面天然无路径难题；拖拽上传经用户定向裁撤，访客页
// 拖拽维持协作收件箱原语义，见 writablepage.go 仲裁注）。
//
// 门禁 mode-aware 分档（评审定案）：
//   - 形态非 terminal / 双开关全关 → 404 share_not_found（存在性不可探测，
//     direct.go/drops.go 同款语义）；
//   - 开放直入（sh.Writable）：准入——开放连接不进 holds 账本，绑 holds 判
//     定会误拒 open（键入/上传同授权物：持链接 +口令即可，泄露半径与键入
//     同等，出域横幅如实提及）；
//   - 申请批准模式（申请通道开、未开直入）：须持有效输入权（directHub.holds
//     绑 token+visitorId，与 WS 键入帧同一判定）——无持权 403 direct_denied。
//
// 参数复用主人端（白名单/限额同值，本包不 import terminal——分层先例见
// writable.go WritableSink 注；三处对账惯例同 pasteFiles.ts 注记）：
//   - image 形态：Content-Type 四类精确白名单（png/jpeg/gif/webp）10MB ——
//     **四类之外一律 400 unsupported_type**（P-20261122-18 ⑦：旧实现把其余
//     CT 静默落成 .png，与「四类精确白名单」注释不符——svg/bmp/avif 等
//     浏览器截图面板不会产出、访客侧已按扩展名分流到 file 形态，剩余未知
//     CT 只可能是协议误用/伪造，落盘扩展名不可信就不该落盘。**主人端
//     terminal_paste_image.go 保持旧「未知 CT 回落 .png」不变**（主人端
//     前端对非 png/jpeg 的 image/* 原样上传、服务端回落 .png 是既有宽松面；
//     本提案只收紧访客面——访客落盘文件会以路径形式交给主机 shell，扩展名
//     可信度是安全面）；file 形态：
//     扩展名白名单 20MB，单请求单文件（主人端同形），单批 ≤5 的总量闸在
//     访客页（主人端在 pasteFiles.ts PASTE_FILE_MAX_COUNT，两端同参数）；
//   - 落系统临时目录 sc-paste-<unixms>.<ext>（server/pastetmp 微包共用
//     O_EXCL 独占命名）——前缀与主人端一致即共享 paste-cleaner 生命周期
//    （terminal.CleanupStalePasteImages 24h 龄 6h tick），零新清理机制。
//
// 防线：gateGuard 口令门（路由注册）+ ratePair 频控（(token,IP) 10/min +
// token 全局 60/min，drops.go 同参数——上传比留言重一个量级）+ 体封顶 +
// 白名单 + 净化名审计。owner 可见性 = 终端回显（路径经 term.paste 走既有
// WS 键入帧 → commandrisk 预检，≥64B 命中预检）+ 审计（share.pasteUpload）
// + sc-ops toast 广播；通知中心 note 仅敏感名命中才发（IsSensitiveName
// 先例——逐文件 note 过噪）。
//
// masked×上传正交（评审裁定）：上传是输入侧、遮蔽是输出侧，正交不互闸。

import (
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"codecombo/server/notification"
	"codecombo/server/pastetmp"
	"codecombo/server/store"
	"html/template"
)

// 粘贴上传限额单一事实源 = server/pastetmp（P-20261123-5）：访客端 file 20MB /
// image 10MB / body 22MB **刻意维持**（与 drops 协作收件箱 20MB/file 口径一致、
// 访客频控/落盘面更敏感，提额另案）——数值不变，只换事实源；主人端已提额到
// 100MB，两端自此**不再同值**，历史「主人端同值」注释全部退役。
// pasteShareLimits 当前生效的 share 端限额（P-20261123-6）：每次上传请求现读
// settings 生效值（share 面范围=默认 20/10，只允许下调）；store 为 nil 回落默认。
// BodyMax 按 file 生效值 +2MB 推导
func pasteShareLimits() (pastetmp.Limit, int64) {
	lim := pastetmp.Share
	if st := store.Get(); st != nil && st.Settings != nil && st.Settings.Get() != nil {
		_, lim, _ = st.Settings.Get().Server.EffectivePasteLimits()
	}
	return lim, pastetmp.BodyMaxForMB(lim.FileMB, 2)
}

// pasteLimitsJS window.__scPasteLimits 注入体（P-20261123-6 S2 方案⑥，
// termpage.go PasteLimitsJS 字段消费）：nil-safe 现读 settings 生效值（渲染期），
// 纯数字 template.JS；store 不可用 → 注入 null（访客页预检跳过，服务端权威兜底）
func pasteLimitsJS() template.JS {
	if st := store.Get(); st != nil && st.Settings != nil && st.Settings.Get() != nil {
		_, share, _ := st.Settings.Get().Server.EffectivePasteLimits()
		return template.JS(fmt.Sprintf("window.__scPasteLimits={fileMB:%d,imageMB:%d};", share.FileMB, share.ImageMB))
	}
	return template.JS("window.__scPasteLimits=null;")
}

const (
	// 频控（ratePair 复用，drops.go dropMaxPerIP/dropMaxPerToken 同参数取态）：
	// 每 (token,IP) 每分钟 10 次（正常访客贴几张截图远够）、token 全局每分钟
	// 60 次防多 IP 合围
	pasteMaxPerIP    = 10
	pasteMaxPerToken = 60
	pasteWindow      = time.Minute
)

// pasteFileAllowedExts file 形态扩展名白名单（与主人端
// server/api/terminal/terminal_paste_image.go pasteFileAllowedExts 及
// web/src/utils/pasteFiles.ts PASTE_FILE_ALLOWED_EXTS 三处对账——本包不
// import terminal，白名单各自维护、跨包一致性由对账注记与本侧单测锚定）
var pasteFileAllowedExts = map[string]bool{
	// 图片（OS 里复制的图片文件走 file 形态；截图 blob 才走 image 形态）
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".bmp": true, ".svg": true,
	// 纯文本 / 结构化文本
	".txt": true, ".md": true, ".markdown": true, ".log": true, ".csv": true, ".tsv": true,
	".json": true, ".jsonl": true, ".xml": true, ".yml": true, ".yaml": true, ".toml": true,
	".ini": true, ".cfg": true, ".conf": true, ".sql": true, ".html": true, ".htm": true, ".css": true,
	// 常见源码
	".js": true, ".mjs": true, ".cjs": true, ".ts": true, ".tsx": true, ".jsx": true,
	".py": true, ".go": true, ".rs": true, ".java": true, ".kt": true, ".swift": true,
	".c": true, ".h": true, ".cpp": true, ".hpp": true, ".cc": true,
	".sh": true, ".bash": true, ".zsh": true, ".bat": true, ".cmd": true, ".ps1": true,
	".rb": true, ".php": true, ".lua": true, ".pl": true, ".r": true,
	".dart": true, ".vue": true, ".svelte": true,
	// office / 文档
	".pdf": true, ".doc": true, ".docx": true, ".xls": true, ".xlsx": true,
	".ppt": true, ".pptx": true, ".odt": true, ".ods": true, ".odp": true, ".rtf": true, ".epub": true,
	// 压缩包
	".zip": true, ".tar": true, ".gz": true, ".tgz": true, ".bz2": true, ".xz": true, ".7z": true, ".rar": true,
}

// PasteUploadEvent sc-ops:share.paste-upload 广播载荷（owner 侧「访客上传了
// 什么」的即时感知面；仅元数据——文件内容与落盘绝对路径不上广播面，落盘
// 路径访客侧自持）。导出类型：装配层广播接线消费
type PasteUploadEvent struct {
	Token       string `json:"token"`
	ShareName   string `json:"shareName"`
	TerminalID  string `json:"terminalId,omitempty"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	Mode        string `json:"mode"`
	Nick        string `json:"nick,omitempty"`
	VisitorTail string `json:"visitorTail,omitempty"`
	At          int64  `json:"at"`
}

// handlePasteUpload POST /s/{token}/paste-upload（gateGuard 后）：访客粘贴
// 链的落盘端点。校验链：mode-aware 门禁（404/403 分档见包注释）→ 频控 →
// multipart 解析（体封顶）→ 字段分派（file/image 两形态，主人端同形）→
// 大小/白名单校验 → pastetmp 独占落盘。响应同主人端形状 {"data":{path,size}}
// ——访客页客户端逻辑与主人端 uploadPaste 近逐行同构（Windows 正斜杠回告
// 惯例同源）。审计/通知/ops 广播为副作用旁路（元数据口径，访客响应路径
// 零落盘第二笔，drops.go 同纪律）
func (s *Service) handlePasteUpload(w http.ResponseWriter, r *http.Request) {
	sh, herr := s.lookup(r, r.PathValue("token"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	// mode-aware 门禁：形态/双开关全关 = 端点不存在（存在性不可探测）
	open := sh.Writable
	chanOpen := !sh.GuestInputOff
	if sh.Kind != store.ShareKindTerminal || sh.TerminalID == "" || (!open && !chanOpen) {
		writeJSONErrorStatus(w, http.StatusNotFound, "share_not_found")
		return
	}
	if !s.pasteLimit.allow(sh.Token, r) {
		if ra := s.pasteLimit.retryAfter(sh.Token, r); ra > 0 {
			w.Header().Set("Retry-After", strconv.Itoa(ra))
		}
		writeJSONErrorStatus(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	lim, bodyMax := pasteShareLimits()
	r.Body = http.MaxBytesReader(w, r.Body, bodyMax)
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeJSONErrorStatus(w, http.StatusRequestEntityTooLarge, "too_large")
			return
		}
		writeJSONErrorStatus(w, http.StatusBadRequest, "invalid_request")
		return
	}
	// 访客身份：自报 visitorId（sanitizeVisitorID 同 WS 桥——稳定自报标识
	// 非凭据，open 模式仅审计用，hold 模式参与持权匹配）+ 昵称沿留言板清洗
	visitorID := sanitizeVisitorID(r.FormValue("visitorId"))
	nick := sanitizeGuestNickname(r.FormValue("nickname"))
	// hold 模式持权门：与 WS 键入帧同一判定（directHub.holds 绑 token+visitorId）。
	// 持权上传顺带 touch 续期（与 WS 键入帧同款取态——上传活动中不因无键入被
	// 误回收）；上传不承担惰性清扫的权威触发，flush 同键入帧路径顺带即可
	mode := "open"
	if !open {
		now := time.Now()
		hold := s.direct.holdOf(sh.Token, sh.TerminalID, now)
		s.flushReleasedHolds(sh)
		if visitorID == "" || hold == nil || hold.VisitorID != visitorID {
			// 403 而非 404：通道在场已由页面可见，「这里的 403」不新增探测面
			//（403 只向已过口令门的持链访客确认持权态，direct_denied 语义同
			// 旧 POST 端点/WS input_denied 帧）
			writeJSONErrorStatus(w, http.StatusForbidden, "direct_denied")
			return
		}
		s.direct.touch(sh.Token, now)
		mode = "hold"
	}
	// 字段分派（主人端 UploadPasteImage 同形：file 优先、缺省回落 image——
	// ErrMissingFile 判别「字段不存在」，字段在但解析失败如实回告不静默换字段）
	file, header, err := r.FormFile("file")
	if err != nil {
		if errors.Is(err, http.ErrMissingFile) {
			file, header, err = r.FormFile("image")
			if err != nil {
				writeJSONErrorStatus(w, http.StatusBadRequest, "no_file")
				return
			}
			s.writePasteUploadFile(w, r, sh, file, header, visitorID, nick, mode, "image", lim)
			return
		}
		writeJSONErrorStatus(w, http.StatusBadRequest, "invalid_request")
		return
	}
	s.writePasteUploadFile(w, r, sh, file, header, visitorID, nick, mode, "file", lim)
}

// writePasteUploadFile 校验 + 落盘 + 响应 + 副作用旁路（审计/敏感名 note/ops
// 广播）。kind 仅用于校验分档与审计语境（image 截图 blob 按内容形态 / file
// 白名单文件按扩展名），两形态规则各自独立（主人端同构）
func (s *Service) writePasteUploadFile(w http.ResponseWriter, r *http.Request, sh *store.Share,
	file multipart.File, header *multipart.FileHeader, visitorID, nick, mode, kind string, lim pastetmp.Limit) {
	var ext string
	switch kind {
	case "file":
		if header.Size > lim.FileMB*1024*1024 {
			writeJSONErrorStatus(w, http.StatusBadRequest, "too_large")
			return
		}
		ext = strings.ToLower(filepath.Ext(header.Filename))
		if !pasteFileAllowedExts[ext] {
			writeJSONErrorStatus(w, http.StatusBadRequest, "unsupported_type")
			return
		}
	default: // image：Content-Type 四类精确白名单（P-20261122-18 ⑦ 真执行：
		// 四类之外 400 unsupported_type。旧实现对其余 CT 静默落 .png——扩展名
		// 不可信时落盘即产生「名字说 png、内容是别的」的文件交给主机 shell，
		// 且与头注白名单承诺不符。CT 归一：去参数（; charset=…）+ 小写，
		// 浏览器 blob 上传实际不带参数，这里兼容非浏览器客户端的合法形态）
		if header.Size > lim.ImageMB*1024*1024 {
			writeJSONErrorStatus(w, http.StatusBadRequest, "too_large")
			return
		}
		ct := strings.ToLower(strings.TrimSpace(header.Header.Get("Content-Type")))
		if i := strings.IndexByte(ct, ';'); i >= 0 {
			ct = strings.TrimSpace(ct[:i])
		}
		switch ct {
		case "image/png":
			ext = ".png"
		case "image/jpeg":
			ext = ".jpg"
		case "image/gif":
			ext = ".gif"
		case "image/webp":
			ext = ".webp"
		default:
			writeJSONErrorStatus(w, http.StatusBadRequest, "unsupported_type")
			return
		}
	}
	// 落盘：pastetmp 独占命名（O_EXCL 防同毫秒碰撞/共享 /tmp symlink 劫持），
	// 半途失败删半成品（drops.go 同纪律——不留残骸）
	dst, fullPath, err := pastetmp.Create(os.TempDir(), pastetmp.Name(ext))
	if err != nil {
		writeJSONErrorStatus(w, http.StatusInternalServerError, "internal_error")
		return
	}
	n, cerr := io.Copy(dst, file)
	if cerr != nil {
		dst.Close()
		_ = os.Remove(fullPath)
		writeJSONErrorStatus(w, http.StatusInternalServerError, "internal_error")
		return
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(fullPath)
		writeJSONErrorStatus(w, http.StatusInternalServerError, "internal_error")
		return
	}
	// Windows 路径反斜杠在 shell 里需要转义；统一返回正斜杠（主人端同惯例
	// ——访客贴进终端的路径要能被主机的 shell 直接消费）
	path := fullPath
	if runtime.GOOS == "windows" {
		path = filepath.ToSlash(fullPath)
	}
	now := time.Now()
	name := SanitizeDropFileName(header.Filename)
	// 副作用旁路（元数据口径）：审计攒批 + 敏感名命中才发 note + ops 广播
	//（views/notes 内存攒批由装配层 share-flush tick 批量入账；广播是非阻塞
	// 队列投递——访客响应路径零落盘第二笔）
	s.views.Add(store.AuditEvent{
		Action: store.AuditSharePasteUpload,
		Result: store.AuditResultSuccess,
		Time:   now,
		IP:     clientIPOf(r),
		Detail: fmt.Sprintf("%s (%s), visitor %s uploaded %s (%d bytes) mode=%s -> session %s",
			sh.Name, sh.Token, visitorBrief(visitorID), name, n, mode, sh.TerminalID),
	})
	if IsSensitiveName(name) {
		s.notes.Add(pasteUploadNote(sh, name, n, nick, now))
	}
	if s.pasteUploadEvents != nil {
		s.pasteUploadEvents(PasteUploadEvent{
			Token:       sh.Token,
			ShareName:   sh.Name,
			TerminalID:  sh.TerminalID,
			Name:        name,
			Size:        n,
			Mode:        mode,
			Nick:        nick,
			VisitorTail: visitorBrief(visitorID),
			At:          now.UnixMilli(),
		})
	}
	writeJSON(w, map[string]any{
		"data": map[string]any{"path": path, "size": n},
	})
}

// pasteUploadNote 构造粘贴上传到达通知（dropNote 同款：模板键 + 参数供前端
// 按界面语言渲染，Title/Body 中文原文兜底无模板消费方）。类别 system——
// drop 类别语义是协作素材到达（有「交给会话」动作链），本件语义是「可写
// 访客上传了敏感名文件」的出域警示，静音粒度不混淆；无行内动作（文件已在
// 主机临时目录，终端里看得见路径——感知面是 audit+toast+note 三路）
func pasteUploadNote(sh *store.Share, name string, size int64, nick string, at time.Time) notification.Notification {
	return notification.Notification{
		Type:     "warning",
		Category: notification.CategorySystem,
		TitleKey: "share.writable.notify.pasteUpload.title",
		BodyKey:  "share.writable.notify.pasteUpload.body",
		Title:    "访客粘贴上传了敏感名文件",
		Body:     "「" + sh.Name + "」" + displayNick(nick) + " 上传了 " + name + "（" + FmtSize(size) + "）到主机临时目录",
		Time:     at,
		MsgParams: map[string]any{
			"name": sh.Name, "file": name, "nick": displayNick(nick), "size": size,
		},
	}
}
