package sync

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"codecombo/server/claudesessions"
	"codecombo/server/config"
	"codecombo/server/store"

	"github.com/google/uuid"
)

// stagingSeq staging 目录序号（并发落位目录名唯一性）
var stagingSeq atomic.Int64

// timeNowUnixMilli 备份目录名（定宽数字串，字典序即时间序）
func timeNowUnixMilli() int64 { return time.Now().UnixMilli() }

// timeNowUTC 策展写入时刻
func timeNowUTC() time.Time { return time.Now().UTC() }

// findProjectByBasename 按根目录基名找已注册项目（上下文单元单独落位寻址）
func findProjectByBasename(base string) *config.ProjectConfig {
	projects, err := store.Get().Project.List()
	if err != nil {
		return nil
	}
	for i := range projects {
		if rootBasename(projects[i].Path) == base {
			return &projects[i]
		}
	}
	return nil
}

// 传输打包与对端落位（方案②）。
//
// zip 包布局：每单元一个 `u<i>/` 前缀（TransferMeta.Units[i] 与之一一对应）：
//   - project：工作区文件树（含 .git 与否按请求档）逐文件条目
//   - sessions：transcripts/<uuid>.jsonl + curation.json
//   - crons/snippets/runtimes/approvals/chains/uistate：单 JSON 文档（笔记单元
//     notes/notes-multi 随 P-20261108-3 单库化退役，打包/落位两侧均拒）
//
// 落位安全（二审增强③）：项目先写临时目录再原子换名（新项目），已存在项目
// 逐文件落位且被覆盖文件先移入 `.sync-backup/<时间戳>/`（保留最近 3 份）——
// 「推错版本覆盖对端新工作」可回滚；传输中断只留 staging 目录，不留半个项目。

// syncBackupDir 覆盖备份目录名（落位项目根内）；syncStagingPrefix 临时目录
// 前缀（落位父目录内，中断残留由下次落位惰性清扫）
const (
	syncBackupDir   = ".sync-backup"
	syncStagingName = ".sc-sync-staging-"
	// syncBackupKeep 备份保留份数（二审增强③：保留最近 3 份可回滚）
	syncBackupKeep = 3
)

// unitPayload 一次打包的单元上下文（解析结果）
type unitPayload struct {
	entry   UnitEntry             // 本端单元（含绝对 Path）
	unit    TransferUnit          // 包内单元元数据
	project *config.ProjectConfig // project/sessions/crons 单元的本端项目
	// withGit 项目单元是否含 .git。同步链按请求全局档（packUnitsStream 入口
	// 统一赋值）；迁移全量包按项目勾选（migration_export 逐单元赋值）——
	// per-unit 档让一个包里能混装「纯工作区」与「含 .git」两种项目档
	withGit bool
}

// resolveUnitPayloads 把单元键解析为打包载荷清单（缺失/无效单元报错入列）
func resolveUnitPayloads(keys []string, includeIgnored bool) ([]unitPayload, []string) {
	var out []unitPayload
	var errs []string
	projects, _ := store.Get().Project.List()
	byBase := map[string]*config.ProjectConfig{}
	for i := range projects {
		b := rootBasename(projects[i].Path)
		if b != "" {
			byBase[b] = &projects[i]
		}
	}
	for _, key := range keys {
		kind, base := ParseUnitKey(key)
		if kind == UnitDeliver {
			errs = append(errs, key+": deliver unit is not transferable via manifest keys")
			continue
		}
		if kind == UnitCredentials {
			// 凭据档单元不走 zip 打包面（P-20261024-3 红线）：只经
			// IncludeCredentials 开关的 E2E 信封通道（credflow），构造性隔离
			errs = append(errs, key+": credentials unit moves only via the includeCredentials envelope channel")
			continue
		}
		if IsRetiredKind(kind) {
			// 笔记单元退役（P-20261108-3）：旧对端拉取/新端误点名均显式拒绝，
			// 回告文案同落位拒收——对端结果卡标红而非拿到空包静默成功
			errs = append(errs, key+": "+retiredNotesUnitError)
			continue
		}
		if base == "" {
			// 全局单元（无内容即拒绝——打包中途失败会拖垮整包）
			if len(globalUnitPayload(kind)) == 0 {
				errs = append(errs, key+": has no content")
				continue
			}
			out = append(out, unitPayload{entry: UnitEntry{Key: key, Kind: kind, Exists: true}, unit: TransferUnit{Key: key, Kind: kind}})
			continue
		}
		p := byBase[base]
		if p == nil {
			errs = append(errs, key+": local project not found")
			continue
		}
		// 上下文单元无内容即拒绝（打包中途失败会拖垮整包——解析期拒绝干净）
		switch kind {
		case UnitCrons:
			if !hasProjectCrons(p.Path) {
				errs = append(errs, key+": no project crons")
				continue
			}
		case UnitSessions:
			if !hasSessions(p.Path) {
				errs = append(errs, key+": no sessions")
				continue
			}
		}
		up := unitPayload{project: p, unit: TransferUnit{
			Key: key, Kind: kind, Name: p.Name, DirName: base,
		}}
		if kind == UnitProject {
			scan, err := enumerateUnitDir(p.Path, false, includeIgnored)
			if err != nil {
				errs = append(errs, key+": "+err.Error())
				continue
			}
			up.entry = UnitEntry{Key: key, Kind: kind, Path: p.Path, Exists: true,
				Fingerprint: fingerprintFiles(scan.files), Size: sumSizes(scan.files), Files: len(scan.files)}
			up.unit.Fingerprint = up.entry.Fingerprint
			up.unit.Size = up.entry.Size
		} else {
			up.entry = UnitEntry{Key: key, Kind: kind, Path: p.Path, Exists: true}
			up.unit.SrcPath = p.Path
			// 上下文单元指纹与 manifest 同源（回账 peerFP 需要——上下文单元的
			// 指纹在 manifest 构建面算出，这里按本项目清单对齐取值，避免
			// 「包带空指纹」让账本基线对账失真）
			local := buildLocalManifest(p.ID)
			for _, u := range local.Units {
				if u.Key == key {
					up.entry.Fingerprint = u.Fingerprint
					up.entry.Size = u.Size
					up.unit.Fingerprint = u.Fingerprint
					up.unit.Size = u.Size
					break
				}
			}
		}
		out = append(out, up)
	}
	return out, errs
}

// packUnitsStream 把单元流式打包为 zip 写入 w（零中转：调用方传 pipe writer
// 即流式响应/上传）。progress 非空时逐文件回报未压缩字节（进度口径 = manifest
// 枚举总量，非 wire 字节）。返回 meta 与错误（错误时 zip 已残缺——调用方整批失败）。
// includeGit 是全局档：按单元粒度混档（迁移全量包）由调用方直接走 packUnitsInto
func packUnitsStream(ctx context.Context, w io.Writer, payloads []unitPayload, includeGit, includeIgnored bool, progress func(unitIdx int, file string, n int64)) (*TransferMeta, error) {
	for i := range payloads {
		payloads[i].withGit = includeGit
	}
	zw := zip.NewWriter(w)
	meta, err := packUnitsInto(ctx, zw, payloads, includeIgnored, progress)
	if err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return meta, nil
}

// packUnitsInto 打包单元到调用方自持的 zip.Writer（不建不关——迁移全量包在
// 同一 zip 里还要塞 payload.json 明文头，见 migration_export）。withGit 已由
// 调用方按单元赋值；进度回报名义与 packUnitsStream 一致
func packUnitsInto(ctx context.Context, zw *zip.Writer, payloads []unitPayload, includeIgnored bool, progress func(unitIdx int, file string, n int64)) (*TransferMeta, error) {
	meta := &TransferMeta{IncludeIgnored: includeIgnored}
	for i := range payloads {
		up := &payloads[i]
		prefix := fmt.Sprintf("u%d/", i)
		var err error
		switch up.unit.Kind {
		case UnitProject:
			err = packProjectUnit(ctx, zw, prefix, up, includeIgnored, progress, i)
		case UnitSessions:
			err = packSessionsUnit(zw, prefix, up, progress, i)
		case UnitCrons:
			err = packCronsUnit(zw, prefix, up)
		default:
			err = packGlobalUnit(zw, prefix, up)
		}
		if err != nil {
			return nil, err
		}
		// 打包后再收 meta（Entries/指纹由打包协程就地补齐，先拷贝会丢更新）
		meta.Units = append(meta.Units, up.unit)
	}
	return meta, nil
}

// reportBytes 进度回报的节流包装（每文件回报名+累计字节，调用方决定节流粒度）
func reportBytes(progress func(int, string, int64), idx int, name string, n int64) {
	if progress != nil {
		progress(idx, name, n)
	}
}

// packProjectUnit 项目本体打包：枚举 → 逐文件写条目（os.Root 双层锚定 +
// 符号链接跳过，dir-archive 同防线）。含 .git 与否取 up.withGit（per-unit 档）
func packProjectUnit(ctx context.Context, zw *zip.Writer, prefix string, up *unitPayload, includeIgnored bool, progress func(int, string, int64), idx int) error {
	scan, err := enumerateUnitDir(up.project.Path, up.withGit, includeIgnored)
	if err != nil {
		return err
	}
	root := up.project.Path
	var sent int64
	for _, f := range scan.files {
		if err := ctx.Err(); err != nil {
			return err
		}
		abs := filepath.Join(root, filepath.FromSlash(f.rel))
		info, ierr := os.Lstat(abs)
		if ierr != nil {
			continue // 枚举后消失：跳过（对端少一文件，落位层数量对账如实回告）
		}
		if info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		hdr := &zip.FileHeader{Name: prefix + f.rel, Method: zip.Deflate}
		hdr.Modified = info.ModTime()
		hdr.SetMode(info.Mode())
		fw, werr := zw.CreateHeader(hdr)
		if werr != nil {
			return werr
		}
		src, oerr := os.Open(abs)
		if oerr != nil {
			continue // 打不开（权限/竞态删除）：跳过不阻断整包
		}
		n, cerr := io.Copy(fw, src)
		src.Close()
		if cerr != nil {
			return cerr
		}
		sent += n
		reportBytes(progress, idx, f.rel, sent)
	}
	up.unit.Entries = len(scan.files)
	metaEntries(&up.unit, len(scan.files))
	return nil
}

// metaEntries 记录包内条目数（packProjectUnit 直改 up.unit 的显式收口）
func metaEntries(u *TransferUnit, n int) { u.Entries = n }

// packSessionsUnit 会话单元打包：transcripts 逐文件 + curation.json
func packSessionsUnit(zw *zip.Writer, prefix string, up *unitPayload, progress func(int, string, int64), idx int) error {
	root := claudesessions.Root()
	if root == "" {
		return errf("claude projects dir unavailable")
	}
	dir := filepath.Join(root, claudesessions.EncodePath(strings.TrimRight(up.project.Path, `\/`)))
	entries, err := os.ReadDir(dir)
	if err == nil {
		var sent int64
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
				continue
			}
			abs := filepath.Join(dir, e.Name())
			info, ierr := e.Info()
			if ierr != nil {
				continue
			}
			hdr := &zip.FileHeader{Name: prefix + "transcripts/" + e.Name(), Method: zip.Deflate}
			hdr.Modified = info.ModTime()
			fw, werr := zw.CreateHeader(hdr)
			if werr != nil {
				return werr
			}
			src, oerr := os.Open(abs)
			if oerr != nil {
				continue
			}
			n, cerr := io.Copy(fw, src)
			src.Close()
			if cerr != nil {
				return cerr
			}
			sent += n
			reportBytes(progress, idx, "transcripts/"+e.Name(), sent)
		}
		up.unit.Entries += countJSONL(entries)
	}
	// 策展（manifest 同源函数复用：键前缀圈定 + 目录内会话过滤）
	cur := curationPayloadJSON(root, dir, entries)
	if len(cur) > 0 {
		fw, werr := zw.CreateHeader(&zip.FileHeader{Name: prefix + "curation.json", Method: zip.Deflate})
		if werr != nil {
			return werr
		}
		if _, err := fw.Write(cur); err != nil {
			return err
		}
		up.unit.Entries++
	}
	return nil
}

func countJSONL(entries []os.DirEntry) int {
	n := 0
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".jsonl") {
			n++
		}
	}
	return n
}

// packCronsUnit 项目域定时任务打包（Dir 保留源形态，落位侧按 SrcPath→dest 重映射）
func packCronsUnit(zw *zip.Writer, prefix string, up *unitPayload) error {
	crons, err := store.Get().AgentCron.List()
	if err != nil {
		return err
	}
	root := strings.TrimRight(up.project.Path, `\/`)
	var mine []store.AgentCron
	for _, c := range crons {
		if c.Dir != "" && dirWithin(c.Dir, root) {
			mine = append(mine, c)
		}
	}
	if len(mine) == 0 {
		return errf("no project crons")
	}
	sort.Slice(mine, func(i, j int) bool { return mine[i].ID < mine[j].ID })
	b, _ := json.Marshal(mine)
	fw, werr := zw.CreateHeader(&zip.FileHeader{Name: prefix + "crons.json", Method: zip.Deflate})
	if werr != nil {
		return werr
	}
	_, werr = fw.Write(b)
	up.unit.Entries = 1
	return werr
}

// packGlobalUnit 全局单元打包（键即 kind 的 JSON 文档）
func packGlobalUnit(zw *zip.Writer, prefix string, up *unitPayload) error {
	var b []byte
	switch up.unit.Kind {
	case UnitSnippets:
		b = globalSnippetsJSON()
	case UnitRuntimes:
		b = runtimesJSON()
	case UnitApprovals:
		b = approvalsJSON()
	case UnitChains:
		b = chainsJSON()
	case UnitUIState:
		b = uiStateJSON()
	default:
		return errf("unknown global unit kind %s", up.unit.Kind)
	}
	if len(b) == 0 {
		return errf("unit %s has no content", up.unit.Key)
	}
	fw, werr := zw.CreateHeader(&zip.FileHeader{Name: prefix + up.unit.Kind + ".json", Method: zip.Deflate})
	if werr != nil {
		return werr
	}
	_, werr = fw.Write(b)
	up.unit.Entries = 1
	return werr
}

// ── 落位（对端 /api/sync/units?mode=land）──

// LandUnitResult 单单元落位结果
type LandUnitResult struct {
	Key         string `json:"key"`
	OK          bool   `json:"ok"`
	Error       string `json:"error,omitempty"`
	ProjectID   string `json:"projectId,omitempty"`
	ProjectPath string `json:"projectPath,omitempty"`
	// Added / Overwritten / Skipped 文件级计数（对账 manifest Entries）
	Added       int `json:"added,omitempty"`
	Overwritten int `json:"overwritten,omitempty"`
	Skipped     int `json:"skipped,omitempty"`
	// BackupDir 覆盖备份目录（发生覆盖时；保留最近 3 份）
	BackupDir string `json:"backupDir,omitempty"`
	// Registered 本次是否新注册了项目（对比复用既有注册）
	Registered bool `json:"registered,omitempty"`
	// Busy 单元锁被占（并发同单元同步），本次跳过
	Busy bool `json:"busy,omitempty"`
}

// LandResult 落位回执（对端返回给推送方/拉取方记账）
type LandResult struct {
	Units    []LandUnitResult `json:"units"`
	DestRoot string           `json:"destRoot"`
	// CleanedStaging 惰性清扫的陈旧 staging 目录数（上次中断残留）
	CleanedStaging int `json:"cleanedStaging,omitempty"`
}

// landUnits 落位 zip 流到本端（对端 handler 主体）。destRoot 空用本端配置。
// progress 可空（逐单元逐文件回报已解包未压缩字节——拉取方向的进度口径）。
// 返回逐单元结果；zip 读取失败整批报错（单元结果照常带回已成功部分）
func landUnits(ctx context.Context, r io.Reader, meta *TransferMeta, destRoot string, progress func(unitIdx int, file string, n int64)) (*LandResult, error) {
	if meta == nil || len(meta.Units) == 0 {
		return nil, errf("transfer meta missing or empty")
	}
	if destRoot == "" {
		destRoot = syncDestRoot()
	}
	if err := os.MkdirAll(destRoot, 0o755); err != nil {
		return nil, errf("dest root create failed: %w", err)
	}
	cleaned := cleanStaleStaging(destRoot)

	// zip 中央目录随机访问是格式要求（archive/zip 的 Reader 只吃 ReaderAt），
	// io.Pipe 零中转只在发送侧成立；接收侧以临时 spool 文件中转（系统临时
	// 目录，落位结束即删——数据不进项目目录也不长期占盘）
	spool, err := os.CreateTemp("", "sc-sync-zip-*.zip")
	if err != nil {
		return nil, errf("spool create failed: %w", err)
	}
	defer os.Remove(spool.Name())
	defer spool.Close()
	if _, err := io.Copy(spool, r); err != nil {
		return nil, errf("transfer interrupted: %w", err)
	}
	if _, err := spool.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	fi, _ := spool.Stat()
	zr, err := zip.NewReader(spool, fi.Size())
	if err != nil {
		return nil, errf("zip open failed: %w", err)
	}
	res, err := landZipReader(ctx, zr, meta, destRoot, progress)
	if res != nil {
		res.CleanedStaging = cleaned
	}
	return res, err
}

// landZipReader 已打开的 zip 落位循环（landUnits 的主体；迁移全量包导入
// P-20261003-147 已持解密后的 zip.Reader，直接复用免二次 spool）。单元按包内
// 顺序落位（project 先于其上下文单元——打包侧保证依赖序）
func landZipReader(ctx context.Context, zr *zip.Reader, meta *TransferMeta, destRoot string, progress func(unitIdx int, file string, n int64)) (*LandResult, error) {
	if meta == nil || len(meta.Units) == 0 {
		return nil, errf("transfer meta missing or empty")
	}
	res := &LandResult{DestRoot: destRoot}
	// 单元按序落位（包内顺序即依赖序：project 先于其上下文单元——meta.Units
	// 打包时按请求序，execute 层保证 project 在前）
	finalPaths := map[string]string{} // projectKey → 落位绝对路径（上下文单元寻址）
	projectIDs := map[string]string{} // projectKey → 本端项目 id
	for i := range meta.Units {
		tu := &meta.Units[i]
		prefix := fmt.Sprintf("u%d/", i)
		lr := landOneUnit(ctx, zr, prefix, tu, destRoot, finalPaths, projectIDs, progress, i)
		res.Units = append(res.Units, *lr)
	}
	return res, nil
}

// landDeliver 非项目投递纯落位（方案④）：对端 destRoot/<Dest> 白名单内落位，
// 不注册项目。目标 = destRoot + Dest（相对路径，拒穿越）；落位目标已存在时
// 走备份覆盖语义（.sync-backup 同链）
func landDeliver(ctx context.Context, r io.Reader, tu *TransferUnit, destRoot string) (*LandResult, error) {
	destRoot = defaultIfEmpty(destRoot, syncDestRoot())
	// 双保险穿越拦截（Dest 已在打包侧清洗；落位侧对 Clean 后形态再校验）
	dest := filepath.Join(destRoot, filepath.FromSlash(normalizeSlashes(tu.Dest)))
	if !strings.HasPrefix(filepath.Clean(dest), filepath.Clean(destRoot)+string(filepath.Separator)) {
		return nil, errf("dest escapes sync dest root")
	}
	spool, err := os.CreateTemp("", "sc-sync-zip-*.zip")
	if err != nil {
		return nil, errf("spool create failed: %w", err)
	}
	defer os.Remove(spool.Name())
	defer spool.Close()
	if _, err := io.Copy(spool, r); err != nil {
		return nil, errf("transfer interrupted: %w", err)
	}
	if _, err := spool.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	fi, _ := spool.Stat()
	zr, err := zip.NewReader(spool, fi.Size())
	if err != nil {
		return nil, errf("zip open failed: %w", err)
	}
	lr := &LandResult{DestRoot: destRoot}
	lr.Units = append(lr.Units, *landOneUnit(ctx, zr, "u0/", tu, destRoot, nil, nil, nil, 0))
	return lr, nil
}

func defaultIfEmpty(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

// landOneUnit 单单元落位（分发到 project/上下文/全局/投递各形态）
func landOneUnit(ctx context.Context, zr *zip.Reader, prefix string, tu *TransferUnit, destRoot string, finalPaths, projectIDs map[string]string, progress func(int, string, int64), unitIdx int) *LandUnitResult {
	lr := &LandUnitResult{Key: tu.Key}
	if IsRetiredKind(tu.Kind) {
		// mixed-version 回流防线（P-20261108-3）：旧对端包携带的笔记单元若照旧
		// 落位会直写项目作用域键——本端 UI 恒全局库看不见 = 静默半态。显式拒收
		// 并回告，推送方结果卡标红（单元键同时以 kind 判定，防改名绕过）
		lr.Error = retiredNotesUnitError
		return lr
	}
	files := prefixFiles(zr, prefix)
	if len(files) == 0 {
		lr.Error = "no entries in package for unit"
		return lr
	}
	release, ok := tryUnitLock(tu.Key)
	if !ok {
		lr.Busy = true
		return lr
	}
	defer release()

	// 解包字节计数（未压缩口径，与打包侧一致）：extractFile 的统一收口
	report := func(file string, n int64) {
		if progress != nil {
			progress(unitIdx, file, n)
		}
	}
	switch tu.Kind {
	case UnitProject:
		landProjectUnit(ctx, zr, prefix, files, tu, destRoot, lr, finalPaths, projectIDs, report)
	case UnitSessions, UnitCrons:
		landContextUnit(ctx, zr, prefix, files, tu, lr, finalPaths, projectIDs, report)
	case UnitDeliver:
		landDeliverUnit(ctx, files, prefix, tu, destRoot, lr, report)
	default:
		landGlobalUnit(zr, prefix, files, tu, lr)
	}
	return lr
}

// landDeliverUnit 投递落位：包内条目（u0/ 前缀 + 子树相对路径）→ destRoot/<Dest>。
// 目录形态条目进 Dest 目录内；单文件形态（包内唯一条目）落为 Dest 文件本体
// （Dest 是目标完整路径——打包侧 DirName=源文件名，Dest 已含目标文件名）
func landDeliverUnit(ctx context.Context, files []*zip.File, prefix string, tu *TransferUnit, destRoot string, lr *LandUnitResult, report func(string, int64)) {
	if tu.Dest == "" {
		lr.Error = "deliver dest missing"
		return
	}
	dest := filepath.Join(destRoot, filepath.FromSlash(normalizeSlashes(tu.Dest)))
	if !strings.HasPrefix(filepath.Clean(dest), filepath.Clean(destRoot)+string(filepath.Separator)) {
		lr.Error = "dest escapes sync dest root"
		return
	}
	// 单文件形态：包内恰一条目且名字即文件名 → 直接落为 Dest
	if len(files) == 1 {
		rel := sanitizeZipName(strings.TrimPrefix(files[0].Name, prefix))
		if rel != "" && !strings.Contains(rel, "/") {
			if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
				lr.Error = "dest parent create failed: " + err.Error()
				return
			}
			if _, err := os.Lstat(dest); err == nil {
				backupOne(dest, lr)
			}
			if err := extractFile(files[0], dest); err != nil {
				lr.Error = "land " + tu.Dest + ": " + err.Error()
				return
			}
			lr.Added++
			return
		}
	}
	// 目录形态：条目进 Dest/ 内（Dest 即目录本体）
	if err := os.MkdirAll(dest, 0o755); err != nil {
		lr.Error = "dest dir create failed: " + err.Error()
		return
	}
	var extracted int64
	for _, f := range files {
		rel := sanitizeZipName(strings.TrimPrefix(f.Name, prefix))
		if rel == "" {
			lr.Skipped++
			continue
		}
		if err := ctx.Err(); err != nil {
			lr.Error = "land interrupted"
			return
		}
		target := filepath.Join(dest, filepath.FromSlash(rel))
		if _, err := os.Lstat(target); err == nil {
			backupOne(target, lr)
		}
		if err := extractFile(f, target); err != nil {
			lr.Error = "land " + rel + ": " + err.Error()
			return
		}
		lr.Added++
		extracted += int64(f.UncompressedSize64)
		report(rel, extracted)
	}
	if lr.Overwritten > 0 {
		pruneBackups(filepath.Join(filepath.Dir(dest), syncBackupDir), syncBackupKeep)
	}
}

// backupOne 单文件覆盖前备份（与项目合并落位同语义：移入 .sync-backup/<ts>/
// ，保同级目录形态——备份锚点取目标父目录）
func backupOne(target string, lr *LandUnitResult) {
	tsRoot := filepath.Join(filepath.Dir(target), syncBackupDir, fmt.Sprintf("%d", timeNowUnixMilli()))
	bak := filepath.Join(tsRoot, filepath.Base(target))
	if err := os.MkdirAll(filepath.Dir(bak), 0o755); err == nil {
		if err := os.Rename(target, bak); err == nil {
			lr.Overwritten++
			lr.BackupDir = tsRoot
		}
	}
}

// landProjectUnit 项目本体落位：新项目 staging→原子换名；已存在逐文件覆盖
// （先备份）+ 自动注册
func landProjectUnit(ctx context.Context, zr *zip.Reader, prefix string, files []*zip.File, tu *TransferUnit, destRoot string, lr *LandUnitResult, finalPaths, projectIDs map[string]string, report func(string, int64)) {
	dest := filepath.Join(destRoot, filepath.FromSlash(tu.DirName))
	lr.ProjectPath = dest
	if _, err := os.Stat(dest); os.IsNotExist(err) {
		// 新项目：staging 整树解包 → 原子换名（中断只留 staging 不留半个项目）
		staging := filepath.Join(destRoot, syncStagingName+fmt.Sprintf("%d-%s", stagingSeq.Add(1), tu.DirName))
		if err := extractTree(zr, files, prefix, staging, lr, report); err != nil {
			lr.Error = "stage extract failed: " + err.Error()
			_ = os.RemoveAll(staging)
			return
		}
		if err := os.Rename(staging, dest); err != nil {
			// 换名失败（跨卷等）：回退为逐文件落位（不因换名限制拒绝服务）
			_ = os.RemoveAll(staging)
			landMergeExisting(ctx, files, prefix, dest, lr, report)
		}
	} else {
		landMergeExisting(ctx, files, prefix, dest, lr, report)
	}
	if lr.Error != "" {
		return
	}
	// 自动注册项目（体验一致验收的最后一环）：已注册同路径则复用
	id, registered, err := registerProject(dest, tu.Name)
	if err != nil {
		lr.Error = "register failed: " + err.Error()
		return
	}
	lr.ProjectID = id
	lr.Registered = registered
	lr.OK = true
	key := UnitKey(UnitProject, tu.DirName)
	finalPaths[key] = dest
	projectIDs[key] = id
}

// landMergeExisting 已存在目录的合并落位：被覆盖文件先移入 .sync-backup/<ts>/
// （保留最近 3 份），包内条目逐文件写入（原子性由逐文件 O_TRUNC 写入 +
// 覆盖备份兜底；中断后重传即自愈）
func landMergeExisting(ctx context.Context, files []*zip.File, prefix, dest string, lr *LandUnitResult, report func(string, int64)) {
	backupRoot := filepath.Join(dest, syncBackupDir, fmt.Sprintf("%d", timeNowUnixMilli()))
	var added, overwritten int
	var extracted int64
	for _, f := range files {
		rel := sanitizeZipName(strings.TrimPrefix(f.Name, prefix))
		if rel == "" {
			lr.Skipped++
			continue
		}
		if err := ctx.Err(); err != nil {
			lr.Error = "land interrupted"
			return
		}
		target := filepath.Join(dest, filepath.FromSlash(rel))
		if _, err := os.Lstat(target); err == nil {
			// 覆盖前备份：目标移入 backupRoot（保目录形态；备份失败不阻断
			// 落位——同步推进优先，回滚面降级为「无备份」并如实计数）
			bak := filepath.Join(backupRoot, filepath.FromSlash(rel))
			if err := os.MkdirAll(filepath.Dir(bak), 0o755); err == nil {
				if err := os.Rename(target, bak); err == nil {
					overwritten++
				}
			}
		}
		if err := extractFile(f, target); err != nil {
			lr.Error = "land " + rel + ": " + err.Error()
			lr.Added = added
			lr.Overwritten = overwritten
			return
		}
		added++
		extracted += int64(f.UncompressedSize64)
		report(rel, extracted)
	}
	lr.Added = added
	lr.Overwritten = overwritten
	if overwritten > 0 {
		lr.BackupDir = backupRoot
		pruneBackups(filepath.Join(dest, syncBackupDir), syncBackupKeep)
	}
}

// extractTree 整树解包到 root（prefix 过滤 + 名字消毒；目录条目按文件条目
// 隐式创建）
func extractTree(zr *zip.Reader, files []*zip.File, prefix, root string, lr *LandUnitResult, report func(string, int64)) error {
	var extracted int64
	for _, f := range files {
		rel := sanitizeZipName(strings.TrimPrefix(f.Name, prefix))
		if rel == "" {
			lr.Skipped++
			continue
		}
		if err := extractFile(f, filepath.Join(root, filepath.FromSlash(rel))); err != nil {
			return err
		}
		lr.Added++
		extracted += int64(f.UncompressedSize64)
		report(rel, extracted)
	}
	return nil
}

// extractFile 单文件解包（MkdirAll 父链 + 常规文件语义；非常规形态跳过计数）
func extractFile(f *zip.File, target string) error {
	if f.FileInfo().IsDir() {
		return os.MkdirAll(target, 0o755)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, rc)
	return err
}

// landContextUnit 上下文单元落位：寻址所属项目（finalPaths/projectIDs 已由
// 同包 project 单元填好；对端已有项目但未随包推送时按 DirName 找已注册项目）
func landContextUnit(ctx context.Context, zr *zip.Reader, prefix string, files []*zip.File, tu *TransferUnit, lr *LandUnitResult, finalPaths, projectIDs map[string]string, report func(string, int64)) {
	_ = report // 上下文单元是小 JSON/少量转录，进度粒度足够（状态机推进已广播）
	_, base := ParseUnitKey(tu.Key)
	pk := UnitKey(UnitProject, base)
	dest, okDest := finalPaths[pk]
	projID, okID := projectIDs[pk]
	if !okDest || !okID {
		// 项目未随包：找本端已注册同基名项目（上下文单独同步的常态）
		if p := findProjectByBasename(base); p != nil {
			dest, projID, okDest, okID = p.Path, p.ID, true, true
		}
	}
	if !okDest || !okID {
		lr.Error = "project " + pk + " not present on this instance; push/pull the project unit first"
		return
	}
	var err error
	switch tu.Kind {
	case UnitSessions:
		err = landSessions(zr, prefix, files, dest, projID)
	case UnitCrons:
		err = landCrons(zr, prefix, tu, dest, projID)
	}
	if err != nil {
		lr.Error = err.Error()
		return
	}
	lr.ProjectID = projID
	lr.OK = true
}

// landSessions 会话落位：transcripts → 对端 claude projects 编码目录（按对端
// 项目绝对路径重编码——「在对端按同规则落位」），curation 按对端 root 重算键
func landSessions(zr *zip.Reader, prefix string, files []*zip.File, projectPath, projectID string) error {
	root := claudesessions.Root()
	if root == "" {
		return errf("claude projects dir unavailable")
	}
	dir := filepath.Join(root, claudesessions.EncodePath(strings.TrimRight(projectPath, `\/`)))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return errf("transcripts dir create failed: %w", err)
	}
	var curPayload []struct {
		ID        string                `json:"id"`
		Starred   bool                  `json:"starred"`
		Note      string                `json:"note"`
		Hidden    bool                  `json:"hidden"`
		Bookmarks []string              `json:"bookmarks"`
		Tags      []store.ClaudeTurnTag `json:"tags"`
	}
	for _, f := range files {
		rel := sanitizeZipName(strings.TrimPrefix(f.Name, prefix))
		if rel == "" {
			continue
		}
		if strings.HasPrefix(rel, "transcripts/") && strings.HasSuffix(rel, ".jsonl") {
			if err := extractFile(f, filepath.Join(dir, filepath.FromSlash(strings.TrimPrefix(rel, "transcripts/")))); err != nil {
				return errf("transcript %s: %w", rel, err)
			}
			continue
		}
		if rel == "curation.json" {
			rc, err := f.Open()
			if err != nil {
				return err
			}
			b, err := io.ReadAll(rc)
			rc.Close()
			if err != nil {
				return err
			}
			if err := json.Unmarshal(b, &curPayload); err != nil {
				return errf("curation.json not parseable")
			}
		}
	}
	for _, c := range curPayload {
		// 对端键规则重算（ClaudeCurKey(root, sessionID)）——策展跟人走不跟机器
		_ = store.Get().ClaudeCur.Put(store.ClaudeSessionCur{
			Key:       store.ClaudeCurKey(root, c.ID),
			ID:        c.ID,
			Starred:   c.Starred,
			Note:      c.Note,
			Hidden:    c.Hidden,
			Bookmarks: c.Bookmarks,
			Tags:      c.Tags,
			UpdatedAt: timeNowUTC(),
		})
	}
	// claudeindex 是车道 3 可重建镜像：落位后对端列表链自然对账（mtime 变化
	// 重扫），无需在此手动重建
	_ = projectID
	return nil
}

// landCrons 项目域定时任务落位：Dir 源路径→本端落位路径重映射，按（Name+
// 重映射 Dir）幂等去重
func landCrons(zr *zip.Reader, prefix string, tu *TransferUnit, destPath, projectID string) error {
	_ = projectID
	members := files1(zr, prefix, "crons.json")
	if len(members) == 0 {
		return errf("crons.json missing in package")
	}
	rc, err := members[0].Open()
	if err != nil {
		return err
	}
	b, err := io.ReadAll(rc)
	rc.Close()
	if err != nil {
		return err
	}
	var crons []store.AgentCron
	if json.Unmarshal(b, &crons) != nil {
		return errf("crons.json not parseable")
	}
	srcRoot := strings.TrimRight(tu.SrcPath, `\/`)
	existing, _ := store.Get().AgentCron.List()
	for _, c := range crons {
		newDir := c.Dir
		if srcRoot != "" && dirWithin(c.Dir, srcRoot) {
			rel, rerr := filepath.Rel(srcRoot, filepath.Clean(c.Dir))
			if rerr == nil {
				newDir = filepath.Join(destPath, rel)
			}
		}
		dup := false
		for _, e := range existing {
			if e.Name == c.Name && filepath.Clean(e.Dir) == filepath.Clean(newDir) {
				dup = true
				break
			}
		}
		if dup {
			continue
		}
		if _, err := store.Get().AgentCron.Create(store.AgentCron{
			Name: c.Name, Hour: c.Hour, Minute: c.Minute, Weekdays: c.Weekdays,
			Timezone: c.Timezone, Runtime: c.Runtime, Prompt: c.Prompt, Dir: newDir,
			Enabled: c.Enabled, MissCatchUp: c.MissCatchUp, Extract: c.Extract,
		}); err != nil {
			return errf("cron %s create failed: %w", c.Name, err)
		}
	}
	return nil
}

// landGlobalUnit 全局单元落位（合并语义见各分支；对端自有配置优先——
// 同名/同键不覆盖）
func landGlobalUnit(zr *zip.Reader, prefix string, files []*zip.File, tu *TransferUnit, lr *LandUnitResult) {
	kind := tu.Kind
	var f *zip.File
	for _, cand := range files {
		if sanitizeZipName(strings.TrimPrefix(cand.Name, prefix)) == kind+".json" {
			f = cand
			break
		}
	}
	if f == nil {
		lr.Error = kind + ".json missing in package"
		return
	}
	rc, err := f.Open()
	if err != nil {
		lr.Error = err.Error()
		return
	}
	b, err := io.ReadAll(rc)
	rc.Close()
	if err != nil {
		lr.Error = err.Error()
		return
	}
	switch kind {
	case UnitSnippets:
		err = mergeSnippets(b)
	case UnitRuntimes:
		err = mergeRuntimes(b)
	case UnitApprovals:
		err = mergeApprovals(b)
	case UnitChains:
		err = mergeChains(b)
	case UnitUIState:
		err = mergeUIState(b)
	default:
		err = errf("unknown global unit kind %s", kind)
	}
	if err != nil {
		lr.Error = err.Error()
		return
	}
	lr.OK = true
}

// mergeSnippets 片段合并：按（Title+Command）去重，host 域不入载荷（打包侧）
func mergeSnippets(b []byte) error {
	var items []store.Snippet
	if json.Unmarshal(b, &items) != nil {
		return errf("snippets.json not parseable")
	}
	existing, _ := store.Get().Snippet.List()
	seen := map[string]bool{}
	for _, e := range existing {
		seen[e.Title+"\x00"+e.Command] = true
	}
	for _, s := range items {
		if seen[s.Title+"\x00"+s.Command] {
			continue
		}
		if _, err := store.Get().Snippet.Create(store.Snippet{
			Title: s.Title, Command: s.Command, Description: s.Description,
			Tags: s.Tags, Kind: s.Kind, Scope: "global",
		}); err != nil {
			return errf("snippet %s create failed: %w", s.Title, err)
		}
	}
	return nil
}

// mergeRuntimes 运行时注册合并：按 Name 去重（对端同名注册保留其启动命令
// ——运行时命令是机器相关配置，对端各自配置优先）
func mergeRuntimes(b []byte) error {
	var items []config.CustomAgent
	if json.Unmarshal(b, &items) != nil {
		return errf("runtimes.json not parseable")
	}
	cfg := store.Get().Settings.Get()
	changed := false
	for _, a := range items {
		if cfg.Server.FindCustomAgent(a.Name) != nil {
			continue
		}
		cfg.Server.SaveCustomAgent(a)
		changed = true
	}
	if changed {
		return store.Get().Settings.Save()
	}
	return nil
}

// mergeApprovals 审批规则合并：按（op+path+effect）三元组精确去重后追加
// （规则表是有序前缀匹配列表——追加保持对端既有规则优先序，不重排）
func mergeApprovals(b []byte) error {
	var items []config.AgentApprovalRule
	if json.Unmarshal(b, &items) != nil {
		return errf("approval-rules.json not parseable")
	}
	cfg := store.Get().Settings.Get()
	existing := map[string]bool{}
	for _, r := range cfg.Server.AgentApprovalRules {
		existing[r.OpPattern+"\x00"+r.PathPattern+"\x00"+r.Effect] = true
	}
	changed := false
	for _, r := range items {
		k := r.OpPattern + "\x00" + r.PathPattern + "\x00" + r.Effect
		if existing[k] {
			continue
		}
		existing[k] = true
		cfg.Server.AgentApprovalRules = append(cfg.Server.AgentApprovalRules, r)
		changed = true
	}
	if changed {
		return store.Get().Settings.Save()
	}
	return nil
}

// mergeChains 接续链定义合并：按（模板+运行时+目录+失败档）去重新建
// （源会话 ID 不迁移——源会话是本机会话，对端源不存在即链失效态，定义保留）
func mergeChains(b []byte) error {
	var defs []store.AgentChain
	if json.Unmarshal(b, &defs) != nil {
		return errf("chains.json not parseable")
	}
	existing, _ := store.Get().AgentChain.List()
	seen := map[string]bool{}
	for _, e := range existing {
		seen[e.PromptTemplate+"\x00"+e.Runtime+"\x00"+e.Dir+"\x00"+boolKey(e.OnFailure)] = true
	}
	for _, d := range defs {
		if seen[d.PromptTemplate+"\x00"+d.Runtime+"\x00"+d.Dir+"\x00"+boolKey(d.OnFailure)] {
			continue
		}
		if _, err := store.Get().AgentChain.Create(store.AgentChain{
			PromptTemplate: d.PromptTemplate, Runtime: d.Runtime, Dir: d.Dir, OnFailure: d.OnFailure,
		}); err != nil {
			return errf("chain create failed: %w", err)
		}
	}
	return nil
}

// mergeUIState uiState 合并（浅合并语义与既有 PUT handler 一致——写入方未
// 携带的键原样保留）
func mergeUIState(b []byte) error {
	var data map[string]interface{}
	if json.Unmarshal(b, &data) != nil {
		return errf("uistate.json not parseable")
	}
	return store.Get().UIState.Merge(data)
}

func boolKey(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// registerProject 落位后自动注册项目（对端 AddProject 同语义：存在性校验/
// 归一去重/建 ProjectConfig）。已注册同路径复用既有 id
func registerProject(path, name string) (id string, registered bool, err error) {
	info, serr := os.Stat(path)
	if serr != nil || !info.IsDir() {
		return "", false, errf("landed path not a directory")
	}
	projects, lerr := store.Get().Project.List()
	if lerr != nil {
		return "", false, lerr
	}
	norm := filepath.Clean(path)
	for i := range projects {
		if filepath.Clean(projects[i].Path) == norm {
			return projects[i].ID, false, nil
		}
	}
	newP := config.ProjectConfig{ID: uuid.New().String(), Name: name, Path: path}
	if err := store.Get().Project.Create(newP); err != nil {
		return "", false, err
	}
	return newP.ID, true, nil
}

// hasProjectCrons / hasSessions 内容存在性快检（解析期拒绝无内容上下文单元）
func hasProjectCrons(root string) bool {
	crons, err := store.Get().AgentCron.List()
	if err != nil {
		return false
	}
	for _, c := range crons {
		if c.Dir != "" && dirWithin(c.Dir, strings.TrimRight(root, `\/`)) {
			return true
		}
	}
	return false
}

func hasSessions(projectPath string) bool {
	root := claudesessions.Root()
	if root == "" {
		return false
	}
	dir := filepath.Join(root, claudesessions.EncodePath(strings.TrimRight(projectPath, `\/`)))
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".jsonl") {
			return true
		}
	}
	return false
}

// prefixFiles 取包内某前缀的全部条目
func prefixFiles(zr *zip.Reader, prefix string) []*zip.File {
	var out []*zip.File
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, prefix) {
			out = append(out, f)
		}
	}
	return out
}

// files1 取包内前缀下唯一指定文件（无则 nil）
func files1(zr *zip.Reader, prefix, name string) []*zip.File {
	var out []*zip.File
	for _, f := range prefixFiles(zr, prefix) {
		if sanitizeZipName(strings.TrimPrefix(f.Name, prefix)) == name {
			out = append(out, f)
		}
	}
	return out
}

// cleanStaleStaging 惰性清扫上次中断残留的 staging 目录（落地成功路径顺带执行，
// 失败静默——下次再试）
func cleanStaleStaging(destRoot string) int {
	entries, err := os.ReadDir(destRoot)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), syncStagingName) {
			if os.RemoveAll(filepath.Join(destRoot, e.Name())) == nil {
				n++
			}
		}
	}
	return n
}

// pruneBackups 备份保留窗口：仅保留最近 keep 份时间戳目录（目录名字典序即
// 时间序——unixmilli 定宽）
func pruneBackups(backupRoot string, keep int) {
	entries, err := os.ReadDir(backupRoot)
	if err != nil {
		return
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	if len(names) <= keep {
		return
	}
	sort.Strings(names)
	for _, n := range names[:len(names)-keep] {
		_ = os.RemoveAll(filepath.Join(backupRoot, n))
	}
}
