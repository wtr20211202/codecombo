package ai

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"codecombo/server/agentops"
	"codecombo/server/api/opschannel"
	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// setupNotifyTest ops-notify 路由测试装配（与 setupAskTest 同构：独立 store + 本组路由）
func setupNotifyTest(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.POST("/api/ops-notify", OpsNotify)
	return r
}

// TestOpsNotify_PreviewPortPayload 预览端口直达事件（P-20261002-70）的发布口校验：
// port 必填且为 1024~65535 的整数——坏载荷 400 退回不进广播流，合法载荷原样转发
func TestOpsNotify_PreviewPortPayload(t *testing.T) {
	r := setupNotifyTest(t)

	valid := []string{
		`{"type":"preview.port","payload":{"port":3000}}`,
		`{"type":"preview.port","payload":{"port":65535,"label":"vite dev server"}}`,
		`{"type":"preview.port","payload":{"port":1024,"label":""}}`,
	}
	for _, body := range valid {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusOK {
			t.Fatalf("%s expect 200, got %d body=%s", body, w.Code, w.Body.String())
		}
	}

	invalid := []string{
		`{"type":"preview.port"}`,                           // 缺 payload → port=0
		`{"type":"preview.port","payload":{}}`,              // 缺 port
		`{"type":"preview.port","payload":{"port":1023}}`,   // 低于下界（特权段）
		`{"type":"preview.port","payload":{"port":65536}}`,  // 高于上界
		`{"type":"preview.port","payload":{"port":3000.5}}`, // 非整数
		`{"type":"preview.port","payload":{"port":"3000"}}`, // 字符串
		`{"type":"preview.port","payload":{"port":true}}`,   // 布尔
		`{"type":"preview.port","payload":[3000]}`,          // 载荷非对象
		`{"type":"preview.port","payload":"3000"}`,          // 载荷非对象（标量）
	}
	for _, body := range invalid {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s expect 400, got %d body=%s", body, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "invalid preview.port payload") {
			t.Fatalf("%s expect invalid payload message, got %s", body, w.Body.String())
		}
	}
}

// TestOpsNotify_PreviewPortNormalized 合法载荷经校验后规整为强类型结构再广播，
// 下游观察者拿到的 port 已是 int（而非 JSON 反序列化的 float64）
func TestOpsNotify_PreviewPortNormalized(t *testing.T) {
	r := setupNotifyTest(t)

	var seenType string
	var seenPayload previewPortPayload
	unsub := opschannel.AddObserver(func(ev opschannel.Event) {
		seenType = ev.Type
		if p, ok := ev.Payload.(previewPortPayload); ok {
			seenPayload = p
		}
	})
	defer unsub()

	w := doJSON(r, http.MethodPost, "/api/ops-notify",
		`{"type":"preview.port","payload":{"port":4173,"label":"e2e dev"}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("expect 200, got %d body=%s", w.Code, w.Body.String())
	}
	if seenType != "preview.port" || seenPayload.Port != 4173 || seenPayload.Label != "e2e dev" {
		t.Fatalf("observer expect normalized payload, got type=%q payload=%+v", seenType, seenPayload)
	}
}

// TestOpsNotify_PreviewPortDoesNotAffectOtherTypes 校验仅作用于 preview.port：
// 其余自定义事件（含相似名）不受新分支影响，载荷原样透传
func TestOpsNotify_PreviewPortDoesNotAffectOtherTypes(t *testing.T) {
	r := setupNotifyTest(t)

	var seenPayload interface{}
	unsub := opschannel.AddObserver(func(ev opschannel.Event) {
		if ev.Type == "preview.ports" {
			seenPayload = ev.Payload
		}
	})
	defer unsub()

	// 相似名 preview.ports 携带同款坏载荷 → 不走 preview.port 校验，照常发布
	w := doJSON(r, http.MethodPost, "/api/ops-notify",
		`{"type":"preview.ports","payload":{"port":80}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("similar type expect 200 (no validation), got %d", w.Code)
	}
	m, ok := seenPayload.(map[string]interface{})
	if !ok || m["port"] == nil {
		t.Fatalf("similar type payload should pass through untouched, got %#v", seenPayload)
	}

	// 其余内置事件不受影响
	if w := doJSON(r, http.MethodPost, "/api/ops-notify", `{"type":"navigate","payload":{"path":"/project"}}`); w.Code != http.StatusOK {
		t.Fatalf("navigate expect 200, got %d", w.Code)
	}
}

// TestOpsNotify_TaskProgressSteps 结构化步骤清单（P-20261004-7）发布口校验：
// steps 在位时必须是 ≤20 项的 {name, done} 数组——畸形 400 退回不进广播流；
// steps 缺省的既有载荷原样透传零变化
func TestOpsNotify_TaskProgressSteps(t *testing.T) {
	r := setupNotifyTest(t)

	valid := []string{
		// 缺省 steps：既有上报形态，零变化
		`{"type":"task.progress","payload":{"task":"t","status":"running","step":"s"}}`,
		// 全量清单 + 增量勾选形态
		`{"type":"task.progress","payload":{"task":"t","status":"running","step":"第二步","steps":[{"name":"第一步","done":true},{"name":"第二步"}]}}`,
		// steps: null 视同缺省（可选字段的「无清单」编码）
		`{"type":"task.progress","payload":{"task":"t","status":"running","steps":null}}`,
		// 空数组 = 显式清空清单
		`{"type":"task.progress","payload":{"task":"t","status":"running","steps":[]}}`,
	}
	for _, body := range valid {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusOK {
			t.Fatalf("%s expect 200, got %d body=%s", body, w.Code, w.Body.String())
		}
	}

	invalid := []string{
		`{"type":"task.progress","payload":{"steps":"一,二"}}`,                       // 非数组
		`{"type":"task.progress","payload":{"steps":{"name":"一"}}}`,                // 对象
		`{"type":"task.progress","payload":{"steps":[{}]}}`,                        // 缺 name
		`{"type":"task.progress","payload":{"steps":[{"name":"  "}]}}`,             // 空白 name
		`{"type":"task.progress","payload":{"steps":[{"name":1}]}}`,                // name 非字符串
		`{"type":"task.progress","payload":{"steps":[[]]}}`,                        // 项非对象
		`{"type":"task.progress","payload":{"steps":"x"}}`,                         // 标量
		`{"type":"task.progress","payload":{"steps":[{"name":"一","done":"yes"}]}}`, // done 非布尔
	}
	for _, body := range invalid {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s expect 400, got %d body=%s", body, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "invalid task.progress payload") {
			t.Fatalf("%s expect invalid payload message, got %s", body, w.Body.String())
		}
	}

	// 上限：21 项拒收（悬浮件是扫读面，超过即畸形上报）
	many := `{"type":"task.progress","payload":{"steps":[` +
		`{"name":"s1"},{"name":"s2"},{"name":"s3"},{"name":"s4"},{"name":"s5"},` +
		`{"name":"s6"},{"name":"s7"},{"name":"s8"},{"name":"s9"},{"name":"s10"},` +
		`{"name":"s11"},{"name":"s12"},{"name":"s13"},{"name":"s14"},{"name":"s15"},` +
		`{"name":"s16"},{"name":"s17"},{"name":"s18"},{"name":"s19"},{"name":"s20"},` +
		`{"name":"s21"}]}}`
	if w := doJSON(r, http.MethodPost, "/api/ops-notify", many); w.Code != http.StatusBadRequest {
		t.Fatalf("21 items expect 400, got %d", w.Code)
	}
}

// TestOpsNotify_OpenFileAtPayload 编辑器打开目标文件事件（P-20261003-287）的
// 发布口校验：path（项目相对、正斜杠、无 .. 段）与 projectId 必填，line/col
// 可选正整数——坏载荷 400 退回不进广播流，合法载荷原样转发
func TestOpsNotify_OpenFileAtPayload(t *testing.T) {
	r := setupNotifyTest(t)

	valid := []string{
		`{"type":"open-file-at","payload":{"path":"src/app.ts","projectId":"p1"}}`,
		`{"type":"open-file-at","payload":{"path":"main.go","projectId":"p1","line":42}}`,
		`{"type":"open-file-at","payload":{"path":"web/src/a b.ts","projectId":"p1","line":3,"col":8}}`,
		`{"type":"open-file-at","payload":{"path":" 带空白.ts ","projectId":" p1 ","line":1}}`, // 首尾空白规整
	}
	for _, body := range valid {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusOK {
			t.Fatalf("%s expect 200, got %d body=%s", body, w.Code, w.Body.String())
		}
	}

	invalid := []string{
		`{"type":"open-file-at"}`,                                                        // 缺 payload
		`{"type":"open-file-at","payload":{}}`,                                           // 缺 path+projectId
		`{"type":"open-file-at","payload":{"path":"a.ts"}}`,                              // 缺 projectId
		`{"type":"open-file-at","payload":{"projectId":"p1"}}`,                           // 缺 path
		`{"type":"open-file-at","payload":{"path":"  ","projectId":"p1"}}`,               // path 空白
		`{"type":"open-file-at","payload":{"path":"a.ts","projectId":"  "}}`,             // projectId 空白
		`{"type":"open-file-at","payload":{"path":"/abs/a.ts","projectId":"p1"}}`,        // 绝对路径
		`{"type":"open-file-at","payload":{"path":"C:/a.ts","projectId":"p1"}}`,          // win 盘符
		`{"type":"open-file-at","payload":{"path":"a\\b.ts","projectId":"p1"}}`,          // 反斜杠
		`{"type":"open-file-at","payload":{"path":"../outside.ts","projectId":"p1"}}`,    // .. 穿越段
		`{"type":"open-file-at","payload":{"path":"a/../b.ts","projectId":"p1"}}`,        // 内嵌 .. 段
		`{"type":"open-file-at","payload":{"path":"a.ts","projectId":"p1","line":0}}`,    // 行号非正整数
		`{"type":"open-file-at","payload":{"path":"a.ts","projectId":"p1","line":-2}}`,   // 负行号
		`{"type":"open-file-at","payload":{"path":"a.ts","projectId":"p1","col":0}}`,     // 列号非正整数
		`{"type":"open-file-at","payload":{"path":"a.ts","projectId":"p1","line":1.5}}`,  // 非整数
		`{"type":"open-file-at","payload":{"path":"a.ts","projectId":"p1","line":"42"}}`, // 字符串
		`{"type":"open-file-at","payload":{"path":true,"projectId":"p1"}}`,               // path 非字符串
		`{"type":"open-file-at","payload":[1]}`,                                          // 载荷非对象
		`{"type":"open-file-at","payload":"a.ts"}`,                                       // 载荷非对象（标量）
	}
	for _, body := range invalid {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s expect 400, got %d body=%s", body, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "invalid open-file-at payload") {
			t.Fatalf("%s expect invalid payload message, got %s", body, w.Body.String())
		}
	}
}

// TestOpsNotify_OpenFileAtNormalized 合法载荷经校验后规整为强类型结构再广播：
// 观察者拿到 *int 行列（非 JSON float64）；缺省 line/col 广播 JSON 不携带键
func TestOpsNotify_OpenFileAtNormalized(t *testing.T) {
	r := setupNotifyTest(t)

	var seenPayload agentops.OpenFileAtPath
	unsub := opschannel.AddObserver(func(ev opschannel.Event) {
		if ev.Type == "open-file-at" {
			if p, ok := ev.Payload.(agentops.OpenFileAtPath); ok {
				seenPayload = p
			}
		}
	})
	defer unsub()

	// 带 line/col：指针带值
	w := doJSON(r, http.MethodPost, "/api/ops-notify",
		`{"type":"open-file-at","payload":{"path":"src/a.ts","projectId":"p1","line":7,"col":3}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("expect 200, got %d body=%s", w.Code, w.Body.String())
	}
	if seenPayload.Path != "src/a.ts" || seenPayload.ProjectID != "p1" ||
		seenPayload.Line == nil || *seenPayload.Line != 7 ||
		seenPayload.Col == nil || *seenPayload.Col != 3 {
		t.Fatalf("observer expect normalized payload, got %+v", seenPayload)
	}
	out, err := json.Marshal(seenPayload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(out), `"line":7`) || !strings.Contains(string(out), `"col":3`) {
		t.Fatalf("broadcast json expect line/col, got %s", out)
	}

	// 缺省 line/col：指针为 nil，广播 JSON 不携带键（前端 detail 无行号语义）
	seenPayload = agentops.OpenFileAtPath{}
	if w := doJSON(r, http.MethodPost, "/api/ops-notify",
		`{"type":"open-file-at","payload":{"path":"b.ts","projectId":"p1"}}`); w.Code != http.StatusOK {
		t.Fatalf("expect 200, got %d", w.Code)
	}
	if seenPayload.Path != "b.ts" || seenPayload.Line != nil || seenPayload.Col != nil {
		t.Fatalf("observer expect nil line/col, got %+v", seenPayload)
	}
	out, err = json.Marshal(seenPayload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(out), "line") || strings.Contains(string(out), "col") {
		t.Fatalf("broadcast json expect no line/col keys when absent, got %s", out)
	}
}

// TestOpsNotify_WatchInvitePayload 直播邀请事件（P-20261005-165）的发布口校验：
// url 必填且限 /s/<token> 访客短链形态（反钓鱼白名单），title/body 可选短文本。
// 注入形态矩阵（../、//、@、query、绝对 URL、伪协议）必须全数 400——url 是
// 前端 window.open 的直接消费值，白名单是唯一防线
func TestOpsNotify_WatchInvitePayload(t *testing.T) {
	r := setupNotifyTest(t)

	valid := []string{
		`{"type":"watch.invite","payload":{"url":"/s/abc123def456ghi7"}}`,
		`{"type":"watch.invite","payload":{"url":"/s/0123456789abcdef","title":"过来看","body":"演示关键步骤"}}`,
		`{"type":"watch.invite","payload":{"url":"/s/Upper1234567890"}}`,                  // 大写在白名单余量内
		`{"type":"watch.invite","payload":{"url":"/s/abc123def456ghi7","title":" 带空白 "}}`, // 首尾空白规整
	}
	for _, body := range valid {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusOK {
			t.Fatalf("%s expect 200, got %d body=%s", body, w.Code, w.Body.String())
		}
	}

	invalid := []string{
		`{"type":"watch.invite"}`,                                                         // 缺 payload
		`{"type":"watch.invite","payload":{}}`,                                            // 缺 url
		`{"type":"watch.invite","payload":{"url":""}}`,                                    // 空 url
		`{"type":"watch.invite","payload":{"url":"  "}}`,                                  // 空白 url
		`{"type":"watch.invite","payload":{"url":"/s/abc/def"}}`,                          // 尾随子路径（/ 注入）
		`{"type":"watch.invite","payload":{"url":"/s/../etc"}}`,                           // .. 穿越段
		`{"type":"watch.invite","payload":{"url":"/s/a/../b"}}`,                           // 内嵌穿越段
		`{"type":"watch.invite","payload":{"url":"//s/abc"}}`,                             // 协议相对外链（// 开头）
		`{"type":"watch.invite","payload":{"url":"//evil.com/s/abc"}}`,                    // 协议相对外链完整形态
		`{"type":"watch.invite","payload":{"url":"https://evil.com/s/abc"}}`,              // 绝对 URL（协议注入）
		`{"type":"watch.invite","payload":{"url":"javascript:alert(1)"}}`,                 // 伪协议
		`{"type":"watch.invite","payload":{"url":"/s/abc?x=1"}}`,                          // query 附加
		`{"type":"watch.invite","payload":{"url":"/s/abc#frag"}}`,                         // fragment 附加
		`{"type":"watch.invite","payload":{"url":"/s/a@b"}}`,                              // @ 凭据形态
		`{"type":"watch.invite","payload":{"url":"/s/abc def"}}`,                          // 空格
		`{"type":"watch.invite","payload":{"url":"/s/abc%2Fdef"}}`,                        // 编码绕过形态
		`{"type":"watch.invite","payload":{"url":"/s/abc\\def"}}`,                         // 反斜杠
		`{"type":"watch.invite","payload":{"url":"/s/"}}`,                                 // 裸前缀无 token
		`{"type":"watch.invite","payload":{"url":"s/abc"}}`,                               // 缺前导斜杠
		`{"type":"watch.invite","payload":{"url":"/x/abc"}}`,                              // 前缀不对
		`{"type":"watch.invite","payload":{"url":"/s/abc","title":"t","body":123}}`,       // body 非字符串
		`{"type":"watch.invite","payload":{"url":true}}`,                                  // url 非字符串
		`{"type":"watch.invite","payload":["/s/abc"]}`,                                    // 载荷非对象
		`{"type":"watch.invite","payload":{"url":"/s/` + strings.Repeat("a", 200) + `"}}`, // token 超长
	}
	for _, body := range invalid {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s expect 400, got %d body=%s", body, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "invalid watch.invite payload") {
			t.Fatalf("%s expect invalid payload message, got %s", body, w.Body.String())
		}
	}

	// 展示文本字段尺寸墙：title 超 4096 字节拒收（url 白名单本身已封死超长，
	// title/body 沿通知文本字段同口径）
	big := `{"type":"watch.invite","payload":{"url":"/s/abc123def456ghi7","title":"` + strings.Repeat("标", opsNotifyTextMax+1) + `"}}`
	if w := doJSON(r, http.MethodPost, "/api/ops-notify", big); w.Code != http.StatusBadRequest {
		t.Fatalf("oversize title expect 400, got %d", w.Code)
	}
}

// TestOpsNotify_WatchInviteNormalized 合法载荷经校验后规整为强类型结构再广播：
// 前端消费链拿到的是去空白后的 url/title/body（观察者断言）
func TestOpsNotify_WatchInviteNormalized(t *testing.T) {
	r := setupNotifyTest(t)

	var seenType string
	var seenPayload agentops.WatchInvitePayload
	unsub := opschannel.AddObserver(func(ev opschannel.Event) {
		seenType = ev.Type
		if p, ok := ev.Payload.(agentops.WatchInvitePayload); ok {
			seenPayload = p
		}
	})
	defer unsub()

	w := doJSON(r, http.MethodPost, "/api/ops-notify",
		`{"type":"watch.invite","payload":{"url":" /s/abc123def456ghi7 ","title":" 过来看 ","body":"演示"}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("expect 200, got %d body=%s", w.Code, w.Body.String())
	}
	if seenType != "watch.invite" || seenPayload.URL != "/s/abc123def456ghi7" ||
		seenPayload.Title != "过来看" || seenPayload.Body != "演示" {
		t.Fatalf("observer expect normalized payload, got type=%q payload=%+v", seenType, seenPayload)
	}
}

// TestOpsNotify_TaskProgressStepsNormalized 合法 steps 经校验规整为强类型清单：
// name 去空白、done 缺省 false、项上未知字段剔除；其余载荷字段原样保留
func TestOpsNotify_TaskProgressStepsNormalized(t *testing.T) {
	r := setupNotifyTest(t)

	var seenPayload map[string]interface{}
	var seenSteps []taskProgressStep
	unsub := opschannel.AddObserver(func(ev opschannel.Event) {
		if ev.Type != "task.progress" {
			return
		}
		if m, ok := ev.Payload.(map[string]interface{}); ok {
			seenPayload = m
		}
		if ss, ok := ev.Payload.(map[string]interface{})["steps"].([]taskProgressStep); ok {
			seenSteps = ss
		}
	})
	defer unsub()

	w := doJSON(r, http.MethodPost, "/api/ops-notify",
		`{"type":"task.progress","payload":{"task":"t","status":"running","step":"第二步","terminalId":"tm1","id":"sc_x","steps":[{"name":" 第一步 ","done":true},{"name":"第二步","done":false,"extra":1}]}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("expect 200, got %d body=%s", w.Code, w.Body.String())
	}
	if len(seenSteps) != 2 ||
		seenSteps[0].Name != "第一步" || !seenSteps[0].Done ||
		seenSteps[1].Name != "第二步" || seenSteps[1].Done {
		t.Fatalf("observer expect normalized steps, got %+v", seenSteps)
	}
	// 其余字段原样保留（限流维度/落库观察者依赖 map 形态与扩展字段）
	for _, k := range []string{"task", "status", "step", "terminalId", "id"} {
		if _, ok := seenPayload[k]; !ok {
			t.Fatalf("payload field %q should be preserved, got %#v", k, seenPayload)
		}
	}
}
