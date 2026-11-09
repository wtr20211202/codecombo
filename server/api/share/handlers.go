package shareapi

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
	"unicode"

	"codecombo/server/api/shared"
	"codecombo/server/claudesessions"
	"codecombo/server/config"
	"codecombo/server/mask"
	"codecombo/server/middleware"
	"codecombo/server/recording"
	"codecombo/server/share"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

// shareKindLabel 审计摘要用的分享形态标注（语言中立）
func shareKindLabel(isDir bool) string {
	if isDir {
		return "dir"
	}
	return "file"
}

// ── 访问口令门（P-20261006-25）：创建可选 passphrase + 管理面改/移除 ──

// maxPassphraseBytes 请求口令字节上限：bcrypt 只消费前 72 字节（更长静默
// 截断=超出部分不参与保护，是 footgun）——入口处显式拒绝而非悄悄截断
const maxPassphraseBytes = 64

// hashPassphrase 口令 → bcrypt 哈希（落库勿明文，lock 域哈希惯例同源；
// DefaultCost 对创建/改口令这类管理面低频操作无感，对访客面错口令爆破
// 是天然节流）。空串 = 无口令，原样返回零迁移
func hashPassphrase(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	if len(plain) > maxPassphraseBytes {
		return "", fmt.Errorf("passphrase exceeds %d bytes", maxPassphraseBytes)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("hash passphrase: %w", err)
	}
	return string(hash), nil
}

// ── 管理接口 ──

type createShareReq struct {
	ProjectID string `json:"projectId" binding:"required"`
	Path      string `json:"path"`
	// Paths 多路径冻结分享（P-20261008-1）：非空 = N 个项目相对路径的集合
	// 单链（跨目录评审包）。MVP 仅 frozen 模式（path 与 paths 互斥；live
	// 多锚定根语义未定义 → 400）。集合顺序无关幂等（服务端排序去重后派生）
	Paths []string `json:"paths"`
	// Override 敏感文件警示的确认标记：true = 用户已在警示框确认仍要分享
	// （首次请求恒为 false；命中警告时响应不带 data，创建被拦下）
	Override bool `json:"override"`
	// Mode 分享模式（P-20261003-320）："" / "live" = 活视图（默认，访客内容
	// 实时读项目目录）；"frozen" = 冻结快照（创建时复制分享根到隔离目录，
	// 访客读副本——内容定格 + 敏感扫描即副本本身）。其他值 400
	Mode string `json:"mode"`
	// Passphrase 可选访问口令（P-20261006-25）：非空 = 分享加口令门（访客
	// 先过口令页再见内容，全子资源统一守卫）。落库为 bcrypt 哈希，明文不
	// 持久化；幂等命中既有记录时带新口令=改门、不带=保持既有门
	Passphrase string `json:"passphrase"`
	// Watermark 可选访客页溯源水印开关（P-20261005-193）：nil/缺省 = 开
	//（归因基线），显式 false = 关。落库为记录字段，访客页按记录渲染
	Watermark *bool `json:"watermark"`
	// ViewOnce 可选一次性查看开关（P-20261006-27，分享时限的次数维）：
	// true = 首位访客打开后进入 10 分钟宽限窗（store.ViewOnceGrace），窗后
	// 失效（访客 410 share_consumed 专页）。缺省 false = 常规分享（存量语义
	// 零变化）；与口令门正交可叠。frozen 模式不支持（400——定格留证语义与
	// 「看一眼即焚」相斥）
	ViewOnce bool `json:"viewOnce"`
	// ExpiresAt 可选有效期截止时点（P-20261020-5，RFC3339 绝对时点）。显式
	// 选择自定义日期时使用；过去时点不拒绝（语义即「立即可过期」，与既有
	// SetExpiry 同口径）。与 TTL 互斥
	ExpiresAt *time.Time `json:"expiresAt"`
	// TTL 可选有效期预设档位（P-20261020-5）：1h / 1d / 7d / 30d /
	// permanent（显式永久，可清掉 frozen 的 30 天默认）。缺省 = 未显式选择：
	// live 文件分享应用 settings.shareDefaultTTL（缺省永久），frozen 维持
	// 30 天默认。自定义日期走 ExpiresAt
	TTL string `json:"ttl"`
}

// watermarkOrDefault 请求水印开关 → 落库值：nil = 缺省开（任务书口径——
// 归因是安全基线，调用方不表态即回到基线），显式值原样
func watermarkOrDefault(p *bool) bool {
	return p == nil || *p
}

// resolveCreateExpiry 把创建请求的有效期选择翻译成落库时点（P-20261020-5）。
// 优先级与语义：
//   - expiresAt（自定义日期）优先，RFC3339 绝对时点；与 ttl 同时给出 → 400
//     （两个来源互相矛盾时静默择一会让调用方拿到非预期的窗口）
//   - ttl 预设：1h/1d/7d/30d 按当前时刻起算；permanent = 显式零值（frozen
//     的 30 天默认也可被显式清成永久，管理面 SetExpiry 同语义）
//   - 都未给 = 未显式选择：live 文件分享应用 settings.shareDefaultTTL
//     （缺省永久，存量行为零变化）；frozen 返回零值，由 store 落 30 天默认
//
// 返回值 explicit 标记「请求显式选择了有效期」：幂等命中既有记录时 store
// 保留旧 ExpiresAt 是安全边界（重复分享不得暗中续期/清窗），只有显式选择
// 才允许经 SetExpiry 覆写（见 applyExplicitExpiry）
func resolveCreateExpiry(req createShareReq, frozen bool) (time.Time, bool, error) {
	ttl := strings.TrimSpace(req.TTL)
	if req.ExpiresAt != nil && ttl != "" {
		return time.Time{}, false, fmt.Errorf("expiresAt and ttl are mutually exclusive")
	}
	if req.ExpiresAt != nil {
		return *req.ExpiresAt, true, nil
	}
	if ttl == "permanent" {
		return time.Time{}, true, nil
	}
	if ttl != "" {
		d, ok := config.ShareTTLDuration(ttl)
		if !ok {
			return time.Time{}, false, fmt.Errorf("invalid ttl (1h, 1d, 7d, 30d, permanent): %s", ttl)
		}
		return time.Now().Add(d), true, nil
	}
	if frozen {
		// 冻结副本的 30 天默认由 store.createFile 落（与旧客户端零变化）；
		// 显式 permanent 已在上方提前返回并走 applyExplicitExpiry 清窗
		return time.Time{}, false, nil
	}
	if d, ok := config.ShareTTLDuration(store.Get().Settings.Get().Server.ShareDefaultTTLOrDefault()); ok {
		return time.Now().Add(d), false, nil
	}
	return time.Time{}, false, nil
}

// applyExplicitExpiry 把显式有效期选择应用到刚创建的记录：新记录的 ExpiresAt
// 已由 store.Create 带入（相等即跳过）；幂等命中既有记录时 store 保留旧值，
// 这里经 SetExpiry 覆写（含显式 permanent 清窗）。未显式选择不动既有倒计时
func applyExplicitExpiry(st *store.Store, created *store.Share, expiresAt time.Time, explicit bool) (*store.Share, error) {
	if !explicit || created.ExpiresAt.Equal(expiresAt) {
		return created, nil
	}
	return st.Share.SetExpiry(created.Token, expiresAt)
}

// CreateShare POST /api/share —— 为项目内文件/目录生成短链（幂等：
// 同一目标恒返回同一 token，已存在时刷新名称/大小快照）。
// 创建前做敏感文件扫描（文件名级确定性匹配）：命中且未确认时响应仅带
// warnings（不创建），前端弹确认框、用户「仍然分享」后带 override 二次
// 请求才真正落库；响应恒附 warnings/scanTruncated 供展示。
// frozen 模式（P-20261003-320）：扫描对象是创建时复制的快照副本本身
// （所见即所扫）——先复制（双体积护栏：单份 200MB / 快照库总量 1GB，超限
// 拒绝并提示走 live），再对副本全量扫描；命中且未确认同样走警示+override
// 二次确认流（半成品副本随警告一并丢弃，确认后的二次请求重拷）
func CreateShare(c *gin.Context) {
	var req createShareReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request", err)
		return
	}
	frozen := false
	switch req.Mode {
	case "", "live":
	case "frozen":
		frozen = true
	default:
		shared.Error(c, http.StatusBadRequest, "invalid mode (live or frozen)", nil)
		return
	}
	// 一次性查看（P-20261006-27）与 frozen 互斥：冻结是「定格留证」语义
	//（副本默认留 30 天供反复查看），一次性是「看一眼即焚」——组合自相
	// 矛盾，显式 400 让 agent/前端可编程感知而非静默吞标志
	if frozen && req.ViewOnce {
		shared.Error(c, http.StatusBadRequest, "viewOnce is not supported for frozen mode", nil)
		return
	}
	// 有效期（P-20261020-5）：显式选择优先；未选择时 live 应用默认档、
	// frozen 维持 store 30 天默认。校验先于任何落盘/复制
	expiresAt, explicitExpiry, err := resolveCreateExpiry(req, frozen)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, err.Error(), nil)
		return
	}
	st := store.Get()
	proj, err := st.Project.GetByID(req.ProjectID)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "project not found", nil)
		return
	}
	// 多路径冻结分享（P-20261008-1）：paths 非空走集合链路（独立记录形态，
	// 与单路径分支零共享幂等键——单路径 batch 也不会复用单文件分享的短链）
	if len(req.Paths) > 0 {
		if req.Path != "" {
			shared.Error(c, http.StatusBadRequest, "path and paths are mutually exclusive", nil)
			return
		}
		if !frozen {
			shared.Error(c, http.StatusBadRequest, "paths requires frozen mode", nil)
			return
		}
		createBatchFrozenShare(c, st, proj, req)
		return
	}
	rel, err := share.NormalizeRelPath(req.Path)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid path", nil)
		return
	}
	target, err := share.StatTarget(proj.Path, rel)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "target not found: "+rel, nil)
		return
	}
	// 口令门（P-20261006-25）：哈希先行，明文只存在于本请求内
	passHash, err := hashPassphrase(req.Passphrase)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, err.Error(), nil)
		return
	}
	// 快照副本锚点（frozen 专用）：目录名 = 零代际派生 token（稳定键，
	// rotate 换链不动副本）；复制/扫描根/警示丢弃/幂等判断共用同一个值。
	// 幂等命中既有冻结链时跳过复制（冻结=不可变，重复分享不刷新副本），
	// 副本在盘才短路——记录在而副本丢失时走重拷修复，不给访客留坏链
	nativeToken := ""
	scanRoot, scanRel := proj.Path, rel
	if frozen {
		nativeToken = store.FrozenNativeToken(config.MasterKey(), req.ProjectID, rel)
		scanRoot, scanRel = share.SnapshotsRoot(), nativeToken
		if rel != "" {
			scanRel = nativeToken + "/" + rel
		}
		if existingFrozen(st, req.ProjectID, rel) && share.HasFrozenSnapshot(nativeToken) {
			created, err := st.Share.Create(store.Share{
				Kind: store.ShareKindFile, ProjectID: req.ProjectID, ProjectName: proj.Name,
				Path: rel, Name: shareDisplayName(target.Name, rel, proj.Name), IsDir: target.IsDir,
				Size: target.Size, Frozen: true, PassphraseHash: passHash,
				Watermark: watermarkOrDefault(req.Watermark),
				ExpiresAt: expiresAt,
			})
			if err != nil {
				shared.Error(c, http.StatusInternalServerError, "create share failed", err)
				return
			}
			// 幂等命中既有冻结链：非显式选择保留既有倒计时；显式选择才覆写
			//（含 permanent 清窗——重复分享不得无声改期）
			if created, err = applyExplicitExpiry(st, created, expiresAt, explicitExpiry); err != nil {
				shared.Error(c, http.StatusInternalServerError, "set share expiry failed", err)
				return
			}
			slog.Info("share created (frozen, existing)", "token", share.TokenSummary(created.Token),
				"project", proj.Name, "path", rel)
			c.JSON(http.StatusOK, gin.H{"data": shareResponse(*created), "warnings": []string{}, "scanTruncated": false})
			return
		}
		if _, err := share.CreateFrozenSnapshot(proj.Path, rel, nativeToken); err != nil {
			if errors.Is(err, share.ErrFrozenTooLarge) || errors.Is(err, share.ErrFrozenQuota) {
				// 护栏拒绝是可预期的常态：哨兵原文即前端 KNOWN_ERROR_I18N
				// 的匹配契约，413 表达「目标太大」而非服务器故障
				shared.Error(c, http.StatusRequestEntityTooLarge, err.Error(), nil)
				return
			}
			shared.Error(c, http.StatusInternalServerError, "create frozen snapshot failed", err)
			return
		}
	}
	scan, err := share.ScanSensitive(scanRoot, scanRel)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "scan share target failed", err)
		return
	}
	if len(scan.Warnings) > 0 && !req.Override {
		slog.Info("share blocked by sensitive scan", "project", proj.Name, "path", rel,
			"hits", len(scan.Warnings), "truncated", scan.Truncated, "frozen", frozen)
		if frozen {
			// 未确认的冻结不留盘：半成品副本随警告一并丢弃
			_ = share.DeleteFrozenSnapshot(nativeToken)
		}
		c.JSON(http.StatusOK, gin.H{"warnings": scan.Warnings, "scanTruncated": scan.Truncated})
		return
	}
	name := shareDisplayName(target.Name, rel, proj.Name)
	created, err := st.Share.Create(store.Share{
		Kind:           store.ShareKindFile,
		ProjectID:      req.ProjectID,
		ProjectName:    proj.Name,
		Path:           rel,
		Name:           name,
		IsDir:          target.IsDir,
		Size:           target.Size,
		Frozen:         frozen,
		PassphraseHash: passHash,
		Watermark:      watermarkOrDefault(req.Watermark),
		ViewOnce:       req.ViewOnce,
		ExpiresAt:      expiresAt,
	})
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "create share failed", err)
		return
	}
	// 显式选择的有效期覆写既有记录（幂等重建默认保留旧倒计时）
	if created, err = applyExplicitExpiry(st, created, expiresAt, explicitExpiry); err != nil {
		shared.Error(c, http.StatusInternalServerError, "set share expiry failed", err)
		return
	}
	// token 打摘要不打全值：日志是最常被外发收集的工件（排障粘贴/崩溃
	// 报告/日志聚合），完整短链进日志 = 分享鉴权面平移给能读日志的人
	// （share.TokenSummary，P-20261002-95）
	slog.Info("share created", "token", share.TokenSummary(created.Token), "project", proj.Name,
		"path", rel, "isDir", created.IsDir, "frozen", frozen, "sensitiveHits", len(scan.Warnings),
		"passphrase", created.PassphraseHash != "", "viewOnce", created.ViewOnce)
	// 审计入账：分享把项目内容暴露到子服务短链，创建即安全事件（只记路径摘要；
	// frozen 注记模式——冻结副本是落盘数据且内容定格，事后审计需能区分；
	// view-once 注记一次性——确认即焚的暴露面（P-20261020-3 起武装在访客
	// 显式确认 POST /s/{token}/view），事后对账需能区分）
	kindLabel := shareKindLabel(created.IsDir)
	if frozen {
		kindLabel += ", frozen"
	}
	if req.ViewOnce {
		kindLabel += ", view-once"
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareCreate,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s: %s (%s)", proj.Name, rel, kindLabel),
	})
	c.JSON(http.StatusOK, gin.H{"data": shareResponse(*created),
		"warnings": scan.Warnings, "scanTruncated": scan.Truncated})
}

// existingFrozen 同目标是否已有冻结分享记录（List 扫描；分享量级为用户手工
// 创建的个位数到十位数，代价可忽略——store.findByFileTarget 同款口径）。
// 过期未清的记录同样命中：幂等创建返回既有记录（含其已定倒计时），访客面
// 把守过期，要延续先撤销重建
func existingFrozen(st *store.Store, projectID, path string) bool {
	shares, err := st.Share.List()
	if err != nil {
		return false
	}
	for _, s := range shares {
		if s.Kind == store.ShareKindFile && s.Frozen && s.ProjectID == projectID && s.Path == path {
			return true
		}
	}
	return false
}

// maxBatchSharePaths 单条批量分享的选择项上限（与 files-archive 批量归档
// 的 50 项同值）：评审包的真实量级是「跨几个目录挑十几个文件」，上限只用于
// 挡住「把整个仓库当选择集」的误用；超出请分批或走单根目录冻结
const maxBatchSharePaths = 50

// resolveBatchSharePaths 批量选择集校验与规范化：CanonicalSharePaths（排序
// 去重 + 拒绝上跳/空段）→ 逐项 StatTarget（存在性与符号链接策略同单路径）
// → 嵌套选择随父目录去重（排序后前缀判定，files-archive 同规则，防同一
// 内容双份复制/双份计费）。返回的 paths 直接用于 token 派生与快照复制
func resolveBatchSharePaths(rootDir string, raw []string) ([]string, int, string) {
	if len(raw) > maxBatchSharePaths {
		return nil, http.StatusBadRequest, fmt.Sprintf("paths exceeds %d entries", maxBatchSharePaths)
	}
	canonical, err := store.CanonicalSharePaths(raw)
	if err != nil {
		return nil, http.StatusBadRequest, "invalid paths"
	}
	for _, p := range canonical {
		if _, err := share.StatTarget(rootDir, p); err != nil {
			return nil, http.StatusNotFound, "target not found: " + p
		}
	}
	out := make([]string, 0, len(canonical))
	for _, p := range canonical {
		nested := false
		for _, q := range out {
			if strings.HasPrefix(p, q+"/") {
				nested = true
				break
			}
		}
		if !nested {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return nil, http.StatusBadRequest, "paths is empty"
	}
	return out, 0, ""
}

// batchShareDisplayName 批量分享展示名：首项名 + 其余计数（"a.ts +2"）——
// 语言中立、管理列表单行可辨识；完整清单在记录的 paths 字段与管理面投影
func batchShareDisplayName(paths []string) string {
	base := path.Base(paths[0])
	if len(paths) == 1 {
		return base
	}
	return fmt.Sprintf("%s +%d", base, len(paths)-1)
}

// summarizeBatchPaths 审计摘要的路径清单（前 5 项 + 计数，防单条审计 Detail
// 被超长集合撑爆；完整集合在记录 paths 中可回查）
func summarizeBatchPaths(paths []string) string {
	const max = 5
	if len(paths) <= max {
		return strings.Join(paths, ", ")
	}
	return strings.Join(paths[:max], ", ") + fmt.Sprintf(" … (+%d)", len(paths)-max)
}

// existingFrozenBatch 同路径集合是否已有冻结分享记录（List 扫描；批量创建
// 幂等短路用。existingFrozen 的集合版：paths 已规范化，全等比较顺序无关）
func existingFrozenBatch(st *store.Store, projectID string, paths []string) *store.Share {
	shares, err := st.Share.List()
	if err != nil {
		return nil
	}
	for i := range shares {
		s := &shares[i]
		if s.Kind != store.ShareKindFile || !s.Frozen || s.ProjectID != projectID || len(s.Paths) != len(paths) {
			continue
		}
		match := true
		for j := range paths {
			if s.Paths[j] != paths[j] {
				match = false
				break
			}
		}
		if match {
			return s
		}
	}
	return nil
}

// createBatchFrozenShare 多路径冻结分享的创建链路（P-20261008-1）：校验 →
// 幂等短路（记录在且副本在盘时跳过复制）→ N 路径各自复制进同一快照副本
// （保留相对结构，合计受单份 200MB 护栏）→ 对副本整扫（所见即所扫，天然
// 覆盖全部路径）→ 命中未确认时丢弃半成品并走 warnings 确认流。
// 记录 Path 恒空、Paths 为规范化集合；Size = 实际复制总字节（管理面/结果卡
// 的体积展示口径）
func createBatchFrozenShare(c *gin.Context, st *store.Store, proj *config.ProjectConfig, req createShareReq) {
	paths, status, msg := resolveBatchSharePaths(proj.Path, req.Paths)
	if status != 0 {
		shared.Error(c, status, msg, nil)
		return
	}
	// 口令门（P-20261006-25）：批量链路与单路径同款，哈希先行、明文只存在于
	// 本请求内（访客守卫按记录字段把门，与形态无关）
	passHash, err := hashPassphrase(req.Passphrase)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, err.Error(), nil)
		return
	}
	nativeToken := store.FrozenBatchNativeToken(config.MasterKey(), proj.ID, paths)
	if old := existingFrozenBatch(st, proj.ID, paths); old != nil && share.HasFrozenSnapshot(nativeToken) {
		// 幂等命中：跳过复制（冻结=不可变，重复分享不刷新副本；要跟进内容走
		// 原地刷新）。记录侧沿用既有展示名/体积，口令/水印按请求覆写
		created, cerr := st.Share.Create(store.Share{
			Kind: store.ShareKindFile, ProjectID: proj.ID, ProjectName: proj.Name,
			Paths: paths, Name: old.Name, IsDir: false, Size: old.Size, Frozen: true,
			PassphraseHash: passHash, Watermark: watermarkOrDefault(req.Watermark),
		})
		if cerr != nil {
			shared.Error(c, http.StatusInternalServerError, "create share failed", cerr)
			return
		}
		slog.Info("share created (frozen batch, existing)", "token", share.TokenSummary(created.Token),
			"project", proj.Name, "paths", len(paths))
		c.JSON(http.StatusOK, gin.H{"data": shareResponse(*created), "warnings": []string{}, "scanTruncated": false})
		return
	}
	copied, err := share.CreateFrozenSnapshotMulti(proj.Path, paths, nativeToken)
	if err != nil {
		if errors.Is(err, share.ErrFrozenTooLarge) || errors.Is(err, share.ErrFrozenQuota) {
			// 护栏拒绝是可预期的常态：哨兵原文即前端 KNOWN_ERROR_I18N 的
			// 匹配契约（合计超 200MB 时提示拆分选择集）
			shared.Error(c, http.StatusRequestEntityTooLarge, err.Error(), nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "create frozen snapshot failed", err)
		return
	}
	// 敏感扫描对副本整棵（frozen 所见即所扫语义：N 路径的副本内容全覆盖）
	scan, err := share.ScanSensitive(share.SnapshotsRoot(), nativeToken)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "scan share target failed", err)
		return
	}
	if len(scan.Warnings) > 0 && !req.Override {
		slog.Info("share blocked by sensitive scan", "project", proj.Name, "paths", len(paths),
			"hits", len(scan.Warnings), "truncated", scan.Truncated, "frozen", true)
		// 未确认的冻结不留盘：半成品副本随警告一并丢弃（单路径同语义）
		_ = share.DeleteFrozenSnapshot(nativeToken)
		c.JSON(http.StatusOK, gin.H{"warnings": scan.Warnings, "scanTruncated": scan.Truncated})
		return
	}
	name := batchShareDisplayName(paths)
	created, err := st.Share.Create(store.Share{
		Kind: store.ShareKindFile, ProjectID: proj.ID, ProjectName: proj.Name,
		Paths: paths, Name: name, IsDir: false, Size: copied, Frozen: true,
		PassphraseHash: passHash, Watermark: watermarkOrDefault(req.Watermark),
	})
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "create share failed", err)
		return
	}
	slog.Info("batch share created", "token", share.TokenSummary(created.Token), "project", proj.Name,
		"paths", len(paths), "bytes", created.Size, "sensitiveHits", len(scan.Warnings),
		"passphrase", created.PassphraseHash != "")
	// 审计入账（与单路径同族）：批量把多个路径定格出域，Detail 记项目 + 路径
	// 摘要（前 5 项 + 计数）与 frozen/batch 注记，事后对账可区分集合形态
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareCreate,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s: %s (file, frozen, batch)", proj.Name, summarizeBatchPaths(paths)),
	})
	c.JSON(http.StatusOK, gin.H{"data": shareResponse(*created),
		"warnings": scan.Warnings, "scanTruncated": scan.Truncated})
}

// shareDisplayName 分享展示名：目标名；项目根分享展示项目名
func shareDisplayName(targetName, rel, projectName string) string {
	if rel == "" {
		return projectName
	}
	return targetName
}

// createSnippetReq 文本片段分享请求
type createSnippetReq struct {
	// Content 片段文本（必填；字节上限 store.MaxSnippetBytes）
	Content string `json:"content" binding:"required"`
	// Name 展示标题（可选；缺省取内容首个非空行截断）
	Name string `json:"name"`
	// Passphrase 可选访问口令（P-20261006-25，四形态统一守卫）：非空 = 片段
	// 加口令门；幂等命中既有片段时带新口令=改门、不带=保持既有
	Passphrase string `json:"passphrase"`
	// Watermark 可选访客页溯源水印开关（P-20261005-193）：nil/缺省 = 开，
	// 显式 false = 关
	Watermark *bool `json:"watermark"`
	// ViewOnce 可选一次性查看开关（P-20261006-27，与文件分享同语义同参）：
	// 排障贴「发给同事看一眼」正是一次性的主场景
	ViewOnce bool `json:"viewOnce"`
}

// snippetNameMax 标题截取宽度（rune）：管理列表/访客页头的单行辨识度
// 与不吞没内容的平衡点
const snippetNameMax = 60

// sanitizeSnippetTitle 标题清洗：控制字符（含 \t/\r）折叠为空格——标题是
// 单行展示位，控制字符只会渲染成不可预测的空白
func sanitizeSnippetTitle(s string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s))
}

// defaultSnippetName 缺省标题 = 内容首个非空行（清洗 + rune 截断）；
// 全空白内容回退语言中立的 "snippet"
func defaultSnippetName(content string) string {
	for _, line := range strings.Split(content, "\n") {
		line = sanitizeSnippetTitle(line)
		if line == "" {
			continue
		}
		runes := []rune(line)
		if len(runes) > snippetNameMax {
			return string(runes[:snippetNameMax])
		}
		return line
	}
	return "snippet"
}

// CreateSnippet POST /api/share/snippet —— 文本片段分享（排障贴短链）。
// 与文件分享刻意区分的三点：
//  1. 不绑项目（projectId 不存在），内容随记录落库（≤ store.MaxSnippetBytes）；
//  2. 24h 自动过期（store.SnippetTTL，片段临时性强、暴露面应短；文件分享
//     维持不自动过期的既有评审决定——片段的短暴露是安全收益而非断链回归）；
//  3. 同一段内容重复分享得到同一短链（内容确定性派生，幂等重建不续期）
func CreateSnippet(c *gin.Context) {
	var req createSnippetReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request", err)
		return
	}
	if len(req.Content) > store.MaxSnippetBytes {
		shared.Error(c, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("snippet exceeds %d bytes", store.MaxSnippetBytes), nil)
		return
	}
	// 口令门（P-20261006-25）：哈希先行，明文只存在于本请求内
	passHash, err := hashPassphrase(req.Passphrase)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, err.Error(), nil)
		return
	}
	name := sanitizeSnippetTitle(req.Name)
	if name == "" {
		name = defaultSnippetName(req.Content)
	}
	if runes := []rune(name); len(runes) > snippetNameMax {
		name = string(runes[:snippetNameMax])
	}
	created, err := store.Get().Share.Create(store.Share{
		Kind:           store.ShareKindSnippet,
		Name:           name,
		Content:        req.Content,
		PassphraseHash: passHash,
		Watermark:      watermarkOrDefault(req.Watermark),
		ViewOnce:       req.ViewOnce,
	})
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "create snippet share failed", err)
		return
	}
	slog.Info("snippet share created", "token", share.TokenSummary(created.Token), "name", name, "bytes", created.Size)
	// 审计入账：片段把任意文本暴露到匿名短链，创建即安全事件（只记标题与字节数）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareCreate,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("snippet: %s (%d bytes)", name, created.Size),
	})
	c.JSON(http.StatusOK, gin.H{"data": shareResponse(*created)})
}

// ListShares GET /api/share —— 全部分享（短链管理视图数据源）。响应附
// frozenUsage{totalBytes,capBytes}（P-20261005-176 快照库占用——双体积护栏
// 从撞 413 才知变常透明，agent 可程序化容量治理）；有快照在盘的行（冻结
// 文件分享/终端输出快照）另带 frozenBytes = 该份快照目录字节量（找大头）。
// 统计失败不阻断列表（管理面可用性优先，仅省略投影并留痕）
//
// 健康投影（P-20261020-10）：逐行补 health（见 health.go）。列表接口不带
// 服务端分页（前端按 15 行/页切片），因此对返回行逐行判定；分享量级为手工
// 创建的个位数到十位数，且同一项目根只 stat 一次，开销可控。stat 失败按
// 异常值（target_missing/project_gone）投影，绝不让列表请求 500。
func ListShares(c *gin.Context) {
	list, err := store.Get().Share.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "list shares failed", err)
		return
	}
	total, perToken, uerr := share.SnapshotUsage()
	health := newShareHealthProbe(store.Get())
	out := make([]gin.H, 0, len(list))
	for _, s := range list {
		row := shareResponse(s)
		row["health"] = health.health(s)
		if name := snapshotDirName(&s); name != "" {
			if used, ok := perToken[name]; ok {
				row["frozenBytes"] = used
			}
		}
		out = append(out, row)
	}
	if uerr != nil {
		slog.Warn("share usage stats failed", "err", uerr)
	} else {
		c.JSON(http.StatusOK, gin.H{"data": out, "frozenUsage": gin.H{
			"totalBytes": total,
			"capBytes":   share.MaxFrozenTotalBytes,
		}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": out})
}

// ── 终端只读直播分享（P-20261003-306） ──

// liveWire 终端直播馈线接线口（liveterm.Hub 结构性满足；Module Start 注入、
// Stop 摘除。nil = 未装配——创建仍成功，馈线在访客订阅时由 hub 惰性接通，
// 语义不变只是首访多一次播种）。unfiltered 是 live 源参数（P-20261106-9）：
// 取生效记录（幂等命中时是既有记录，非请求值）的 Unfiltered，模式不符的
// 陈旧馈线由 hub 整条替换；Prune 供过期清理巡检按存活 token 集收口馈线
type liveWiring interface {
	Wire(token, sessionID string, unfiltered bool)
	Unwire(token string)
	Prune(keep map[string]bool) int
}

var liveWire liveWiring

// setLiveWire 注入/摘除接线口（Module Start/Stop 调用；测试可直接置 nil）
func setLiveWire(h liveWiring) { liveWire = h }

// unfilteredEgressNote 未过滤分享（P-20261106-9）的审计/日志 Detail 后缀：
// 敏感值遮蔽被显式关闭是出域安全事件的关键维度，审计台账必须一眼可辨
func unfilteredEgressNote(unfiltered bool) string {
	if unfiltered {
		return ", UNFILTERED"
	}
	return ""
}

// createTerminalReq 终端直播分享请求
type createTerminalReq struct {
	// SessionID 终端会话 ID（必填；不限 shell/agent——直播的是输出不是控制权）
	SessionID string `json:"sessionId" binding:"required"`
	// TTLMinutes 可选有效期覆盖（分钟）；缺省/0 = store.TerminalLiveTTL 30 分钟，
	// 上限钳到 store.TerminalLiveTTLMax（直播是临时暴露面，不提供永久档）
	TTLMinutes int `json:"ttlMinutes"`
	// Override 敏感会话出域警示的确认标记（P-20261003-155）：true = 用户已在
	// 警示框确认仍要开直播（首次请求恒为 false；命中警示时响应不带 data，
	// 创建被拦下）——与文件分享扫描的 override 同一契约
	Override bool `json:"override"`
	// Passphrase 可选访问口令（P-20261006-25，四形态统一守卫）：非空 = 直播
	// 加口令门（访客页同门，stream 端点同守卫）；幂等命中既有直播时带新
	// 口令=改门、不带=保持既有
	Passphrase string `json:"passphrase"`
	// Watermark 可选访客页溯源水印开关（P-20261005-193）：nil/缺省 = 开，
	// 显式 false = 关
	Watermark *bool `json:"watermark"`
	// ViewOnce 显式拒绝位（P-20261006-27）：直播是持续流语义，「看一眼即焚」
	// 不成立——传 true 一律 400（可编程感知，不静默吞）
	ViewOnce bool `json:"viewOnce"`
	// Unfiltered 敏感值遮蔽关闭开关（P-20261106-9）：缺省 false = 遮蔽开（安全
	// 默认不可让步，旧客户端/agent 不带字段即遮蔽）；true = 直播 feeder 原样
	// 转发（内网协作原样输出场景，访客页标注「未过滤」）。创建时定死：幂等
	// 命中既有直播时以既有记录为准（改配置须结束直播后重开）
	Unfiltered bool `json:"unfiltered"`
}

// CreateTerminalLive POST /api/share/terminal —— 终端只读直播分享（远程结对/
// 教学/汇报场景）：token→会话锚点，访客经短链看遮蔽化只读输出流。
// 幂等：同一会话重复开直播得到同一短链（倒计时不续期）；会话已关闭 → 404
// （无可直播的源，不做「空直播」记录）。创建即接通馈线（tap 从此刻累积
// 遮蔽尾流，先于任何访客订阅）。
// 敏感出域闸门（P-20261003-155）：会话被人工标记敏感且未带 override 时不创建，
// 响应仅带 warnings（shared.SensitiveSessionWarning）——创建被拦下，前端弹
// 「确认出域」后带 override 二次请求才落库（文件分享扫描同流）
func CreateTerminalLive(c *gin.Context) {
	var req createTerminalReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request", err)
		return
	}
	// 一次性不适用于直播（P-20261006-27⑤）：持续流无「看一眼」语义
	if req.ViewOnce {
		shared.Error(c, http.StatusBadRequest, "viewOnce is not supported for terminal live", nil)
		return
	}
	if req.TTLMinutes < 0 {
		shared.Error(c, http.StatusBadRequest, "ttlMinutes must be >= 0", nil)
		return
	}
	sess := terminal.DefaultManager.GetSession(req.SessionID)
	if sess == nil {
		shared.Error(c, http.StatusNotFound, "terminal session not found", nil)
		return
	}
	if shared.IsSessionSensitive(req.SessionID) && !req.Override {
		slog.Info("terminal live share blocked by sensitive mark", "session", req.SessionID)
		c.JSON(http.StatusOK, gin.H{"warnings": []string{shared.SensitiveSessionWarning}})
		return
	}
	expiresAt := time.Time{}
	if req.TTLMinutes > 0 {
		expiresAt = time.Now().Add(time.Duration(req.TTLMinutes) * time.Minute)
	}
	// 口令门（P-20261006-25）：哈希先行，明文只存在于本请求内
	passHash, err := hashPassphrase(req.Passphrase)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, err.Error(), nil)
		return
	}
	created, err := store.Get().Share.Create(store.Share{
		Kind:           store.ShareKindTerminal,
		TerminalID:     req.SessionID,
		Name:           sess.Name,
		ExpiresAt:      expiresAt,
		PassphraseHash: passHash,
		Watermark:      watermarkOrDefault(req.Watermark),
		Unfiltered:     req.Unfiltered,
	})
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "create terminal live share failed", err)
		return
	}
	// 馈线即刻接通：分享创建到访客首连之间的输出也要进遮蔽尾流（否则那段
	// 输出在访客页只以播种形式晚到，时序错乱）。幂等命中同链时 Wire no-op。
	// 遮蔽模式取生效记录（P-20261106-9：幂等命中 = 既有记录的定死配置）
	if liveWire != nil {
		liveWire.Wire(created.Token, created.TerminalID, created.Unfiltered)
	}
	slog.Info("terminal live share created", "token", share.TokenSummary(created.Token),
		"session", created.TerminalID, "ttl", time.Until(created.ExpiresAt).Round(time.Second),
		"unfiltered", created.Unfiltered)
	// 审计入账：终端输出暴露到匿名短链，创建即安全事件（与文件分享同族）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareCreate,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("terminal live: %s (%s, ttl %s%s)", sess.Name, created.TerminalID,
			time.Until(created.ExpiresAt).Round(time.Minute), unfilteredEgressNote(created.Unfiltered)),
	})
	c.JSON(http.StatusOK, gin.H{"data": shareResponse(*created)})
}

// createTerminalFrozenReq 终端输出冻结快照分享请求（P-20261005-205）
type createTerminalFrozenReq struct {
	// SessionID 终端会话 ID（必填）。快照在创建时刻定格——不要求会话持续
	// 存活（定格完成后脱离会话生命周期），但创建时刻必须可读 scrollback
	SessionID string `json:"sessionId" binding:"required"`
	// Override 敏感会话出域警示的确认标记（P-20261003-155 同一契约）
	Override bool `json:"override"`
	// Watermark 可选访客页溯源水印开关（P-20261005-193）：nil/缺省 = 开，
	// 显式 false = 关
	Watermark *bool `json:"watermark"`
	// ViewOnce 显式拒绝位（P-20261006-27）：快照是定格留证语义，与一次性
	// 相斥（file 冻结模式同款 400）
	ViewOnce bool `json:"viewOnce"`
	// Unfiltered 敏感值遮蔽关闭开关（P-20261106-9）：缺省 false = 遮蔽开；
	// true = 快照不经 mask.MaskText（仍剥 ANSI——渲染净化与敏感遮蔽正交），
	// 含敏感原文落盘，TTL 强制钳 store.UnfilteredTTLMax（24h）
	Unfiltered bool `json:"unfiltered"`
	// Passphrase 可选访问口令（P-20261107-4：终端分享弹层透出口令，快照与直播
	// 创建面对齐；P-20261006-25 同一守卫族）：非空 = 快照加口令门（访客页与
	// /raw 同门）；缺省/空 = 无门（存量语义零变化）。幂等命中既有快照时带新
	// 口令=改门、不带=保持既有（store 合并语义与直播同款）
	Passphrase string `json:"passphrase"`
}

// unfilteredHashDomain 未过滤快照的内容哈希域前缀（P-20261106-9）：遮蔽/未过滤
// 两模式对同一段输出（尤其无敏感值、两模式字节全等时）必须落不同链与不同快照
// 目录——否则幂等定位会把「请求未过滤」落到既有遮蔽记录上（或反之），访客页
// 横幅与 TTL 语义错配。遮蔽模式哈希保持原口径（存量链接零变化）。NUL 起首
// 保证与任何可读文本前缀不碰撞
const unfilteredHashDomain = "\x00unfiltered\x00"

// sanitizeTermFrozenOutput 终端输出净化链（纯函数，单测锁纪律）：剥 ANSI
// （P-100 同原语，快照定格可读文本非字节保真）→ mask.MaskText 全量遮蔽
// （P-108 同源模式表，与 liveterm 流式遮蔽同一张表）。**顺序即纪律：净化
// 全部完成于哈希/落盘之前**——快照身份与内容都是净化后的形态，快照本体
// 即净本，访客面零二次处理。返回净化文本与其 sha256（hex，快照身份键）。
// unfiltered（P-20261106-9 显式 opt-out）：只剥 ANSI、跳过遮蔽——「快照本体
// 即净本」对该类快照显式失效（由强制短 TTL + 访客页未过滤横幅替代收敛），
// 哈希走 unfilteredHashDomain 域分离，与遮蔽快照恒不同链
func sanitizeTermFrozenOutput(raw []byte, unfiltered bool) (masked, hash string) {
	text := string(terminal.StripANSI(raw))
	if unfiltered {
		sum := sha256.Sum256([]byte(unfilteredHashDomain + text))
		return text, hex.EncodeToString(sum[:])
	}
	masked = mask.MaskText(text)
	sum := sha256.Sum256([]byte(masked))
	return masked, hex.EncodeToString(sum[:])
}

// CreateTerminalFrozen POST /api/share/terminal-frozen —— 终端输出时点冻结
// 快照分享（报障/求援的定格链接）：CaptureScrollback(0)（P-100 同原语）取
// 创建时刻全量缓冲，净化链 = 剥 ANSI（留可读文本非字节保真）→ mask.MaskText
// 全量遮蔽（P-108 同源模式集，与 liveterm 流式遮蔽同一张表）——**净化在落盘
// 前完成，快照本体即净本**，访客面零二次处理；内容哈希参与 token 派生
// （同一段输出重复定格恒同链，snippet 语义同构），单文件快照入 P-320 同一
// SnapshotsRoot 隔离区。默认 TTL 30 天（store.FrozenTTL，快照是落盘数据防
// 磁盘长尾；SetExpiry 可调）。与直播（CreateTerminalLive）刻意区分：直播是
// 活流（创建后自己的后续输入持续暴露），快照是定格（会话继续跑、内容不更新，
// 且会话关闭后链接仍可访问——求援场景「人来看」的入口链接化）。
// 未过滤模式（P-20261106-9，unfiltered:true 显式 opt-out）：跳过遮蔽、含原文
// 落盘，TTL 强制 24h（store 钳制），访客页横幅换「未过滤」警示
func CreateTerminalFrozen(c *gin.Context) {
	var req createTerminalFrozenReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request", err)
		return
	}
	// 一次性不适用于快照（P-20261006-27⑤，frozen 文件模式同款互斥）
	if req.ViewOnce {
		shared.Error(c, http.StatusBadRequest, "viewOnce is not supported for terminal-frozen", nil)
		return
	}
	sess := terminal.DefaultManager.GetSession(req.SessionID)
	if sess == nil {
		shared.Error(c, http.StatusNotFound, "terminal session not found", nil)
		return
	}
	if shared.IsSessionSensitive(req.SessionID) && !req.Override {
		slog.Info("terminal frozen share blocked by sensitive mark", "session", req.SessionID)
		c.JSON(http.StatusOK, gin.H{"warnings": []string{shared.SensitiveSessionWarning}})
		return
	}
	// 口令门（P-20261107-4，直播同款）：哈希先行、校验先于快照落盘——超长口令
	// 400 不留半成品快照；明文只存在于本请求内
	passHash, err := hashPassphrase(req.Passphrase)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, err.Error(), nil)
		return
	}
	raw, err := sess.CaptureScrollback(0)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Terminal operation failed", err)
		return
	}
	// 净化链（见 sanitizeTermFrozenOutput）：空白快照无分享价值，直接拒绝
	//（snippet 空内容拒绝同构）。未过滤模式（P-20261106-9）只剥 ANSI 不遮蔽
	masked, hash := sanitizeTermFrozenOutput(raw, req.Unfiltered)
	if strings.TrimSpace(masked) == "" {
		shared.Error(c, http.StatusBadRequest, "terminal output is empty", nil)
		return
	}
	nativeToken := store.TermFrozenNativeToken(config.MasterKey(), req.SessionID, hash)
	// 幂等短路：副本在盘跳过重写（同哈希 = 同内容）；记录在而副本丢失时
	// 走重写修复（与冻结文件分享「宁可重拷不给坏链」同款取向）
	if !share.HasTermFrozenSnapshot(nativeToken) {
		if err := share.WriteTermFrozenSnapshot(nativeToken, []byte(masked)); err != nil {
			if errors.Is(err, share.ErrFrozenQuota) || errors.Is(err, share.ErrFrozenTooLarge) {
				// 护栏拒绝是可预期的常态：哨兵原文即前端 KNOWN_ERROR_I18N 契约
				shared.Error(c, http.StatusRequestEntityTooLarge, err.Error(), nil)
				return
			}
			shared.Error(c, http.StatusInternalServerError, "write term-frozen snapshot failed", err)
			return
		}
	}
	created, err := store.Get().Share.Create(store.Share{
		Kind:           store.ShareKindTermFrozen,
		TerminalID:     req.SessionID,
		Name:           sess.Name,
		Size:           int64(len(masked)),
		ContentHash:    hash,
		PassphraseHash: passHash,
		Watermark:      watermarkOrDefault(req.Watermark),
		Unfiltered:     req.Unfiltered,
	})
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "create terminal frozen share failed", err)
		return
	}
	slog.Info("terminal frozen share created", "token", share.TokenSummary(created.Token),
		"session", created.TerminalID, "bytes", created.Size,
		"ttl", time.Until(created.ExpiresAt).Round(time.Minute), "unfiltered", created.Unfiltered,
		"passphrase", created.PassphraseHash != "")
	// 审计入账：终端输出暴露到匿名短链（定格形态），创建即安全事件（同族）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareCreate,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("terminal frozen: %s (%s, %d bytes%s)", sess.Name, created.TerminalID, created.Size,
			unfilteredEgressNote(created.Unfiltered)),
	})
	c.JSON(http.StatusOK, gin.H{"data": shareResponse(*created)})
}

// createCastReq 会话回放分享请求（P-20261004-103）
type createCastReq struct {
	// RecordingID 录制索引 id（必填；内容锚点与短链派生键）
	RecordingID string `json:"recordingId" binding:"required"`
	// TTLMinutes 可选有效期覆盖（分钟）；缺省/0 = store.CastShareTTL 1 小时，
	// 上限钳到 store.CastShareTTLMax（回放是临时暴露面，不提供永久档）
	TTLMinutes int `json:"ttlMinutes"`
	// Override 回放文本敏感模式扫描的确认标记（P-97 同语义）：true = 用户已
	// 在警示框确认仍要分享（首次请求恒为 false；命中警告时响应不带 data）
	Override bool `json:"override"`
	// Passphrase 可选访问口令（P-20261006-25，全形态统一守卫）
	Passphrase string `json:"passphrase"`
	// Watermark 可选访客页溯源水印开关（P-20261005-193）：nil/缺省 = 开，
	// 显式 false = 关
	Watermark *bool `json:"watermark"`
	// ViewOnce 显式拒绝位（P-20261006-27）：回放是异步观看语义，「看一眼
	// 即焚」不成立——传 true 一律 400（可编程感知，不静默吞）
	ViewOnce bool `json:"viewOnce"`
}

// CreateCast POST /api/share/cast —— 会话回放分享（异步 walkthrough）：
// 把一次录制（asciinema v2 cast）以只读回放页分享给队友（教学/复盘/展示）。
// 内容面是创建时刻的 cast 快照（写进 SnapshotsRoot 隔离区，与 terminal-frozen
// 同一落盘/清账通道）——录制继续写不影响访客所见，录制删除后链接仍可访问
// （独立的短 TTL：缺省 1 小时）。分享前对 cast 文本跑敏感模式扫描（录制写盘
// 前已流式遮蔽，这是兜底复检）：命中且未确认时响应仅带 warnings、不落快照
// 不建记录；确认后带 override 二次请求才真正创建（P-97 同语义的警示确认流）。
// 无论如何，落盘快照都再跑一遍全量兜底遮蔽（SanitizeCastText，含 OSC 133
// E 帧载荷解码）——快照即净本，访客页零二次处理。
// 幂等：同一录制重复分享恒同链（RecordingID 派生），倒计时不续期；重复
// 分享会重写快照跟进录制内容（链接不变，晚分享看到更完整的过程）。
func CreateCast(c *gin.Context) {
	var req createCastReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request", err)
		return
	}
	if req.ViewOnce {
		shared.Error(c, http.StatusBadRequest, "viewOnce is not supported for cast replay", nil)
		return
	}
	if req.TTLMinutes < 0 {
		shared.Error(c, http.StatusBadRequest, "ttlMinutes must be >= 0", nil)
		return
	}
	st := store.Get()
	rec, err := st.Recording.Get(req.RecordingID)
	if err != nil || rec == nil {
		shared.Error(c, http.StatusNotFound, "recording not found", nil)
		return
	}
	castPath := recording.CastPath(req.RecordingID)
	info, err := os.Stat(castPath)
	if err != nil {
		// 索引在而 cast 文件缺失：服务端数据事故（录制写盘/清理竞态），
		// 不产出「空回放」坏链
		shared.Error(c, http.StatusNotFound, "recording cast file missing", nil)
		return
	}
	// 体积护栏在读入内存前判（录制窗口 15 分钟上限下实际不可达，纯防御：
	// 损坏/异常大的 cast 文件不应先把整包读进内存再拒绝）
	if info.Size() > share.MaxFrozenBytes {
		shared.Error(c, http.StatusRequestEntityTooLarge, share.ErrReplayTooLarge.Error(), nil)
		return
	}
	raw, err := os.ReadFile(castPath)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "recording cast file missing", nil)
		return
	}
	// 录制中文件在 Stat 与 Read 之间仍可能增长：读后复检同护栏
	if len(raw) > share.MaxFrozenBytes {
		shared.Error(c, http.StatusRequestEntityTooLarge, share.ErrReplayTooLarge.Error(), nil)
		return
	}
	if !share.CastHasOutput(string(raw)) {
		shared.Error(c, http.StatusBadRequest, "recording has no output yet", nil)
		return
	}
	// 敏感模式扫描（P-97 同语义）：命中清单是行号，不含命中原文——警示面
	// 本身不得成为新的泄露面
	scan := share.ScanCastSensitive(string(raw))
	if len(scan.Warnings) > 0 && !req.Override {
		slog.Info("cast share blocked by sensitive scan", "recording", req.RecordingID,
			"hits", len(scan.Warnings), "truncated", scan.Truncated)
		c.JSON(http.StatusOK, gin.H{"warnings": scan.Warnings, "scanTruncated": scan.Truncated})
		return
	}
	// 落盘前全量兜底遮蔽：快照即净本（含 E 帧载荷；自定义敏感模式同步生效）
	sanitized := []byte(share.SanitizeCastText(string(raw)))
	nativeToken := store.CastNativeToken(config.MasterKey(), req.RecordingID)
	if err := share.WriteCastSnapshot(nativeToken, sanitized); err != nil {
		if errors.Is(err, share.ErrFrozenQuota) || errors.Is(err, share.ErrFrozenTooLarge) {
			shared.Error(c, http.StatusRequestEntityTooLarge, err.Error(), nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "write cast snapshot failed", err)
		return
	}
	// 口令门（P-20261006-25）：哈希先行，明文只存在于本请求内
	passHash, err := hashPassphrase(req.Passphrase)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, err.Error(), nil)
		return
	}
	expiresAt := time.Time{}
	if req.TTLMinutes > 0 {
		expiresAt = time.Now().Add(time.Duration(req.TTLMinutes) * time.Minute)
	}
	name := strings.TrimSpace(rec.Op)
	if name == "" {
		name = rec.SessionID
	}
	if name == "" {
		name = req.RecordingID
	}
	created, err := st.Share.Create(store.Share{
		Kind:           store.ShareKindCast,
		RecordingID:    req.RecordingID,
		TerminalID:     rec.SessionID,
		Name:           name,
		Size:           int64(len(sanitized)),
		ExpiresAt:      expiresAt,
		PassphraseHash: passHash,
		Watermark:      watermarkOrDefault(req.Watermark),
	})
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "create cast share failed", err)
		return
	}
	slog.Info("cast share created", "token", share.TokenSummary(created.Token),
		"recording", req.RecordingID, "session", rec.SessionID, "bytes", created.Size,
		"ttl", time.Until(created.ExpiresAt).Round(time.Second),
		"sensitiveHits", len(scan.Warnings))
	// 审计入账：回放把整段过程输出暴露到匿名短链，创建即安全事件（同族）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareCreate,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("cast replay: %s (%s, %d bytes)", name, req.RecordingID, created.Size),
	})
	c.JSON(http.StatusOK, gin.H{"data": shareResponse(*created),
		"warnings": scan.Warnings, "scanTruncated": scan.Truncated})
}

// createSessionShareReq 会话回放只读分享请求（P-20261003-77）
type createSessionShareReq struct {
	// SessionID Claude transcript 的会话 id（必填；内容锚点与短链派生键）
	SessionID string `json:"sessionId" binding:"required"`
	// TTLMinutes 可选有效期覆盖（分钟）；缺省/0 = store.SessionShareTTL 24
	// 小时，上限钳到 store.SessionShareTTLMax（本形态不提供长留存档）
	TTLMinutes int `json:"ttlMinutes"`
	// Passphrase 可选访问口令（P-20261006-25，全形态统一守卫）
	Passphrase string `json:"passphrase"`
	// Watermark 可选访客页溯源水印开关（P-20261005-193）：nil/缺省 = 开
	Watermark *bool `json:"watermark"`
	// ViewOnce 显式拒绝位（P-20261006-27）：回放是异步观看语义，与「看一眼
	// 即焚」相斥——传 true 一律 400（可编程感知，不静默吞）
	ViewOnce bool `json:"viewOnce"`
}

// CreateSessionShare POST /api/share/session —— 会话回放只读分享
// （P-20261003-77）：「你看 agent 刚才怎么干活的」的现场只读链接。把一条
// Claude 会话的完整回放（user/assistant/thinking/tool/result——按 2026-10-19
// 产品口径思考块与工具详情均对访客可见）解析后快照进 SnapshotsRoot 隔离区，
// 访客从结构化时间线页只读浏览。快照写盘前按 P-108 模式集做敏感值遮蔽
// （title/text/tool input → ***，mask.MaskText 与回放展示面/终端录制同源）
// ——快照即净本，访客面不存在「显示原文」放行开关。
// 默认 TTL 24 小时（store.SessionShareTTL，上限同值；可经 ttlMinutes 调短），
// 快照与源会话生命周期解耦：会话继续写/被删除都不影响访客所见。
// 幂等：同一会话重复分享恒同链（SessionID 派生），倒计时不续期；重复分享
// 会重写快照跟进会话新增回合（链接不变，晚分享看到更完整的过程）。
func CreateSessionShare(c *gin.Context) {
	var req createSessionShareReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request", err)
		return
	}
	if req.ViewOnce {
		shared.Error(c, http.StatusBadRequest, "viewOnce is not supported for session replay", nil)
		return
	}
	if req.TTLMinutes < 0 {
		shared.Error(c, http.StatusBadRequest, "ttlMinutes must be >= 0", nil)
		return
	}
	// 会话 id 归一后才参与解析/派生/落库：三处必须同一个值，否则快照目录
	// 与记录锚点对不上（访客面按记录字段重算目录会 410）
	sessionID := strings.TrimSpace(req.SessionID)
	res, err := claudesessions.ShareSnapshot(claudesessions.Root(), sessionID)
	if err != nil {
		if errors.Is(err, claudesessions.ErrSessionNotFound) {
			shared.Error(c, http.StatusNotFound, "session not found", nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "read claude session failed", err)
		return
	}
	if len(res.Entries) == 0 {
		// 空窗口/纯噪声行：没有可回放的步骤，不产出「空回放」坏链
		//（cast 的 header-only 拒绝同语义）
		shared.Error(c, http.StatusBadRequest, "session has no replayable entries", nil)
		return
	}
	// 快照装箱 + P-108 敏感值遮蔽（标题/正文/工具输入；快照即净本）
	snap := share.BuildSessionSnapshot(res)
	data, err := share.MarshalSessionSnapshot(snap)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "marshal session snapshot failed", err)
		return
	}
	nativeToken := store.SessionNativeToken(config.MasterKey(), sessionID)
	if err := share.WriteSessionSnapshot(nativeToken, data); err != nil {
		if errors.Is(err, share.ErrFrozenQuota) || errors.Is(err, share.ErrFrozenTooLarge) {
			shared.Error(c, http.StatusRequestEntityTooLarge, err.Error(), nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "write session snapshot failed", err)
		return
	}
	// 口令门（P-20261006-25）：哈希先行，明文只存在于本请求内
	passHash, err := hashPassphrase(req.Passphrase)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, err.Error(), nil)
		return
	}
	expiresAt := time.Time{}
	if req.TTLMinutes > 0 {
		expiresAt = time.Now().Add(time.Duration(req.TTLMinutes) * time.Minute)
	}
	name := strings.TrimSpace(snap.Title)
	if name == "" {
		name = sessionID
	}
	created, err := store.Get().Share.Create(store.Share{
		Kind:           store.ShareKindSession,
		SessionID:      sessionID,
		Name:           name,
		Size:           int64(len(data)),
		ExpiresAt:      expiresAt,
		PassphraseHash: passHash,
		Watermark:      watermarkOrDefault(req.Watermark),
	})
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "create session share failed", err)
		return
	}
	slog.Info("session share created", "token", share.TokenSummary(created.Token),
		"session", sessionID, "entries", len(snap.Entries), "bytes", created.Size,
		"truncated", snap.Truncated, "ttl", time.Until(created.ExpiresAt).Round(time.Second))
	// 审计入账：整条会话（含思考与工具详情）暴露到匿名短链，创建即安全事件
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareCreate,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("session replay: %s (%s, %d entries, %d bytes)",
			name, sessionID, len(snap.Entries), created.Size),
	})
	c.JSON(http.StatusOK, gin.H{"data": shareResponse(*created)})
}

// DeleteShare DELETE /api/share/:token —— 撤销分享（链接立即失效）
func DeleteShare(c *gin.Context) {
	token := c.Param("token")
	cur, err := store.Get().Share.Get(token)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "share not found", nil)
		return
	}
	if err := store.Get().Share.Delete(token); err != nil {
		shared.Error(c, http.StatusInternalServerError, "delete share failed", err)
		return
	}
	// 终端直播：撤销即断流（馈线终结 → 订阅访客收 end 帧，页面呈现「已结束」）
	if cur.Kind == store.ShareKindTerminal && liveWire != nil {
		liveWire.Unwire(token)
	}
	// 冻结分享：撤销即删副本（P-20261003-320「随撤销即删」；删除失败不回滚
	// 记录撤销——孤儿目录由清账对账兜底扫走，不能为磁盘残壳牺牲链接失效语义）。
	// 目录名经 snapshotDirName 统一重算：单路径/多路径（P-20261008-1）同一处
	if cur.Frozen && cur.ProjectID != "" {
		if name := snapshotDirName(cur); name != "" {
			if err := share.DeleteFrozenSnapshot(name); err != nil {
				slog.Warn("share: delete frozen snapshot failed", "token", share.TokenSummary(token), "err", err)
			}
		}
	}
	// 终端输出冻结快照（P-20261005-205）：撤销即删快照，同一落盘隔离区同一
	// 清账纪律（「随撤销即删」语义同上；孤儿由 gcFrozenOrphans 兜底）
	if cur.Kind == store.ShareKindTermFrozen && cur.TerminalID != "" && cur.ContentHash != "" {
		if err := share.DeleteFrozenSnapshot(store.TermFrozenNativeToken(config.MasterKey(), cur.TerminalID, cur.ContentHash)); err != nil {
			slog.Warn("share: delete term-frozen snapshot failed", "token", share.TokenSummary(token), "err", err)
		}
	}
	// 会话回放 cast 快照（P-20261004-103）：撤销即删快照（同一隔离区/同一
	// 清账纪律；删除失败不回滚记录撤销，孤儿由对账兜底）
	if cur.Kind == store.ShareKindCast && cur.RecordingID != "" {
		if err := share.DeleteFrozenSnapshot(store.CastNativeToken(config.MasterKey(), cur.RecordingID)); err != nil {
			slog.Warn("share: delete cast snapshot failed", "token", share.TokenSummary(token), "err", err)
		}
	}
	// 会话回放只读分享快照（P-20261003-77）：撤销即删快照（同一隔离区/同一
	// 清账纪律；删除失败不回滚记录撤销，孤儿由对账兜底）
	if cur.Kind == store.ShareKindSession && cur.SessionID != "" {
		if err := share.DeleteFrozenSnapshot(store.SessionNativeToken(config.MasterKey(), cur.SessionID)); err != nil {
			slog.Warn("share: delete session snapshot failed", "token", share.TokenSummary(token), "err", err)
		}
	}
	// 协作通道级联（P-20261024-1）：撤销即清收件目录（素材生命周期与分享
	// 一体——「分享终止级联清」；删除失败残留由 GcOrphanDrops keep 集对账
	// 兜底）+ 直通持权级联回收（回收即解除会话只读闸——记录死亡后访客面
	// 404，不会再有输入触发惰性清扫，闸必须就地解除）
	if err := share.DeleteDropsFor(token); err != nil {
		slog.Warn("share: delete drops dir failed", "token", share.TokenSummary(token), "err", err)
	}
	if shareSvc != nil {
		shareSvc.RevokeDirect(token, "cascade")
		// 可写上行级联清场（P-20261106-8）：记录死亡后访客面 404，上行桥
		// 不能残留（连接断开+待批面清空+会话闸随连接 defer 解除）
		shareSvc.WritableDown(token)
	}
	slog.Info("share revoked", "token", share.TokenSummary(token))
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareRevoke,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: token,
	})
	c.JSON(http.StatusOK, gin.H{"message": "revoked"})
}

// RotateShare POST /api/share/:token/rotate —— 轮换分享短链（泄露应对
// 一步化）：链接疑似外泄时无需「撤销 + 重建」——服务端为该分享派生新短链
// （代际计数参与派生）、旧短链立即失效，响应即带新记录（前端刷新列表并把
// 新链送剪贴板）。未知/已撤销/已过期 → 404
func RotateShare(c *gin.Context) {
	token := c.Param("token")
	rotated, err := store.Get().Share.Rotate(token)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			shared.Error(c, http.StatusNotFound, "share not found", nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "rotate share failed", err)
		return
	}
	slog.Info("share rotated", "oldToken", share.TokenSummary(token), "token", share.TokenSummary(rotated.Token))
	// 终端直播轮换：旧 token 的馈线立即终结（旧链订阅者收 end 帧）；新 token
	// 的馈线在访客首连时惰性接通（Subscribe 惰性 Wire）
	if rotated.Kind == store.ShareKindTerminal && liveWire != nil {
		liveWire.Unwire(token)
	}
	// 直通持权级联回收（P-20261024-1）：轮换代际换 token 键——旧 token 上
	// 的持权随旧链消亡（新链持权需重新申请-批准），会话侧只读闸同步解除。
	// 可写上行同款级联（P-20261106-8）：旧链上行连接即刻断开，新链从只读
	// 基线重新开始（可写位随记录迁移，访客重连即恢复——但口令门会话绑定
	// 旧哈希不变，门语义不受轮换影响）
	if shareSvc != nil {
		shareSvc.RevokeDirect(token, "cascade")
		shareSvc.WritableDown(token)
	}
	// 审计入账：轮换是泄露应对动作，谁在何时轮换了哪条短链值得留痕。
	// 注意与 slog 不同界：审计台账（AuditEvent）是本地持久化的对账凭证
	// 而非外发日志工件，Detail 记完整 token（新旧）保指认能力——脱敏只
	// 收口 slog 与 gin 访问日志（P-20261002-95）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareRotate,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s -> %s", token, rotated.Token),
	})
	c.JSON(http.StatusOK, gin.H{"data": shareResponse(*rotated)})
}

// refreshShareReq 原地刷新请求（P-20261005-177）。Override 敏感扫描警示的
// 确认标记：与创建同契约——新副本扫描命中且未确认时响应不带 data、旧副本
// 原样保留，前端弹确认框后带 true 二次请求才真正换内容
type refreshShareReq struct {
	Override bool `json:"override"`
}

// RefreshShare POST /api/share/:token/refresh —— 冻结分享原地刷新（保 token
// 换内容的分发友好语义）：同 token 重拷当前内容顶替旧副本，已分发出去的
// 链接全部继续有效——与 rotate 换链语义正交并存（rotate = 主动换链防泄露，
// refresh = 链稳定、内容跟进；长期维护的冻结分享不再需要「撤销重建 + 外链
// 全失效」两步换新）。两段式：新副本先拷进暂存目录（在服务的旧副本全程
// 零扰动，访客面无空窗；换名收口窗口仅两次元数据操作）→ 敏感扫描对暂存
// 副本（所见即所扫，同创建语义；命中未确认拦下、暂存丢弃、旧副本保留）。
// 体积护栏重跑（单份 200MB/快照库总量 1GB），触顶拒绝且旧副本保留——拒绝
// 刷新绝不弄瞎既有链。刷新即 TTL 重置（FrozenTTL 30 天）：内容换新副本
// 落盘，磁盘保留窗口随之续期（显式调过的有效期一并重置，属本语义的一部分，
// 结果卡/SetExpiry 可再调）。仅 frozen 记录可刷新（400：live 活视图随项目
// 漂移无需刷新；snippet/terminal/terminal-frozen 无项目源可重拷）
func RefreshShare(c *gin.Context) {
	token := c.Param("token")
	var req refreshShareReq
	// 空请求体容忍（rotate 同款 curl 习惯）：首次刷新通常不带任何字段
	if c.Request.Body != nil && c.Request.ContentLength > 0 {
		if err := c.ShouldBindJSON(&req); err != nil {
			shared.Error(c, http.StatusBadRequest, "invalid request", err)
			return
		}
	}
	st := store.Get()
	cur, err := st.Share.Get(token)
	if err != nil || cur.Expired(time.Now()) {
		shared.Error(c, http.StatusNotFound, "share not found", nil)
		return
	}
	kind := cur.Kind
	if kind == "" {
		kind = store.ShareKindFile // 存量记录零迁移语义
	}
	if kind != store.ShareKindFile || !cur.Frozen || cur.ProjectID == "" {
		shared.Error(c, http.StatusBadRequest, "refresh requires a frozen file share", nil)
		return
	}
	proj, err := st.Project.GetByID(cur.ProjectID)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "project not found", nil)
		return
	}
	// 多路径冻结分享（P-20261008-1）：集合链路独立走多源两段式刷新
	if len(cur.Paths) > 0 {
		refreshBatchFrozenShare(c, st, proj, cur, req)
		return
	}
	target, err := share.StatTarget(proj.Path, cur.Path)
	if err != nil {
		// 目标已删除/挪走：刷新无从谈起，旧副本保留（既有访客面继续服务
		// 定格内容，直到分享者撤销或 TTL 到期清账）
		shared.Error(c, http.StatusNotFound, "target not found: "+cur.Path, nil)
		return
	}
	nativeToken := store.FrozenNativeToken(config.MasterKey(), cur.ProjectID, cur.Path)
	copied, err := share.StageFrozenSnapshot(proj.Path, cur.Path, nativeToken)
	if err != nil {
		if errors.Is(err, share.ErrFrozenTooLarge) || errors.Is(err, share.ErrFrozenQuota) {
			// 护栏拒绝是可预期的常态：哨兵原文即前端 KNOWN_ERROR_I18N 的
			// 匹配契约，413 表达「目标太大」而非服务器故障；暂存已随 Stage
			// 内部回滚，旧副本未动
			shared.Error(c, http.StatusRequestEntityTooLarge, err.Error(), nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "refresh frozen snapshot failed", err)
		return
	}
	// 敏感扫描对暂存副本本身（所见即所扫，与创建同表同语义）：命中未确认
	// → 暂存丢弃、旧副本原样、响应不带 data（同创建的警示确认流）
	scan, err := share.ScanSensitive(share.SnapshotsRoot(), share.StagedScanRel(nativeToken, cur.Path))
	if err != nil {
		share.DiscardFrozenStaging(nativeToken)
		shared.Error(c, http.StatusInternalServerError, "scan share target failed", err)
		return
	}
	if len(scan.Warnings) > 0 && !req.Override {
		share.DiscardFrozenStaging(nativeToken)
		slog.Info("share refresh blocked by sensitive scan", "token", share.TokenSummary(token),
			"path", cur.Path, "hits", len(scan.Warnings), "truncated", scan.Truncated)
		c.JSON(http.StatusOK, gin.H{"warnings": scan.Warnings, "scanTruncated": scan.Truncated})
		return
	}
	if err := share.PromoteFrozenSnapshot(nativeToken); err != nil {
		share.DiscardFrozenStaging(nativeToken)
		shared.Error(c, http.StatusInternalServerError, "refresh frozen snapshot failed", err)
		return
	}
	// 记录面：走幂等创建刷新名称/大小/项目名快照（Token/Rotate/CreatedAt/
	// ExpiresAt/Hits/口令门/水印等既有字段由 store 幂等分支保留），再把 TTL
	// 重置为从当下起算的 30 天（「刷新即续期」；SetExpiry 同管线）
	updated, err := st.Share.Create(store.Share{
		Kind:           store.ShareKindFile,
		ProjectID:      cur.ProjectID,
		ProjectName:    proj.Name,
		Path:           cur.Path,
		Name:           shareDisplayName(target.Name, cur.Path, proj.Name),
		IsDir:          target.IsDir,
		Size:           target.Size,
		Frozen:         true,
		PassphraseHash: cur.PassphraseHash,
		Watermark:      cur.Watermark,
	})
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "refresh share record failed", err)
		return
	}
	final, err := st.Share.SetExpiry(updated.Token, time.Now().Add(store.FrozenTTL))
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "refresh share record failed", err)
		return
	}
	slog.Info("share refreshed", "token", share.TokenSummary(token), "project", proj.Name,
		"path", cur.Path, "bytes", copied, "sensitiveHits", len(scan.Warnings),
		"ttl", time.Until(final.ExpiresAt).Round(time.Minute))
	// 审计入账：刷新把新内容顶进既有出域链，属暴露面内容变更，与创建/轮换
	// 同族留痕（只记路径摘要，frozen 注记沿创建惯例）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareRefresh,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s: %s (%s, frozen)", proj.Name, cur.Path, shareKindLabel(final.IsDir)),
	})
	c.JSON(http.StatusOK, gin.H{"data": shareResponse(*final),
		"warnings": scan.Warnings, "scanTruncated": scan.Truncated})
}

// refreshBatchFrozenShare 多路径冻结分享的原地刷新（P-20261008-1，与单路径
// 刷新同语义）：新副本先拷进暂存目录（旧副本零扰动）→ 扫描暂存副本 → 换名
// 顶替 → 记录侧幂等创建刷新体积并重置 TTL。任一路径已删除 → 404 保旧副本
// （与单路径「目标不在只报错不动旧链」同一取舍）；护栏触顶拒绝且旧副本保留
func refreshBatchFrozenShare(c *gin.Context, st *store.Store, proj *config.ProjectConfig, cur *store.Share, req refreshShareReq) {
	// 刷新前逐项确认源仍存在：一条路径被删除即整单拒绝（manifest 语义要求
	// 集合完整；旧副本继续服务定格内容，直到分享者撤销或 TTL 到期）
	for _, p := range cur.Paths {
		if _, err := share.StatTarget(proj.Path, p); err != nil {
			shared.Error(c, http.StatusNotFound, "target not found: "+p, nil)
			return
		}
	}
	nativeToken := store.FrozenBatchNativeToken(config.MasterKey(), cur.ProjectID, cur.Paths)
	copied, err := share.StageFrozenSnapshotMulti(proj.Path, cur.Paths, nativeToken)
	if err != nil {
		if errors.Is(err, share.ErrFrozenTooLarge) || errors.Is(err, share.ErrFrozenQuota) {
			shared.Error(c, http.StatusRequestEntityTooLarge, err.Error(), nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "refresh frozen snapshot failed", err)
		return
	}
	// 扫描暂存副本根（批量镜像布局下整棵暂存目录即全部路径的副本）
	scan, err := share.ScanSensitive(share.SnapshotsRoot(), share.StagedScanRel(nativeToken, ""))
	if err != nil {
		share.DiscardFrozenStaging(nativeToken)
		shared.Error(c, http.StatusInternalServerError, "scan share target failed", err)
		return
	}
	if len(scan.Warnings) > 0 && !req.Override {
		share.DiscardFrozenStaging(nativeToken)
		slog.Info("batch share refresh blocked by sensitive scan", "token", share.TokenSummary(cur.Token),
			"paths", len(cur.Paths), "hits", len(scan.Warnings), "truncated", scan.Truncated)
		c.JSON(http.StatusOK, gin.H{"warnings": scan.Warnings, "scanTruncated": scan.Truncated})
		return
	}
	if err := share.PromoteFrozenSnapshot(nativeToken); err != nil {
		share.DiscardFrozenStaging(nativeToken)
		shared.Error(c, http.StatusInternalServerError, "refresh frozen snapshot failed", err)
		return
	}
	// 记录面：集合/展示名/口令/水印原样，体积按新副本实际复制量刷新；
	// 幂等 Create 保留 Token/Rotate/CreatedAt/ExpiresAt/Hits 等既有字段
	updated, err := st.Share.Create(store.Share{
		Kind: store.ShareKindFile, ProjectID: cur.ProjectID, ProjectName: proj.Name,
		Paths: cur.Paths, Name: cur.Name, IsDir: false, Size: copied, Frozen: true,
		PassphraseHash: cur.PassphraseHash, Watermark: cur.Watermark,
	})
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "refresh share record failed", err)
		return
	}
	final, err := st.Share.SetExpiry(updated.Token, time.Now().Add(store.FrozenTTL))
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "refresh share record failed", err)
		return
	}
	slog.Info("batch share refreshed", "token", share.TokenSummary(final.Token), "project", proj.Name,
		"paths", len(cur.Paths), "bytes", copied, "sensitiveHits", len(scan.Warnings),
		"ttl", time.Until(final.ExpiresAt).Round(time.Minute))
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareRefresh,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s: %s (file, frozen, batch)", proj.Name, summarizeBatchPaths(cur.Paths)),
	})
	c.JSON(http.StatusOK, gin.H{"data": shareResponse(*final),
		"warnings": scan.Warnings, "scanTruncated": scan.Truncated})
}

// setExpiryReq 有效期调整请求（opt-in TTL，P-20261003-29）。ExpiresAt 为
// RFC3339 绝对时点（前端把自定义日期取到当日 23:59:59 本地时区；过去时点
// 不拒绝——语义即「立即可过期」，访客面 410 + 清理管线接管）；null = 恢复
// 永久（A2 默认语义）
type setExpiryReq struct {
	ExpiresAt *time.Time `json:"expiresAt"`
}

// SetShareExpiry POST /api/share/:token/expiry —— 显式调整文件/目录分享的
// 有效期。snippet 拒绝（400）：24h 倒计时是创建即定的固定安全边界，不开放
// 调整；未知/已撤销/已过期 → 404（与轮换同口径）。调整是暴露窗口变更，
// 与创建/撤销/轮换同族入审计（Detail 只记 token 与目标时点）
func SetShareExpiry(c *gin.Context) {
	token := c.Param("token")
	var req setExpiryReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request", err)
		return
	}
	cur, err := store.Get().Share.Get(token)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "share not found", nil)
		return
	}
	if cur.Kind == store.ShareKindSnippet {
		shared.Error(c, http.StatusBadRequest, "snippet expiry is fixed", nil)
		return
	}
	expiresAt := time.Time{}
	if req.ExpiresAt != nil {
		expiresAt = *req.ExpiresAt
	}
	updated, err := store.Get().Share.SetExpiry(token, expiresAt)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			shared.Error(c, http.StatusNotFound, "share not found", nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "set share expiry failed", err)
		return
	}
	// 留痕记生效值（P-20261106-9：未过滤记录的「恢复永久/越界延长」被 store
	// 钳到 UnfilteredTTLMax，请求值≠生效值，台账以落库为准；其余记录两者恒等）
	target := "permanent"
	if !updated.ExpiresAt.IsZero() {
		target = updated.ExpiresAt.UTC().Format(time.RFC3339)
	}
	slog.Info("share expiry set", "token", share.TokenSummary(token), "expiresAt", target)
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareExpiry,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s -> %s", token, target),
	})
	c.JSON(http.StatusOK, gin.H{"data": shareResponse(*updated)})
}

// setPassphraseReq 口令门设置请求（P-20261006-25）。Passphrase 空/缺省 =
// 移除口令（回到「知道链接即能看」）；Rotate = 改口令同时轮换短链（任务书
// 建议：旧链失效防「持有旧口令的旧收件人」继续经旧链访问——改口令的动机
// 多是口令本身外泄，此时旧链+旧会话一并作废才是完整应对）
type setPassphraseReq struct {
	Passphrase string `json:"passphrase"`
	Rotate     bool   `json:"rotate"`
}

// SetSharePassphrase POST /api/share/:token/passphrase —— 设置/更换/移除
// 访问口令门（四形态统一：file/frozen/snippet/terminal）。改口令即让全部
// 已发访客门会话失效（访客 cookie 绑定记录当前口令哈希，见 share/passgate.go
// ——服务端无需会话表）。rotate=true 时连带轮换短链，响应 data 为最终记录
// （新 token）。未知/已撤销/已过期 → 404（与轮换/有效期同口径）
func SetSharePassphrase(c *gin.Context) {
	token := c.Param("token")
	var req setPassphraseReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request", err)
		return
	}
	hash, err := hashPassphrase(req.Passphrase)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, err.Error(), nil)
		return
	}
	updated, err := store.Get().Share.SetPassphrase(token, hash)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			shared.Error(c, http.StatusNotFound, "share not found", nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "set share passphrase failed", err)
		return
	}
	// 已发访客门会话的失效不依赖此处——cookie 校验按记录当前哈希重签比对，
	// 哈希一变全体失效（passgate.valid）
	action := "removed"
	if hash != "" {
		action = "set"
	}
	slog.Info("share passphrase "+action, "token", share.TokenSummary(updated.Token), "rotate", req.Rotate)
	// 审计入账：口令门是出域暴露面的访问控制变更，与创建/撤销/轮换同族留痕
	//（Detail 记 token 与 set/removed，不记口令值——哈希也不记）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditSharePassphrase,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s %s", token, action),
	})
	final := updated
	// rotate 联动（任务书「改口令建议联动 rotate」）：旧链与旧门会话一并作废，
	// 新链即刻可用（terminal 直播轮换的馈线终结由 RotateShare 同款语义承接）
	if req.Rotate {
		rotated, err := store.Get().Share.Rotate(updated.Token)
		if err != nil {
			shared.Error(c, http.StatusInternalServerError, "rotate share failed", err)
			return
		}
		if rotated.Kind == store.ShareKindTerminal && liveWire != nil {
			liveWire.Unwire(token)
		}
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditShareRotate,
			Result: store.AuditResultSuccess,
			IP:     c.ClientIP(),
			Detail: fmt.Sprintf("%s -> %s", token, rotated.Token),
		})
		final = rotated
	}
	c.JSON(http.StatusOK, gin.H{"data": shareResponse(*final)})
}

// GetShareStatus GET /api/share/status —— 子服务端口/协议/就绪态
// （前端据此拼短链 + 服务未就绪时提示）
func GetShareStatus(c *gin.Context) {
	s := currentStatus()
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"running": s.Running,
		"port":    s.Port,
		"scheme":  s.Scheme,
	}})
}

// ── 访客留言板（P-20261006-13）：主人侧聚合面（只读回流，回复是 IM 的活；
// 单删/清空是垃圾内容的出清通道。留言写入在访客子服务 POST /s/{token}/messages，
// 限长/频控/转义防线在 server/share/guestboard.go）──

// ListShareMessages GET /api/share/:token/messages —— 该分享的留言列表
// （新到旧；管理面板数据源 + agent 巡检读留言「同事对我分享的配置有疑问」）。
// 未知/已撤销 → 404（与撤销/轮换同口径）
func ListShareMessages(c *gin.Context) {
	token := c.Param("token")
	if _, err := store.Get().Share.Get(token); err != nil {
		shared.Error(c, http.StatusNotFound, "share not found", nil)
		return
	}
	list, err := store.Get().ShareMsg.List(token, 0)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "list share messages failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": list})
}

// DeleteShareMessage DELETE /api/share/:token/messages/:mid —— 主人单删一条
// 留言（垃圾内容逐条出清）。未知分享/留言 → 404；处置动作入审计
func DeleteShareMessage(c *gin.Context) {
	token, mid := c.Param("token"), c.Param("mid")
	if err := store.Get().ShareMsg.Delete(token, mid); err != nil {
		shared.Error(c, http.StatusNotFound, "share message not found", nil)
		return
	}
	slog.Info("share message deleted", "token", share.TokenSummary(token))
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareMsg,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("delete %s/%s", token, mid),
	})
	c.JSON(http.StatusOK, gin.H{"message": "deleted"})
}

// ClearShareMessages DELETE /api/share/:token/messages —— 主人一键清空该
// 分享全部留言。返回删除条数；处置动作入审计
func ClearShareMessages(c *gin.Context) {
	token := c.Param("token")
	removed, err := store.Get().ShareMsg.Clear(token)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "share not found", nil)
		return
	}
	slog.Info("share messages cleared", "token", share.TokenSummary(token), "removed", removed)
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareMsg,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("clear %s (%d)", token, removed),
	})
	c.JSON(http.StatusOK, gin.H{"message": "cleared", "removed": removed})
}

// shareResponse 管理响应（不含本机路径以外的敏感信息；snippet 不回传
// Content——管理列表只需元数据，内容经访客短链取阅）。hits 恒回传
// （P-20261002-14 访问指标，0 = 未访问）；lastAccessAt 仅访问过后携带
func shareResponse(s store.Share) gin.H {
	kind := s.Kind
	if kind == "" {
		kind = store.ShareKindFile // 存量记录零迁移
	}
	out := gin.H{
		"token":       s.Token,
		"kind":        kind,
		"projectId":   s.ProjectID,
		"projectName": s.ProjectName,
		"path":        s.Path,
		"name":        s.Name,
		"isDir":       s.IsDir,
		"size":        s.Size,
		"createdAt":   s.CreatedAt,
		"hits":        s.Hits,
		// 访客留言计数（P-20261006-13）：恒回传（0 = 无留言）——「留言 N」
		// 角标的 O(1) 数据源（计数是附表的冗余投影，真实存量以留言列表为准）
		"messages": s.MessageCount,
		// 溯源水印开关（P-20261005-193）：恒回传布尔（存量记录 false = 未开，
		// 字段缺省语义与落库一致）
		"watermark": s.Watermark,
		// 协作通道开关（P-20261024-1）：恒回传布尔（缺省 false = 关，端点
		// 对访客恒 404）——管理列表行内开关的数据源
		"collab": s.Collab,
		// 直通输入档开关（P-20261024-1 第二档）：恒回传布尔；持权/申请态
		// 单独投影（direct 字段，见下）
		"directInput": s.DirectInput,
		// 可写分享开关（P-20261106-8）：恒回传布尔（缺省 false = 关，WS 端点
		// 对访客恒 404）——管理列表行内开关与批量多选的数据源
		"writable": s.Writable,
	}
	if s.TerminalID != "" {
		out["terminalId"] = s.TerminalID
	}
	// 回放分享的录制锚点（P-20261004-103）：管理列表据此展示来源录制 /
	// agent 程序化回查；其余形态缺省
	if s.RecordingID != "" {
		out["recordingId"] = s.RecordingID
	}
	// 会话回放分享的会话锚点（P-20261003-77）：管理列表展示来源会话 /
	// agent 程序化回查；其余形态缺省
	if s.SessionID != "" {
		out["sessionId"] = s.SessionID
	}
	// 冻结标记（P-20261003-320）：管理列表据此挂「冻结」徽标；live 记录
	// 不携带（存量零迁移语义——缺省即 live）
	if s.Frozen {
		out["frozen"] = true
	}
	// 多路径冻结分享（P-20261008-1）：集合清单随记录投影——管理列表展示
	// 「N 项」并可展开核对，agent 程序化回查评审包组成；单路径记录不携带
	if len(s.Paths) > 0 {
		out["paths"] = s.Paths
	}
	// 一次性查看标记（P-20261006-27）：管理列表据此挂「一次性」徽标；
	// consumed = 已被查看且宽限窗走完的失效态（服务端判——宽限窗常量
	// 单点在 store，前端不复制判定逻辑），列表据此挂「已失效」标
	if s.ViewOnce {
		out["viewOnce"] = true
	}
	// 未过滤标记（P-20261106-9）：管理列表据此挂「未过滤」显式徽标、结果卡
	// 标注——敏感值遮蔽被关闭的分享必须在每个管理面一眼可辨。遮蔽开（缺省）
	// 不携带（存量零迁移语义——缺省即已遮蔽）
	if s.Unfiltered {
		out["unfiltered"] = true
	}
	if s.Consumed(time.Now()) {
		out["consumed"] = true
	}
	// 口令门标记（P-20261006-25）：管理列表据此挂 🔒 徽标 + 改/移除口令入口；
	// 只报有无（布尔），哈希本身永不外发
	if s.PassphraseHash != "" {
		out["hasPassphrase"] = true
	}
	if !s.LastAccessAt.IsZero() {
		out["lastAccessAt"] = s.LastAccessAt
	}
	// 退役访问观测（P-20261008-2）：台账条目命中数的合计与最近命中时点——
	// 管理列表「退役访问 N 次」徽标的数据源（有命中才携带，与 lastAccessAt
	// 同款缺省纪律）。明细（各退役 token）不进列表投影：对账面在审计台账
	//（share.retiredHit 事件 Detail 含退役 token），列表只承载告警级别的计数
	var retiredHits int64
	var lastRetired time.Time
	for _, rt := range s.RetiredTokens {
		retiredHits += rt.Hits
		if rt.LastHitAt.After(lastRetired) {
			lastRetired = rt.LastHitAt
		}
	}
	if retiredHits > 0 {
		out["retiredHits"] = retiredHits
	}
	if !lastRetired.IsZero() {
		out["lastRetiredAt"] = lastRetired
	}
	if !s.ExpiresAt.IsZero() {
		out["expiresAt"] = s.ExpiresAt
	}
	// 直通持权/申请态（P-20261024-1）：行内「收回访客输入」入口与会话侧
	// 徽标的数据源（惰性时效在投影路径顺带生效——超时持权回收 + 回调解除
	// 会话闸）。未装配访客面（测试）零投影零开销；列表行数个位数到十位数，
	// 每行一次记录读的增量可忽略（DirectState 内部另有 store.Get 补桥）
	if shareSvc != nil {
		pending, hold := shareSvc.DirectState(s.Token)
		if hold != nil {
			out["direct"] = gin.H{
				"held":        true,
				"visitorTail": visitorBrief(hold.VisitorID),
				"nick":        hold.Nick,
				"grantedAt":   hold.GrantedAt,
				"lastInputAt": hold.LastInputAt,
				"expiresIn":   int(time.Until(hold.LastInputAt.Add(share.DirectHoldIdleTTL)).Seconds()),
			}
		} else if pending != nil {
			out["direct"] = gin.H{
				"held":      false,
				"pending":   true,
				"nick":      pending.Nick,
				"expiresIn": int((share.DirectRequestTTL - time.Since(pending.At)).Seconds()),
			}
		}
		// 可写分享「访客输入中」投影（P-20261106-8）：上行连接数 >0 即在场
		//（wtyping 徽标的 15s 轮询兜底数据源；sc-ops:share.wtyping 是即时
		// 对账路）。轮换/开关关闭即清零，零投影零开销
		if v := shareSvc.WritableState(s.Token); v > 0 {
			out["wtyping"] = gin.H{"visitors": v}
		}
	}
	return out
}
