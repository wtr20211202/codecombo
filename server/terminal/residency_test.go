package terminal

import (
	"runtime"
	"testing"
)

// 表驱动覆盖三平台路径形态（P-20261006-36）：windowsSemantics=true/false 两套
// 语义各一张表，Windows 形态（盘符大小写/混用分隔符/UNC）在任何平台上都经
// 旗标注入验证——匹配函数无构建标签分支，测试同样平台可移植。
func TestLexPathResidesIn_WindowsSemantics(t *testing.T) {
	cases := []struct {
		name string
		dir  string
		root string
		want bool
	}{
		{"会话恰在项目根", `D:\work\proj`, `D:\work\proj`, true},
		{"项目根内子目录（文件树在此目录新建 agent 会话形态）", `D:\work\proj\packages\app`, `D:\work\proj`, true},
		{"盘符大小写失配（用户注册小写盘符）", `d:\work\proj\sub`, `D:\work\proj`, true},
		{"路径大小写失配（NTFS 缺省不敏感）", `D:\WORK\Proj`, `d:\work\proj`, true},
		{"正反斜杠混用（OSC 7 file URL 折算形态）", `D:/work/proj/src`, `D:\work\proj`, true},
		{"根带尾分隔符", `D:\work\proj\sub`, `D:\work\proj\`, true},
		{"根恰为盘符根", `D:\anything\here`, `D:\`, true},
		{"UNC 形态", `\\nas\share\proj\sub`, `\\nas\share\proj`, true},
		{"兄弟目录不得前缀误命中", `D:\work\proj2\x`, `D:\work\proj`, false},
		{"不同盘符", `C:\work\proj\x`, `D:\work\proj`, false},
		{"盘符不同仅大小写不同视为同卷", `d:\x`, `D:\x`, true},
		{"相对路径从严不计", `work\proj`, `D:\work\proj`, false},
		{"根为相对路径从严不计", `D:\work\proj`, `work\proj`, false},
		{"空路径从严不计", ``, `D:\work\proj`, false},
		{"空根从严不计", `D:\work\proj`, ``, false},
		{"首尾空白容忍（TrimSpace 后命中）", `  D:\work\proj  `, `D:\work\proj`, true},
		{"dot 段归一后命中", `D:\work\.\proj\sub\..\sub`, `D:\work\proj`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := lexPathResidesIn(tc.dir, tc.root, true); got != tc.want {
				t.Fatalf("lexPathResidesIn(%q, %q, windows) = %v, want %v", tc.dir, tc.root, got, tc.want)
			}
		})
	}
}

func TestLexPathResidesIn_PosixSemantics(t *testing.T) {
	cases := []struct {
		name string
		dir  string
		root string
		want bool
	}{
		{"会话恰在项目根", `/home/u/proj`, `/home/u/proj`, true},
		{"项目根内子目录", `/home/u/proj/packages/app`, `/home/u/proj`, true},
		{"根带尾分隔符", `/home/u/proj/sub`, `/home/u/proj/`, true},
		{"POSIX 根目录包含一切绝对路径", `/srv/anywhere`, `/`, true},
		{"大小写敏感（Linux 两个仅大小写不同的目录真实并存）", `/home/u/Proj/x`, `/home/u/proj`, false},
		{"兄弟目录不得前缀误命中", `/home/u/proj2/x`, `/home/u/proj`, false},
		{"反斜杠是合法文件名字符不折算为分隔符", `/home/u/proj\sub`, `/home/u/proj`, false},
		{"相对路径从严不计", `proj/sub`, `/home/u/proj`, false},
		{"空路径从严不计", ``, `/home/u/proj`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := lexPathResidesIn(tc.dir, tc.root, false); got != tc.want {
				t.Fatalf("lexPathResidesIn(%q, %q, posix) = %v, want %v", tc.dir, tc.root, got, tc.want)
			}
		})
	}
}

// pathResidesIn 生产入口按 GOOS 选语义：用本平台原生形态的路径对验证平台
// 默认行为（子目录命中、兄弟目录不命中），断言在 win/linux 两平台同样成立。
func TestPathResidesIn_PlatformDefault(t *testing.T) {
	var root, sub, sibling string
	if runtime.GOOS == "windows" {
		root, sub, sibling = `D:\sc-test-proj`, `D:\sc-test-proj\sub`, `D:\sc-test-proj2\sub`
	} else {
		root, sub, sibling = `/tmp/sc-test-proj`, `/tmp/sc-test-proj/sub`, `/tmp/sc-test-proj2/sub`
	}
	if !pathResidesIn(sub, root) {
		t.Fatalf("pathResidesIn(%q, %q) = false, want true", sub, root)
	}
	if pathResidesIn(sibling, root) {
		t.Fatalf("pathResidesIn(%q, %q) = true, want false", sibling, root)
	}
	if pathResidesIn(root, "") {
		t.Fatal("empty root must never match")
	}
}

// ResidentAgentSessions 过滤口径：kind=agent 且免项目绑定且 Path 驻留才计入；
// external 接管会话与项目绑定会话不参与。夹具按 GOOS 构造本机原生形态路径
// （生产入口 pathResidesIn 按运行平台选语义——Windows 形态夹具在 Linux 语义
// 下反斜杠是文件名字符，子目录形态不构成前缀，非平台缺陷）；各语义下路径
// 形态本身的覆盖在上方两张旗标注入表中，与平台无关。
func TestResidentAgentSessions(t *testing.T) {
	var root, sub, outside string
	switch runtime.GOOS {
	case "windows":
		root, sub, outside = `D:\work\proj`, `D:\work\proj\pkg`, `D:\other`
	default:
		root, sub, outside = `/home/u/work/proj`, `/home/u/work/proj/pkg`, `/home/u/other`
	}
	m := &Manager{sessions: make(map[string]*Session)}
	mk := func(id, kind, origin, projectID, path string) *Session {
		return &Session{ID: id, Kind: kind, Origin: origin, ProjectID: projectID, Path: path}
	}
	resident := mk("a1", KindAgent, OriginSelf, "", root)
	deepResident := mk("a2", KindAgent, OriginSelf, "", sub)
	outsideA := mk("a3", KindAgent, OriginSelf, "", outside)
	boundAgent := mk("a4", KindAgent, OriginSelf, "p1", root)
	external := mk("a5", KindAgent, OriginExternal, "", root)
	shell := mk("s1", KindShell, OriginSelf, "p1", root)
	for _, s := range []*Session{resident, deepResident, outsideA, boundAgent, external, shell} {
		m.sessions[s.ID] = s
	}

	got := m.ResidentAgentSessions(root)
	if len(got) != 2 {
		t.Fatalf("ResidentAgentSessions(%q) returned %d sessions, want 2 (a1,a2)", root, len(got))
	}
	ids := map[string]bool{}
	for _, s := range got {
		ids[s.ID] = true
	}
	if !ids["a1"] || !ids["a2"] {
		t.Fatalf("got %v, want a1+a2", ids)
	}
	// 空根不计任何会话
	if got := m.ResidentAgentSessions(""); len(got) != 0 {
		t.Fatalf("empty root matched %d sessions, want 0", len(got))
	}
}
