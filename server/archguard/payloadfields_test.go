package archguard_test

// 前后端 payload 契约漂移哨兵（P-20261003-120）：把核心 API 契约类型的 JSON
// 字段集固化为已提交快照，字段增删/改名即测试失败并输出「新增 (+) / 删除 (-)」
// diff，把「字段集变更」变成显式评审动作。
//
// 动机：store/config/notification 的契约类型经 JSON 出入界，前端 TS interface
// 是手工镜像（web/src/api/domains/*.ts）——字段漂移在 TS 编译期不可见，运行期
// 表现为 undefined 静默丢数据。与路由对账（server/app/meta_conformance_test.go，
// P-20261002-133）、ops 事件目录（docs/OPS_EVENTS.md，P-20261003-75）构成
// API / 事件 / payload 三层契约防线。
//
// 机制：
//   - 覆盖表 payloadContracts 声明受守护类型（渐进扩表：新契约类型追加一行）；
//   - 字段集提取镜像 encoding/json 命名规则（json tag 优先、无 tag 用 Go 字段
//     名、匿名嵌入结构体拍平、json:"-" 与未导出字段跳过）；omitempty 字段同样
//     计入——契约变更与是否省略空值无关，零值 marshal 会漏掉它们，故走反射取
//     tag 而非 json.Marshal 键集（提案原文的「Marshal 后提取」按意图适配）；
//   - 与 server/archguard/testdata/payload-fields.json 对账，差异逐类型输出；
//     快照出现覆盖表之外的键同样失败（类型改名/删除时强制同步修剪快照）。
//
// 更新纪律：有意变更 → 先同步前端 TS interface → 以
//
//	CC_UPDATE_PAYLOAD_SNAPSHOT=1 go test ./server/archguard/
//
// 重写快照（一行一字段、键字典序，git diff 即评审材料）。快照键用「包名.类型名」
// 限定——notification 与 pluginsdk 各有一个 Notification，裸类型名会撞键。
//
// 本文件落在包外测试包 archguard_test（而非 archguard）：一是它要 import
// store/config/notification 三契约包，包外测试包在包依赖边界扫描
// （TestPackageDependencyBoundaries）中豁免，不构成产品依赖面；二是哨兵与
// 边界扫描互不耦合，互不拖累。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"

	"codecombo/server/config"
	"codecombo/server/git"
	"codecombo/server/notification"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

// updatePayloadSnapshotEnv 有意变更时的快照重写开关（置 1 生效）。
const updatePayloadSnapshotEnv = "CC_UPDATE_PAYLOAD_SNAPSHOT"

// payloadContract 受守护的 payload 契约条目：key 进快照；surface/ts 只进失败
// 提示——surface 定位服务端出入界口，ts 指向前端手工镜像的 TS interface 位置
// （变更须同步的另一半契约）。
type payloadContract struct {
	key     string
	typ     reflect.Type
	surface string
	ts      string
}

// payloadContracts 守护覆盖表——渐进扩表（P-20261003-120 首批判：审批 / 通知 /
// 远程主机 / agent 令牌 / 设置 server 段五条高频 API 链 + 其嵌套结构契约）。
// 新契约类型或新挖出的高频出入界口在此追加一行，刷新快照后随 diff 评审。
var payloadContracts = []payloadContract{
	{
		key:     "store.AgentApproval",
		typ:     reflect.TypeFor[store.AgentApproval](),
		surface: "POST /api/ops-confirm 载荷 · 审批卡 + agent 轮询/广播",
		ts:      "web/src/api/domains/opsconfirm.ts ApprovalRecord",
	},
	{
		key:     "store.AgentAsk",
		typ:     reflect.TypeFor[store.AgentAsk](),
		surface: "POST /api/ops-ask 载荷 · 提问卡 + input.request 广播（P-20261006-46 事件载荷交叉核对面）",
		ts:      "web/src/api/domains/opsask.ts AskRecord",
	},
	{
		key:     "store.ApprovalImpact",
		typ:     reflect.TypeFor[store.ApprovalImpact](),
		surface: "AgentApproval.impact 嵌套契约（P-20261003-319 审批徽标行）",
		ts:      "web/src/api/domains/opsconfirm.ts ApprovalImpact",
	},
	{
		key:     "store.ApprovalMergedItem",
		typ:     reflect.TypeFor[store.ApprovalMergedItem](),
		surface: "AgentApproval.merged 嵌套契约（P-20261006-26 合并审批挂起条目快照）",
		ts:      "web/src/api/domains/opsconfirm.ts ApprovalMergedItem",
	},
	{
		key:     "store.AgentTokenMeta",
		typ:     reflect.TypeFor[store.AgentTokenMeta](),
		surface: "GET /api/agent-token 载荷 · agent 令牌管理页",
		ts:      "web/src/api/domains/system.ts AgentTokenMeta",
	},
	{
		key:     "notification.Notification",
		typ:     reflect.TypeFor[notification.Notification](),
		surface: "通知中心 REST + /ws/notifications notification.new 载荷",
		ts:      "web/src/api/domains/system.ts NotificationItem",
	},
	{
		key:     "terminal.SentinelProbeResult",
		typ:     reflect.TypeFor[terminal.SentinelProbeResult](),
		surface: "POST /api/sentinels/test 逐规则结果（P-20261004-107 哨兵服务端真跑）",
		ts:      "web/src/api/domains/sentinel.ts SentinelProbeResult",
	},
	{
		key:     "config.RemoteHost",
		typ:     reflect.TypeFor[config.RemoteHost](),
		surface: "远程主机管理 REST 载荷 · 部署/远程终端/文件管理",
		ts:      "web/src/api/domains/remote.ts RemoteHost",
	},
	{
		key:     "config.ServerConfig",
		typ:     reflect.TypeFor[config.ServerConfig](),
		surface: "设置 server 段（config.json 落盘 + PUT /settings 写入面；GET /settings 的 SettingsData 是其派生视图）",
		ts:      "web/src/api/domains/system.ts SettingsData / settingsApi.update",
	},
	{
		key:     "config.CustomAgent",
		typ:     reflect.TypeFor[config.CustomAgent](),
		surface: "ServerConfig.customAgents 嵌套契约（自定义运行时注册）",
		ts:      "web/src/api/domains/system.ts CustomAgent",
	},
	{
		key:     "config.AgentApprovalRule",
		typ:     reflect.TypeFor[config.AgentApprovalRule](),
		surface: "ServerConfig.agentApprovalRules 嵌套契约（P-20261003-35 per-op 审批规则 + /settings/approval-rules/test）",
		ts:      "web/src/api/domains/system.ts AgentApprovalRule",
	},
	{
		key:     "git.NumstatFile",
		typ:     reflect.TypeFor[git.NumstatFile](),
		surface: "GET /api/projects/:id/numstat 载荷 · 变更树「复制变更摘要」数据面（P-20261003-219）",
		ts:      "web/src/api/domains/git.ts NumstatFile",
	},
	{
		key:     "store.UISnapshot",
		typ:     reflect.TypeFor[store.UISnapshot](),
		surface: "POST/GET /api/ui/snapshot 载荷 · 用户 UI 现场上报/读取（P-20261004-52；GET 响应是本类型 + updatedAt/ageSeconds 派生视图）",
		ts:      "web/src/api/domains/system.ts UiSnapshotPayload / UiSnapshotView",
	},
	{
		key:     "config.DshTarget",
		typ:     reflect.TypeFor[config.DshTarget](),
		surface: "ServerConfig.dshTargets 嵌套契约（dsh 多目标 cookie 路由）",
		ts:      "web/src/api/domains/system.ts dshTargetsList 消费面",
	},
}

// TestPayloadFieldSnapshot 逐契约类型对比字段集快照，差异 FAIL 并输出增删 diff。
func TestPayloadFieldSnapshot(t *testing.T) {
	live := map[string][]string{}
	for _, c := range payloadContracts {
		fields := jsonFieldNames(c.typ)
		if len(fields) == 0 {
			t.Fatalf("%s: 从 %s 未提取到任何 JSON 字段（类型被移除/改为不可导出形态？覆盖表须同步）", c.key, c.typ)
		}
		if _, dup := live[c.key]; dup {
			t.Fatalf("覆盖表键重复: %s", c.key)
		}
		live[c.key] = fields
	}

	path := snapshotPath(t)
	if os.Getenv(updatePayloadSnapshotEnv) == "1" {
		writeSnapshot(t, path, live)
	}
	want := readSnapshot(t, path)

	// 快照悬空键：类型改名/删除后旧键必须显式修剪，防快照腐化成死账
	var stale []string
	for k := range want {
		if _, ok := live[k]; !ok {
			stale = append(stale, k)
		}
	}
	if len(stale) > 0 {
		slices.Sort(stale)
		t.Errorf("快照含覆盖表之外的键（类型改名/已删除，修剪 testdata/payload-fields.json）：%v", stale)
	}

	for _, c := range payloadContracts {
		added, removed := diffFields(want[c.key], live[c.key])
		if len(added) == 0 && len(removed) == 0 {
			continue
		}
		t.Errorf("payload 契约漂移 %s（%s）\n  新增 (+): %v\n  删除 (-): %v\n  前端 TS 镜像位: %s\n  有意变更：先同步 TS interface，再以 %s=1 go test ./server/archguard/ 重写快照并让 diff 进评审",
			c.key, c.surface, added, removed, c.ts, updatePayloadSnapshotEnv)
	}
}

// TestPayloadFieldExtractorMatchesEncodingJSON 用构造反样本钉住字段提取器与
// encoding/json 命名规则的一致性——提取器改坏（而非契约改字段）时在此先红，
// 不与真实快照对账混在一起。
func TestPayloadFieldExtractorMatchesEncodingJSON(t *testing.T) {
	type inner struct {
		E       string `json:"e"`
		ignored string // 未导出字段：encoding/json 不出界（带 tag 也救不回，vet 禁此形态）
	}
	type probe struct {
		A     string `json:"a"`
		B     string `json:"b,omitempty"` // omitempty 也计字段（契约变更与省略空值无关）
		C     string // 无 tag → Go 字段名原样（encoding/json 不做小写化）
		D     string `json:"-"`
		inner        // 匿名嵌入（含未导出类型）：导出字段提升拍平
		Named inner  `json:"named"` // 显式命名嵌入：按普通字段处理，不拍平
	}
	got := jsonFieldNames(reflect.TypeFor[probe]())
	// 无 tag 字段用 Go 字段名原样（encoding/json 不做小写化）
	want := []string{"C", "a", "b", "e", "named"}
	if !slices.Equal(got, want) {
		t.Fatalf("字段提取器与 encoding/json 命名规则失配\ngot:  %v\nwant: %v", got, want)
	}
	if slices.Contains(got, "ignored") {
		t.Fatalf("未导出字段意外出界: %v", got)
	}
	_ = probe{}.ignored // 字段仅以反射元数据形态参与上面的断言，直读一次防 unused 误报
}

// jsonFieldNames 按类型声明序遍历（与 encoding/json 同向），返回字典序字段名集。
func jsonFieldNames(t reflect.Type) []string {
	seen := map[string]bool{}
	var walk func(t reflect.Type)
	walk = func(t reflect.Type) {
		for t.Kind() == reflect.Pointer {
			t = t.Elem()
		}
		if t.Kind() != reflect.Struct {
			return
		}
		for i := range t.NumField() {
			f := t.Field(i)
			ft := f.Type
			for ft.Kind() == reflect.Pointer {
				ft = ft.Elem()
			}
			// 匿名嵌入结构体（含未导出类型——encoding/json 对其导出字段做提升）
			// 且未显式命名：拍平递归；嵌入非结构体无字段可拍，落普通字段路径
			if f.Anonymous && ft.Kind() == reflect.Struct && jsonFieldName(f) == f.Name {
				walk(ft)
				continue
			}
			if !f.IsExported() {
				continue
			}
			name := jsonFieldName(f)
			if name == "" { // json:"-"
				continue
			}
			seen[name] = true
		}
	}
	walk(t)
	out := make([]string, 0, len(seen))
	for name := range seen {
		out = append(out, name)
	}
	slices.Sort(out)
	return out
}

// jsonFieldName 单字段的 wire 名：json tag 首段（逗号前）优先，无 tag 回落 Go
// 字段名，"-" 返回空串（不出界）。
func jsonFieldName(f reflect.StructField) string {
	tag, ok := f.Tag.Lookup("json")
	if !ok {
		return f.Name
	}
	name, _, _ := strings.Cut(tag, ",")
	if name == "-" {
		return ""
	}
	if name == "" {
		return f.Name
	}
	return name
}

// diffFields 两侧均字典序，双指针求增删。
func diffFields(old, cur []string) (added, removed []string) {
	i, j := 0, 0
	for i < len(old) && j < len(cur) {
		switch {
		case old[i] < cur[j]:
			removed = append(removed, old[i])
			i++
		case old[i] > cur[j]:
			added = append(added, cur[j])
			j++
		default:
			i++
			j++
		}
	}
	removed = append(removed, old[i:]...)
	added = append(added, cur[j:]...)
	return added, removed
}

// snapshotPath 定位快照文件（随本文件编译期路径走，不依赖测试进程 cwd——
// 按包目录为 cwd 的测试惯例下依然成立）。
func snapshotPath(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位 payloadfields_test.go 源文件路径")
	}
	return filepath.Join(filepath.Dir(thisFile), "testdata", "payload-fields.json")
}

// readSnapshot 读取已提交快照；字段序就地排序（手改乱序不产生幻影 diff）。
func readSnapshot(t *testing.T, path string) map[string][]string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取快照失败: %v\n首跑引导：%s=1 go test ./server/archguard/ 生成并提交 %s",
			err, updatePayloadSnapshotEnv, path)
	}
	snap := map[string][]string{}
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("快照非法 JSON（%s）: %v", path, err)
	}
	for _, fields := range snap {
		slices.Sort(fields)
	}
	return snap
}

// writeSnapshot 重写快照：键字典序 + 一行一字段缩进 JSON，git diff 即逐字段
// 评审材料（输出跨平台确定，无 CRLF/平台路径因素）。
func writeSnapshot(t *testing.T, path string, live map[string][]string) {
	t.Helper()
	data, err := json.MarshalIndent(live, "", "  ")
	if err != nil {
		t.Fatalf("序列化快照失败: %v", err)
	}
	data = append(data, '\n')
	// testdata/ 首跑可能尚不存在（引导期自建，免手工 mkdir）
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("创建快照目录失败: %v", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("写入快照失败（%s）: %v", path, err)
	}
	t.Logf("快照已重写: %s（先同步前端 TS interface，diff 随本提交评审）", path)
}
