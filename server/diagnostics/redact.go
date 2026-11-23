package diagnostics

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"codecombo/server/mask"
)

// 诊断包脱敏层（P-20261122-10 必改D）——「分层可执行」口径在这里落地：
//
//	① 逐行 mask.MaskText 缺省开（mask=0 显式关，与 servicelogs 同口径）；
//	② 路径归一：DataDir → $DATA_DIR、家目录 → ~（用户名/盘符工作区不外泄）；
//	③ 凭据 denylist 硬拒：master-key / data/ 整目录 / config.json /
//	   *.pem *.key / id_* / *cookie* / *authorization*——命中即整条不入包
//	   （不是打码，是不收集）；
//	④ 分享 token 只出前缀（share.TokenSummary，收集侧负责）、env 只白名单
//	   （runtimeEnv 负责）。
//
// 边界（包内 README 同步声明）：脱敏口径是「凭据不是拓扑」——主机名/内网
// IP/项目路径/端口刻意保留（排障必需）；包留在用户机器、外发责任在用户。
// 因此这里不做 IP/主机名/任意绝对路径的抹除：那是拓扑面，抹了就排不了障。

// Redactor 诊断包文本归一器（并发不安全：单次收集内顺序使用）
type Redactor struct {
	dataDir string
	homeDir string
	maskOn  bool
}

// NewRedactor 构造归一器：dataDir 为实际数据目录（占位符替换源），
// maskOn 控制是否叠加 mask.MaskText
func NewRedactor(dataDir string, maskOn bool) *Redactor {
	home, _ := os.UserHomeDir()
	return &Redactor{
		dataDir: filepath.Clean(dataDir),
		homeDir: filepath.Clean(home),
		maskOn:  maskOn,
	}
}

// Line 日志行/自由文本：先遮蔽敏感值再归一化路径。顺序固定——先遮蔽防
// 「路径段里带 token」形态被前缀替换改写后漏遮；路径归一只动目录前缀，
// 不引入新的敏感面
func (r *Redactor) Line(s string) string {
	if r.maskOn {
		s = mask.MaskText(s)
	}
	return r.Path(s)
}

// Path 路径归一（只替换目录前缀，其余原样保留）。Windows 大小写不敏感 +
// 反斜杠/正斜杠双形态都收——日志里同一目录常以两种分隔符出现
func (r *Redactor) Path(s string) string {
	s = replacePathVariant(s, r.dataDir, "$DATA_DIR")
	s = replacePathVariant(s, r.homeDir, "~")
	return s
}

// replacePathVariant 路径前缀替换：原样 + 正斜杠形态各一遍；Windows 追加
// 大小写不敏感替换（盘符/用户名大小写在日志来源间不保证一致）
func replacePathVariant(s, old, repl string) string {
	if old == "" || old == "." || old == string(filepath.Separator) {
		return s
	}
	s = replaceFold(s, old, repl)
	if slash := filepath.ToSlash(old); slash != old {
		s = replaceFold(s, slash, repl)
	}
	return s
}

// replaceFold 大小写不敏感替换（仅 Windows 启用；unix 路径大小写敏感，
// 折叠会误伤仅大小写不同的另一个路径——虽然只影响占位符可读性，但语义
// 精度优先保持）
func replaceFold(s, old, repl string) string {
	if old == "" {
		return s
	}
	if runtime.GOOS != "windows" {
		return strings.ReplaceAll(s, old, repl)
	}
	lowerS, lowerOld := strings.ToLower(s), strings.ToLower(old)
	if !strings.Contains(lowerS, lowerOld) {
		return s
	}
	var b strings.Builder
	i := 0
	for {
		j := strings.Index(lowerS[i:], lowerOld)
		if j < 0 {
			b.WriteString(s[i:])
			return b.String()
		}
		b.WriteString(s[i : i+j])
		b.WriteString(repl)
		i += j + len(old)
	}
}

// deniedBaseNames 基名硬拒表（凭据面整文件不入包）。值即 manifest 里的
// 拒绝缘由（ABSENT/OMITTED 之外单列 status=denied 语义由调用方表达）
var deniedBaseNames = map[string]string{
	"master-key":  "machine master key (decrypts every stored credential)",
	"config.json": "instance config (may carry tokens / webhook targets)",
}

// deniedReason 凭据 denylist 判定：返回拒绝缘由（空串 = 允许）。三道闸门——
// 基名表、私钥/证书扩展与 id_* 前缀、data/ 目录整族（凭据库与 master-key
// 都住那里，逐文件判断不如整目录拒收）
func deniedReason(path, dataDir string) string {
	base := strings.ToLower(filepath.Base(path))
	if why, ok := deniedBaseNames[base]; ok {
		return why
	}
	switch strings.ToLower(filepath.Ext(base)) {
	case ".pem", ".key":
		return "private key / certificate file"
	}
	if strings.HasPrefix(base, "id_") {
		return "SSH private key"
	}
	if strings.Contains(base, "cookie") || strings.Contains(base, "authorization") {
		return "credential / cookie artifact"
	}
	if dataDir != "" {
		if rel, err := filepath.Rel(filepath.Clean(dataDir), path); err == nil &&
			rel != "." && !strings.HasPrefix(rel, "..") {
			if seg := strings.SplitN(filepath.ToSlash(rel), "/", 2)[0]; strings.EqualFold(seg, "data") {
				return "credential store directory (data/) — metadata only, content never packed"
			}
		}
	}
	return ""
}
