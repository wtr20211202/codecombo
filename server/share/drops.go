package share

// 分享协作通道——访客素材上行（P-20261024-1）：终端直播访客页的「粘贴/拖入/
// 点击」三入口直达会话的收件位。开的是「素材上行通道」，不是原始终端操作权
// ——匿名访客仍然拿不到任何按键回传通道（termpage.go 严格只读三层保证不变）：
//
//   - 开关即门禁：Share.Collab 缺省关，关闭时端点恒 404（与「端点不存在」
//     不可区分，退役短链同款语义——存在性不可探测）；开启才暴露。
//   - 落位隔离：素材住车道 2 隔离区 <DataDir>/artifacts/share-drops/<token>/
//     （per-share 收件目录），访客永远触不到项目目录；文件名经净化链
//     （单段化 + 保留名改写）后经 os.Root 落盘——防穿越是物理边界不是约定。
//   - 护栏全家桶：类型白名单（图片四类 + 常见文档/文本/压缩族）× 大小上限
//     （图片 ≤10MB 对齐 UploadPasteImage，文件 ≤20MB）× 单批 ≤5 个 × per-share
//     磁盘配额 × (token,IP)+token 全局双维频控（msgRateLimiter 同款复用）。
//     敏感文件名命中只警示不阻断（素材是「主人要看的现场」，警示随响应与
//     审计如实呈现，处置权在主人）。
//   - TTL 消费语义：交给会话即标已消费（管理面 consume 端点），已消费 24h
//     清、未消费 72h 清——防主人未看即被清；分享撤销/过期级联清（shareapi
//     清账管线 + 孤儿对账，快照同通道）。
//   - 响应零路径泄露：访客只拿成功态+净化文件名；绝对路径只在主人侧清单
//     （GET /api/share/:token/drops）出现。

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"codecombo/server/config"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/store"
)

const (
	// MaxDropImageBytes 图片素材上限：对齐 UploadPasteImage 的 10MB 护栏
	//（截图通常 <2MB，留余量）
	MaxDropImageBytes = 10 << 20
	// MaxDropFileBytes 文件素材上限：报障现场常见的日志/压缩包量级封顶，
	// 更大的产物请主人走正常文件传输通道
	MaxDropFileBytes = 20 << 20
	// MaxDropBatchFiles 单批上限：一次 Ctrl+V 贴几张截图 / 拖几个文件的
	// 正常量级；上限防把上传端点当批量镜像通道
	MaxDropBatchFiles = 5

	// MaxDropPerShareBytes 单条分享的收件配额（车道 2 per-share 隔离区）：
	// 对齐冻结快照单份 200MB 护栏，触顶 413 劝退——配额是磁盘滥用三闸之一
	//（配额+TTL+限流）
	MaxDropPerShareBytes = 200 << 20

	// DropConsumedTTL 已消费素材的保留窗口：交给会话即标（主人已取走），
	// 24h 清——消费语义要求「未消费的更久」而非「消费了的更久」；agent 已
	// 读到路径，素材本体的使命在交给会话时完成
	DropConsumedTTL = 24 * time.Hour
	// DropUnconsumedTTL 未消费素材的保留窗口：72h 覆盖「测试周五贴图、
	// 主人周一上班处理」的真实协作节奏（防主人未看即被清）
	DropUnconsumedTTL = 72 * time.Hour

	// dropBodyLimit 上传请求体封顶：5×20MB 文件 + multipart 编码开销余量
	//（在解析前置位——超大请求体在逐文件校验前已付出代价）
	dropBodyLimit = int64(112) << 20

	// dropNameMaxRunes 净化文件名的 rune 上限：保留判读信息，防超长名把
	// 文件系统/清单展示面撑爆
	dropNameMaxRunes = 120

	// dropMaxPerIP / dropMaxPerToken 上行频控：素材上传比留言重一个量级，
	// 每 (token,IP) 每分钟 10 批（正常访客贴几张截图远够）、token 全局每
	// 分钟 60 批防多 IP 合围；校验先于计数（垃圾载荷不消耗配额）
	dropMaxPerIP    = 10
	dropMaxPerToken = 60
	dropWindow      = time.Minute

	// dropSidecarNameLimit sidecar 元数据读取的字节上限（单条元数据远小于此，
	// 防损坏文件把读取面放大）
	dropSidecarNameLimit = 64 << 10
)

// dropSidecarSuffix sidecar 元数据文件后缀（清单枚举据此排除）
const dropSidecarSuffix = ".json"

// ratePair 双维固定窗口频控（msgRateLimiter 的参数化通用形态）：perIP 按
// (token, IP) 维度、perToken 按 token 全局维度——访客面写入端点的标准
// 护栏形状（留言/上传/直通握手三面共用一个实现，参数各自独立）
type ratePair struct {
	perIP    *middleware.RateLimiter
	perToken *middleware.RateLimiter
	maxIP    int
	maxToken int
}

func newRatePair(perIP, perToken int, window time.Duration) *ratePair {
	return &ratePair{
		perIP:    middleware.NewRateLimiter(perIP, window),
		perToken: middleware.NewRateLimiter(perToken, window),
		maxIP:    perIP,
		maxToken: perToken,
	}
}

func (m *ratePair) allow(token string, r *http.Request) bool {
	if m == nil {
		return true
	}
	key := token + "\x00" + guestClientIP(r)
	if m.perIP.IsLimited(key) || m.perToken.IsLimited(token) {
		return false
	}
	return m.perIP.Hit(key) <= m.maxIP && m.perToken.Hit(token) <= m.maxToken
}

func (m *ratePair) retryAfter(token string, r *http.Request) int {
	if m == nil {
		return 0
	}
	end := m.perIP.ExpireAt(token + "\x00" + guestClientIP(r))
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

// dropImageExts 图片族（UploadPasteImage 同表：png/jpg/jpeg/gif/webp）——
// 大小走 10MB 档，访客页相机直拍/贴图的主形态
var dropImageExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true,
}

// dropFileExts 常见文档/文本/压缩族白名单：报障现场的日志、配置、导出件
// 与打包产物。白名单是显式 allowlist 不是 denylist——未列出的扩展名一律
// 拒（可执行/脚本/凭据族天然不在表内，类型面先收窄一半）
var dropFileExts = map[string]bool{
	".pdf": true, ".doc": true, ".docx": true, ".xls": true, ".xlsx": true,
	".ppt": true, ".pptx": true, ".md": true, ".txt": true, ".log": true,
	".csv": true, ".tsv": true, ".json": true, ".xml": true, ".yaml": true,
	".yml": true, ".ini": true, ".conf": true, ".zip": true, ".7z": true,
	".tar": true, ".gz": true, ".tgz": true,
}

// dropKindFor 扩展名 → 形态与大小上限（"" = 白名单外，拒收）
func dropKindFor(ext string) (kind string, maxBytes int64) {
	if dropImageExts[ext] {
		return "image", MaxDropImageBytes
	}
	if dropFileExts[ext] {
		return "file", MaxDropFileBytes
	}
	return "", 0
}

// windowsReservedNames Windows 保留设备名（不分大小写；带扩展名的词干同样
// 保留——净化链在此改写，三平台纪律：落盘名在所有平台都安全）
var windowsReservedNames = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
	"com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
	"lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

// sanitizeDropFileName 上传文件名净化（落盘名的唯一权威实现）：取末段
// （剥路径分隔符与盘符——multipart filename 可能带客户端全路径）、控制
// 字符折叠为空格、剥首尾空白与点（Windows 尾点/尾空格静默丢失、首点藏
// 文件）、Windows 保留名词干 "_" 前缀改写、rune 截断、空名回退 "file"。
// 产出恒为单段安全名（无分隔符——os.Root 落盘无穿越面，且管理面取绝对
// 路径时无拼接受污染输入）
func sanitizeDropFileName(name string) string {
	if idx := strings.LastIndexAny(name, "/\\"); idx >= 0 {
		name = name[idx+1:]
	}
	// 裸盘符前缀兜底（有分隔符时末段已剥，这里处理 "C:report.png" 形态）
	if len(name) >= 2 && name[1] == ':' {
		name = name[2:]
	}
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, name)
	// 只剥尾部的点与空格（Windows 尾点/尾空格静默丢失）；**保留首点**——
	// 点头是 unix 隐藏文件的合法名字（.env 族密钥文件名），剥掉会既改写
	// 用户素材名、又绕过敏感文件名扫描（IsSensitiveName 的 .env* 表）
	name = strings.TrimRight(name, " .")
	name = strings.TrimLeft(name, " ")
	if !utf8.ValidString(name) {
		name = strings.ToValidUTF8(name, string(utf8.RuneError))
	}
	if runes := []rune(name); len(runes) > dropNameMaxRunes {
		name = string(runes[:dropNameMaxRunes])
	}
	stem := strings.ToLower(name)
	if i := strings.IndexByte(stem, '.'); i >= 0 {
		stem = stem[:i]
	}
	if windowsReservedNames[stem] {
		name = "_" + name
	}
	if name == "" {
		name = "file"
	}
	return name
}

// DropMeta 一条已收素材的元数据（sidecar JSON 与清单投影共用形态）。
// 素材本体是车道 2 隔离区文件，元数据是同目录 sidecar——sidecar 缺失/损坏
// 的素材在清单里跳过（孤儿对账兜底清尸）
type DropMeta struct {
	// ID 收件标识（纳秒时间戳十进制串，per-share 目录内唯一）
	ID string `json:"id"`
	// FileName 落盘名（<id>_<净化名>；id 前缀防同名覆盖）——只在主人侧
	// 清单出现，访客面响应剥除
	FileName string `json:"fileName,omitempty"`
	// Name 净化后的展示名（访客响应与通知/清单共用的唯一对外名——不回传
	// 客户端原始 filename，路径/盘符信息不外泄）
	Name string `json:"name"`
	// Size 素材字节数
	Size int64 `json:"size"`
	// Kind 形态：image | file（清单/通知的展示徽标）；rejected 仅供上传
	// 响应内的「被拒」占位（不落盘不进清单）
	Kind string `json:"kind"`
	// Nick 访客自报昵称（可选；沿用留言板昵称清洗与上限）
	Nick string `json:"nick,omitempty"`
	// At 收件时点（未消费 TTL 起算锚）
	At time.Time `json:"at"`
	// ConsumedAt 已消费时点（交给会话即标；零值 = 未消费，已消费 TTL 起算锚）
	ConsumedAt time.Time `json:"consumedAt,omitempty"`
	// Sensitive 敏感文件名扫描命中（警示注记：主人侧清单橙标，处置权在主人）
	Sensitive bool `json:"sensitive,omitempty"`
}

// DropsRoot 访客素材隔离区根（车道 2：<DataDir>/artifacts/share-drops/；
// 快照隔离区 share-snapshots 的兄弟目录）
func DropsRoot() string {
	return filepath.Join(config.DataDir(), "artifacts", "share-drops")
}

// dropDirFor 单条分享的收件目录（token 即目录名——token 是 16 位 base36
// 短链标识，作目录名无穿越面；写盘只发生在 lookup 已验证记录之后）
func dropDirFor(token string) string {
	return filepath.Join(DropsRoot(), token)
}

// listDrops 该分享的收件清单（新到旧；sidecar 缺失/损坏的条目跳过——
// 清单不给坏条目）。limit ≤0 = 不限（收件量级被配额护栏钉在 200MB 内，
// 全量返回是管理面/访客页的正常态）
func listDrops(token string, limit int) []DropMeta {
	dir := dropDirFor(token)
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil
	}
	defer root.Close()
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return nil
	}
	out := make([]DropMeta, 0, len(entries)/2+1)
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, dropSidecarSuffix) {
			continue
		}
		f, err := root.Open(name)
		if err != nil {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(f, dropSidecarNameLimit))
		f.Close()
		if err != nil {
			continue
		}
		var m DropMeta
		if json.Unmarshal(data, &m) != nil || m.ID == "" || m.Name == "" {
			continue
		}
		out = append(out, m)
	}
	// 新到旧（At 降序的插入排序——量级为个位数到几十，排序代价可忽略）
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].At.After(out[j-1].At); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// dropDirBytes 收件目录字节量（配额判定用；目录不存在 = 0）。目录规模被
// 配额护栏钉住，walk 代价可控；上传是低频动作
func dropDirBytes(token string) int64 {
	total, _ := dirTotalBytes(DropsRoot(), token)
	return total
}

// markDropConsumed 标记素材已消费（交给会话即标——TTL 消费语义的落盘点）。
// sidecar RMW：读→覆写 ConsumedAt→写回；已标幂等跳过（首标时点是 TTL 锚，
// 重复点击不得续期——与幂等重建不续期同纪律）。未消费标记丢失的后果只是
// 多留 48h，无害方向
func markDropConsumed(token, id string, at time.Time) error {
	dir := dropDirFor(token)
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	meta, sidecar, err := readDropMeta(root, id)
	if err != nil {
		return err
	}
	if !meta.ConsumedAt.IsZero() {
		return nil
	}
	meta.ConsumedAt = at
	data, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	sf, err := root.Create(sidecar)
	if err != nil {
		return err
	}
	if _, err := sf.Write(data); err != nil {
		sf.Close()
		return err
	}
	return sf.Close()
}

// deleteDrop 主人单删素材（本体+sidecar 同删；未知 id 幂等成功——dismiss
// 语义，quickdrop 删除同款）
func deleteDrop(token, id string) error {
	dir := dropDirFor(token)
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil // 目录不在 = 已清
	}
	defer root.Close()
	_, sidecar, err := readDropMeta(root, id)
	if err != nil {
		return nil
	}
	_ = root.Remove(sidecar)
	_ = root.Remove(strings.TrimSuffix(sidecar, dropSidecarSuffix))
	return nil
}

// readDropMeta 按 id 读 sidecar 元数据，返回 (meta, sidecar 文件名)。
// sidecar 名 = <id>_<净化名>.json——id 前缀 + 后缀双锚定位（纳秒 id 在
// 目录内唯一，同前缀双文件是理论不可能的竞态，取首个）
func readDropMeta(root *os.Root, id string) (*DropMeta, string, error) {
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return nil, "", err
	}
	prefix := id + "_"
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, dropSidecarSuffix) {
			continue
		}
		f, err := root.Open(name)
		if err != nil {
			return nil, "", err
		}
		data, err := io.ReadAll(io.LimitReader(f, dropSidecarNameLimit))
		f.Close()
		if err != nil {
			return nil, "", err
		}
		var m DropMeta
		if json.Unmarshal(data, &m) != nil {
			return nil, "", fs.ErrInvalid
		}
		return &m, name, nil
	}
	return nil, "", fs.ErrNotExist
}

// gcOrphanDrops 孤儿对账（快照孤儿对账 GcOrphanSnapshots 同通道）：keep =
// 存活分享 token 集，集外收件目录删除（撤销/过期清账的兜底——记录侧删除
// 与目录侧删除是两个落盘点，崩溃窗口的孤儿在这里收口）。keep 为 nil 时
// 拒绝清账（防误删全库，GcOrphanSnapshots 同款守卫）
// GcOrphanDrops 孤儿对账导出面（装配层清账管线调用；gcOrphanDrops 的
// 导出别名——快照侧 GcOrphanSnapshots 同款命名）
func GcOrphanDrops(keep map[string]bool, logger *slog.Logger) int {
	return gcOrphanDrops(keep, logger)
}

// CleanExpiredDrops TTL 消费清理导出面（装配层 ticker 调用）
func CleanExpiredDrops(now time.Time, logger *slog.Logger) int {
	return cleanExpiredDrops(now, logger)
}

func gcOrphanDrops(keep map[string]bool, logger *slog.Logger) int {
	if keep == nil {
		return 0
	}
	root, err := os.OpenRoot(DropsRoot())
	if err != nil {
		return 0
	}
	defer root.Close()
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return 0
	}
	removed := 0
	for _, e := range entries {
		if !e.IsDir() || keep[e.Name()] {
			continue
		}
		if err := root.RemoveAll(e.Name()); err == nil {
			removed++
		}
	}
	if removed > 0 && logger != nil {
		logger.Warn("share drops gc removed orphan dirs", "removed", removed)
	}
	return removed
}

// cleanExpiredDrops TTL 消费语义的清理任务（装配层 ticker 调用）：已消费
// 24h 清、未消费 72h 清；清空的目录一并移除（隔离区紧凑）。sidecar 缺失的
// 裸文件（崩溃残骸）按文件 mtime 以未消费口径处理
func cleanExpiredDrops(now time.Time, logger *slog.Logger) int {
	root, err := os.OpenRoot(DropsRoot())
	if err != nil {
		return 0
	}
	defer root.Close()
	tokens, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return 0
	}
	removed := 0
	for _, t := range tokens {
		if !t.IsDir() {
			continue
		}
		token := t.Name()
		dir, err := root.OpenRoot(token)
		if err != nil {
			continue
		}
		live := 0
		entries, err := fs.ReadDir(dir.FS(), ".")
		if err != nil {
			dir.Close()
			continue
		}
		for _, e := range entries {
			name := e.Name()
			if strings.HasSuffix(name, dropSidecarSuffix) {
				continue // sidecar 随本体判定/删除，不独立计时
			}
			var cutoff time.Time
			if meta, _, err := readDropMeta(dir, sidecarID(name)); err == nil {
				if !meta.ConsumedAt.IsZero() {
					cutoff = meta.ConsumedAt.Add(DropConsumedTTL)
				} else {
					cutoff = meta.At.Add(DropUnconsumedTTL)
				}
			} else {
				info, ierr := e.Info()
				if ierr != nil {
					continue
				}
				cutoff = info.ModTime().Add(DropUnconsumedTTL)
			}
			if now.After(cutoff) {
				_ = dir.Remove(name)
				_ = dir.Remove(name + dropSidecarSuffix)
				removed++
				continue
			}
			live++
		}
		dir.Close()
		if live == 0 {
			_ = root.RemoveAll(token)
		}
	}
	if removed > 0 && logger != nil {
		logger.Warn("share drops ttl cleanup", "removed", removed)
	}
	return removed
}

// sidecarID 落盘名 → 收件 id（"<id>_<name>" 的 id 段）
func sidecarID(fileName string) string {
	if i := strings.IndexByte(fileName, '_'); i > 0 {
		return fileName[:i]
	}
	return fileName
}

// ── 访客端点 ──

// handleGuestDropPost POST /s/{token}/drop（gateGuard 后）：访客素材上行。
// 校验链：协作开关门禁（关 → 404 share_not_found）→ 频控 → multipart 解析
// （体封顶）→ 数量 ≤5 → 逐文件：扩展名白名单 → 形态大小上限 → 文件名净化
// → 配额 → 敏感名警示 → os.Root 落位。响应只回成功态+净化名（零路径泄露）；
// 通知/审计/ops 广播为副作用旁路（元数据口径，访客响应路径零落盘第二笔）。
// 多文件部分被拒时：可达的照收，被拒的在响应 added 内以 kind=rejected 占位
// （id 空 = 未落盘）——访客按 kind 分支呈现失败文案，单文件可重传，不搞
// 全批回滚的假原子
func (s *Service) handleGuestDropPost(w http.ResponseWriter, r *http.Request) {
	sh, herr := s.lookup(r, r.PathValue("token"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	if !sh.Collab {
		// 开关关闭 = 端点不存在（存在性不可探测，retired 短链同款语义）——
		// 不是 403：403 会向无权访客确认「这里有功能」
		writeJSONErrorStatus(w, http.StatusNotFound, "share_not_found")
		return
	}
	if !s.dropLimit.allow(sh.Token, r) {
		if ra := s.dropLimit.retryAfter(sh.Token, r); ra > 0 {
			w.Header().Set("Retry-After", strconv.Itoa(ra))
		}
		writeJSONErrorStatus(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, dropBodyLimit)
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeJSONErrorStatus(w, http.StatusRequestEntityTooLarge, "too_large")
			return
		}
		writeJSONErrorStatus(w, http.StatusBadRequest, "invalid_request")
		return
	}
	nick := sanitizeGuestNickname(r.FormValue("nickname"))
	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		writeJSONErrorStatus(w, http.StatusBadRequest, "no_files")
		return
	}
	if len(files) > MaxDropBatchFiles {
		writeJSONErrorStatus(w, http.StatusBadRequest, "too_many_files")
		return
	}
	quotaUsed := dropDirBytes(sh.Token)
	now := time.Now()
	// 批内唯一 id 发放器：time.Now() 在快循环里可能同值（Windows 计时精度），
	// id 撞车会让 readDropMeta 的前缀定位拿到别人的 sidecar——发号器保证
	// 批内严格递增（纳秒基座 + 撞车即 +1 的纯十进制推进）
	idSeq := now.UnixNano()
	nextID := func() string {
		idSeq++
		return strconv.FormatInt(idSeq, 10)
	}
	added := make([]DropMeta, 0, len(files))
	warnings := make([]string, 0, 1)
	for _, fh := range files {
		ext := strings.ToLower(filepath.Ext(fh.Filename))
		kind, maxBytes := dropKindFor(ext)
		name := sanitizeDropFileName(fh.Filename)
		if kind == "" || fh.Size > maxBytes {
			// 白名单外/超限：拒绝位（不消耗配额不落盘，访客拿到逐文件失败态）
			added = append(added, DropMeta{Name: name, Kind: "rejected"})
			continue
		}
		if quotaUsed+fh.Size > MaxDropPerShareBytes {
			// 配额触顶整批收尾（后续文件必然同顶）：413 劝退已收的保留——
			// 拆批重传是唯一出路，响应错误码即前端文案契约
			writeJSONErrorStatus(w, http.StatusRequestEntityTooLarge, "drop_quota")
			return
		}
		dir := dropDirFor(sh.Token)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			writeJSONErrorStatus(w, http.StatusInternalServerError, "internal_error")
			return
		}
		root, rerr := os.OpenRoot(dir)
		if rerr != nil {
			writeJSONErrorStatus(w, http.StatusInternalServerError, "internal_error")
			return
		}
		id := nextID()
		fileName := id + "_" + name
		dst, cerr := root.Create(fileName)
		if cerr != nil {
			root.Close()
			writeJSONErrorStatus(w, http.StatusInternalServerError, "internal_error")
			return
		}
		src, err := fh.Open()
		if err != nil {
			dst.Close()
			root.Close()
			writeJSONErrorStatus(w, http.StatusBadRequest, "invalid_request")
			return
		}
		// 流式拷贝（io.Copy 32KB 缓冲——20MB 素材不整包进内存）；半途失败
		// 删半成品（防配额统计与清单被残骸污染）
		n, cerr := io.Copy(dst, src)
		src.Close()
		if cerr != nil {
			dst.Close()
			_ = root.Remove(fileName)
			root.Close()
			writeJSONErrorStatus(w, http.StatusInternalServerError, "internal_error")
			return
		}
		if err := dst.Close(); err != nil {
			_ = root.Remove(fileName)
			root.Close()
			writeJSONErrorStatus(w, http.StatusInternalServerError, "internal_error")
			return
		}
		root.Close()
		meta := &DropMeta{
			ID: id, FileName: fileName, Name: name, Size: n, Kind: kind,
			Nick: nick, At: now, Sensitive: IsSensitiveName(name),
		}
		if err := writeDropSidecar(dir, meta); err != nil {
			// 本体已落、元数据失败：删本体重来（宁失败不留「清单可见而文件
			// 缺失」的坏条目——访客重传是干净路径）
			_ = os.Remove(filepath.Join(dir, fileName))
			writeJSONErrorStatus(w, http.StatusInternalServerError, "internal_error")
			return
		}
		quotaUsed += n
		added = append(added, *meta)
		if meta.Sensitive {
			warnings = append(warnings, meta.Name)
		}
		// 副作用旁路（元数据口径）：审计攒批 + 通知中心攒批 + ops 广播
		//（views/notes 都是内存攒批由装配层 3s flush 入账，广播是非阻塞
		// 队列投递——访客响应路径零落盘）
		s.views.Add(store.AuditEvent{
			Action: store.AuditShareDrop,
			Result: store.AuditResultSuccess,
			Time:   now,
			IP:     clientIPOf(r),
			Detail: fmt.Sprintf("%s (%s), file: %s, %d bytes, kind: %s, nick: %s%s",
				sh.Name, sh.Token, meta.Name, meta.Size, meta.Kind, displayNick(nick), sensitiveNote(meta.Sensitive)),
		})
		s.notes.Add(dropNote(sh, meta))
		if s.dropEvents != nil {
			s.dropEvents(DropEvent{
				Token: sh.Token, ShareName: sh.Name, TerminalID: sh.TerminalID,
				ID: meta.ID, Name: meta.Name, Size: meta.Size, Kind: meta.Kind, Nick: nick,
			})
		}
	}
	writeJSON(w, map[string]any{"added": added, "warnings": warnings})
}

// writeDropSidecar 落 sidecar 元数据（os.Root 同锚定；本体已在盘后才写——
// sidecar 在场即清单可见，本体先于 sidecar 保证无坏条目）
func writeDropSidecar(dir string, meta *DropMeta) error {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	data, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	sf, err := root.Create(meta.FileName + dropSidecarSuffix)
	if err != nil {
		return err
	}
	if _, err := sf.Write(data); err != nil {
		sf.Close()
		return err
	}
	return sf.Close()
}

// sensitiveNote 审计 Detail 的敏感名命中注记
func sensitiveNote(hit bool) string {
	if hit {
		return ", sensitive-name"
	}
	return ""
}

// displayNick 审计/通知共用的昵称展示（空 = 匿名占位）
func displayNick(nick string) string {
	if nick == "" {
		return guestNoteAnonNick
	}
	return nick
}

// handleGuestDropsGet GET /s/{token}/drops（gateGuard 后）：该分享的收件
// 清单（访客可见版——id/净化名/大小/昵称/时点/消费态；落盘名与绝对路径
// 只在主人侧管理面出现）。访客页上传位以此恢复完成态（刷新/重开不丢
// 「我传过了」的事实）
func (s *Service) handleGuestDropsGet(w http.ResponseWriter, r *http.Request) {
	sh, herr := s.lookup(r, r.PathValue("token"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	if !sh.Collab {
		writeJSONErrorStatus(w, http.StatusNotFound, "share_not_found")
		return
	}
	list := listDrops(sh.Token, 0)
	out := make([]DropMeta, 0, len(list))
	for _, m := range list {
		m.FileName = "" // 落盘名不出访客面（内部命名细节）
		out = append(out, m)
	}
	writeJSON(w, map[string]any{"drops": out, "count": len(out)})
}

// DropEvent 素材到达的 ops 广播载荷（仅元数据：分享 id/文件名/大小/昵称
// ——内容不上广播面，terminal.message 同纪律；sc-ops:share.drop 直通分发）
type DropEvent struct {
	Token      string `json:"token"`
	ShareName  string `json:"shareName"`
	TerminalID string `json:"terminalId,omitempty"`
	ID         string `json:"id"`
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	Kind       string `json:"kind"`
	Nick       string `json:"nick,omitempty"`
}

// dropNote 构造素材到达通知（quickdrop 通知同款：模板键 + 行内动作双出口；
// Action=payload "shdrop:<token>:<id>"——前端「交给当前会话/新会话处理」
// 消费链据此回查主人侧清单取绝对路径）
func dropNote(sh *store.Share, meta *DropMeta) notification.Notification {
	return notification.Notification{
		Type:     "info",
		Category: notification.CategoryDrop,
		TitleKey: "share.drop.notify.title",
		BodyKey:  "share.drop.notify.body",
		Title:    "分享收到访客素材",
		Body:     "「" + sh.Name + "」" + displayNick(meta.Nick) + " 上传了 " + meta.Name + "（" + fmtSize(meta.Size) + "）",
		Time:     meta.At,
		MsgParams: map[string]any{
			"name": sh.Name, "file": meta.Name, "nick": displayNick(meta.Nick), "size": meta.Size,
		},
		Action:              "shdrop-active",
		ActionPayload:       shDropPayload(sh.Token, meta.ID),
		SecondAction:        "shdrop-new",
		SecondActionPayload: shDropPayload(sh.Token, meta.ID),
	}
}

// shDropPayloadPrefix 行内动作载荷前缀（quickdrop: 前缀同款先例）
const shDropPayloadPrefix = "shdrop:"

// shDropPayload 行内动作载荷："shdrop:<token>:<id>"
func shDropPayload(token, id string) string { return shDropPayloadPrefix + token + ":" + id }

// parseShDropPayload 解析行内动作载荷 → (token, id)；异形载荷返回空
func parseShDropPayload(payload string) (token, id string) {
	if !strings.HasPrefix(payload, shDropPayloadPrefix) {
		return "", ""
	}
	rest := payload[len(shDropPayloadPrefix):]
	i := strings.IndexByte(rest, ':')
	if i <= 0 || i == len(rest)-1 {
		return "", ""
	}
	return rest[:i], rest[i+1:]
}

// fmtSize 通知体的字节量速览（KB/MB 一档小数；语言中立的数字+单位）
func fmtSize(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1fMB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1fKB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%dB", n)
	}
}

// share.drop 审计无独立缓冲——随 s.views（ViewAuditBuffer）与访客访问留痕
// 同批入账（装配层 FlushViewAudits 同一收口），零新增冲刷面

// ── 管理面导出面（server/api/share 消费；访客面函数不导出） ──

// ListDropsFor 该分享的收件清单（主人侧管理面用；访客面走
// handleGuestDropsGet——同源数据，访客响应剥落盘名）
func ListDropsFor(token string) []DropMeta { return listDrops(token, 0) }

// DropAbsPath 素材绝对路径（主人侧清单投影——「把绝对路径贴进所选会话」
// 动作链的取数点；访客面零路径泄露，界在此函数只被管理面调用）。
// 文件名已净化为单段安全名，Join 无受污染输入面
func DropAbsPath(token, fileName string) string {
	if fileName == "" {
		return ""
	}
	return filepath.Join(dropDirFor(token), fileName)
}

// ConsumeDrop 标记素材已消费（交给会话即标——TTL 消费语义的落盘点）
func ConsumeDrop(token, id string, at time.Time) error { return markDropConsumed(token, id, at) }

// DeleteDrop 主人单删素材（未知 id 幂等成功）
func DeleteDrop(token, id string) error { return deleteDrop(token, id) }

// DeleteDropsFor 撤销分享的收件目录级联清（「分享终止级联清」——素材生命
// 周期与分享一体；目录不存在幂等成功，删除失败残留由 GcOrphanDrops 对账兜底）
func DeleteDropsFor(token string) error {
	return os.RemoveAll(dropDirFor(token))
}
