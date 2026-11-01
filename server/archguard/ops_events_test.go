package archguard_test

// ops 事件目录对账快照（P-20261006-46）：把 /ws/ops-channel 事件族的契约面固化
// 为已提交快照 server/archguard/testdata/ops-events.json，与五条「代码现实」
// 对账，漂移当轮即红：
//
//  1. 常量集 vs 快照集：server/api/opschannel 包内 Event*/System* 常量逐个解析，
//     快照缺登记（新增事件漏对账）与悬空登记（事件已删快照未剪）双向即红；
//  2. 服务端广播点：BroadcastEvent 调用点全量扫描——裸串调用硬失败（服务端
//     广播点禁裸串，新事件必须先加 opschannel 常量，grep 可核）；source 含
//     "server" 的事件必须有在播调用点，"agent" 独占型必须零在播（注释漂移即红）；
//  3. 手册章节锚：anchor 必填且必须命中 docs/OPS_EVENTS.md 的 `### <锚>` 小节
//     ——新事件不登记手册（维护纪律第 1 条）测试即红；
//  4. 命名规范：新类型一律 domain.action 点分（存量例外见 legacyEventNames，
//     与 events.go 头注同源）；新类型不合规范即红，例外须显式登记缘由；
//  5. 载荷契约键交叉核对：payload 为完整契约记录的事件声明 contractKey（指入
//     payload-fields.json 的「包名.类型名」键），两快照键集相等——契约结构体
//     加减字段（P-20261003-120 快照重写）后事件载荷登记必须跟随，单向漂移即红。
//
// 与 scripts/ops-events-catalog.cjs --check（Node 侧：前端常量族 + 显式分发 +
// 目录行对账）分工：本测试守 Go 侧契约（常量集增删、裸串回潮、广播点与 source
// 注记一致、Go 测试可进 CI 门禁），脚本守前端与文档全量对账，两层互补不重复。
//
// 更新纪律：新增事件 = events.go 加常量 → 本快照补一条（source/payload/anchor
// 人工校注，无自动重写——锚与载荷语义是评审材料非派生物）→ OPS_EVENTS.md 登记
// 小节；删除事件反向修剪。本文件落在包外测试包 archguard_test（与
// payloadfields_test.go 同包）：复用其 readSnapshot/snapshotPath 读
// payload-fields.json 做交叉核对，且在包依赖边界扫描中豁免。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// opsEventContract 快照条目：键 = 事件 type（线上协议字符串）。
type opsEventContract struct {
	// Source 来源注记：server（仅服务端内部广播）/ agent（仅 ops-notify 上报，
	// 服务端零广播点）/ server+agent（双源）。与广播点扫描对账（见测试 2）。
	Source string `json:"source"`
	// Payload 载荷契约键集（字典序；空数组 = 无载荷契约，如 settings.changed
	// 的全量重拉语义）。gin.H 内联载荷无结构体可反射，键集是文档级冻结——
	// 改动载荷形状须同步本快照让 diff 进评审；contractKey 声明者走机械核对。
	Payload []string `json:"payload"`
	// Anchor 手册章节锚：docs/OPS_EVENTS.md 的 `### <Anchor>` 小节标题，必填
	// ——事件契约面（广播点/payload 形状/消费方）的手册登记位置。
	Anchor string `json:"anchor"`
	// ContractKey 载荷完整契约记录时指入 payload-fields.json 的键（如
	// store.AgentApproval）；内联/子集载荷留空不参与交叉核对。
	ContractKey string `json:"contractKey,omitempty"`
}

// legacyEventNames 命名规范（domain.action 点分）的存量例外 → 缘由。与
// events.go 头注同源：存量不改零迁移（字符串值即线上协议），新类型不在此表、
// 不合点分即红；给新类型开例外必须在此登记缘由（显式评审动作）。
var legacyEventNames = map[string]string{
	"navigate":            "agent 面动词型无域前缀（最早一批，前端显式分发 switch case 契约，改名牵动前端联合变更）",
	"notify":              "同 navigate：agent 面动词型存量",
	"panel":               "同 navigate：agent 面动词型存量",
	"open-file-at":        "连字符早于规范；常量值恰等于前端窗口事件名 sc-ops:open-file-at（双栖事件，改名破坏直通恒等）",
	"locate-in-tree":      "同 open-file-at：常量值恰等于前端既有窗口事件名 sc-ops:locate-in-tree（P-20261022-3 把纯前端内部事件升级为 agent 可发形态，直通恒等是零前端分发改动的根基），连字符段同理（P-20261001-32 命名早于规范）",
	"system:rate-limited": "system: 保留前缀冒号 + 连字符段（发布口拒绝伪造绑定该值，opsentry 同源校验）",
	"task.relaySkipped":   "驼峰段早于本对账测试落地（P-20261005-207 先于 P-20261006-46，P-46 盘点漏登记）；常量值已是 agent 监控面直通窗口事件名 sc-ops:task.relaySkipped（OPS_EVENTS.md 手册契约，agent 自动化脚本在监听），改名破坏外部消费恒等",
}

// eventNameRe domain.action 点分命名：小写字母开头、段内 [a-z0-9-]、至少两段
// （多段 terminal.message.read 合规）。
var eventNameRe = regexp.MustCompile(`^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$`)

// eventConstRe opschannel 常量声明行：与 scripts/ops-events-catalog.cjs 同款
// 口径（Event/System 前缀、字面量或 常量+字面量 两种取值形态）。
var (
	eventConstDeclRe = regexp.MustCompile(`(?m)^\s*(?:const\s+)?((?:Event|System)[A-Za-z0-9]*)\s*=\s*(.+?)\s*$`)
	eventConstLitRe  = regexp.MustCompile(`^"([^"]*)"`)
	eventConstAddRe  = regexp.MustCompile(`^([A-Z][A-Za-z0-9]*)\s*\+\s*"([^"]*)"$`)
)

// broadcastCallRe 服务端广播调用点：字面量形态（组1）或常量形态（组2）。
// 变量形态（opsentry.go 发布口 req.Type）不匹配——那是开放词表入口，非内置广播。
var broadcastCallRe = regexp.MustCompile(`opschannel\.BroadcastEvent\(\s*(?:"([^"]*)"|opschannel\.([A-Za-z0-9]+))`)

// TestOpsEventCatalogSnapshot 五面对账主测试。
func TestOpsEventCatalogSnapshot(t *testing.T) {
	root := repoRoot(t)

	// —— 1. 常量集：解析 opschannel 包源码（与 .cjs 同目录口径：包内全部非测试
	// .go，新文件落常量同样被扫到）——
	consts := parseOpsEventConstants(t, filepath.Join(root, "server", "api", "opschannel"))

	// —— 2. 服务端广播调用点：裸串硬失败 + 按 type 计数 ——
	broadcasts := scanServerBroadcasts(t, filepath.Join(root, "server"), consts)

	// —— 3. 手册章节锚现状 ——
	headings := opsDocHeadings(t, filepath.Join(root, "docs", "OPS_EVENTS.md"))

	// —— 4. 快照对账 ——
	snap := readOpsEventsSnapshot(t, filepath.Join(root, "server", "archguard", "testdata", "ops-events.json"))

	var added, stale []string
	for _, c := range consts {
		if _, ok := snap[c.value]; !ok {
			added = append(added, c.value)
		}
	}
	for k := range snap {
		if !slices.ContainsFunc(consts, func(c opsConst) bool { return c.value == k }) {
			stale = append(stale, k)
		}
	}
	if len(added) > 0 {
		slices.Sort(added)
		t.Errorf("常量集有、快照无（新增事件未对账登记）：%v\n新增事件登记路径：events.go 已有常量 → 本快照补一条（source/payload/anchor 人工校注）→ docs/OPS_EVENTS.md 登记 ### 小节", added)
	}
	if len(stale) > 0 {
		slices.Sort(stale)
		t.Errorf("快照有、常量集无（事件已删/改名，修剪快照）：%v", stale)
	}

	// payload-fields 快照（contractKey 交叉核对面）：复用 P-20261003-120 的
	// 读取与 diff helper（同包）
	payloadFields := readSnapshot(t, snapshotPath(t))

	types := make([]string, 0, len(snap))
	for k := range snap {
		types = append(types, k)
	}
	slices.Sort(types)

	for _, typ := range types {
		e := snap[typ]
		// 来源注记枚举
		switch e.Source {
		case "server", "agent", "server+agent":
		default:
			t.Errorf("%s: source 注记非法 %q（server | agent | server+agent）", typ, e.Source)
		}
		// 手册章节锚：必填 + 小节实际存在
		if e.Anchor == "" {
			t.Errorf("%s: 手册章节锚为空——事件契约面必须登记 docs/OPS_EVENTS.md（维护纪律第 1 条）", typ)
		} else if !headings[e.Anchor] {
			t.Errorf("%s: 章节锚 %q 在 docs/OPS_EVENTS.md 无对应 `### %s` 小节——新事件不登记手册测试即红，先补小节再对账", typ, e.Anchor, e.Anchor)
		}
		// 命名规范：非例外必须 domain.action 点分；例外表只准挂现存类型
		if reason, ok := legacyEventNames[typ]; ok {
			_ = reason // 例外合法，缘由见表注释
		} else if !eventNameRe.MatchString(typ) {
			t.Errorf("%s: 不合 domain.action 点分命名且未登记 legacyEventNames 例外——新类型统一点分，存量例外须显式登记缘由", typ)
		}
		// 载荷契约键与 payload-fields 快照交叉核对
		if e.ContractKey != "" {
			fields, ok := payloadFields[e.ContractKey]
			if !ok {
				t.Errorf("%s: contractKey %q 在 payload-fields.json 不存在——契约类型被移出 P-20261003-120 覆盖表？两快照须同步", typ, e.ContractKey)
			} else {
				live := slices.Clone(e.Payload)
				slices.Sort(live)
				if a, r := diffFields(fields, live); len(a) > 0 || len(r) > 0 {
					t.Errorf("%s: 载荷契约键与 payload-fields.json[%s] 漂移\n  payload-fields 有 (+): %v\n  事件快照有 (-): %v\n契约结构体加减字段后事件载荷登记必须跟随（两快照同一 PR 更新）", typ, e.ContractKey, a, r)
				}
			}
		}
		// source 注记 vs 服务端广播现实
		n := broadcasts[typ]
		if e.Source == "agent" && n > 0 {
			t.Errorf("%s: source 注记为 agent（服务端零广播）但扫到 %d 处服务端 BroadcastEvent 调用——注记漂移，改 source 或核对调用点", typ, n)
		}
		if e.Source != "agent" && n == 0 {
			t.Errorf("%s: source 注记含 server 但服务端零 BroadcastEvent 调用点（广播点被移除/常量改名？）——事件停播是 agent 监听面断裂，须有意识地处理并更新手册与快照", typ)
		}
	}
}

// TestOpsEventLegacyNamesReferenceLiveTypes 例外表只准挂现存事件——事件删除后
// 例外条目必须显式修剪，防例外表腐化成第二本死账。
func TestOpsEventLegacyNamesReferenceLiveTypes(t *testing.T) {
	consts := parseOpsEventConstants(t, filepath.Join(repoRoot(t), "server", "api", "opschannel"))
	for name := range legacyEventNames {
		if !slices.ContainsFunc(consts, func(c opsConst) bool { return c.value == name }) {
			t.Errorf("legacyEventNames 含已不存在的事件 %q——事件删除时例外条目同步修剪", name)
		}
	}
}

// opsConst 常量名 → 事件 type 值的一对。
type opsConst struct {
	name  string
	value string
}

// parseOpsEventConstants 解析 opschannel 包内全部 Event*/System* 常量取值。
// 取值支持「字面量」与「已解析常量 + 字面量」两种形态（与 .cjs 同口径）；
// 其余形态（fmt.Sprintf 等）无法静态解析即 Fatal——表结构变化时同步本解析器，
// 宁可红不可漏。SystemEventPrefix 是保留前缀常量而非事件类型，显式排除。
func parseOpsEventConstants(t *testing.T, dir string) []opsConst {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("读取 opschannel 包目录失败: %v", err)
	}
	values := map[string]string{} // 常量名 → 值
	for _, ent := range entries {
		name := ent.Name()
		if ent.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		src := readGoSource(t, filepath.Join(dir, name))
		for _, m := range eventConstDeclRe.FindAllStringSubmatch(src, -1) {
			cname, expr := m[1], m[2]
			if lit := eventConstLitRe.FindStringSubmatch(expr); lit != nil {
				values[cname] = lit[1]
				continue
			}
			if add := eventConstAddRe.FindStringSubmatch(expr); add != nil {
				base, ok := values[add[1]]
				if !ok {
					t.Fatalf("%s: 常量 %s 拼接的 %s 尚未解析（声明顺序？）——本解析器按声明顺序取值，调整声明或同步解析器", name, cname, add[1])
				}
				values[cname] = base + add[2]
				continue
			}
			t.Fatalf("%s: 常量 %s 取值形态无法静态解析（%q）——只支持字面量与「常量+字面量」，改写时同步本解析器与 scripts/ops-events-catalog.cjs", name, cname, expr)
		}
	}
	// SystemEventPrefix 是 system: 保留前缀常量，发布口校验与 EventRateLimited
	// 构造共用，不是事件类型——显式排除（新增非事件常量同样在此登记或给快照
	// 补条目，二选一都是显式动作）
	delete(values, "SystemEventPrefix")
	out := make([]opsConst, 0, len(values))
	for name, val := range values {
		if val == "" {
			t.Fatalf("常量 %s 解析出空值——声明形态变化？", name)
		}
		out = append(out, opsConst{name: name, value: val})
	}
	slices.SortFunc(out, func(a, b opsConst) int { return strings.Compare(a.name, b.name) })
	if len(out) == 0 {
		t.Fatal("opschannel 包未解析到任何 Event/System 常量——常量表移动/改名时同步本测试")
	}
	return out
}

// scanServerBroadcasts 扫描 server 树全部非测试 .go 的 opschannel.BroadcastEvent
// 调用点：裸串形态硬失败（服务端广播点禁裸串——拼错即静默失联，必须先落常量），
// 未知常量形态硬失败（常量表改名调用点未跟），返回 type → 调用点数。
func scanServerBroadcasts(t *testing.T, serverDir string, consts []opsConst) map[string]int {
	t.Helper()
	byName := map[string]string{}
	for _, c := range consts {
		byName[c.name] = c.value
	}
	counts := map[string]int{}
	err := filepath.WalkDir(serverDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "testdata" { // 测试夹具树无产品调用点
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			return nil
		}
		src := readGoSource(t, path)
		rel, _ := filepath.Rel(serverDir, path)
		rel = filepath.ToSlash(rel)
		for _, m := range broadcastCallRe.FindAllStringSubmatch(src, -1) {
			if m[1] != "" {
				t.Errorf("服务端广播点裸串 %s: BroadcastEvent(%q)——禁裸串，先在 opschannel/events.go 落常量再引用（对账快照与手册同 PR 登记）", rel, m[1])
				continue
			}
			if m[2] != "" {
				val, ok := byName[m[2]]
				if !ok {
					t.Errorf("%s: BroadcastEvent 引用未知常量 opschannel.%s——常量表改名时同步调用点", rel, m[2])
					continue
				}
				counts[val]++
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("扫描 server 广播调用点失败: %v", err)
	}
	return counts
}

// opsDocHeadings 提取 docs/OPS_EVENTS.md 的 `### ` 小节标题集（行精确匹配，
// terminal.message 与 terminal.message.read 这类前缀型小节天然区分）。
func opsDocHeadings(t *testing.T, path string) map[string]bool {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取事件目录失败: %v", err)
	}
	headings := map[string]bool{}
	for _, line := range strings.Split(normalizeLF(string(data)), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "### ") {
			headings[strings.TrimSpace(strings.TrimPrefix(line, "###"))] = true
		}
	}
	if len(headings) == 0 {
		t.Fatal("docs/OPS_EVENTS.md 未扫到任何 ### 小节——文档结构变化时同步本测试")
	}
	return headings
}

// readOpsEventsSnapshot 读取已提交快照；payload 键序就地排序（手改乱序不产生
// 幻影 diff，与 payload-fields 同纪律）。空文件/缺文件 Fatal 并给出登记指引
// ——本快照是人工校注的语义材料，不设自动重写开关。
func readOpsEventsSnapshot(t *testing.T, path string) map[string]opsEventContract {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取 ops-events 快照失败: %v\n首跑引导：为 opschannel/events.go 每个事件常量补一条 {source, payload, anchor}（payload 键字典序，锚指向 docs/OPS_EVENTS.md 小节）", err)
	}
	snap := map[string]opsEventContract{}
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("ops-events 快照非法 JSON（%s）: %v", path, err)
	}
	for k, e := range snap {
		slices.Sort(e.Payload)
		snap[k] = e
	}
	if len(snap) == 0 {
		t.Fatalf("ops-events 快照为空（%s）", path)
	}
	return snap
}

// readGoSource 读源码并归一换行（win 检出行尾 CRLF 不产生幻影差异）。
func readGoSource(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取源文件失败（%s）: %v", path, err)
	}
	return normalizeLF(string(data))
}

func normalizeLF(s string) string { return strings.ReplaceAll(s, "\r\n", "\n") }

// repoRoot 以本文件编译期路径定位仓库根（server/archguard 上两级），不依赖
// 测试进程 cwd（同 payloadfields_test.go snapshotPath 惯例）。
func repoRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位 ops_events_test.go 源文件路径")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", ".."))
}
