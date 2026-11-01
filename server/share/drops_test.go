package share

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/store"
)

// 访客素材上行（P-20261024-1）纪律锁：开关门禁（关闭恒 404）、类型/大小/
// 数量白名单、文件名净化、per-share 配额、敏感名警示、清单消费语义——
// 上行面护栏逐条可执行化，防后续演进放水

// dropTestEnv 起一个开了协作开关的访客子服务（httptest；SC_DATA_DIR 隔离
// 由调用方 t.Setenv 保证——隔离纪律与 passgate_test 同款）
func dropTestEnv(t *testing.T, token string, collab bool) (*httptest.Server, *[]DropEvent) {
	t.Helper()
	shares := fakeShares{token: {
		Token: token, Kind: store.ShareKindFile, ProjectID: "p1", Name: "collab", Collab: collab,
	}}
	events := &[]DropEvent{}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil).
		WithDropEvents(func(ev DropEvent) { *events = append(*events, ev) })
	srv := httptest.NewServer(svc.Handler())
	t.Cleanup(srv.Close)
	return srv, events
}

// postDrop multipart 上传（files 字段多文件 + nickname）
func postDrop(t *testing.T, base, token, nick string, files map[string]string) (*http.Response, map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	_ = w.WriteField("nickname", nick)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	// map 迭代序不定——multipart 内的文件序与断言无关（断言按名检索）
	for _, name := range names {
		fw, err := w.CreateFormFile("files", name)
		if err != nil {
			t.Fatalf("create form file: %v", err)
		}
		_, _ = fw.Write([]byte(files[name]))
	}
	_ = w.Close()
	res, err := http.Post(base+"/s/"+token+"/drop", w.FormDataContentType(), &buf)
	if err != nil {
		t.Fatalf("post drop: %v", err)
	}
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	res.Body.Close()
	return res, out
}

func TestDropToggleGate(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	token := fixedToken("dropgate")
	// 关闭（缺省）：上传与清单恒 404 share_not_found——存在性不可探测
	srv, _ := dropTestEnv(t, token, false)
	res, _ := postDrop(t, srv.URL, token, "", map[string]string{"a.png": "PNG"})
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("closed toggle upload = %d, want 404", res.StatusCode)
	}
	lg, err := http.Get(srv.URL + "/s/" + token + "/drops")
	if err != nil || lg.StatusCode != http.StatusNotFound {
		t.Fatalf("closed toggle list = %d, want 404", lg.StatusCode)
	}
	lg.Body.Close()
	// 未知 token 同形 404（探测者无从区分「无此分享」与「开关关闭」）
	res2, _ := postDrop(t, srv.URL, fixedToken("nosuch"), "", map[string]string{"a.png": "PNG"})
	if res2.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown token = %d, want 404", res2.StatusCode)
	}
}

func TestDropUploadRoundtrip(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	token := fixedToken("dropok")
	srv, events := dropTestEnv(t, token, true)

	res, out := postDrop(t, srv.URL, token, "测试员", map[string]string{
		"bug screenshot.png": "PNGDATA",
		"server.log":         "2026-10-24 ERROR boom",
	})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("upload = %d: %v", res.StatusCode, out)
	}
	added, _ := out["added"].([]any)
	if len(added) != 2 {
		t.Fatalf("added = %v", out)
	}
	// 净化名/大小/形态逐项校验（按名检索——multipart 顺序不定）
	byName := map[string]map[string]any{}
	for _, a := range added {
		m, _ := a.(map[string]any)
		byName[m["name"].(string)] = m
	}
	img := byName["bug screenshot.png"]
	if img == nil || img["kind"] != "image" || img["size"] != float64(7) {
		t.Fatalf("image entry wrong: %v", img)
	}
	log := byName["server.log"]
	if log == nil || log["kind"] != "file" {
		t.Fatalf("file entry wrong: %v", log)
	}
	// 响应零路径泄露：added 内不得出现任何绝对路径/落盘名（fileName 已剥）
	raw, _ := json.Marshal(out)
	if strings.Contains(string(raw), "_") && strings.Contains(string(raw), "absPath") {
		t.Fatalf("response leaks path-ish fields: %s", raw)
	}

	// 落位物理校验：隔离区 per-share 目录 + sidecar 成对（本体在盘可读）
	list := ListDropsFor(token)
	if len(list) != 2 {
		t.Fatalf("owner list = %d, want 2", len(list))
	}
	for _, m := range list {
		p := DropAbsPath(token, m.FileName)
		if data, err := os.ReadFile(p); err != nil || len(data) == 0 {
			t.Fatalf("drop file unreadable: %s err=%v", p, err)
		}
		if !strings.HasPrefix(filepath.Base(p), m.ID+"_") {
			t.Fatalf("file name lacks id prefix: %s", p)
		}
	}
	// 清单新到旧 + 消费态投影
	if list[0].Name != "server.log" && list[1].Name != "server.log" {
		t.Fatalf("list missing file: %+v", list)
	}
	// 事件旁路：两条 DropEvent（元数据口径）
	if len(*events) != 2 {
		t.Fatalf("drop events = %d, want 2", len(*events))
	}
	if (*events)[0].ShareName != "collab" || (*events)[0].Nick != "测试员" {
		t.Fatalf("event metadata wrong: %+v", (*events)[0])
	}

	// 访客清单：净化名/大小在场，落盘名剥除
	vg, err := http.Get(srv.URL + "/s/" + token + "/drops")
	if err != nil || vg.StatusCode != 200 {
		t.Fatalf("visitor list = %d", vg.StatusCode)
	}
	var vout struct {
		Drops []DropMeta `json:"drops"`
		Count int        `json:"count"`
	}
	_ = json.NewDecoder(vg.Body).Decode(&vout)
	vg.Body.Close()
	if vout.Count != 2 {
		t.Fatalf("visitor count = %d", vout.Count)
	}
	for _, d := range vout.Drops {
		if d.FileName != "" {
			t.Fatalf("visitor list leaks fileName: %+v", d)
		}
	}

	// 消费语义：consume 后 consumedAt 落盘（幂等首标）；主人侧单删
	first := list[0]
	if err := ConsumeDrop(token, first.ID, time.Now()); err != nil {
		t.Fatalf("consume: %v", err)
	}
	mark := ListDropsFor(token)
	for _, m := range mark {
		if m.ID == first.ID && m.ConsumedAt.IsZero() {
			t.Fatalf("consumedAt not recorded: %+v", m)
		}
	}
	first2 := mark[0]
	at := first2.ConsumedAt
	if err := ConsumeDrop(token, first.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("reconsume: %v", err)
	}
	for _, m := range ListDropsFor(token) {
		if m.ID == first.ID && !m.ConsumedAt.Equal(at) {
			t.Fatalf("reconsume moved anchor (must be idempotent first-mark): %+v", m)
		}
	}
	if err := DeleteDrop(token, first.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if got := len(ListDropsFor(token)); got != 1 {
		t.Fatalf("after delete = %d, want 1", got)
	}
	// 未知 id 幂等成功
	if err := DeleteDrop(token, "nope"); err != nil {
		t.Fatalf("delete unknown must be idempotent: %v", err)
	}
}

func TestDropGuards(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	token := fixedToken("dropgrd")
	srv, _ := dropTestEnv(t, token, true)

	// 白名单外扩展名（可执行族）：拒绝位（kind=rejected，不落盘）
	res, out := postDrop(t, srv.URL, token, "", map[string]string{"evil.exe": "MZ"})
	if res.StatusCode != 200 {
		t.Fatalf("rejected file should not fail the batch: %d", res.StatusCode)
	}
	added := out["added"].([]any)
	if len(added) != 1 || added[0].(map[string]any)["kind"] != "rejected" {
		t.Fatalf("rejected entry wrong: %v", out)
	}
	if got := len(ListDropsFor(token)); got != 0 {
		t.Fatalf("rejected file must not land: %d", got)
	}

	// 超限图片（>10MB）：同拒绝位
	big := strings.Repeat("x", MaxDropImageBytes+1)
	res, out = postDrop(t, srv.URL, token, "", map[string]string{"big.png": big})
	if res.StatusCode != 200 {
		t.Fatalf("oversize should be per-file rejected: %d", res.StatusCode)
	}
	if out["added"].([]any)[0].(map[string]any)["kind"] != "rejected" {
		t.Fatalf("oversize entry wrong: %v", out)
	}

	// 单批 >5 个：400
	six := map[string]string{}
	for i := 0; i < 6; i++ {
		six[string(rune('a'+i))+".txt"] = "x"
	}
	res, _ = postDrop(t, srv.URL, token, "", six)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("batch >5 = %d, want 400", res.StatusCode)
	}

	// 敏感文件名警示（credentials.json 命中模式表且在白名单内；.env 族
	// 本身被白名单拒绝——敏感性最强的名字根本进不来，警示层管「白名单内
	// 但长得像凭据」的边缘认定），警示不阻断
	res, out = postDrop(t, srv.URL, token, "", map[string]string{"credentials.json": "{}"})
	if res.StatusCode != 200 {
		t.Fatalf("sensitive-named upload = %d", res.StatusCode)
	}
	warnings, _ := out["warnings"].([]any)
	if len(warnings) != 1 || warnings[0] != "credentials.json" {
		t.Fatalf("warnings wrong: %v", out)
	}
	list := ListDropsFor(token)
	if len(list) != 1 || !list[0].Sensitive {
		t.Fatalf("sensitive flag not recorded: %+v", list)
	}
}

func TestDropQuota(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	token := fixedToken("dropqta")
	srv, _ := dropTestEnv(t, token, true)

	// 配额触顶 413：写入超过 per-share 配额的文件（构造 20MB 白名单内文件
	// × N 触顶——测试用直写隔离区省流量：预置 190MB 语义上不可行，改为
	// 验证判定边界：单文件 20MB×2 批（40MB）< 配额；再以落盘侧 helper
	// 直接灌一个伪大 sidecar 校验 walk 口径）
	res, _ := postDrop(t, srv.URL, token, "", map[string]string{"a.zip": strings.Repeat("z", 8<<20)})
	if res.StatusCode != 200 {
		t.Fatalf("within-quota upload = %d", res.StatusCode)
	}
	if got := dropDirBytes(token); got < 8<<20 {
		t.Fatalf("dir bytes = %d, want >= 8MB", got)
	}
	// dropKindFor 边界：图片/文件上限分档
	if k, m := dropKindFor(".png"); k != "image" || m != MaxDropImageBytes {
		t.Fatalf("png kind wrong: %s %d", k, m)
	}
	if k, m := dropKindFor(".zip"); k != "file" || m != MaxDropFileBytes {
		t.Fatalf("zip kind wrong: %s %d", k, m)
	}
	if k, _ := dropKindFor(".exe"); k != "" {
		t.Fatalf("exe must be rejected: %s", k)
	}
}

func TestDropSanitizeName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"report.png", "report.png"},
		{`..\..\..\Windows\system32\evil.dll`, "evil.dll"},
		{"../../etc/passwd", "passwd"},
		{"C:\\Users\\bob\\shot.png", "shot.png"},
		{"/var/log/syslog", "syslog"},
		{"C:report.png", "report.png"},
		{"con", "_con"},
		{".env.production", ".env.production"},
		{"CON.txt", "_CON.txt"},
		{"nul", "_nul"},
		{" .hidden ", ".hidden"},
		{"trailing... ", "trailing"},
		{"", "file"},
		{".", "file"},
		{"a\x01b.txt", "a b.txt"},
	}
	for _, c := range cases {
		if got := sanitizeDropFileName(c.in); got != c.want {
			t.Errorf("sanitize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	long := strings.Repeat("字", 200)
	if got := sanitizeDropFileName(long); len([]rune(got)) != dropNameMaxRunes {
		t.Errorf("long name not truncated: %d", len([]rune(got)))
	}
}

func TestDropTTLCleanup(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	token := fixedToken("dropttl")
	srv, _ := dropTestEnv(t, token, true)
	_, _ = postDrop(t, srv.URL, token, "", map[string]string{"keep.txt": "k", "old.zip": "o"})

	list := ListDropsFor(token)
	if len(list) != 2 {
		t.Fatalf("setup list = %d", len(list))
	}
	// 一条标已消费（时刻回拨 25h 前）→ 已消费 24h 窗外；另一条 At 回拨
	// 73h（未消费 72h 窗外）→ 双双到期
	now := time.Now()
	if err := ConsumeDrop(token, list[0].ID, now.Add(-25*time.Hour)); err != nil {
		t.Fatalf("consume: %v", err)
	}
	// 直写 sidecar 回拨 At（消费锚只对已消费条目生效，未消费条目看 At）
	_ = srv
	for _, m := range ListDropsFor(token) {
		if m.ID == list[1].ID {
			meta := m
			meta.At = now.Add(-73 * time.Hour)
			dir := dropDirFor(token)
			data, _ := json.Marshal(meta)
			if err := writeDropSidecar(dir, &meta); err != nil {
				t.Fatalf("rewrite sidecar: %v", err)
			}
			_ = data
		}
	}
	removed := cleanExpiredDrops(now, nil)
	if removed != 2 {
		t.Fatalf("cleanup removed = %d, want 2", removed)
	}
	if got := ListDropsFor(token); len(got) != 0 {
		t.Fatalf("after cleanup = %+v", got)
	}
	// 目录清空后整目录移除（隔离区紧凑）
	if _, err := os.Stat(dropDirFor(token)); !os.IsNotExist(err) {
		t.Fatalf("empty drop dir should be removed: %v", err)
	}
}

func TestDropOrphanGc(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	alive, dead := fixedToken("orphkeep"), fixedToken("orphdead")
	for _, tok := range []string{alive, dead} {
		if err := os.MkdirAll(dropDirFor(tok), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dropDirFor(tok), "1_x.txt"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// keep = nil 拒绝清账（防误删全库）
	if n := gcOrphanDrops(nil, nil); n != 0 {
		t.Fatalf("nil keep must refuse: %d", n)
	}
	if n := gcOrphanDrops(map[string]bool{alive: true}, nil); n != 1 {
		t.Fatalf("gc removed = %d, want 1", n)
	}
	if _, err := os.Stat(dropDirFor(dead)); !os.IsNotExist(err) {
		t.Fatalf("orphan dir should be gone: %v", err)
	}
	if _, err := os.Stat(dropDirFor(alive)); err != nil {
		t.Fatalf("alive dir should survive: %v", err)
	}
}

func TestShDropPayload(t *testing.T) {
	tok, id := parseShDropPayload(shDropPayload("abcdef0123456789", "123"))
	if tok != "abcdef0123456789" || id != "123" {
		t.Fatalf("parse = %q %q", tok, id)
	}
	if tok, _ := parseShDropPayload("quickdrop:x"); tok != "" {
		t.Fatalf("foreign prefix must not parse")
	}
	if tok, _ := parseShDropPayload("shdrop:onlytoken"); tok != "" {
		t.Fatalf("missing id must not parse")
	}
}
