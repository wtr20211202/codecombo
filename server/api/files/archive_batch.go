package files

import (
	"archive/zip"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/share"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ============== 多选批量归档下载（P-20261003-250） ==============
//
// 文件树多选（P-20261002-20）右键「下载选中」的服务端承载：把选择的路径集合
// （文件/目录混合）流式打包为 zip 响应（不落盘、不整读进内存）。与单目录
// dir-archive（P-20261002-115）和远程归档端点（remotehost_zip.go
// files/archive?paths=）构成同族取件面——
//   - 路径集合参数化沿 remotehost 归档同款 query 数组（1..50 项）；
//   - 打包语义复用本包 StreamZip 惯例（appendDirTree 自 streamDirZip 参数化
//     抽出）：目录项递归含子树、os.Root 锚定、符号链接跳过、.git 默认排除、
//     条目/字节护栏触顶优雅收尾出合法截断包（聚合一份护栏）；
//   - 条目根名 = 选择项 basename，同包撞名 -N 序号去重（remote uniqueName
//     同约定）——与单目录包「以所选目录为根」组合成一致的「以选择项为根」；
//   - 出域防线同款：逐项 share.ScanSensitive，命中拦回 warnings + override=1
//     二次请求确认（与分享创建/目录打包同流）；probe=1 只回聚合规模预估 +
//     命中清单不出包；
//   - 嵌套选择防御：路径落在另一选中目录子树内时随父目录去重（前端同款
//     前缀规则，服务端兜底防同一内容双份进包）。

// batchArchiveMaxPaths 单批最多选择项（remotehost 归档同值）
const batchArchiveMaxPaths = 50

// batchArchiveTarget 一个已校验的批量归档选择项
type batchArchiveTarget struct {
	rel   string // 项目相对路径（/ 分隔，已 NormalizeRelPath 归一）
	abs   string // 项目内绝对路径
	isDir bool
}

// DownloadFilesArchive GET /api/projects/:id/files-archive?paths=a&paths=b[&probe=1][&override=1]
//
//   - probe=1：不出包，返回 {data: 聚合规模预估, warnings: 敏感命中（带目标
//     前缀）, scanTruncated}
//   - 默认：任一选择项敏感扫描命中且未确认（override!=1）时不出包，409 拦回
//     warnings（P-26 同款；P-20261030-2 起取包直链化，200+JSON 会被浏览器存成
//     假 zip，故拦回改错误状态码——下载条显式失败，载荷形态不变）；确认或
//     无命中则以 application/zip 流式响应
//
// .git 目录默认排除同 dir-archive（excludeGit=0 可带）
func DownloadFilesArchive(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	targets, errStatus, errMsg := resolveBatchTargets(p.Path, c.QueryArray("paths"))
	if errStatus != 0 {
		shared.Error(c, errStatus, errMsg, nil)
		return
	}

	excludeGit := c.Query("excludeGit") != "0"
	// probe：逐项敏感扫描 + 聚合规模预估一次返回（元数据级走树，本地盘同步
	// 路径可承受）；命中清单带目标前缀，多选跨目录时可定位到具体选择项
	if c.Query("probe") == "1" {
		scale, warnings, scanTruncated, err := selectionProbe(p.Path, targets, excludeGit)
		if err != nil {
			shared.Error(c, http.StatusInternalServerError, "scan selection failed", err)
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"data":          scale,
			"warnings":      warnings,
			"scanTruncated": scanTruncated,
		})
		return
	}

	// 出域防线（P-26 同款）：任一选择项命中即拦，确认后 override=1 整单放行
	warnings, scanTruncated, err := selectionScan(p.Path, targets)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "scan selection failed", err)
		return
	}
	if len(warnings) > 0 && c.Query("override") != "1" {
		slog.Info("selection archive blocked by sensitive scan", "project", p.Name,
			"targets", len(targets), "hits", len(warnings), "truncated", scanTruncated)
		// 409 而非 200+JSON（P-20261030-2）：取包已直链化——直链响应 200 会被
		// 浏览器按 a.download 存成假 zip（JSON 内容 .zip 名）。拦回属「确认
		// 冲突」语义，409 让浏览器显式下载失败（下载条可见），载荷形态不变
		c.JSON(http.StatusConflict, gin.H{"warnings": warnings, "scanTruncated": scanTruncated})
		return
	}

	c.Header("Content-Type", "application/zip")
	// 下载头统一净化 helper（P-20261003-109）：basename 用户可控，同 dir-archive
	c.Header("Content-Disposition", shared.ContentDispositionFile(selectionZipName(targets)))

	lim := dirZipLimits{maxEntries: dirZipMaxEntries, maxBytes: dirZipMaxTotalBytes, excludeGit: excludeGit}
	st := streamSelectionZip(c.Writer, p.Path, targets, lim)
	if st.err != nil {
		// 头已发出，只能日志留痕（前端表现为 zip 提前截断/损坏，dir-archive 同）
		slog.Warn("selection archive: zip streaming aborted", "project", p.Name, "targets", len(targets), "err", st.err)
	}
	slog.Info("selection archive downloaded", "project", p.Name, "targets", len(targets),
		"entries", st.entries, "bytes", st.bytes, "truncated", st.truncated)
	// 审计入账：多选打包把项目内容批量带出本机，与目录打包同族数据出域动作
	detail := fmt.Sprintf("%s: %d items (%d entries)", p.Name, len(targets), st.entries)
	if st.truncated {
		detail += " truncated"
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditFileBatchArchive,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: detail,
	})
}

// resolveBatchTargets 预检逐项锚定：归一 → 符号链接判定 → SafeJoinProject
// 白名单。单项非法即整单拒绝（400/403/404 带该路径可定位），重复 rel 去重；
// 符号链接选择项跳过（「链接条目一律不打包」的同一策略在选择项级的表现）；
// 全部落空不出空包（claude 批量导出先例）。嵌套选择（子项落在选中目录子树
// 内）随父目录去重，返回 nil 目标时以 errStatus 承载拒绝原因
//
// 为什么 Lstat 判链在 SafeJoinProject 之前：SafeJoinProject 按 EvalSymlinks
// 后的真实路径做根内校验——指向根外的链接选择项会被它 403 拒绝，而选择语义
// 要的是「链接项跳过、其余项照常打包」（dir-archive 单目标拒绝语义之外的
// 批量宽容档）。rel 已被 NormalizeRelPath 词法归一（无 ".." 不出根），naive
// join 恒在项目根内，Lstat 不解链接只触链接本体，无越界读面；链接的中间
// 链路径仍会落进 SafeJoinProject 被拒，越界防线不变
func resolveBatchTargets(rootPath string, raws []string) (targets []batchArchiveTarget, errStatus int, errMsg string) {
	if len(raws) == 0 || len(raws) > batchArchiveMaxPaths {
		return nil, http.StatusBadRequest, "paths must contain 1..50 entries"
	}
	seen := map[string]bool{}
	for _, raw := range raws {
		// NormalizeRelPath 先行（dir-archive 同款）：反斜杠归一 + 内部 ".." 逐级
		// 上跳，归一后再过边界校验
		rel, err := share.NormalizeRelPath(raw)
		if err != nil {
			return nil, http.StatusBadRequest, "invalid path"
		}
		// 空段拒绝：NormalizeRelPath 把 ""/"."/"a/.." 都归一为项目根——批量端点
		// 的选择项必须是具体路径，畸形 query 静默整项目导出太意外（整项目打包
		// 走 dir-archive?path= 显式入口）
		if rel == "" {
			return nil, http.StatusBadRequest, "invalid path"
		}
		if seen[rel] {
			continue
		}
		seen[rel] = true
		fi, err := os.Lstat(filepath.Join(rootPath, filepath.FromSlash(rel)))
		if err != nil {
			return nil, http.StatusNotFound, "not found: " + rel
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			continue
		}
		abs, err := SafeJoinProject(rootPath, rel)
		if err != nil {
			return nil, http.StatusForbidden, err.Error()
		}
		targets = append(targets, batchArchiveTarget{rel: rel, abs: abs, isDir: fi.IsDir()})
	}
	targets = dedupNestedTargets(targets)
	if len(targets) == 0 {
		return nil, http.StatusNotFound, "no packable selection"
	}
	return targets, 0, ""
}

// dedupNestedTargets 嵌套选择去重：路径落在另一选中目录子树内时随父目录
// （排序后仅向前查前缀即可，n≤50 量级；前端 batch-download 同规则，服务端
// 兜底防同一内容以两个名字双份进包）
func dedupNestedTargets(targets []batchArchiveTarget) []batchArchiveTarget {
	if len(targets) < 2 {
		return targets
	}
	sorted := append([]batchArchiveTarget(nil), targets...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].rel < sorted[j].rel })
	out := make([]batchArchiveTarget, 0, len(sorted))
	for i, tg := range sorted {
		nested := false
		for _, q := range sorted[:i] {
			if q.isDir && strings.HasPrefix(tg.rel, q.rel+"/") {
				nested = true
				break
			}
		}
		if !nested {
			out = append(out, tg)
		}
	}
	return out
}

// selectionZipName 包名：单项用其名，多项用时间戳归档名（remotehost 归档同
// 约定；前端下载名客户端合成，日期粒度略粗但同族可辨识——axios 响应拦截器
// 不透 Content-Disposition，服务端同名头供直链/API 消费方）
func selectionZipName(targets []batchArchiveTarget) string {
	if len(targets) == 1 {
		return filepath.Base(targets[0].rel) + ".zip"
	}
	return "archive-" + time.Now().Format("20060102-150405") + ".zip"
}

// selectionScan 逐项敏感扫描：命中清单带「目标前缀」定位到具体选择项——
// 目录项 = rel/ + 树内命中名，文件项 = rel 自身（ScanSensitive 对文件目标
// 只报自身名）。同名命中跨目标去重保序；任一项扫描失败即报错（与单目录
// 包「命中拦回」同级防线不容静默半扫）
func selectionScan(rootPath string, targets []batchArchiveTarget) ([]string, bool, error) {
	var warnings []string
	seen := map[string]bool{}
	truncated := false
	for _, tg := range targets {
		scan, err := share.ScanSensitive(rootPath, tg.rel)
		if err != nil {
			return nil, false, err
		}
		truncated = truncated || scan.Truncated
		for _, w := range scan.Warnings {
			full := tg.rel
			if tg.isDir {
				full = tg.rel + "/" + w
			}
			if !seen[full] {
				seen[full] = true
				warnings = append(warnings, full)
			}
		}
	}
	if warnings == nil {
		warnings = []string{}
	}
	return warnings, truncated, nil
}

// selectionProbe 聚合规模预估 + 敏感命中（probe 响应）：目录项复用
// dirZipScaleOf（同排除面同护栏口径），文件项自身即一条目；跨目标累计触顶
// 即置 Truncated——与实际打包的聚合护栏同口径，超限预估才有截断提示通道
func selectionProbe(rootPath string, targets []batchArchiveTarget, excludeGit bool) (dirZipScale, []string, bool, error) {
	warnings, scanTruncated, err := selectionScan(rootPath, targets)
	if err != nil {
		return dirZipScale{}, nil, false, err
	}
	lim := dirZipLimits{maxEntries: dirZipMaxEntries, maxBytes: dirZipMaxTotalBytes, excludeGit: excludeGit}
	var sc dirZipScale
	for _, tg := range targets {
		if tg.isDir {
			part := dirZipScaleOf(rootPath, tg.abs, lim)
			sc.Entries += part.Entries
			sc.Bytes += part.Bytes
			sc.Truncated = sc.Truncated || part.Truncated
			continue
		}
		if fi, err := os.Stat(tg.abs); err == nil {
			sc.Entries++
			sc.Bytes += fi.Size()
		}
	}
	sc.Truncated = sc.Truncated || sc.Entries > int64(lim.maxEntries) || sc.Bytes > lim.maxBytes
	return sc, warnings, scanTruncated, nil
}

// streamSelectionZip 把选择项集合流式打包写入 w：一枚 zip.Writer 串起全部
// 目标，聚合护栏一份（st 跨目标累计）。目录项 = basename 前缀 + 子树相对
// 路径（appendDirTree 参数化复用），文件项 = 单条目；条目根名撞名 -N 序号
// 去重（首项保原名，remote uniqueName 同约定）。任一目标走树失败记 st.err
// 继续其余目标（部分包仍合法可开，zip 中央目录收尾必写）
func streamSelectionZip(w io.Writer, rootPath string, targets []batchArchiveTarget, lim dirZipLimits) dirZipStats {
	var st dirZipStats
	zw := zip.NewWriter(w)
	used := map[string]bool{}
	for _, tg := range targets {
		name := uniqueEntryName(used, filepath.Base(tg.rel), tg.isDir)
		var err error
		if tg.isDir {
			err = appendDirTree(zw, rootPath, tg.abs, name+"/", &st, lim)
		} else {
			err = appendFileEntry(zw, rootPath, tg, name, &st, lim)
		}
		if err != nil && st.err == nil {
			st.err = err
		}
	}
	// 中央目录必须写出：即使中途失败也让客户端拿到可打开的部分包
	if cerr := zw.Close(); cerr != nil && st.err == nil {
		st.err = cerr
	}
	return st
}

// appendFileEntry 把单个本地文件作为一条 zip 条目追加（批量归档的文件选择
// 项）。经 os.Root 打开（选择项为符号链接已在预检剔除，Root 拒绝路径内
// 链接兜底 TOCTOU）；护栏触顶跳过该条目并置 truncated（先记账后写头部，
// truncated 当且仅当确有未打包条目，appendDirTree 同语义）
func appendFileEntry(zw *zip.Writer, rootPath string, tg batchArchiveTarget, name string, st *dirZipStats, lim dirZipLimits) error {
	if st.entries >= int64(lim.maxEntries) {
		st.truncated = true
		return nil
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return err
	}
	defer root.Close()
	f, err := root.Open(tg.rel)
	if err != nil {
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	if st.bytes+fi.Size() > lim.maxBytes {
		st.truncated = true
		return nil
	}
	hdr, err := zip.FileInfoHeader(fi)
	if err != nil {
		return err
	}
	hdr.Name = name
	hdr.Modified = fi.ModTime().Truncate(time.Second) // 秒级精度（跨平台 zip 时间戳口径）
	hdr.Method = zip.Deflate
	out, err := zw.CreateHeader(hdr)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, f)
	st.entries++
	st.bytes += n
	return err
}

// uniqueEntryName 多选 basename 撞名时追加序号（docs/a.txt 与 src/a.txt 同包
// → a.txt 与 a-2.txt；remote uniqueName 同约定）
func uniqueEntryName(used map[string]bool, base string, isDir bool) string {
	name := base
	for i := 2; used[name]; i++ {
		if isDir {
			name = fmt.Sprintf("%s-%d", base, i)
		} else {
			ext := filepath.Ext(base)
			name = fmt.Sprintf("%s-%d%s", strings.TrimSuffix(base, ext), i, ext)
		}
	}
	used[name] = true
	return name
}
