package agentops

// 原子能力注册表门禁（P-20261022-3）：注册表是手册（ops-channel 节内置事件
// 目录 + 人类深链表）与 /api/meta ops.present-atoms 能力项的单一事实源，本组
// 测试钉住三面对账——
//  1. 注册表 ⇄ present-atoms.json 双侧快照（web 镜像单测读同一文件核对 TS
//     接口字段，字段增删不同步即红）；
//  2. 原子载荷字段 ⊆ ops-events.json 事件契约键（原子形态不越事件契约——
//     P-46 事件级快照仍是广播面权威，原子级是动词×目标视图）；
//  3. 手册渲染完整性：navigate 五形态 / 深链表 / locate-in-tree 在册，渲染
//     输出无未展开占位（{{PRESENT_ATOMS}} 落地）。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// presentAtomSnapshot present-atoms.json 的原子条目
type presentAtomSnapshot struct {
	ID       string   `json:"id"`
	Verb     string   `json:"verb"`
	Event    string   `json:"event"`
	Payload  []string `json:"payload"`
	DeepLink string   `json:"deepLink,omitempty"`
}

// deepLinkSnapshot present-atoms.json 的深链条目
type deepLinkSnapshot struct {
	ID         string   `json:"id"`
	Pattern    string   `json:"pattern"`
	Params     []string `json:"params"`
	ViewValues []string `json:"viewValues,omitempty"`
}

// presentAtomsDocSnapshot 快照整体
type presentAtomsDocSnapshot struct {
	Meta      map[string]string     `json:"meta"`
	Atoms     []presentAtomSnapshot `json:"atoms"`
	DeepLinks []deepLinkSnapshot    `json:"deepLinks"`
}

func readPresentAtomsSnapshot(t *testing.T) presentAtomsDocSnapshot {
	t.Helper()
	path := filepath.Join(repoDir(t), "server", "agentops", "testdata", "present-atoms.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取 present-atoms 快照失败: %v", err)
	}
	var snap presentAtomsDocSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("present-atoms 快照非法 JSON: %v", err)
	}
	if len(snap.Atoms) == 0 || len(snap.DeepLinks) == 0 {
		t.Fatalf("present-atoms 快照缺 atoms/deepLinks: %s", path)
	}
	return snap
}

// repoDir 仓库根（编译期路径定位，与 archguard repoRoot 同思路不依赖 cwd）
func repoDir(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位 capabilities_test.go 源文件路径")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", ".."))
}

// TestPresentAtomsRegistryMatchesSnapshot 注册表 ⇄ 双侧快照：id/verb/event/
// 载荷字段/深链形态逐原子对账。改注册表不带快照（或反之）当轮即红。
func TestPresentAtomsRegistryMatchesSnapshot(t *testing.T) {
	snap := readPresentAtomsSnapshot(t)
	byID := func(id string) *presentAtomSnapshot {
		for i := range snap.Atoms {
			if snap.Atoms[i].ID == id {
				return &snap.Atoms[i]
			}
		}
		return nil
	}

	// 注册表每原子必须在快照且逐字段相等
	for _, a := range PresentAtoms() {
		s := byID(a.ID)
		if s == nil {
			t.Errorf("注册表原子 %q 未登记 present-atoms.json（双侧快照同 PR 更新）", a.ID)
			continue
		}
		if s.Verb != a.Verb || s.Event != a.Event {
			t.Errorf("%s: 快照 verb/event (%q,%q) ≠ 注册表 (%q,%q)", a.ID, s.Verb, s.Event, a.Verb, a.Event)
		}
		fields := slices.Clone(a.PayloadFields)
		slices.Sort(fields)
		if !slices.Equal(s.Payload, fields) {
			t.Errorf("%s: 载荷字段漂移\n  快照:   %v\n  注册表: %v", a.ID, s.Payload, fields)
		}
		if s.DeepLink != a.DeepLink {
			t.Errorf("%s: 深链形态漂移：快照 %q ≠ 注册表 %q", a.ID, s.DeepLink, a.DeepLink)
		}
	}

	// 快照悬空条目（原子已删快照未剪）
	for _, s := range snap.Atoms {
		found := slices.ContainsFunc(PresentAtoms(), func(a PresentAtom) bool { return a.ID == s.ID })
		if !found {
			t.Errorf("present-atoms.json 悬空条目 %q（原子已删，修剪快照）", s.ID)
		}
	}

	// 深链表对账：快照 deepLinks ⇄ DeepLinkKinds
	kinds := DeepLinkKinds()
	if len(kinds) != len(snap.DeepLinks) {
		t.Fatalf("深链形态数漂移：快照 %d ≠ 注册表 %d", len(snap.DeepLinks), len(kinds))
	}
	for i, k := range kinds {
		s := snap.DeepLinks[i]
		if s.ID != k.ID || s.Pattern != k.Pattern {
			t.Errorf("深链 %d: 快照 id/pattern (%q,%q) ≠ 注册表 (%q,%q)", i, s.ID, s.Pattern, k.ID, k.Pattern)
		}
		params := slices.Clone(k.Params)
		slices.Sort(params)
		if !slices.Equal(s.Params, params) {
			t.Errorf("深链 %s: params 漂移\n  快照:   %v\n  注册表: %v", k.ID, s.Params, params)
		}
	}

	// /api/meta 能力项同名：快照 meta.capability 与手册渲染头注一致（探测协议
	// 的名字是跨实例契约，改动须双侧同 PR）
	if snap.Meta["capability"] != "ops.present-atoms" {
		t.Errorf("meta.capability = %q，want ops.present-atoms（/api/meta 族项名字漂移）", snap.Meta["capability"])
	}
}

// TestPresentAtomsWithinEventContracts 原子载荷字段 ⊆ 所属事件的事件级契约键
// （server/archguard/testdata/ops-events.json，P-46 快照）：原子是动词×目标
// 视图，字段不得越事件契约——越界即两侧快照有一侧漏更。
func TestPresentAtomsWithinEventContracts(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(repoDir(t), "server", "archguard", "testdata", "ops-events.json"))
	if err != nil {
		t.Fatalf("读取 ops-events 快照失败: %v", err)
	}
	var events map[string]struct {
		Payload []string `json:"payload"`
	}
	if err := json.Unmarshal(data, &events); err != nil {
		t.Fatalf("ops-events 快照非法 JSON: %v", err)
	}
	for _, a := range PresentAtoms() {
		ev, ok := events[a.Event]
		if !ok {
			t.Errorf("%s: 承载事件 %q 未登记 ops-events.json（事件级契约缺失）", a.ID, a.Event)
			continue
		}
		for _, f := range a.PayloadFields {
			if !slices.Contains(ev.Payload, f) {
				t.Errorf("%s: 字段 %q 不在事件 %s 的契约键 %v 内——载荷扩展须两快照（ops-events + present-atoms）同 PR 登记", a.ID, f, a.Event, ev.Payload)
			}
		}
	}
}

// TestManualRendersPresentAtoms 手册渲染完整性：内置事件目录由注册表渲染落地，
// navigate 五形态 / 深链表 / locate-in-tree 在册，且无未展开占位（新增能力
// 「注册即自动在册」的结构性验证——此前手写双份的漂移形态由本测试钉死）。
func TestManualRendersPresentAtoms(t *testing.T) {
	manual := Manual("")
	for _, atom := range PresentAtoms() {
		if !strings.Contains(manual, atom.ID) {
			t.Errorf("手册未渲染原子 %s（占位展开或目录渲染断裂）", atom.ID)
		}
	}
	// navigate 五形态逐形态在册（P-20261005-223 实现而手册未写的漂移，此处收口）
	for _, fragment := range []string{
		`"path":"/project"`,
		`"file":"src/app.go"`,
		`"view":"diff"`,
		`"view":"changes"`,
		`"terminalId"`,
	} {
		if !strings.Contains(manual, fragment) {
			t.Errorf("手册 navigate 目录缺形态 %s", fragment)
		}
	}
	// 人类深链表在册（编造 URL 的机制性杜绝面）
	for _, fragment := range []string{
		"人类深链表",
		"/project?file=<项目相对路径>&project=<项目id>&line=<N>&col=<M>[&diff=1]",
		"/project?view=",
		"/monitor[?fleet=<batchId>]",
	} {
		if !strings.Contains(manual, fragment) {
			t.Errorf("手册深链表缺 %q", fragment)
		}
	}
	// 组合配方小节在册（P-20261023-4 方案③：「基础原子 × 组合 = 任意功能」的
	// 协议哲学入册——agent 学组合而非背功能）
	for _, fragment := range []string{"组合配方", "frontend.download", "frontend.clipboard", "notify.persist"} {
		if !strings.Contains(manual, fragment) {
			t.Errorf("手册组合配方缺 %q", fragment)
		}
	}
	if strings.Contains(manual, presentAtomsPlaceholder) {
		t.Fatal("手册含未展开 {{PRESENT_ATOMS}} 占位——渲染链断裂")
	}
	// SKILL.md 参考文件同链（渐进式披露第二层同目录）
	var opsRef *SkillRef
	for _, r := range SkillReferences("") {
		if r.Path == "references/ops-channel.md" {
			cp := r
			opsRef = &cp
		}
	}
	if opsRef == nil || !strings.Contains(opsRef.Content, "present.tree") || !strings.Contains(opsRef.Content, "人类深链表") {
		t.Error("SKILL.md references/ops-channel.md 未含注册表目录/深链表")
	}
}

// TestFileDeepLinkShape 文件深链生成器：参数齐全形态 / 缺省折叠 / URL 转义
// （agent 按表拼链接的产出形态在此钉死；web 侧 parseFileDeepLinkQuery 消费
// 同参，双向锁死见 web/src/__tests__/utils/presentAtoms.test.ts）。
func TestFileDeepLinkShape(t *testing.T) {
	full := FileDeepLink("src/app.go", "prj1", 55, 8, false)
	if full != "/project?file=src%2Fapp.go&line=55&col=8&project=prj1" &&
		full != "/project?col=8&file=src%2Fapp.go&line=55&project=prj1" {
		// url.Values.Encode 按键字典序输出；只断言参数集与值，不绑键序
		for _, want := range []string{"file=src%2Fapp.go", "project=prj1", "line=55", "col=8"} {
			if !strings.Contains(full, want) {
				t.Fatalf("深链缺 %s: %s", want, full)
			}
		}
		if strings.Contains(full, "diff=1") {
			t.Fatalf("diff=false 不应携带 diff=1: %s", full)
		}
	}
	// 缺省折叠：line/col ≤0 与空 project 不产生空值参数
	min := FileDeepLink("a.ts", "", 0, 0, false)
	if strings.ContainsAny(min, "&") {
		t.Fatalf("最小深链应只含 file 单参数: %s", min)
	}
	if !strings.HasPrefix(min, "/project?file=a.ts") {
		t.Fatalf("最小深链形态: %s", min)
	}
	// diff 变体：对比视图无行定位语义（line/col 不与 diff 同拼的调用约定在
	// 注册表文档，生成器本身允许并存——这里钉 diff=1 的键名）
	if d := FileDeepLink("a.ts", "p", 0, 0, true); !strings.Contains(d, "diff=1") {
		t.Fatalf("diff 深链应含 diff=1: %s", d)
	}
}

// TestPresentAtomValidators 注册表校验函数行为抽样（收编自 ai/opsentry 的既有
// 语义 + locate-in-tree 新形态——坏载荷 400 面的服务端直测，端到端面在 e2e）。
func TestPresentAtomValidators(t *testing.T) {
	// 唯一性守卫：每事件至多一个带 Validate 的原子（AtomForEvent 扫描口的
	// 确定性前提；事件级校验入口必须唯一）
	validatorsByEvent := map[string]int{}
	for _, a := range PresentAtoms() {
		if a.Validate != nil {
			validatorsByEvent[a.Event]++
		}
	}
	for ev, n := range validatorsByEvent {
		if n > 1 {
			t.Errorf("事件 %s 有 %d 个带 Validate 的原子——发布口校验入口须唯一", ev, n)
		}
	}
	if a := AtomForEvent("navigate"); a != nil {
		t.Errorf("navigate 族应无服务端校验（宽容语义），扫到 %s", a.ID)
	}
	for _, ev := range []string{"open-file-at", "watch.invite", "notify.persist", "locate-in-tree", "frontend.download", "frontend.clipboard", "frontend.open"} {
		if a := AtomForEvent(ev); a == nil {
			t.Errorf("事件 %s 应有注册表校验原子（发布口收编后缺位）", ev)
		}
	}
	if a := AtomForEvent("preview.port"); a != nil {
		t.Errorf("preview.port 校验留在发布口特判（伴生副作用耦合），不应在注册表带 Validate：%s", a.ID)
	}

	t.Run("open-file-at", func(t *testing.T) {
		if _, ok := ValidateOpenFileAtPath(map[string]interface{}{"path": "a.ts"}); ok {
			t.Error("缺 projectId 应拒绝")
		}
		if _, ok := ValidateOpenFileAtPath(map[string]interface{}{"path": "../x", "projectId": "p"}); ok {
			t.Error(".. 段应拒绝")
		}
		v, ok := ValidateOpenFileAtPath(map[string]interface{}{"path": " a.ts ", "projectId": "p", "line": float64(3)})
		if !ok {
			t.Fatal("合法载荷应通过")
		}
		p := v.(OpenFileAtPath)
		if p.Path != "a.ts" || p.Line == nil || *p.Line != 3 {
			t.Fatalf("规整结果异常: %+v", p)
		}
	})
	t.Run("locate-in-tree", func(t *testing.T) {
		// 空路径 = 项目根（合法）；focus 布尔可缺省
		v, ok := ValidateLocateInTree(map[string]interface{}{"path": "", "projectId": "p"})
		if !ok {
			t.Fatal("空路径（项目根）应通过")
		}
		if p := v.(LocateInTreePayload); p.Path != "" || p.ProjectID != "p" || p.Focus {
			t.Fatalf("规整结果异常: %+v", p)
		}
		if _, ok := ValidateLocateInTree(map[string]interface{}{"projectId": "p", "focus": true}); !ok {
			t.Error("path 缺省 + focus 应通过")
		}
		if _, ok := ValidateLocateInTree(map[string]interface{}{"path": "a\\b.ts", "projectId": "p"}); ok {
			t.Error("反斜杠路径应拒绝")
		}
		if _, ok := ValidateLocateInTree(map[string]interface{}{"path": "a.ts"}); ok {
			t.Error("缺 projectId 应拒绝")
		}
	})
	t.Run("watch.invite", func(t *testing.T) {
		if _, ok := ValidateWatchInvite(map[string]interface{}{"url": "https://evil.com/s/x"}); ok {
			t.Error("绝对 URL 应拒绝（反钓鱼白名单）")
		}
		if _, ok := ValidateWatchInvite(map[string]interface{}{"url": "/s/ab?query=1"}); ok {
			t.Error("query 形态应拒绝（/s/<token> 字符集白名单）")
		}
		if _, ok := ValidateWatchInvite(map[string]interface{}{"url": "/s/abc123def456ghi7"}); !ok {
			t.Error("合法访客短链应通过")
		}
	})
	t.Run("notify.persist", func(t *testing.T) {
		v, ok := ValidateNotifyPersist(map[string]interface{}{"title": "token=sk-secret123"})
		if !ok {
			t.Fatal("合法载荷应通过")
		}
		if p := v.(NotifyPersistPayload); p.Level != "info" || !strings.Contains(p.Title, "***") {
			t.Fatalf("level 缺省规整/遮蔽异常: %+v", p)
		}
		if _, ok := ValidateNotifyPersist(map[string]interface{}{"title": "t", "action": "agent-fix", "actionPayload": "x"}); ok {
			t.Error("人裁决类动作应对 agent 拒绝")
		}
	})
	t.Run("frontend.download", func(t *testing.T) {
		v, ok := ValidateFrontendDownload(map[string]interface{}{"path": " reports/a.md ", "projectId": "p1"})
		if !ok {
			t.Fatal("合法载荷应通过")
		}
		if p := v.(FrontendDownloadPayload); p.Path != "reports/a.md" || p.ProjectID != "p1" {
			t.Fatalf("规整结果异常: %+v", p)
		}
		if _, ok := ValidateFrontendDownload(map[string]interface{}{"path": "a.md"}); ok {
			t.Error("缺 projectId 应拒绝")
		}
		if _, ok := ValidateFrontendDownload(map[string]interface{}{"path": "C:/tmp/a.md", "projectId": "p"}); ok {
			t.Error("盘符路径应拒绝")
		}
	})
	t.Run("frontend.clipboard", func(t *testing.T) {
		v, ok := ValidateFrontendClipboard(map[string]interface{}{"text": " git push \n"})
		if !ok {
			t.Fatal("合法载荷应通过")
		}
		// 逐字保真：剪贴板载荷不做空白规整（首尾空白可能是待粘贴语义）
		if p := v.(FrontendClipboardPayload); p.Text != " git push \n" {
			t.Fatalf("text 应原样透传（不 trim）: %q", p.Text)
		}
		if _, ok := ValidateFrontendClipboard(map[string]interface{}{"text": ""}); ok {
			t.Error("空文本应拒绝")
		}
		if _, ok := ValidateFrontendClipboard(map[string]interface{}{"text": strings.Repeat("a", 32*1024+1)}); ok {
			t.Error("超 32KB 应拒绝（与回落链中继槽同界）")
		}
		if _, ok := ValidateFrontendClipboard(map[string]interface{}{"text": strings.Repeat("a", 32*1024)}); !ok {
			t.Error("恰 32KB 应通过")
		}
	})
	t.Run("frontend.open", func(t *testing.T) {
		v, ok := ValidateFrontendOpen(map[string]interface{}{"url": " https://ci.example.net/runs/1 "})
		if !ok {
			t.Fatal("合法载荷应通过")
		}
		if p := v.(FrontendOpenPayload); p.URL != "https://ci.example.net/runs/1" {
			t.Fatalf("规整结果异常: %+v", p)
		}
		if _, ok := ValidateFrontendOpen(map[string]interface{}{"url": "javascript:alert(1)"}); ok {
			t.Error("伪协议应拒绝（scheme 白名单）")
		}
		if _, ok := ValidateFrontendOpen(map[string]interface{}{"url": "/project?file=a.ts"}); ok {
			t.Error("站内相对路径应拒绝（本原子只收绝对外链）")
		}
		// 与 notify.persist action=url 同防线：站内 host 形态也放行（主机不限）
		if _, ok := ValidateFrontendOpen(map[string]interface{}{"url": "http://127.0.0.1:9999/monitor"}); !ok {
			t.Error("http 绝对 URL 应通过")
		}
	})
}
