package archguard

// 包依赖边界守护（P-20261003-17）：把散落在代码注释里的分层禁令固化为可执行测试。
//
// 动机：「notification 不能反向 import store」（webhook.go:20/59）、「remoteterminal
// 不能反向 import api」（module.go:11）等约束只活在注释里，违反在编译期不可见；
// AI 流水线多会话并行开发恰是规则遗忘高发环境。本测试用标准库 go/parser 遍历
// server/ 各包 import 块（ImportsOnly，不引 x/tools 重依赖），对违规输出
// 包 + 文件 + 违反规则 行并 FAIL。
//
// 范围与口径：
//   - 扫描 server/ 全部 .go 文件的 import 块。包内 _test.go 与产品代码同包编译、
//     一并纳入；外部测试包（<pkg>_test）是 Go 语义上的独立包、不构成产品环，
//     予以豁免——如 store 的外部测试包桥接 git/auth 属测试装配合法面。
//   - 跨平台变体文件（*_unix.go / *_windows.go）无论当前 GOOS 全部纳入：
//     边界禁令须在所有平台成立。
//   - 前缀匹配带 "/" 边界（forbid "…/api" 不会误伤 "…/apiary" 类包名）。
//   - 首跑全绿承诺：规则表只收录当前合规面的禁令。现存合法依赖不设禁令——
//     如 filestore→store 是 store.DocumentStore 的接口实现方向（见
//     server/filestore/conformance_test.go 对拍套件），属合法下行依赖。
//     新增规则前先跑 TestPackageDependencyBoundaries 确认现存代码合规；
//     若发现现存违规，先修依赖方向（组合根注入 / 函数口 / 总线桥接均为仓库
//     既有解法）再入表，不得为转绿而掩盖。

import (
	"fmt"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// depRule 单条边界禁令：from 匹配的包禁止 import forbid 匹配的包，
// allow 列出 forbid 的豁免前缀（如 middleware 允许 api/shared 叶子工具包）。
type depRule struct {
	id     string   // 规则编号（违规报告按此引用）
	from   string   // 受限包 import 路径前缀（默认含其子包）
	exact  bool     // true 时 from 仅精确匹配该包本身，不波及子包
	forbid []string // 禁止 import 的目标 import 路径前缀（含其子包）
	allow  []string // forbid 的豁免前缀（边界匹配同 forbid）
	why    string   // 业务缘由 + 代码注释锚点（与既有注释互相引用成网）
}

// fileImports 单个源文件的 import 面（违规定位到文件）。
type fileImports struct {
	name    string
	imports []string
}

// pkgImports 单个包的 import 面。
type pkgImports struct {
	importPath string
	files      []fileImports
}

// violation 一条边界违规：包 + 文件 + 违反规则。
type violation struct {
	pkg, file, imp, ruleID, why string
}

// rules 包依赖边界禁令表——以现有代码注释约束为初始清单逐条锚定，
// 表驱动：架构演进时在此续写（why 注明业务缘由与注释锚点），改完先跑
// TestPackageDependencyBoundaries 确认现存代码合规再提交。
var rules = []depRule{
	{
		id:     "R1 notification 不上行 store",
		from:   "codecombo/server/notification",
		forbid: []string{"codecombo/server/store"},
		why: "notification 是 store 的下游事件消费侧（store 落库出站 → 总线 TopicNew → 模块，" +
			"见 notification/webhook.go:45），偏好读取与审批快照须经构造注入的函数口 / JSON 往返，" +
			"反向 import store 即与 store→notification 成环——" +
			"锚点：server/notification/webhook.go:20、webhook.go:59、server/app/modules.go:60",
	},
	{
		id:     "R2 remoteterminal 不上行 api",
		from:   "codecombo/server/remoteterminal",
		forbid: []string{"codecombo/server/api"},
		why: "remoteterminal 是内核模块，生产 Dialer 所需的 api 层 SSH 凭据解析" +
			"（remote.NewRemoteTerminalDialer）经构造参数声明式注入，而非反向 import api（含子包）——" +
			"锚点：server/remoteterminal/module.go:11、server/app/modules.go:108",
	},
	{
		id:     "R3 store 不上行 git/auth",
		from:   "codecombo/server/store",
		forbid: []string{"codecombo/server/git/auth"},
		why: "auth 已 import store（凭据仓库），store 反向 import auth 即成环；" +
			"故凭据 resolver 的 LRU 失效操作上提到 handler 层（git/auth_inject 桥、creds 持引用触发）——" +
			"锚点：server/git/auth/ssh_resolver.go:98、server/git/auth_inject.go:46、server/api/creds/sshkey.go:76",
	},
	{
		id:    "R4 git/auth 不下行自有子包",
		from:  "codecombo/server/git/auth",
		exact: true, // 仅约束 auth 本包；providers/platforms 之间的兄弟依赖不在此列
		forbid: []string{
			"codecombo/server/git/auth/providers",
			"codecombo/server/git/auth/platforms",
			"codecombo/server/git/auth/integration",
		},
		why: "auth 的子包（providers 平台 provider 实现、platforms 平台注册表）反向 import auth，" +
			"auth 下行 import 子包立即成环；桥接由 main.go 启动期 SetProviderLookup(providers.FindByPlatform) 完成——" +
			"锚点：server/git/auth/helper.go:43、helper.go:124、oauth_device_flow.go:67、https_resolver.go:56、" +
			"CLAUDE.md「Git Auth Subsystem」",
	},
	{
		id:     "R5 store 不上行 api",
		from:   "codecombo/server/store",
		forbid: []string{"codecombo/server/api"},
		why: "api handler 层单向消费 store，store 上行 import api 任意子包即反转分层成环；" +
			"历史上 api/shared ↔ store ↔ notification 的环正是靠抽出零依赖的 wssafe 包打破——" +
			"锚点：server/wssafe/wssafe.go:2",
	},
	{
		id:     "R6 wssafe 保持叶子",
		from:   "codecombo/server/wssafe",
		exact:  true,
		forbid: []string{"codecombo/server"},
		why: "wssafe 是 gorilla websocket 并发写安全包装，独立成包的存在意义就是当公共叶子、" +
			"打破 api/shared ↔ store ↔ notification 的循环依赖（各消费侧均可安全引用它）——" +
			"锚点：server/wssafe/wssafe.go:2",
	},
	{
		id:     "R7 middleware 不上行 api（豁免 shared）",
		from:   "codecombo/server/middleware",
		forbid: []string{"codecombo/server/api"},
		allow:  []string{"codecombo/server/api/shared"},
		why: "middleware 由 api/router 挂载于 api 之下，上行 import api handler（如 opschannel）即成环；" +
			"api/shared 是双方共用的叶子工具包故豁免。需要触达 api 层的出口经包级函数变量由组合根桥接" +
			"（middleware.ApprovalNotifier → ops-channel 广播）——" +
			"锚点：server/middleware/agentguard.go:52、server/app/app.go:217",
	},
	{
		id:     "R8 update 不上行 api/system",
		from:   "codecombo/server/update",
		forbid: []string{"codecombo/server/api/system"},
		why: "api/system 的优雅关闭链单向依赖 update（自更新时序：子进程替换二进制前本进程必须退出），" +
			"update 的重启钩子经 SetRestartHook 由组合根注入，不反向依赖 api/system——" +
			"锚点：server/update/hook.go:12",
	},
	{
		id:     "R9 api/terminal 不上行 api/agentcron",
		from:   "codecombo/server/api/terminal",
		forbid: []string{"codecombo/server/api/agentcron"},
		why: "agentcron 反向依赖 api/terminal（定时任务复用终端会话链），api/terminal 再 import agentcron 即成环；" +
			"故 agentcron 未导出的终态字面量（resultDone/resultFailed）只能同值复制、不能跨包引用——" +
			"锚点：server/api/terminal/longsession.go:68",
	},
	{
		id:     "R10 kernel 保持最底层",
		from:   "codecombo/server/kernel",
		exact:  true, // kernel/kerneltest 契约套件以 kernel 为被测对象，属合法下行
		forbid: []string{"codecombo/server"},
		why: "kernel 是全应用生命周期契约（模块注册拓扑 / 总线 / 日志），被全部模块与 api 单向依赖；" +
			"契约层若 import 任何 server 包即成为环汇点（其 Load 自身也做 ErrDepCycle 检测）。" +
			"kernel/kerneltest 契约一致性套件（M1.6）import kernel 是被测对象方向，" +
			"同 filestore→store 的接口实现方向、属合法下行，故本规则 exact 约束 kernel 本包——" +
			"锚点：server/kernel/kernel.go:147、server/kernel/kerneltest/conformance.go、CLAUDE.md「Architecture」",
	},
	{
		id:     "R11 model 保持纯类型层",
		from:   "codecombo/server/model",
		exact:  true,
		forbid: []string{"codecombo/server"},
		why: "model 集中定义 Git 基础结构体（Project/Commit/Branch/Diff 等），被 api/git/store 多层共享；" +
			"零行为零服务依赖是其被任意层安全引用的前提——见 CLAUDE.md「Architecture · 数据模型」",
	},
}

// matchesPath 前缀匹配，带 "/" 边界：path 等于 prefix 或位于 prefix 之下。
func matchesPath(path, prefix string) bool {
	return path == prefix || strings.HasPrefix(path, prefix+"/")
}

func matchesAny(path string, prefixes []string) bool {
	for _, p := range prefixes {
		if matchesPath(path, p) {
			return true
		}
	}
	return false
}

// applies 报告本规则是否约束给定包。
func (r depRule) applies(pkgPath string) bool {
	if r.exact {
		return pkgPath == r.from
	}
	return matchesPath(pkgPath, r.from)
}

// forbidden 判定单条 import 是否触禁（allow 豁免优先于 forbid）。
func (r depRule) forbidden(imp string) bool {
	if !matchesAny(imp, r.forbid) {
		return false
	}
	return !matchesAny(imp, r.allow)
}

// evaluate 表驱动求值：返回全部违规，按 包/文件/import/规则 排序保证输出稳定。
func evaluate(rs []depRule, pkgs []pkgImports) []violation {
	var out []violation
	for _, p := range pkgs {
		for _, r := range rs {
			if !r.applies(p.importPath) {
				continue
			}
			for _, f := range p.files {
				for _, imp := range f.imports {
					if r.forbidden(imp) {
						out = append(out, violation{pkg: p.importPath, file: f.name, imp: imp, ruleID: r.id, why: r.why})
					}
				}
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if c := strings.Compare(a.pkg, b.pkg); c != 0 {
			return c < 0
		}
		if c := strings.Compare(a.file, b.file); c != 0 {
			return c < 0
		}
		if c := strings.Compare(a.imp, b.imp); c != 0 {
			return c < 0
		}
		return a.ruleID < b.ruleID
	})
	return out
}

// checkRuleTable 规则表健康检查（防漂移）：from 必须命中现存包——否则包改名 /
// 移除后规则沦为永不触发的死条目，守护悄悄失效；allow 必须命中现存包或任一
// 现存 import，否则疑似笔误。forbid 允许指向尚不存在的包（预防性禁令），
// 不作存在性检查。
func checkRuleTable(rs []depRule, pkgs []pkgImports) []string {
	pkgPaths := make(map[string]bool, len(pkgs))
	imported := make(map[string]bool)
	for _, p := range pkgs {
		pkgPaths[p.importPath] = true
		for _, f := range p.files {
			for _, imp := range f.imports {
				imported[imp] = true
			}
		}
	}
	prefixHits := func(prefix string, set map[string]bool) bool {
		for path := range set {
			if matchesPath(path, prefix) {
				return true
			}
		}
		return false
	}
	var issues []string
	for _, r := range rs {
		if !prefixHits(r.from, pkgPaths) {
			issues = append(issues, fmt.Sprintf("%s 的 from %q 不命中任何现存包（包已改名/移除，规则已成死条目，须同步更新禁令表）", r.id, r.from))
		}
		for _, a := range r.allow {
			if !prefixHits(a, pkgPaths) && !prefixHits(a, imported) {
				issues = append(issues, fmt.Sprintf("%s 的 allow %q 不命中任何现存包或 import（疑似笔误或包已消亡，须同步更新禁令表）", r.id, a))
			}
		}
	}
	return issues
}

// repoRoot 定位仓库根（本文件位于 <root>/server/archguard/，随编译期路径走，
// 不依赖测试进程 cwd）。
func repoRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位 archguard_test.go 源文件路径")
	}
	return filepath.Dir(filepath.Dir(filepath.Dir(thisFile)))
}

// readModulePath 从 go.mod 读 module 声明（不硬编码模块名，仓库改名后守护自愈）。
func readModulePath(t *testing.T, root string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		t.Fatalf("读取 go.mod 失败: %v", err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "module ") {
			return strings.Trim(strings.TrimSpace(strings.TrimPrefix(line, "module ")), `"`)
		}
	}
	t.Fatalf("go.mod 中未找到 module 声明")
	return ""
}

// scanServerPackages 遍历 <root>/server 下全部包，收集产品面（含包内 _test.go、
// 豁免外部 <pkg>_test 包）的逐文件 import 面。目录与文件均按字典序处理，
// 保证输出确定。
func scanServerPackages(t *testing.T, root, modulePath string) []pkgImports {
	t.Helper()
	serverDir := filepath.Join(root, "server")
	filesByDir := map[string][]string{}
	if err := filepath.WalkDir(serverDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path != serverDir && d.Name() == "testdata" {
				return filepath.SkipDir // 测试夹具不属产品依赖面
			}
			return nil
		}
		if strings.HasSuffix(path, ".go") {
			dir := filepath.Dir(path)
			filesByDir[dir] = append(filesByDir[dir], path)
		}
		return nil
	}); err != nil {
		t.Fatalf("遍历 %s 失败: %v", serverDir, err)
	}

	dirs := make([]string, 0, len(filesByDir))
	for dir := range filesByDir {
		dirs = append(dirs, dir)
	}
	sort.Strings(dirs)

	pkgs := make([]pkgImports, 0, len(dirs))
	fset := token.NewFileSet()
	for _, dir := range dirs {
		rel, err := filepath.Rel(root, dir)
		if err != nil {
			t.Fatalf("计算相对路径失败（%s）: %v", dir, err)
		}
		pkg := pkgImports{importPath: modulePath + "/" + filepath.ToSlash(rel)}
		for _, path := range filesByDir[dir] { // WalkDir 字典序 → 文件有序
			af, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
			if err != nil {
				t.Fatalf("解析 %s 失败: %v", path, err)
			}
			if strings.HasSuffix(af.Name.Name, "_test") {
				continue // 外部测试包是独立包，不构成产品环
			}
			imports := make([]string, 0, len(af.Imports))
			for _, spec := range af.Imports {
				ip, err := strconv.Unquote(spec.Path.Value)
				if err != nil {
					t.Fatalf("import 路径非法（%s）: %v", path, err)
				}
				imports = append(imports, ip)
			}
			pkg.files = append(pkg.files, fileImports{name: filepath.Base(path), imports: imports})
		}
		if len(pkg.files) > 0 {
			pkgs = append(pkgs, pkg)
		}
	}
	return pkgs
}

// TestPackageDependencyBoundaries 主守护：现存 server 依赖面对禁令表全量校验。
// 失败即存在真实边界违规（或规则表漂移），按违规行的规则 why 修复依赖方向，
// 不得为转绿而放宽禁令。
func TestPackageDependencyBoundaries(t *testing.T) {
	root := repoRoot(t)
	pkgs := scanServerPackages(t, root, readModulePath(t, root))
	if len(pkgs) < 30 {
		t.Fatalf("仅扫描到 %d 个包，疑似仓库根定位漂移（当前根 %s）", len(pkgs), root)
	}
	for _, issue := range checkRuleTable(rules, pkgs) {
		t.Errorf("规则表漂移: %s", issue)
	}
	vs := evaluate(rules, pkgs)
	for _, v := range vs {
		t.Errorf("包 %s 文件 %s import %q 违反 %s：%s", v.pkg, v.file, v.imp, v.ruleID, v.why)
	}
	t.Logf("边界守护通过：禁令 %d 条，扫描包 %d 个，违规 %d", len(rules), len(pkgs), len(vs))
}

// TestRuleEngineDetectsViolations 守卫引擎自检（不触磁盘）：用内存合成的包 /
// import 面驱动 evaluate，断言违规被逐条捕获且归位到 包+文件+规则、子包前缀
// 命中、allow 豁免生效、from 前缀带 "/" 边界不误伤（leaf 不匹配 leafx）。
func TestRuleEngineDetectsViolations(t *testing.T) {
	synthetic := []depRule{
		{id: "T1", from: "alpha/leaf", forbid: []string{"alpha/top"}, why: "合成规则：叶子禁上行"},
		{id: "T2", from: "alpha/mid", forbid: []string{"alpha/top/sub"}, allow: []string{"alpha/top/shared"}, why: "合成规则：豁免 shared"},
	}
	pkgs := []pkgImports{
		{importPath: "alpha/leaf", files: []fileImports{{name: "a.go", imports: []string{"fmt", "alpha/top"}}}},
		{importPath: "alpha/mid", files: []fileImports{
			{name: "b.go", imports: []string{"alpha/top/shared"}},   // allow 豁免，不报
			{name: "c.go", imports: []string{"alpha/top/sub/deep"}}, // forbid 子包前缀命中
		}},
		{importPath: "alpha/other", files: []fileImports{{name: "d.go", imports: []string{"alpha/top"}}}}, // 非 from，不适用
		{importPath: "alpha/leafx", files: []fileImports{{name: "e.go", imports: []string{"alpha/top"}}}}, // from 边界：leafx ≠ leaf
	}
	got := evaluate(synthetic, pkgs)
	want := []violation{
		{pkg: "alpha/leaf", file: "a.go", imp: "alpha/top", ruleID: "T1", why: "合成规则：叶子禁上行"},
		{pkg: "alpha/mid", file: "c.go", imp: "alpha/top/sub/deep", ruleID: "T2", why: "合成规则：豁免 shared"},
	}
	if len(got) != len(want) {
		t.Fatalf("期望 %d 条违规，实得 %d 条: %+v", len(want), len(got), got)
	}
	for i, w := range want {
		if got[i] != w {
			t.Errorf("第 %d 条违规不符：期望 %+v，实得 %+v", i+1, w, got[i])
		}
	}
}

// TestRuleTableHealthCatchesDeadRules 规则表防漂移自检：from 指向不存在的包时
// 健康检查必须报出（否则包改名后禁令悄悄失效），from 存活时不误报。
func TestRuleTableHealthCatchesDeadRules(t *testing.T) {
	pkgs := []pkgImports{{importPath: "alpha/real"}}
	if issues := checkRuleTable([]depRule{{id: "D1", from: "alpha/gone", forbid: []string{"x"}}}, pkgs); len(issues) != 1 || !strings.Contains(issues[0], "alpha/gone") {
		t.Fatalf("期望报出 1 条死规则（alpha/gone），实得: %v", issues)
	}
	if issues := checkRuleTable([]depRule{{id: "D2", from: "alpha/real", forbid: []string{"x"}}}, pkgs); len(issues) != 0 {
		t.Fatalf("存活规则不应报漂移，实得: %v", issues)
	}
}
