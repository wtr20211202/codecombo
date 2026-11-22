package quickdrop

// 主人侧接收面（P-20261117-3）：P-20261117-2 两步让文件「投得进来」（multipart
// 流式上行 + 访客页产品化），本文件补「收得出去」的最后一环——缺此面则落盘
// = 黑洞（P-2 评审原判词）。三块：
//
//   - GET /api/quickdrop/dropfile/:id?fid= 逐文件下载（主人侧鉴权组；
//     attachment + octet-stream 附件红线，ServeContent 自带 Range）
//   - 收件箱清单的 files 投影（机器面结构化元数据：磁盘 sidecar 是单一事实
//     源，store.Quickdrop 五字段不扩——评审必改①裁决，免三源一致性负担）
//   - 摘除单条的落盘联动（即时回收 2GB token 配额 + 消除「已摘除条目文件在
//     TTL 窗内不可见占盘」；24h TTL GC 兜底不变）
//
// 条目 ↔ 文件的归属链：postDropMultipart 在收件箱 doc Add 成功后把 doc id
// 回填进各文件 sidecar（share.DropMeta.DropID）——文件落盘在先、doc 发号在
// 后，链只能后写；sidecar 缺链（升级窗口 ≤24h 的旧文件/回填失败）不进投影、
// 摘除不联动，下载仍按 fid 等值自证放行，TTL 到点 gcQuickdropFiles 一并收尸。
//
// token 目录解析（评审必改③钉死）：QuickdropTokenStore 仅存哈希无明文
// getter（store/quickdrop.go）——现役目录以「扫 quickdropFilesRoot + 逐目录
// Validate」解析（gcQuickdropFiles 同款），绝不为此加明文 getter（哈希-only
// 安全设计不破）。绝对路径只在主人侧鉴权面投影（DropAbsPath 纪律，drops.go
// 同构）——访客响应与通知面零路径泄露的口径不因本文件松动。

import (
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"codecombo/server/api/shared"
	"codecombo/server/share"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// qdFidQuery 下载端点的取件键参数名（?fid=<DropMeta.ID>）。取件键是 fid 不
// 是落盘名/条目内序号：落盘名 <id>_<净化名> 天然唯一，同批同名双文件靠 fid
// 消歧（评审必改②——?name= 对同批同名歧义，弃用）
const qdFidQuery = "fid"

// qdFileItem 收件箱清单的逐文件投影（List 扩展的机器面；id 即下载取件键 fid）
type qdFileItem struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	Kind      string `json:"kind"` // image | file
	Sensitive bool   `json:"sensitive,omitempty"`
	// AbsPath 落盘绝对路径（主人侧鉴权面内投影——「交给会话」把路径贴进
	// 会话 / 管理卡复制路径的取数点；访客面/通知面不出现本字段）
	AbsPath string `json:"absPath"`
}

// ── token 目录解析与 sidecar 扫描（投影/下载/摘除共用） ──

// qdActiveTokenDir 解析现役凭据的落盘目录名：token 是单例，至多一个子目录
// 名能通过 Validate（目录名 = 历史 token 明文，只存在文件系统这一处）。无
// 凭据/无目录 → ("", false)——调用方一律按「无文件面」幂等处理
func qdActiveTokenDir(st *store.Store) (string, bool) {
	if st == nil || st.QuickdropToken == nil {
		return "", false
	}
	root, err := os.OpenRoot(quickdropFilesRoot())
	if err != nil {
		return "", false
	}
	defer root.Close()
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return "", false
	}
	for _, e := range entries {
		if e.IsDir() && st.QuickdropToken.Validate(e.Name()) {
			return e.Name(), true
		}
	}
	return "", false
}

// qdSidecarEntry 扫描所得的一个 sidecar（本体落盘名 + 元数据）
type qdSidecarEntry struct {
	// bodyName 本体落盘名（sidecar 名去后缀——从目录枚举而来，不采信
	// sidecar 内容里的 FileName：损坏 sidecar 的字段是攻击者可写面，
	// Remove/Open 的目标恒取自 fs.ReadDir 枚举结果即零注入面）
	bodyName string
	meta     share.DropMeta
}

// qdScanSidecars 枚举目录内全部 sidecar（清单投影/摘除回收一次扫描共用）。
// sidecar 损坏/超限的条目跳过（readQdSidecar 兜底口径——清单不给坏条目）。
// 量级考量：sidecar 数 ≤ 上传频次 × 24h TTL 窗（30/min/IP + 配额四闸兜底，
// 实际数十~数百），每份 ≤64KB 读取上限、典型 ~300B，List/摘除是低频管理面，
// 全扫一遍无感
func qdScanSidecars(root *os.Root) []qdSidecarEntry {
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return nil
	}
	out := make([]qdSidecarEntry, 0, len(entries)/2+1)
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, share.DropSidecarSuffix) {
			continue
		}
		bodyName := strings.TrimSuffix(name, share.DropSidecarSuffix)
		meta, err := readQdSidecar(root, bodyName)
		if err != nil {
			continue
		}
		out = append(out, qdSidecarEntry{bodyName: bodyName, meta: *meta})
	}
	return out
}

// qdFilesByDrop 全隔离区 sidecar 按 dropId 批次链归组（List 投影用）。缺链
// sidecar（升级窗口旧文件/回填失败）不归组——清单只呈现可对账的面；键缺 =
// 前端拿到空 files（文本投递同形态）
func qdFilesByDrop(st *store.Store) map[string][]qdFileItem {
	out := make(map[string][]qdFileItem)
	dirName, ok := qdActiveTokenDir(st)
	if !ok {
		return out
	}
	root, err := os.OpenRoot(qdTokenDirFor(dirName))
	if err != nil {
		return out
	}
	defer root.Close()
	for _, sc := range qdScanSidecars(root) {
		if sc.meta.DropID == "" {
			continue
		}
		out[sc.meta.DropID] = append(out[sc.meta.DropID], qdFileItem{
			ID:        sc.meta.ID,
			Name:      sc.meta.Name,
			Size:      sc.meta.Size,
			Kind:      sc.meta.Kind,
			Sensitive: sc.meta.Sensitive,
			AbsPath:   filepath.Join(quickdropFilesRoot(), dirName, sc.bodyName),
		})
	}
	return out
}

// ── 下载端点 ──

// DownloadDropFile GET /api/quickdrop/dropfile/:id?fid=——逐文件下载（主人侧
// 鉴权组，router.go 快投递管理面同族）。链路：id 回查条目（过期/已摘除 →
// 404，与「不存在」不可区分——收件箱 Get 的惰性把守在此复用）→ 现役 token
// 目录解析 → fid 与 sidecar 清单等值匹配 → os.Root 锚定打开 → 附件头 +
// http.ServeContent（自带 Range 断点续传，share serveRaw 同款先例）。
//
// 附件形态是红线（P-20261116-7 先例）：Content-Type 恒 application/octet-
// stream + Content-Disposition attachment——上传素材（SVG/HTML 可藏脚）永不
// 内联渲染；头值经 shared.ContentDispositionFile 全站统一净化 helper 产出，
// 禁手拼（文件名是访客可控内容，自拼头是响应头注入面）
func DownloadDropFile(c *gin.Context) {
	st := store.Get()
	if st == nil {
		shared.Error(c, http.StatusInternalServerError, "internal error", nil)
		return
	}
	id := c.Param("id")
	fid := c.Query(qdFidQuery)
	if fid == "" {
		shared.Error(c, http.StatusBadRequest, "fid is required", nil)
		return
	}
	if _, err := st.Quickdrop.Get(id); err != nil {
		shared.Error(c, http.StatusNotFound, "drop not found", nil)
		return
	}
	dirName, ok := qdActiveTokenDir(st)
	if !ok {
		shared.Error(c, http.StatusNotFound, "file not found", nil)
		return
	}
	root, err := os.OpenRoot(qdTokenDirFor(dirName))
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "internal error", err)
		return
	}
	defer root.Close()
	meta, bodyName := qdMatchDropFile(root, id, fid)
	if meta == nil {
		shared.Error(c, http.StatusNotFound, "file not found", nil)
		return
	}
	f, err := root.Open(bodyName)
	if err != nil {
		// sidecar 在而本体已被 GC/清盘的竞态窗口：对消费面即「无此文件」
		shared.Error(c, http.StatusNotFound, "file not found", nil)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		shared.Error(c, http.StatusNotFound, "file not found", nil)
		return
	}
	c.Header("Content-Type", "application/octet-stream")
	c.Header("Content-Disposition", shared.ContentDispositionFile(meta.Name))
	http.ServeContent(c.Writer, c.Request, meta.Name, meta.At, f)
}

// qdMatchDropFile fid 等值匹配：落盘名前缀定位（fid 全局唯一 → 至多一个
// 候选 sidecar）→ sidecar 元数据等值复核（防前缀撞名）。批次链（DropID）
// 在场时强校验归属本条目——拿条目 A 的链接取条目 B 的文件不允许；缺链
// （升级窗口旧文件）按 fid 自证放行：同一主人鉴权面、同目录、同 24h TTL
// 窗，归属无从考据即不苛责，TTL 到点自然消亡
func qdMatchDropFile(root *os.Root, dropID, fid string) (*share.DropMeta, string) {
	entries, err := fs.ReadDir(root.FS(), ".")
	if err != nil {
		return nil, ""
	}
	prefix := fid + "_"
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, share.DropSidecarSuffix) {
			continue
		}
		bodyName := strings.TrimSuffix(name, share.DropSidecarSuffix)
		meta, err := readQdSidecar(root, bodyName)
		if err != nil || meta.ID != fid {
			continue
		}
		if meta.DropID != "" && meta.DropID != dropID {
			continue // 归属链在场但不指向本条目：不伺服
		}
		return meta, bodyName
	}
	return nil, ""
}

// ── 摘除联动 ──

// deleteDropFiles 摘除单条的落盘联动（P-20261117-3④）：按 sidecar 批次链
// （dropId 等值）逐文件 Remove 本体+sidecar——摘除即时回收 2GB token 配额，
// 消除「已摘除条目的文件在 TTL 窗内不可见占盘」。尽力而为：单文件失败不
// 阻断不回告（store 摘除已成功，响应语义不因磁盘残留改变）——残留由
// gcQuickdropFiles 的 24h TTL 对账兜底收尸，摘除与 GC 是同一终态的两条
// 路径。凭据已轮换/撤销（purgeQuickdropFiles 已清盘/目录不在册）时解析不到
// 现役目录，幂等无事发生
func deleteDropFiles(st *store.Store, dropID string) {
	dirName, ok := qdActiveTokenDir(st)
	if !ok {
		return
	}
	root, err := os.OpenRoot(qdTokenDirFor(dirName))
	if err != nil {
		return
	}
	defer root.Close()
	for _, sc := range qdScanSidecars(root) {
		if sc.meta.DropID != dropID {
			continue
		}
		_ = root.Remove(sc.bodyName)
		_ = root.Remove(sc.bodyName + share.DropSidecarSuffix)
	}
}
