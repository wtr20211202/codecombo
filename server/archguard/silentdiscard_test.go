package archguard

// 静默失败窄门禁（P-20261122-12，用户原则「系统的功能出错都应该有错误日志
// 或者必要的日志，并且可以诊断收集」）：
//
// 全仓 `_ =` 丢弃点两百余处，绝大多数是 w.Write/Close/Remove 这类不可补救或
// 幂等的清理（响应已提交、句柄释放、临时件回收）——按 `_ =` 计数既抓不到真
// 缺陷也制造海量噪声。本门禁沿用 archguard「首跑全绿 + 规则只收录当前合规
// 面」纪律（见 archguard_test.go 头注），只钉两类**持久化写 API 被整条丢弃**
// 的形态（实证缺陷：do_update.go 的 `_ = SaveUpdateResult(...)` 让整条更新
// 观察链唯一事实源写失败无迹；store/notification.go 的 `_ = r.doc.Patch(...)`
// 让「标已读」失败静默、重启后通知又变未读）：
//
//	R1 双丢弃：`_, _ = f(...)` 且 f 名带持久化动词——两个返回值一起丢，
//	   连「调用是否成功」这一位信息都不留，任何接收者都不应如此；
//	R2 单丢弃（三类接收者，均按 callee 最终名 + 导入别名/句柄判定，不做类型
//	   推断——go/ast 纯语法层）：
//	   a. 包内直呼：store/update/filestore 包内的裸函数名带持久化动词
//	      （SaveUpdateResult 一类——包内直呼看不到包限定名，只能按包归属判）；
//	   b. 包限定：`store.X(...)` / `update.X(...)` / `filestore.X(...)`，X 带
//	      动词（别名经 import 声明解析，含重命名别名）；
//	   c. DocumentStore 句柄：store 包内 `x.doc.<Patch|PatchBatch|Create|Mark|
//	      Save>(...)`——状态位写（已读/已删/通知落库）正是用户可感知的
//	      「重启后又变回去」形态。
//
// 刻意不收的口径（宁漏勿误，与既有 filesize/api_routes 基线纪律同源）：
//   - 跨包方法链（`store.Get().Credential.Save(cred)` 等 38 处）——root 是
//     import 别名但 callee 是链尾方法，语法层无法与普通 getter 区分；这些站
//     点在 docs/error-log-audit-20261122.md 表内按 P2 登记（逐条裁定），不进
//     门禁，否则首跑即红且逼出大批 whitelist 噪声；
//   - store 包内 `r.doc.Delete/Update/...`（份额轮换、trim 清理等）——多数是
//     幂等清理语义，Delete 更不在句柄规则动词集内；只有状态位动词（Patch/
//     PatchBatch/Create/Mark/Save）入册。
//
// 豁免：同行或上一行注释含 `// nolog: idempotent-cleanup`（为什么可以不留
// 日志：该丢弃是幂等清理，失败在下一轮自然重试且无用户可感知后果）。豁免
// 必须写理由，空理由不豁免。`_test.go` 与 testdata 不入扫描面。

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

// discardVerbs 持久化写 API 的动词前缀（提案口径；前缀匹配使
// SaveUpdateResult / PatchBatch / MarkAllRead / DeleteByUnit 等派生名全覆盖）。
var discardVerbs = []string{"Save", "Create", "Update", "Patch", "Delete", "Mark", "WriteFile"}

// docHandleVerbs DocumentStore 句柄上「状态位写」的动词前缀——Delete/Update
// 刻意不在内（见头注「刻意不收的口径」）。
var docHandleVerbs = []string{"Patch", "Create", "Mark", "Save"}

// persistenceOwnerPkgs 持久化拥有者包：包内裸函数名/句柄调用才判持久化写。
var persistenceOwnerPkgs = map[string]bool{"store": true, "update": true, "filestore": true}

// nologMarker 豁免标记（同行或上一行注释）。
const nologMarker = "nolog: idempotent-cleanup"

// discardViolation 一处被整条丢弃的持久化写调用。
type discardViolation struct {
	line int
	expr string // callee 最终名（报告用）
}

// findSilentDiscards 扫描单个已解析文件的丢弃点。pkg 为文件所属包名
// （ast.File.Name.Name），供包内直呼规则判定。
func findSilentDiscards(fset *token.FileSet, f *ast.File, pkg string) []discardViolation {
	aliases := persistenceImportAliases(f)
	ownerPkg := persistenceOwnerPkgs[pkg]
	comments := commentsByLine(fset, f)

	var out []discardViolation
	ast.Inspect(f, func(n ast.Node) bool {
		as, ok := n.(*ast.AssignStmt)
		if !ok || as.Tok != token.ASSIGN || len(as.Rhs) != 1 {
			return true
		}
		call, ok := as.Rhs[0].(*ast.CallExpr)
		if !ok {
			return true
		}
		double := false
		switch len(as.Lhs) {
		case 1:
			if !isBlankIdent(as.Lhs[0]) {
				return true
			}
		case 2:
			if !isBlankIdent(as.Lhs[0]) || !isBlankIdent(as.Lhs[1]) {
				return true
			}
			double = true
		default:
			return true
		}

		name := calleeName(call)
		if name == "" {
			return true
		}
		violates := double && hasVerbPrefix(name, discardVerbs)
		if !violates {
			switch fun := call.Fun.(type) {
			case *ast.Ident:
				// 包内直呼持久化写 API（store/update/filestore 内）
				violates = ownerPkg && hasVerbPrefix(name, discardVerbs)
			case *ast.SelectorExpr:
				// 包限定：store.X / update.X / filestore.X
				if id, ok := fun.X.(*ast.Ident); ok && aliases[id.Name] && hasVerbPrefix(name, discardVerbs) {
					violates = true
				}
				// DocumentStore 句柄状态位写：x.doc.Patch / doc.Create …
				if ownerPkg && isDocHandle(fun.X) && hasVerbPrefix(name, docHandleVerbs) {
					violates = true
				}
			}
		}
		if !violates {
			return true
		}

		line := fset.Position(as.Pos()).Line
		if hasNologComment(comments, line) {
			return true
		}
		out = append(out, discardViolation{line: line, expr: name})
		return true
	})
	return out
}

// persistenceImportAliases 收集 store/update/filestore 的导入别名（含重命名
// 别名；默认别名取路径最后一段）。按路径尾段判定而非全路径，worktree/模块名
// 变化不影响。
func persistenceImportAliases(f *ast.File) map[string]bool {
	aliases := map[string]bool{}
	for _, imp := range f.Imports {
		path := strings.Trim(imp.Path.Value, `"`)
		seg := path
		if i := strings.LastIndex(path, "/"); i >= 0 {
			seg = path[i+1:]
		}
		if !persistenceOwnerPkgs[seg] {
			continue
		}
		name := seg
		if imp.Name != nil {
			if imp.Name.Name == "_" || imp.Name.Name == "." {
				continue // 点导入不产生限定名，下划线导入无从调用
			}
			name = imp.Name.Name
		}
		aliases[name] = true
	}
	return aliases
}

// commentsByLine 行号 → 注释文本（注释组覆盖的每一行都带整组文本，使「同行」
// 与「上一行」两种放置都能命中）。
func commentsByLine(fset *token.FileSet, f *ast.File) map[int]string {
	out := map[int]string{}
	for _, g := range f.Comments {
		text := g.Text()
		start := fset.Position(g.Pos()).Line
		end := fset.Position(g.End()).Line
		for line := start; line <= end; line++ {
			out[line] = text
		}
	}
	return out
}

// hasNologComment 同行或上一行是否带豁免标记。
func hasNologComment(comments map[int]string, line int) bool {
	if strings.Contains(comments[line], nologMarker) {
		return true
	}
	return strings.Contains(comments[line-1], nologMarker)
}

func isBlankIdent(e ast.Expr) bool {
	id, ok := e.(*ast.Ident)
	return ok && id.Name == "_"
}

// calleeName 调用目标最终名（裸函数名或链尾方法名）；闭包/类型断言等非常规
// 形态返回空串（不判）。
func calleeName(call *ast.CallExpr) string {
	switch fun := call.Fun.(type) {
	case *ast.Ident:
		return fun.Name
	case *ast.SelectorExpr:
		return fun.Sel.Name
	}
	return ""
}

// isDocHandle 接收者是否是 DocumentStore 句柄（字段名 doc：`r.doc` / `doc`）。
// 纯语法判定——本仓 repo 层对 DocumentStore 的字段命名恒为 doc（20+ 个 repo
// 文件一致），不做类型检查以保持无 x/tools 依赖。
func isDocHandle(e ast.Expr) bool {
	switch v := e.(type) {
	case *ast.Ident:
		return v.Name == "doc"
	case *ast.SelectorExpr:
		return v.Sel.Name == "doc"
	}
	return false
}

func hasVerbPrefix(name string, verbs []string) bool {
	for _, v := range verbs {
		if strings.HasPrefix(name, v) {
			return true
		}
	}
	return false
}

// scannableGoFile 扫描面判定：产品代码 .go，排除 _test.go（测试里的丢弃是
// 夹具语义）与 testdata（archguard 夹具）。
func scannableGoFile(path string) bool {
	if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
		return false
	}
	return !strings.Contains(filepath.ToSlash(path), "/testdata/")
}

// minScannedFiles 失明守卫：扫描文件数下限（防 walk 起点错/过滤写坏后空转全绿）。
// 取当前存量的低位（server/ 产品代码 400+）。
const minScannedFiles = 200

// TestNoSilentPersistenceDiscard 全仓扫描：任何持久化写调用的整条丢弃都必须
// 留日志或显式登记 `// nolog: idempotent-cleanup`。
func TestNoSilentPersistenceDiscard(t *testing.T) {
	repo := filepath.Join("..", "..")
	var violations []string
	scanned := 0
	err := filepath.WalkDir(filepath.Join(repo, "server"), func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "testdata" {
				return filepath.SkipDir
			}
			return nil
		}
		if !scannableGoFile(p) {
			return nil
		}
		scanned++
		fset := token.NewFileSet()
		f, perr := parser.ParseFile(fset, p, nil, parser.ParseComments)
		if perr != nil {
			return fmt.Errorf("解析 %s: %w", p, perr)
		}
		rel, _ := filepath.Rel(repo, p)
		for _, v := range findSilentDiscards(fset, f, f.Name.Name) {
			violations = append(violations, fmt.Sprintf("%s:%d  _ 丢弃 %s(...)",
				filepath.ToSlash(rel), v.line, v.expr))
		}
		return nil
	})
	if err != nil {
		t.Fatalf("扫描失败: %v", err)
	}
	if scanned < minScannedFiles {
		t.Fatalf("扫描面失明：仅 %d 个文件（下限 %d）——walk 起点或过滤条件坏了", scanned, minScannedFiles)
	}
	if len(violations) > 0 {
		t.Fatalf("持久化写被整条丢弃且无日志（用户可感知失败 + 零诊断，见 P-20261122-12）：\n  %s\n"+
			"修法：判错留 slog.Warn/updateLogf 后按需处理；确属幂等清理则同行或上一行写 "+
			"// %s 并附理由", strings.Join(violations, "\n  "), nologMarker)
	}
}

// TestSilentDiscardFixtures 门禁本体红绿两态自证（豁免/非豁免、动词/句柄/
// 双丢弃、包归属与导入别名边界）。
func TestSilentDiscardFixtures(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want int
	}{
		{
			name: "包内直呼持久化写（update.SaveUpdateResult 实证缺陷形态）",
			src: `package update
func f() { _ = SaveUpdateResult("dd", nil) }
`,
			want: 1,
		},
		{
			name: "包限定调用（重命名别名）",
			src: `package api
import st "codecombo/server/store"
func f() { _ = st.Save("k") }
`,
			want: 1,
		},
		{
			name: "包限定调用（默认别名）",
			src: `package api
import "codecombo/server/update"
func f() { _ = update.Patch("k") }
`,
			want: 1,
		},
		{
			name: "DocumentStore 句柄状态位写（notification Patch 实证缺陷形态）",
			src: `package store
func (r *notificationRepo) f() { _ = r.doc.Patch("notifications", "id", nil) }
`,
			want: 1,
		},
		{
			name: "DocumentStore 句柄 Create",
			src: `package store
func (r *notificationRepo) f() { _ = r.doc.Create("notifications", "id", nil) }
`,
			want: 1,
		},
		{
			name: "双丢弃（两个返回值一起丢）",
			src: `package store
func (r *notificationRepo) f() { _, _ = r.doc.DeleteBatch("notifications", nil) }
`,
			want: 1,
		},
		{
			name: "豁免：同行 nolog 标记",
			src: `package store
func (r *notificationRepo) f() { _ = r.doc.Patch("notifications", "id", nil) } // nolog: idempotent-cleanup
`,
			want: 0,
		},
		{
			name: "豁免：上一行 nolog 标记",
			src: `package store
func (r *notificationRepo) f() {
	// nolog: idempotent-cleanup
	_ = r.doc.Create("notifications", "id", nil)
}
`,
			want: 0,
		},
		{
			name: "句柄 Delete 不在状态位动词集（幂等清理语义）",
			src: `package store
func (r *notificationRepo) f() { _ = r.doc.Delete("notifications", "id") }
`,
			want: 0,
		},
		{
			name: "非持久化包的非别名接收者不判（os.WriteFile）",
			src: `package api
import "os"
func f() { _ = os.WriteFile("p", nil, 0644) }
`,
			want: 0,
		},
		{
			name: "跨包方法链刻意不判（store.Get().X.Save 属 P2 清单，非门禁面）",
			src: `package api
import "codecombo/server/store"
func f() { _ = store.Get().Credential.Save() }
`,
			want: 0,
		},
		{
			name: "非持久化动词不判",
			src: `package update
func f() { _ = updateLogf("x") }
`,
			want: 0,
		},
		{
			name: "非持久化包的裸函数不判",
			src: `package api
func f() { _ = SaveSomething() }
`,
			want: 0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fset := token.NewFileSet()
			f, err := parser.ParseFile(fset, "fixture.go", tc.src, parser.ParseComments)
			if err != nil {
				t.Fatalf("fixture 解析失败: %v", err)
			}
			got := findSilentDiscards(fset, f, f.Name.Name)
			if len(got) != tc.want {
				t.Fatalf("违规数 = %d, want %d (%+v)", len(got), tc.want, got)
			}
		})
	}
}

// TestSilentDiscardScanScope _test.go / testdata 不入扫描面（测试夹具里的丢弃
// 是夹具语义，纳入会让门禁自己被自己的夹具绊倒）。
func TestSilentDiscardScanScope(t *testing.T) {
	if scannableGoFile("server/store/notification_test.go") {
		t.Error("_test.go 不应入扫描面")
	}
	if scannableGoFile("server/archguard/testdata/fixture.go") {
		t.Error("testdata 不应入扫描面")
	}
	if !scannableGoFile("server/store/notification.go") {
		t.Error("产品代码应入扫描面")
	}
}
