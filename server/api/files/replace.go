package files

// 批量替换的服务端执行 API（P-20261004-114）：agent 批量编辑原语——
// 此前批量替换的执行编排纯在前端（ProjectSearch.executeReplace 逐文件
// readFile→replace→writeFile，N 次 API 往返、无备份纪律），跨文件重命名/
// 迁移类任务 agent 只能逐文件手搓。本文件把同一能力服务端化：
//
//	POST   /api/projects/:id/replace/preview  命中预览（文件×行 before→after，纯读不写）
//	POST   /api/projects/:id/replace          执行替换（强制备份 → 逐文件写回）
//	GET    /api/projects/:id/replace/backups  备份 patch 清单 / ?name= 取内容（回滚原料）
//
// 预览与执行拆成两个端点（而非任务书原稿的单端点 dryRun 字段）是刻意的：
// AgentGuard 是路由级守卫（method+FullPath 精确匹配），同路由则 agent 的
// 预览也要吃 428，工作流变成「审批→预览→再审批→执行」双卡体验；拆开后
// preview 与 GET /search 同敏感级（grep 行内容）读面开放，execute 独入高危
// 审批（agentguard.go guardedRoutes「批量替换」）——resolve 族「读面不设防、
// 裁决关口设防」同构。任务书的 dryRun 语义由 preview 端点承载。
//
// 替换核心与前端 buildReplaceRegex（web/src/utils/replacePreview.ts）同语义的
// Go 重实现：字面量转义 / 整词 \b / 大小写 (?i) / 全量替换；双端正则引擎差异
// （Go RE2 无前瞻/后顾/反向引用）编译期暴露，400 提示「以服务端为准」
// （哨兵惯例：预览 API 的 POSIX ERE 与本端点同为服务端裁决）。

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/filepolicy"
	"codecombo/server/git"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ── 量级护栏（热路径注记：单次请求 = 1 次 grep 子进程 + 逐命中文件整读整写，
// 文件数由 maxFiles 钳制、单文件由 replaceMaxFileBytes 钳制，内存峰值有界）──

const (
	// replaceDefaultMaxFiles maxFiles 缺省值：跨文件重命名/迁移的常见规模
	replaceDefaultMaxFiles = 100
	// replaceMaxFilesCap maxFiles 硬钳制：批量写 N 文件的爆量防线（任务书
	// 「maxFiles 钳制防爆量」），更大范围应缩小 glob 分批
	replaceMaxFilesCap = 500
	// replaceScanProbeHits 命中文件集扫描上限：与搜索端点同口径的 5000 钳制，
	// 多取 1 条探测截断（批量搜索 truncated 探测同款）
	replaceScanProbeHits = 5000
	// replacePathsMax Paths 圈定子集的条数上限（= replaceMaxFilesCap 同一量级
	// 防线：批量写 N 文件的爆量防线对显式清单同样生效，更大范围分批）
	replacePathsMax = 500
	// replacePreviewRowsPerFile 预览每文件行数上限：命中千行的文件不把响应
	// 撑爆——行数全量计数（hits），对照行只展示前 N 行
	replacePreviewRowsPerFile = 20
	// replaceBackupRetention 备份 patch 保留期（车道 2 义务：第一天配保留策略）
	replaceBackupRetention = 30 * 24 * time.Hour
	// replaceBackupMaxPerProject 每项目备份数上限（逐最旧裁剪）
	replaceBackupMaxPerProject = 50
)

// 包级变量：replaceMaxFileBytes 源自 filepolicy.TextPreviewLimit（var 非 const，
// 故随包级变量），单文件整读整写上限与编辑器全文打开上限同源——超大文件
// 不走批量替换（编辑器同样打不开）；replaceBodyMaxBytes 是请求体上限
// （pattern/replacement 文本面，64KB 富余）
var (
	replaceMaxFileBytes = filepolicy.TextPreviewLimit
	replaceBodyMaxBytes = int64(64) << 10
)

// replaceOptions 替换请求（preview / execute 共用一份请求形状）。
// 三个开关缺省 false 与 GET /search 查询参数缺省同语义（大小写不敏感、
// 非整词、字面量）——agent 先 search 后 replace 时无需翻译参数
type replaceOptions struct {
	Pattern       string `json:"pattern"`
	Replacement   string `json:"replacement,omitempty"`
	Glob          string `json:"glob,omitempty"`
	MaxFiles      int    `json:"maxFiles,omitempty"`
	CaseSensitive bool   `json:"caseSensitive,omitempty"`
	WholeWord     bool   `json:"wholeWord,omitempty"`
	UseRegex      bool   `json:"useRegex,omitempty"`
	// ConfirmSensitive 敏感文件二次确认（files.sensitive_confirm_required
	// 409 后的重试档，dir-archive override=1 同流：先看清单再显式放行）
	ConfirmSensitive bool `json:"confirmSensitive,omitempty"`
	// PreserveCase 保留大小写（P-20261006-16）：替换输出跟随命中词形态——
	// 全小写原样 / 全大写大写化 / Title 首字母大写化，混合形态不猜原样。与
	// CaseSensitive 正交（那管匹配、这管输出，可同开）；预览 after 与执行写回
	// 同走 replaceWithShape 单点，「所见即所得」不漂移。前端同名开关/同语义
	// 纯函数双实现互指（web/src/utils/replacePreview.ts applyPreservedCase）
	PreserveCase bool `json:"preserveCase,omitempty"`
	// Paths 执行范围圈定（P-20261004-66 前端切换到服务端执行链所补）：前端
	// 预览弹层的文件勾选是「用户显式圈定的范围」，命中集收窄到该子集——
	// 服务端 grep 仍是唯一事实源（paths 只做交集不过度授权，越界路径由
	// replaceOneFile SafeJoinProject 拒绝）。agent 全库替换不传（nil=全命中集）。
	// 条数钳 replacePathsMax（前端勾选来自搜索结果，超限提示缩小范围）
	Paths []string `json:"paths,omitempty"`
}

// replaceLinePreview 单行 before→after 对照（行内容来自 grep 展示解码，
// 执行侧以逐文件探测解码为准——同前端行级预览的粒度注记）
type replaceLinePreview struct {
	Line   int    `json:"line"`
	Before string `json:"before"`
	After  string `json:"after"`
}

// replaceFilePreview 单文件命中（preview 响应与 execute 的内部命中集同构）
type replaceFilePreview struct {
	Path string               `json:"path"`
	Hits int                  `json:"hits"`
	Rows []replaceLinePreview `json:"rows,omitempty"`
}

// replacePreviewResponse 预览响应：文件×行摘要 + 截断/敏感标记，绝不写盘
type replacePreviewResponse struct {
	Files         []replaceFilePreview `json:"files"`
	TotalFiles    int                  `json:"totalFiles"`
	TotalHits     int                  `json:"totalHits"`
	Truncated     bool                 `json:"truncated,omitempty"`
	SensitiveHits []string             `json:"sensitiveHits,omitempty"`
}

// replaceBackupInfo 执行响应携带的回滚点：备份 patch 文件名（内容经
// GET /replace/backups?name= 取回）。Empty=true = 执行前无任何可备份内容
// （tracked 干净且无 untracked），还原只需丢弃工作区改动；P-20261004-56 起
// untracked 命中文件以 new-file 段入备份（「先删除该文件再重放补丁」即还原
// 替换前内容），本地历史快照（P-130）仍是其第二还原路
type replaceBackupInfo struct {
	Name  string `json:"name"`
	Empty bool   `json:"empty,omitempty"`
}

// replaceResult 执行响应
type replaceResult struct {
	Backup        *replaceBackupInfo   `json:"backup,omitempty"`
	Changed       []replaceChangedFile `json:"changed"`
	Skipped       []replaceSkippedFile `json:"skipped,omitempty"`
	Conflicts     []string             `json:"conflicts,omitempty"`
	TotalHits     int                  `json:"totalHits"`
	Truncated     bool                 `json:"truncated,omitempty"`
	SensitiveHits []string             `json:"sensitiveHits,omitempty"`
}

type replaceChangedFile struct {
	Path string `json:"path"`
	Hits int    `json:"hits"`
}

type replaceSkippedFile struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// buildReplaceRegexp 与前端 buildReplaceRegex 同语义的 Go 构造：
// 字面量 QuoteMeta / 整词 \b / 大小写 (?i) / 全量替换（ReplaceAllLiteral）。
// 编译失败原样上抛：RE2 不支持的 JS 语法（前瞻/后顾/反向引用）在服务端
// 显式报错，错误文案点名双端差异——「以服务端为准」
func buildReplaceRegexp(o replaceOptions) (*regexp.Regexp, error) {
	if strings.TrimSpace(o.Pattern) == "" {
		return nil, errors.New("pattern is required")
	}
	src := o.Pattern
	if !o.UseRegex {
		src = regexp.QuoteMeta(o.Pattern)
	}
	if o.WholeWord {
		// 非捕获组包裹：顶层择一并列（foo|bar）+ 整词时，裸 \bfoo|bar\b 会
		// 错切第二支的左边界——前端镜像存在同形态问题，服务端按正确语义收口
		src = `\b(?:` + src + `)\b`
	}
	if !o.CaseSensitive {
		src = `(?i)` + src
	}
	return regexp.Compile(src)
}

// dualEndRegexHint 编译失败的稳定提示段：agent 据此降级为字面量模式或改写
// 正则（RE2 语法子集），不再盲试
const dualEndRegexHint = " (server-side Go RE2 regex; JS-only constructs like lookaround/backreferences are not supported — simplify the pattern or omit useRegex)"

// applyPreservedCase 形态跟随推断（P-20261006-16，前端同名函数同语义双实现，
// 改动两处同步）：按命中词自身形态变换 replacement——全小写（含空串/无大小写
// 字符）→ 原样、全大写 → 大写化、首字符大写且其余全小写（Title 形态）→
// replacement 首字符大写化；混合形态不猜——原样。下划线/驼峰互转不做（提案
// 克制边界：推断只认三形态，覆盖重命名重构的绝大多数场景）
func applyPreservedCase(replacement, matched string) string {
	if matched == strings.ToLower(matched) {
		return replacement
	}
	if matched == strings.ToUpper(matched) {
		return strings.ToUpper(replacement)
	}
	mr := []rune(matched)
	rr := []rune(replacement)
	if unicode.IsUpper(mr[0]) && strings.ToLower(string(mr[1:])) == string(mr[1:]) && len(rr) > 0 {
		rr[0] = unicode.ToUpper(rr[0])
		return string(rr)
	}
	return replacement
}

// replaceWithShape 预览 after 与执行写回的唯一替换出口（前端 replaceMatches
// 同款「预览-执行零漂移」单点纪律）：preserveCase 时逐命中 applyPreservedCase
// 形态跟随，否则字面量全量替换。ReplaceAllStringFunc 的返回值同为字面量
// （不展开 $1 等特殊序列），与 ReplaceAllLiteralString 字面量语义一致
func replaceWithShape(s string, re *regexp.Regexp, replacement string, preserveCase bool) string {
	if !preserveCase {
		return re.ReplaceAllLiteralString(s, replacement)
	}
	return re.ReplaceAllStringFunc(s, func(m string) string {
		return applyPreservedCase(replacement, m)
	})
}

// filterPathsOrder 命中文件清单按显式 Paths 子集收窄（保序）：前端勾选范围
// 语义。匹配按规范化相对路径（前端搜索结果与 grep 命中同为 forward-slash 口径）
func filterPathsOrder(order, paths []string) []string {
	allow := make(map[string]bool, len(paths))
	for _, p := range paths {
		allow[NormalizeRelPath(p)] = true
	}
	out := make([]string, 0, len(order))
	for _, p := range order {
		if allow[NormalizeRelPath(p)] {
			out = append(out, p)
		}
	}
	return out
}

// collectReplaceHits 服务端 git grep/rg 取命中文件集（与搜索面板同后端、
// 同语义），按文件聚合并构造行级 before→after。maxFiles 钳制文件数；
// 截断（扫描上限或 maxFiles）以 truncated 如实回告——文件集可能不完整，
// agent 应缩小 glob 再来
func collectReplaceHits(root string, re *regexp.Regexp, o replaceOptions) (resp replacePreviewResponse, err error) {
	maxFiles := o.MaxFiles
	if maxFiles <= 0 {
		maxFiles = replaceDefaultMaxFiles
	}
	if maxFiles > replaceMaxFilesCap {
		maxFiles = replaceMaxFilesCap
	}
	matches, err := git.SearchContent(root, o.Pattern, git.SearchOptions{
		CaseSensitive: o.CaseSensitive,
		WholeWord:     o.WholeWord,
		UseRegex:      o.UseRegex,
		FilePattern:   o.Glob,
		MaxResults:    replaceScanProbeHits + 1,
	})
	if err != nil {
		return resp, err
	}

	byPath := make(map[string]*replaceFilePreview, 16)
	order := make([]string, 0, 16)
	resp.Truncated = len(matches) > replaceScanProbeHits
	if resp.Truncated {
		matches = matches[:replaceScanProbeHits]
	}
	for _, m := range matches {
		fp := byPath[m.Path]
		if fp == nil {
			fp = &replaceFilePreview{Path: m.Path}
			byPath[m.Path] = fp
			order = append(order, m.Path)
		}
		fp.Hits++
		resp.TotalHits++
		// 同行多处命中只出一行（after 已含该行全部替换，buildFilePreview 同约定）；
		// 对照行封顶防爆响应
		if len(fp.Rows) >= replacePreviewRowsPerFile {
			continue
		}
		seen := false
		for _, r := range fp.Rows {
			if r.Line == m.Line {
				seen = true
				break
			}
		}
		if seen {
			continue
		}
		fp.Rows = append(fp.Rows, replaceLinePreview{
			Line:   m.Line,
			Before: m.Content,
			After:  replaceWithShape(m.Content, re, o.Replacement, o.PreserveCase),
		})
	}

	sort.Strings(order)
	if len(o.Paths) > 0 {
		// 显式子集圈定：勾选清单即授权范围，maxFiles 不再二次截断（条数已由
		// replacePathsMax 钳制）；TotalFiles/TotalHits 重算为圈定口径——执行
		// 响应的 totalHits 供「完成 N 处替换」回告，混入未勾选文件的命中数
		// 是虚报。清单外的命中文件只从响应剔除，不改变 grep 快照本身
		order = filterPathsOrder(order, o.Paths)
		maxFiles = replacePathsMax
		resp.TotalHits = 0
		for _, p := range order {
			resp.TotalHits += byPath[p].Hits
		}
	}
	if len(order) > maxFiles {
		order = order[:maxFiles]
		resp.Truncated = true
	}
	resp.TotalFiles = len(order)
	resp.Files = make([]replaceFilePreview, 0, len(order))
	for _, p := range order {
		fp := byPath[p]
		rows := fp.Rows
		if len(rows) > 0 {
			cp := make([]replaceLinePreview, len(rows))
			copy(cp, rows)
			sort.Slice(cp, func(i, j int) bool { return cp[i].Line < cp[j].Line })
			fp.Rows = cp
		}
		resp.Files = append(resp.Files, *fp)
	}
	return resp, nil
}

// sensitiveHitPaths 命中集中触发敏感清单的路径（IsSensitiveReadPath 共享 util，
// 大小写不敏感 basename 级匹配——与敏感读取审计同一把尺子）
func sensitiveHitPaths(files []replaceFilePreview) []string {
	var out []string
	for _, f := range files {
		if IsSensitiveReadPath(f.Path) {
			out = append(out, f.Path)
		}
	}
	return out
}

// replaceWriteLocks 批量替换按项目根串行（hunkWriteLocks 同款 sync.Map 惯例）：
// 「grep 快照 → 备份 patch → 逐文件写回」是一个读改写过程，两个并发替换会
// 互踩备份与命中集；与用户/其他 agent 的单文件 WriteFile 并发由 per-file
// BaseHash 重检拒绝（安全失败，工作区不动）
var replaceWriteLocks sync.Map // projectRoot -> *sync.Mutex

// replaceOneFile 单文件替换：WriteFile 链同序（文本甄别 → 整读 → 探测解码 →
// 替换 → 原编码回编 → BaseHash 重检 → 本地历史快照 → 原子写）。
// 返回 (changed hits, skippedReason, conflict)。跳过/冲突不视为错误——批量
// 语义下单文件失败回告继续，与 UploadFiles 的 skipped 形态同哲学
func replaceOneFile(p *config.ProjectConfig, relPath string, re *regexp.Regexp, replacement string, preserveCase bool) (int, string, bool) {
	absPath, err := SafeJoinProject(p.Path, relPath)
	if err != nil {
		return 0, "path outside project root", false
	}
	if !isEditableTextFile(absPath, replaceMaxFileBytes) {
		return 0, "not a readable text file (missing/binary/too large)", false
	}
	cur, err := os.ReadFile(absPath)
	if err != nil {
		return 0, "read failed", false
	}
	baseHash := contentHash(cur)
	text, encoding := decodeText(cur)
	// 执行链跳过无命中文件（前端 contentHasMatch 守卫同语义）：grep 命中与
	// 解码后文本可能失配（GBK 非 ASCII 查询的边界），宁跳过不空写
	if !re.MatchString(text) {
		return 0, "no match in decoded content", false
	}
	next := replaceWithShape(text, re, replacement, preserveCase)
	data, err := encodeText(next, encoding)
	if err != nil {
		return 0, "encode failed", false
	}
	// BaseHash 语义（WriteFile 保存冲突检测同源）：以替换所基的磁盘内容
	// hash 为基线，写前重读比对——读改写窗口被外部（用户编辑/其他会话）
	// 写入打破即拒绝该文件，陈旧替换绝不静默落盘。窗口在重检与 rename 之间
	// 仍有固有残缝（WriteFile 同限），批量替换间互斥由 replaceWriteLocks 保证
	if baseChangedSince(absPath, baseHash) {
		return 0, "", true
	}
	rel := NormalizeRelPath(relPath)
	snapshotForHistory(p.ID, rel, absPath)
	if err := atomicWriteFile(absPath, data); err != nil {
		return 0, "write failed", false
	}
	// 处数按替换所基的解码文本计（与 ReplaceAll 实际替换处数同源同值）
	return countMatches(re, text), "", false
}

// baseChangedSince 写前重检比对：absPath 当前磁盘内容是否已偏离 baseHash
// 所基的内容（读失败按未变处理——文件被删场景由后续原子写自然失败，与
// WriteFile「覆盖保存是显式意图」的既有取舍同口径）
func baseChangedSince(absPath, baseHash string) bool {
	cur, err := os.ReadFile(absPath)
	return err == nil && contentHash(cur) != baseHash
}

// countMatches 替换处数（响应观测面；FindAll 计数与 ReplaceAll 语义同源）
func countMatches(re *regexp.Regexp, text string) int {
	locs := re.FindAllStringIndex(text, -1)
	return len(locs)
}

// replaceBackupsRoot 备份 patch 根（车道 2 artifacts/<feature>/ 惯例，同
// trash/recordings；保留策略见 PurgeExpiredReplaceBackups）
func replaceBackupsRoot() string {
	return filepath.Join(config.DataDir(), "artifacts", "replace-backups")
}

func replaceBackupsProjectDir(projectID string) string {
	return filepath.Join(replaceBackupsRoot(), projectID)
}

// validBackupName 备份文件名白名单：纯文件名段 + .patch 后缀（?name= 取内容
// 入口的路径穿越防线）
func validBackupName(name string) bool {
	if name == "" || len(name) > 128 || !strings.HasSuffix(name, ".patch") {
		return false
	}
	if strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
		return false
	}
	return filepath.Base(name) == name
}

// saveReplaceBackup 执行前强制备份（前端备份链服务端化）：把当前工作区
// vs 暂存区 diff 以 --binary patch 落档 artifacts/replace-backups/<项目>/。
// P-20261004-56 起 untracked 命中文件以 new-file 段入备份（此前无 index 基线
// 不入 patch，此类文件还原只能靠本地历史快照——备份不完整）；还原口诀仍按
// tracked 语义（git checkout -- . 丢弃替换后重放此补丁），untracked 段对应
// 「先删除该文件再重放」即还原替换前内容。空 diff（无任何可备份内容）也落
// 文件占位——Empty=true 告知还原只需丢弃工作区改动，不做「有备份」的假象
// 返回 patch 原文供 replacehist 内嵌（P-20261004-66 落档改车道 1 双副本：
// artifacts 副本吃 30 天清账，内嵌副本让产品内还原不依赖文件系统留存）
func saveReplaceBackup(projectID, repoPath string) (replaceBackupInfo, string, error) {
	content, err := git.ExportDiffAsPatch(repoPath, false)
	if err != nil {
		return replaceBackupInfo{}, "", fmt.Errorf("backup patch unavailable: %w", err)
	}
	dir := replaceBackupsProjectDir(projectID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return replaceBackupInfo{}, "", fmt.Errorf("backup patch unavailable: %w", err)
	}
	var rnd [4]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return replaceBackupInfo{}, "", fmt.Errorf("backup patch unavailable: %w", err)
	}
	name := time.Now().Format("20060102-150405") + "-" + hex.EncodeToString(rnd[:]) + ".patch"
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		return replaceBackupInfo{}, "", fmt.Errorf("backup patch unavailable: %w", err)
	}
	return replaceBackupInfo{Name: name, Empty: strings.TrimSpace(content) == ""}, content, nil
}

// runReplaceBatch 执行批量替换：per-repo 写锁内完成「命中集 → 敏感闸 →
// 强制备份 → 逐文件写回」。blocked=true 表示敏感命中未确认（409 出口，
// 未写任何盘、未落备份）；其余错误为基础设施失败（同样未动工作区）
func runReplaceBatch(p *config.ProjectConfig, o replaceOptions, re *regexp.Regexp) (res replaceResult, blocked bool, err error) {
	l, _ := replaceWriteLocks.LoadOrStore(p.Path, &sync.Mutex{})
	l.(*sync.Mutex).Lock()
	defer l.(*sync.Mutex).Unlock()

	hits, err := collectReplaceHits(p.Path, re, o)
	if err != nil {
		return res, false, err
	}
	res.Truncated = hits.Truncated
	res.TotalHits = hits.TotalHits
	res.SensitiveHits = sensitiveHitPaths(hits.Files)
	// 敏感闸在任何副作用之前：先看清单（preview 也回 sensitiveHits），
	// 显式 confirmSensitive=true 才放行——宁多一次往返不静默改写密钥文件
	if len(res.SensitiveHits) > 0 && !o.ConfirmSensitive {
		return res, true, nil
	}
	if len(hits.Files) == 0 {
		res.Changed = []replaceChangedFile{}
		return res, false, nil
	}

	backup, patchContent, err := saveReplaceBackup(p.ID, p.Path)
	if err != nil {
		return res, false, err
	}
	res.Backup = &backup

	res.Changed = make([]replaceChangedFile, 0, len(hits.Files))
	for _, f := range hits.Files {
		n, skipReason, conflict := replaceOneFile(p, f.Path, re, o.Replacement, o.PreserveCase)
		switch {
		case conflict:
			res.Conflicts = append(res.Conflicts, f.Path)
		case skipReason != "":
			res.Skipped = append(res.Skipped, replaceSkippedFile{Path: f.Path, Reason: skipReason})
		default:
			res.Changed = append(res.Changed, replaceChangedFile{Path: f.Path, Hits: n})
		}
	}
	// 替换历史留档（P-20261004-66，车道 1）：有实际改写才留（空执行的
	// 「替换」不进历史面板）；尽力而为，落档失败只记日志不影响执行结果
	if len(res.Changed) > 0 {
		recordReplaceHist(p, o, res, patchContent)
	}
	return res, false, nil
}

// auditReplace 执行入账（file.replace）：只记元数据（项目/文件数/处数/备份
// 文件名），pattern/replacement 是内容语义（替换泄露密钥的场景里恰是敏感值）
// 绝不入账——审计只记元数据的全域纪律
func auditReplace(c *gin.Context, p *config.ProjectConfig, res replaceResult) {
	if store.Get() == nil || store.Get().Audit == nil {
		return // 测试环境未装配 Store 时静默跳过（sensitiveRead 同款守卫）
	}
	backupName := ""
	if res.Backup != nil {
		backupName = res.Backup.Name
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditFileReplace,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s: %d file(s) replaced, %d hit(s), backup %s", p.Name, len(res.Changed), res.TotalHits, backupName),
	})
}

// PreviewReplace POST /api/projects/:id/replace/preview
// 命中预览（文件×行 before→after）：纯读不写，agent 工作流「预览→确认→执行」
// 的第一步，也是敏感命中警示的观测点（sensitiveHits 回告 → 执行带
// confirmSensitive 二次确认）
func PreviewReplace(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	shared.LimitBody(c, replaceBodyMaxBytes)
	o, ok := bindReplaceOptions(c)
	if !ok {
		return
	}
	re, err := buildReplaceRegexp(o)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "invalid pattern: "+err.Error()+dualEndRegexHint, nil)
		return
	}
	resp, err := collectReplaceHits(p.Path, re, o)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "replace preview failed", err)
		return
	}
	resp.SensitiveHits = sensitiveHitPaths(resp.Files)
	c.JSON(http.StatusOK, gin.H{"data": resp})
}

// ReplaceInProject POST /api/projects/:id/replace
// 执行批量替换：AgentGuard 高危面（agentguard.go guardedRoutes「批量替换」，
// 项目级硬锁同挂）→ 敏感命中 409 待确认 → 强制备份 → 逐文件写回。
// 备份落档失败即整体拒绝（备份是执行的前置而非旁路，同回收站与删除的关系）
func ReplaceInProject(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	shared.LimitBody(c, replaceBodyMaxBytes)
	o, ok := bindReplaceOptions(c)
	if !ok {
		return
	}
	re, err := buildReplaceRegexp(o)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "invalid pattern: "+err.Error()+dualEndRegexHint, nil)
		return
	}
	res, blocked, err := runReplaceBatch(p, o, re)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "replace failed", err)
		return
	}
	if blocked {
		shared.JSONWithCode(c, shared.CodeFilesSensitiveConfirmRequired, gin.H{
			"error":         "sensitive files matched; review the list and re-run with confirmSensitive=true",
			"sensitiveHits": res.SensitiveHits,
		})
		return
	}
	auditReplace(c, p, res)
	c.JSON(http.StatusOK, gin.H{"data": res})
}

// ListReplaceBackups GET /api/projects/:id/replace/backups[?name=]
// 备份清单（新→旧）/ 指定备份内容（?name=）。回滚组合：取内容 → 丢弃替换后
// 改动（rollback / checkout）→ POST /patch/import 应用备份（ops 手册登记）
func ListReplaceBackups(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	dir := replaceBackupsProjectDir(p.ID)
	if name := c.Query("name"); name != "" {
		if !validBackupName(name) {
			shared.ErrorWithCode(c, shared.CodeFilesPathOutsideRoot, "invalid backup name", nil)
			return
		}
		content, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			shared.ErrorWithCode(c, shared.CodeFilesNotFound, "backup not found", nil)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": string(content)})
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"data": []replaceBackupEntry{}}) // 从未备份过：空清单
		return
	}
	type dated struct {
		mod   time.Time
		entry replaceBackupEntry
	}
	list := make([]dated, 0, len(entries))
	for _, de := range entries {
		if de.IsDir() || !validBackupName(de.Name()) {
			continue
		}
		fi, err := de.Info()
		if err != nil {
			continue
		}
		list = append(list, dated{mod: fi.ModTime(), entry: replaceBackupEntry{
			Name: de.Name(), Size: fi.Size(), CreatedAt: fi.ModTime().Format(time.RFC3339),
		}})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].mod.After(list[j].mod) })
	out := make([]replaceBackupEntry, 0, len(list))
	for _, d := range list {
		out = append(out, d.entry)
	}
	c.JSON(http.StatusOK, gin.H{"data": out})
}

// replaceBackupEntry 清单项（清单上限由保留策略治理，此处只做读侧防御性封顶：
// 裁剪前的存量目录最多数百条，直接全量返回不构成无界面）
type replaceBackupEntry struct {
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	CreatedAt string `json:"createdAt"`
}

// PurgeExpiredReplaceBackups 备份清账（启动 + 每日 ticker，与回收站清账同一
// sweep）：age 超 replaceBackupRetention 先清；单项目存量超
// replaceBackupMaxPerProject 再逐最旧直到回线。尽力而为：单文件失败记日志继续
func PurgeExpiredReplaceBackups() {
	projDirs, err := os.ReadDir(replaceBackupsRoot())
	if err != nil {
		return // 从未备份（目录未建）或不可读：无事可做
	}
	cutoff := time.Now().Add(-replaceBackupRetention)
	for _, pd := range projDirs {
		if !pd.IsDir() {
			continue
		}
		dir := filepath.Join(replaceBackupsRoot(), pd.Name())
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		type aged struct {
			name string
			ts   time.Time
		}
		var alive []aged
		for _, de := range entries {
			if de.IsDir() {
				continue
			}
			fi, err := de.Info()
			if err != nil {
				continue
			}
			if fi.ModTime().Before(cutoff) {
				if rmErr := os.Remove(filepath.Join(dir, de.Name())); rmErr != nil {
					slog.Warn("replace backup purge failed", "file", de.Name(), "err", rmErr)
				}
				continue
			}
			alive = append(alive, aged{name: de.Name(), ts: fi.ModTime()})
		}
		if len(alive) <= replaceBackupMaxPerProject {
			continue
		}
		sort.Slice(alive, func(i, j int) bool { return alive[i].ts.Before(alive[j].ts) })
		for _, a := range alive[:len(alive)-replaceBackupMaxPerProject] {
			if rmErr := os.Remove(filepath.Join(dir, a.name)); rmErr != nil {
				slog.Warn("replace backup purge failed", "file", a.name, "err", rmErr)
			}
		}
	}
}

// DeleteProjectReplaceBackups 项目删除级联清理（DeleteProjectTrash 同惯例：
// 项目 ID 不复用，备份永无回滚入口，孤儿目录随项目一锅端）
func DeleteProjectReplaceBackups(projectID string) {
	if projectID == "" {
		return
	}
	_ = os.RemoveAll(replaceBackupsProjectDir(projectID))
}

// bindReplaceOptions 请求体解析 + 必填校验（preview / execute 共用一份形状）
func bindReplaceOptions(c *gin.Context) (replaceOptions, bool) {
	var o replaceOptions
	if err := c.ShouldBindJSON(&o); err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "replace payload invalid", err)
		return o, false
	}
	if strings.TrimSpace(o.Pattern) == "" {
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "pattern is required", nil)
		return o, false
	}
	if len(o.Paths) > replacePathsMax {
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid,
			fmt.Sprintf("paths exceeds cap %d; narrow the selection or split into batches", replacePathsMax), nil)
		return o, false
	}
	return o, true
}
