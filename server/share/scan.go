// 分享创建前的敏感文件扫描：文件名级确定性匹配（零误报根——只认约定
// 俗成的密钥/凭据文件名，不做内容级猜测）。命中清单随创建 API 响应返回，
// 由前端弹确认框、用户显式确认后才真正创建（内容级正则扫描列为后续加强）。
//
// 扫描在服务端做（路径信任链与 StatTarget 同源：项目根 os.Root 锚定 +
// 逐段符号链接拒绝），分享根内的符号链接与访客面同策略跳过——列表里
// 看不到的东西扫描器同样不猜。

package share

import (
	"io/fs"
	"os"
	"path"
	"strings"
)

// maxScanEntries 目录分享递归扫描的条目上限：超大目录（node_modules/
// 构建产物）不应在创建分享的同步路径上无限走盘；触顶即收尾并在结果
// 标注 Truncated（确有未扫条目时才置位——恰好等于上限不误报）
const maxScanEntries = 2000

// sensitivePatterns 确定性文件名模式表（小写基准；匹配时对文件名统一
// 转小写，Windows 大小写不敏感文件系统与跨平台语义天然一致）。
// 包级变量留作扩展点：后续可改为配置注入（任务书「模式表可配置化」）
var sensitivePatterns = []string{
	".env*", // .env / .env.local / .env.production 等环境密钥
	"id_rsa*",
	"*.pem",
	"*.key",
	".npmrc", // 可含 _authToken
	".netrc",
	".git-credentials",
	"*.kdbx", // KeePass 口令库
	"serviceaccount*.json",
	"credentials.json",
}

// ScanResult 敏感文件扫描结果
type ScanResult struct {
	// Warnings 命中的敏感文件（分享根内相对路径，/ 分隔；WalkDir 字典序，确定）
	Warnings []string
	// Truncated 条目数达上限提前收尾：确有未扫描的条目（可能漏检）
	Truncated bool
}

// ScanSensitive 扫描 rootDir 内 rel 目标（文件或目录）中的敏感文件。
// rootDir 必须是已校验的项目根（与 StatTarget 同一信任链）；rel 为分享
// 目标的相对路径（"" = 项目根本身）。目标不可达返回错误。
func ScanSensitive(rootDir, rel string) (ScanResult, error) {
	return scanSensitive(rootDir, rel, maxScanEntries)
}

// scanSensitive limit 独立成参供单测用小上限验证截断语义
func scanSensitive(rootDir, rel string, limit int) (ScanResult, error) {
	rel, err := NormalizeRelPath(rel)
	if err != nil {
		return ScanResult{}, err
	}
	root, err := os.OpenRoot(rootDir)
	if err != nil {
		return ScanResult{}, err
	}
	defer root.Close()
	// 与 StatTarget 同一准入：目标路径上的符号链接一律拒绝
	if herr := rejectSymlinkPath(root, rel); herr != nil {
		return ScanResult{}, fs.ErrNotExist
	}
	fsRel := rel
	if fsRel == "" {
		fsRel = "."
	}
	info, err := root.Lstat(fsRel)
	if err != nil {
		return ScanResult{}, err
	}

	res := ScanResult{Warnings: []string{}}
	if !info.IsDir() {
		// 文件分享：目标本身即分享根，命中只报文件名
		if IsSensitiveName(info.Name()) {
			res.Warnings = append(res.Warnings, info.Name())
		}
		return res, nil
	}

	// 目录分享：锚定到分享根递归走（WalkDir 字典序，结果确定）
	dir, err := root.OpenRoot(fsRel)
	if err != nil {
		return ScanResult{}, err
	}
	defer dir.Close()

	visited := 0
	_ = fs.WalkDir(dir.FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // 单个条目不可读不阻断扫描（只读名字，不读内容）
		}
		if p == "." {
			return nil
		}
		// 符号链接对访客不可见（列表/zip 同策略），扫描同样跳过
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		visited++
		// 先计数后匹配：第 limit+1 个条目触发收尾（不再参与匹配）——
		// 由此 Truncated=true 当且仅当确有未扫描条目
		if visited > limit {
			res.Truncated = true
			return fs.SkipAll
		}
		if !d.IsDir() && IsSensitiveName(d.Name()) {
			res.Warnings = append(res.Warnings, p)
		}
		return nil
	})
	return res, nil
}

// IsSensitiveName 文件名（大小写不敏感）命中模式表任一 glob 即视为敏感。
// 导出给补丁导出族（P-20261004-97）共用同一张模式表——分享有闸导出裸奔的
// 不对称即源于表与匹配逻辑各自维护后的漂移风险，单一事实源在 share
func IsSensitiveName(name string) bool {
	lower := strings.ToLower(name)
	for _, pat := range sensitivePatterns {
		if ok, _ := path.Match(pat, lower); ok {
			return true
		}
	}
	return false
}

// MatchSensitivePaths 对项目相对路径清单（/ 分隔，git/补丁头口径）做敏感
// 文件名匹配，返回按输入序去重的命中子集。匹配与 IsSensitiveName 同表同
// 语义（basename 级，模式表无「/」模式）。分隔符归一不走 filepath.ToSlash
// ——它在 Linux 是恒等操作，反斜杠输入只在 Windows 被归一（三平台结果
// 不一致）；此处显式替换两种分隔符，归一语义与宿主平台解耦（全平台纪律：
// 三平台显式一致）。消费方：补丁导出族出域前对补丁涉及文件跑同源扫描
// （P-20261004-97），与目录分享的 ScanSensitive 共享防漂移
func MatchSensitivePaths(paths []string) []string {
	var out []string
	seen := make(map[string]bool, len(paths))
	for _, p := range paths {
		norm := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(p), `\`, `/`))
		if norm == "" {
			continue
		}
		base := norm
		if i := strings.LastIndexByte(base, '/'); i >= 0 {
			base = base[i+1:]
		}
		if seen[base] || !IsSensitiveName(base) {
			continue
		}
		seen[base] = true
		out = append(out, p)
	}
	return out
}
