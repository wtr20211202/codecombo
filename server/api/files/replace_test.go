package files

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 批量替换服务端执行 API 单测（P-20261004-114）：真实 fixture 仓库走 git 层全链，
// 覆盖任务书四点——预览（dryRun）/ 执行 / 备份 / 并发与冲突拒绝；另补敏感闸、
// maxFiles 钳制、正则双端差异与备份清账。

// newReplaceFixture 最小 git 仓库 + 已注册项目（handler 级测试路由同生产形态）
type replaceFixture struct {
	t    *testing.T
	root string
	id   string
}

func newReplaceFixture(t *testing.T) *replaceFixture {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
			"GIT_TERMINAL_PROMPT=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "core.autocrlf", "false") // 三平台行尾语义对齐（e2e 同款口径）
	run("config", "user.name", "t")
	run("config", "user.email", "t@t")

	t.Setenv("CC_DATA_DIR", t.TempDir()) // 备份落档隔离到临时数据目录
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	f := &replaceFixture{t: t, root: dir, id: "proj-replace"}
	if err := store.Get().Project.Create(config.ProjectConfig{ID: f.id, Name: "replace-demo", Path: dir}); err != nil {
		t.Fatalf("create project: %v", err)
	}
	return f
}

func (f *replaceFixture) write(name, content string) {
	f.t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(f.root, name)), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.root, name), []byte(content), 0o644); err != nil {
		f.t.Fatal(err)
	}
}

func (f *replaceFixture) read(name string) string {
	f.t.Helper()
	b, err := os.ReadFile(filepath.Join(f.root, name))
	if err != nil {
		f.t.Fatal(err)
	}
	return string(b)
}

func (f *replaceFixture) git(args ...string) {
	f.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = f.root
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_TERMINAL_PROMPT=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		f.t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

// gitStdin 带标准输入的 git 调用（git apply - 回滚组合用）
func (f *replaceFixture) gitStdin(args []string, input string) {
	f.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = f.root
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_TERMINAL_PROMPT=0")
	cmd.Stdin = strings.NewReader(input)
	if out, err := cmd.CombinedOutput(); err != nil {
		f.t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

// commitAll 基线提交（git grep 的可搜索前提）
func (f *replaceFixture) commitAll(msg string) {
	f.git("add", "-A")
	f.git("commit", "-m", msg)
}

// engine 生产形态路由（不含中间件——硬锁/审批守卫由各自对账测试覆盖）
func (f *replaceFixture) engine() *gin.Engine {
	f.t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	g := r.Group("/api/projects/:id")
	{
		g.POST("/replace/preview", PreviewReplace)
		g.POST("/replace", ReplaceInProject)
		g.GET("/replace/backups", ListReplaceBackups)
		g.GET("/replace/history", ReplaceHistoryList)
		g.POST("/replace/history/:hid/restore", RestoreReplaceHistory)
	}
	return r
}

func (f *replaceFixture) do(r *gin.Engine, method, path string, body any) *httptest.ResponseRecorder {
	f.t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		f.t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// decodeData 统一 {"data": ...} 信封解码（泛型：列表/文本/对象各取所需）
func decodeData[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var envelope struct {
		Data T `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode: %v body=%s", err, w.Body.String())
	}
	return envelope.Data
}

// decodeResp 对象形态信封（preview / execute 响应）
func decodeResp(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	return decodeData[map[string]any](t, w)
}

func TestBuildReplaceRegexp(t *testing.T) {
	// 字面量缺省：大小写不敏感、点号是字面量而非通配（QuoteMeta）
	re, err := buildReplaceRegexp(replaceOptions{Pattern: "a.b"})
	if err != nil {
		t.Fatalf("literal compile: %v", err)
	}
	if !re.MatchString("x A.B y") {
		t.Fatal("literal should match case-insensitively")
	}
	if re.MatchString("axb") {
		t.Fatal("literal dot must not act as wildcard")
	}
	// 大小写敏感档
	re, _ = buildReplaceRegexp(replaceOptions{Pattern: "abc", CaseSensitive: true})
	if re.MatchString("xABCx") {
		t.Fatal("caseSensitive not honored")
	}
	// 整词档（正则模式）：顶层择一并列也必须两侧都带边界（非捕获组收口，前端
	// 裸 \bfoo|bar\b 会错切第二支的左边界，服务端按正确语义收口）
	re, _ = buildReplaceRegexp(replaceOptions{Pattern: "foo|bar", WholeWord: true, UseRegex: true})
	if !re.MatchString("a foo b") || !re.MatchString("a bar b") {
		t.Fatal("wholeWord alternation boundaries broken")
	}
	if re.MatchString("a foobar b") || re.MatchString("a foo2 b") {
		t.Fatal("wholeWord should reject subword hits")
	}
	// RE2 不支持的 JS 语法：编译失败上抛（双端差异「以服务端为准」）
	if _, err := buildReplaceRegexp(replaceOptions{Pattern: "(?=x)abc", UseRegex: true}); err == nil {
		t.Fatal("lookahead should fail to compile in RE2")
	}
}

func TestReplacePreviewShapeAndNoWrite(t *testing.T) {
	f := newReplaceFixture(t)
	f.write("a.txt", "alpha one\nalpha two\nplain\n")
	f.write("b.txt", "alpha three\n")
	f.write("c.txt", "no hit here\n")
	f.commitAll("base")

	r := f.engine()
	w := f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace/preview",
		replaceOptions{Pattern: "alpha", Replacement: "beta"})

	data := decodeResp(t, w)
	totalFiles := int(data["totalFiles"].(float64))
	totalHits := int(data["totalHits"].(float64))
	if totalFiles != 2 || totalHits != 3 {
		t.Fatalf("preview totals = %d files / %d hits, want 2/3", totalFiles, totalHits)
	}
	files := data["files"].([]any)
	// rg 并行遍历不保证文件序：按路径查找断言，不假设命中顺序
	byPath := map[string]map[string]any{}
	for _, fi := range files {
		m := fi.(map[string]any)
		byPath[m["path"].(string)] = m
	}
	first, ok := byPath["a.txt"]
	if !ok {
		t.Fatalf("a.txt missing from preview: %v", byPath)
	}
	rows := first["rows"].([]any)
	if len(rows) != 2 {
		t.Fatalf("a.txt rows = %d, want 2", len(rows))
	}
	row := rows[0].(map[string]any)
	if row["before"] != "alpha one" || row["after"] != "beta one" {
		t.Fatalf("row = %v/%v, want alpha one/beta one", row["before"], row["after"])
	}
	// 纯读不写：磁盘内容零变化
	if f.read("a.txt") != "alpha one\nalpha two\nplain\n" {
		t.Fatal("preview must not write")
	}
}

func TestReplaceExecuteWithBackup(t *testing.T) {
	t.Run("clean worktree: backup empty 占位且替换落盘", func(t *testing.T) {
		f := newReplaceFixture(t)
		f.write("a.txt", "old name here\n")
		f.commitAll("base")

		r := f.engine()
		w := f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace",
			replaceOptions{Pattern: "old name", Replacement: "new name"})
		data := decodeResp(t, w)

		if f.read("a.txt") != "new name here\n" {
			t.Fatalf("content = %q, want replaced", f.read("a.txt"))
		}
		backup := data["backup"].(map[string]any)
		if backup["empty"] != true {
			t.Fatalf("clean worktree backup should be empty-flagged: %v", backup)
		}
		// 备份可查：清单 + 内容取回
		wl := f.do(r, http.MethodGet, "/api/projects/"+f.id+"/replace/backups", nil)
		list := decodeData[[]map[string]any](t, wl)
		if len(list) != 1 || list[0]["name"] != backup["name"] {
			t.Fatalf("backup list = %v, want single %v", list, backup["name"])
		}
		wc := f.do(r, http.MethodGet, "/api/projects/"+f.id+"/replace/backups?name="+backup["name"].(string), nil)
		if got := decodeData[string](t, wc); strings.Contains(got, "old name") {
			t.Fatalf("clean-worktree backup should be empty diff, got %q", got)
		}
		// 非法备份名：路径穿越拒绝
		wb := f.do(r, http.MethodGet, "/api/projects/"+f.id+"/replace/backups?name=..%2Fx.patch", nil)
		if wb.Code != http.StatusForbidden {
			t.Fatalf("invalid backup name → %d, want 403", wb.Code)
		}
	})

	t.Run("dirty worktree: 备份 patch 携替换前内容可回滚", func(t *testing.T) {
		f := newReplaceFixture(t)
		f.write("a.txt", "base line\n")
		f.commitAll("base")
		f.write("a.txt", "base line\nuncommitted edit\n") // 替换前未提交改动

		r := f.engine()
		w := f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace",
			replaceOptions{Pattern: "base", Replacement: "replaced"})
		data := decodeResp(t, w)

		backup := data["backup"].(map[string]any)
		if backup["empty"] == true {
			t.Fatal("dirty worktree backup must be non-empty")
		}
		wc := f.do(r, http.MethodGet, "/api/projects/"+f.id+"/replace/backups?name="+backup["name"].(string), nil)
		patch := decodeData[string](t, wc)
		if !strings.Contains(patch, "+uncommitted edit") {
			t.Fatalf("backup patch should carry pre-replace worktree content, got:\n%s", patch)
		}
		// 回滚组合真跑：checkout 丢弃替换后改动 → apply 备份 patch → 替换前状态还原
		f.git("checkout", "--", "a.txt")
		f.gitStdin([]string{"apply", "--allow-empty", "-"}, patch)
		if f.read("a.txt") != "base line\nuncommitted edit\n" {
			t.Fatalf("rollback restored = %q", f.read("a.txt"))
		}
	})

	t.Run("skipped/conflicts 形态", func(t *testing.T) {
		f := newReplaceFixture(t)
		f.write("hit.txt", "tick tock\n")
		f.write("miss.txt", "nothing\n")
		f.commitAll("base")

		r := f.engine()
		w := f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace",
			replaceOptions{Pattern: "tick", Replacement: "tock"})
		data := decodeResp(t, w)
		changed := data["changed"].([]any)
		if len(changed) != 1 || changed[0].(map[string]any)["path"] != "hit.txt" {
			t.Fatalf("changed = %v, want hit.txt only", changed)
		}
		// miss.txt 对 grep 无命中，根本不进命中集（无匹配跳过档是「grep 命中但
		// 解码后失配」的编码边界，此处断言 absent）
		if _, present := data["skipped"]; present {
			t.Fatalf("skipped should be absent, got %v", data["skipped"])
		}
		// 无命中执行是 200 空结果（幂等空替，不落备份不报错）
		w2 := f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace",
			replaceOptions{Pattern: "tick", Replacement: "tock"})
		data2 := decodeResp(t, w2)
		if changed2 := data2["changed"].([]any); len(changed2) != 0 {
			t.Fatalf("repeat execute should be empty, got %v", changed2)
		}
		if _, present := data2["backup"]; present {
			t.Fatal("empty execution must not create a backup")
		}
	})
}

func TestReplaceSensitiveGate(t *testing.T) {
	f := newReplaceFixture(t)
	f.write(".env", "API_HOST=alpha\n")
	f.write("app.go", "host alpha\n")
	f.commitAll("base")

	r := f.engine()
	// 未确认：409 稳定码 + 清单，不写盘不落备份
	w := f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace",
		replaceOptions{Pattern: "alpha", Replacement: "beta"})
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", w.Code)
	}
	var body struct {
		Code          string   `json:"code"`
		SensitiveHits []string `json:"sensitiveHits"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Code != "files.sensitive_confirm_required" {
		t.Fatalf("code = %q", body.Code)
	}
	if len(body.SensitiveHits) != 1 || body.SensitiveHits[0] != ".env" {
		t.Fatalf("sensitiveHits = %v, want [.env]", body.SensitiveHits)
	}
	if f.read(".env") != "API_HOST=alpha\n" || f.read("app.go") != "host alpha\n" {
		t.Fatal("gated request must not write anything")
	}
	// 409 不产生备份（副作用闸在备份之前）：备份目录无任何文件
	if ents, err := os.ReadDir(replaceBackupsProjectDir(f.id)); err == nil && len(ents) != 0 {
		t.Fatalf("gated request must not create backups, got %d entries", len(ents))
	}
	// 预览同样回告 sensitiveHits（执行前观测点）
	wp := f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace/preview",
		replaceOptions{Pattern: "alpha", Replacement: "beta"})
	pv := decodeResp(t, wp)
	hits := pv["sensitiveHits"].([]any)
	if len(hits) != 1 || hits[0] != ".env" {
		t.Fatalf("preview sensitiveHits = %v", hits)
	}
	// 确认后放行：两文件都替换
	w2 := f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace",
		replaceOptions{Pattern: "alpha", Replacement: "beta", ConfirmSensitive: true})
	if w2.Code != http.StatusOK {
		t.Fatalf("confirmed execute = %d, want 200", w2.Code)
	}
	if f.read(".env") != "API_HOST=beta\n" {
		t.Fatalf(".env = %q", f.read(".env"))
	}
}

func TestReplaceMaxFilesClamp(t *testing.T) {
	f := newReplaceFixture(t)
	for _, n := range []string{"f1", "f2", "f3"} {
		f.write(n+".txt", "token "+n+"\n")
	}
	f.commitAll("base")

	r := f.engine()
	// 预览端同钳制（在 execute 前跑——execute 之后命中集会缩小）
	wp := f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace/preview",
		replaceOptions{Pattern: "token", Replacement: "TK", MaxFiles: 1})
	pv := decodeResp(t, wp)
	if int(pv["totalFiles"].(float64)) != 1 || pv["truncated"] != true {
		t.Fatalf("preview clamp = %v", pv)
	}

	w := f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace",
		replaceOptions{Pattern: "token", Replacement: "TK", MaxFiles: 2})
	data := decodeResp(t, w)
	if data["truncated"] != true {
		t.Fatal("truncated should be reported when clamped")
	}
	// rg 并行遍历不保证文件序：只断言钳制数量与「恰好一个文件未被触碰」
	changed := data["changed"].([]any)
	if len(changed) != 2 {
		t.Fatalf("changed = %d, want 2 (clamped)", len(changed))
	}
	untouched := 0
	for _, n := range []string{"f1", "f2", "f3"} {
		if strings.Contains(f.read(n+".txt"), "token") {
			untouched++
		}
	}
	if untouched != 1 {
		t.Fatalf("untouched files = %d, want 1 (clamp boundary)", untouched)
	}
}

// TestReplaceExternalWriteNeverClobbered 执行链以磁盘现状为基：preview 之后
// 文件被外部追加，执行不得基于陈旧预览内容写回（读改写以 fresh 读为基，
// BaseHash 重检拒绝窗口内再写入的并发档见 replaceOneFile 注记）
func TestReplaceExternalWriteNeverClobbered(t *testing.T) {
	f := newReplaceFixture(t)
	f.write("a.txt", "keep alpha\n")
	f.commitAll("base")

	r := f.engine()
	f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace/preview",
		replaceOptions{Pattern: "alpha", Replacement: "beta"})
	// preview 与 execute 之间外部追加一行
	f.write("a.txt", "keep alpha\nadded after preview\n")

	w := f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace",
		replaceOptions{Pattern: "alpha", Replacement: "beta"})
	decodeResp(t, w)
	if got := f.read("a.txt"); got != "keep beta\nadded after preview\n" {
		t.Fatalf("content = %q, external edit must survive", got)
	}
}

// TestReplaceConcurrentSerialized 并发替换互斥（任务书「并发拒绝」的写锁档，
// -race 门禁下跑）：两请求并行，写锁串行后先到者完成替换、后到者命中集已空
// 仍 200（幂等空替），终态为单一连贯结果、无交错半写
func TestReplaceConcurrentSerialized(t *testing.T) {
	f := newReplaceFixture(t)
	f.write("a.txt", "tok one\n")
	f.write("b.txt", "tok two\n")
	f.commitAll("base")

	r := f.engine()
	var wg sync.WaitGroup
	codes := make([]int, 2)
	// 替换词不含模式词（tok→XYZ-*）：串行后先到者完成、后到者命中集已空
	for i, opt := range []replaceOptions{
		{Pattern: "tok", Replacement: "XYZ-A"},
		{Pattern: "tok", Replacement: "XYZ-B"},
	} {
		wg.Add(1)
		go func(idx int, o replaceOptions) {
			defer wg.Done()
			codes[idx] = f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace", o).Code
		}(i, opt)
	}
	wg.Wait()
	for i, c := range codes {
		if c != http.StatusOK {
			t.Fatalf("request %d = %d, want 200 (serialized, both succeed)", i, c)
		}
	}
	// 同一胜者的结果整体落盘：a/b 两文件携同一替换词，不出现交错混合
	a, b := f.read("a.txt"), f.read("b.txt")
	winner := "XYZ-A"
	if a == "XYZ-B one\n" {
		winner = "XYZ-B"
	}
	if a != winner+" one\n" || b != winner+" two\n" {
		t.Fatalf("incoherent final state: a=%q b=%q", a, b)
	}
}

// TestReplaceBaseHashRecheck 写前重检的冲突分支：以 helper 直接验证（链内
// 读改写窗口的注入点在重检与 rename 之间，直接断言比对语义）
func TestReplaceBaseHashRecheck(t *testing.T) {
	f := newReplaceFixture(t)
	f.write("a.txt", "stable\n")
	abs := filepath.Join(f.root, "a.txt")
	cur, _ := os.ReadFile(abs)
	base := contentHash(cur)
	if baseChangedSince(abs, base) {
		t.Fatal("unchanged file must not report conflict")
	}
	if err := os.WriteFile(abs, []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !baseChangedSince(abs, base) {
		t.Fatal("externally changed file must report conflict")
	}
}

func TestReplaceValidationErrors(t *testing.T) {
	f := newReplaceFixture(t)
	r := f.engine()

	// pattern 缺失 → 400 payload_invalid
	w := f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace", replaceOptions{})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing pattern = %d, want 400", w.Code)
	}
	// RE2 编译失败 → 400 + 双端差异提示（「以服务端为准」）
	w = f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace/preview",
		replaceOptions{Pattern: "a(?=b)", UseRegex: true})
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "RE2") {
		t.Fatalf("regex divergence = %d %s", w.Code, w.Body.String())
	}
}

func TestReplaceBackupPurge(t *testing.T) {
	f := newReplaceFixture(t)
	dir := replaceBackupsProjectDir(f.id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(dir, "20200101-000000-aa.patch")
	fresh := filepath.Join(dir, time.Now().Format("20060102-150405")+"-bb.patch")
	for _, p := range []string{old, fresh} {
		if err := os.WriteFile(p, []byte("patch"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-replaceBackupRetention - time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}
	PurgeExpiredReplaceBackups()
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatalf("expired backup should be purged, err=%v", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("fresh backup should survive, err=%v", err)
	}

	// 条数上限：61 份新鲜备份 → 裁到 50，最旧先走
	for i := 0; i < 60; i++ {
		p := filepath.Join(dir, time.Now().Add(time.Duration(i)*time.Second).Format("20060102-150405")+string(rune('a'+i%26))+".patch")
		if err := os.WriteFile(p, []byte("p"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, time.Now().Add(time.Duration(i)*time.Second), time.Now().Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	PurgeExpiredReplaceBackups()
	ents, _ := os.ReadDir(dir)
	if len(ents) != replaceBackupMaxPerProject {
		t.Fatalf("backups after purge = %d, want %d", len(ents), replaceBackupMaxPerProject)
	}
}

// TestApplyPreservedCase 形态跟随推断三形态（P-20261006-16）：与前端
// applyPreservedCase 同语义双实现，三形态断言两侧同镜像（e2e 守跨端对账）
func TestApplyPreservedCase(t *testing.T) {
	cases := []struct {
		replacement, matched, want string
	}{
		{"fetchUser", "getuser", "fetchUser"},    // 全小写 → 原样
		{"fetch_user", "get_user", "fetch_user"}, // 含下划线同前
		{"fetchUser", "GETUSER", "FETCHUSER"},    // 全大写 → 大写化
		{"fetchUser", "Getuser", "FetchUser"},    // Title → 首字母大写化
		{"fetch_user", "Get_user", "Fetch_user"},
		{"fetchUser", "geTuser", "fetchUser"}, // 混合不猜——原样
		{"fetchUser", "getUser", "fetchUser"}, // 驼峰混合不猜
		{"fetch", "123", "fetch"},             // 无大小写字符按全小写
		{"fetch", "", "fetch"},                // 空命中（零宽）原样
	}
	for _, c := range cases {
		if got := applyPreservedCase(c.replacement, c.matched); got != c.want {
			t.Fatalf("applyPreservedCase(%q, %q) = %q, want %q", c.replacement, c.matched, got, c.want)
		}
	}
}

// TestReplacePreserveCase 保留大小写端到端（同请求参数预览 after = 执行写盘，
// replaceWithShape 单点供给零漂移）；缺省 false 走字面量替换零变化
func TestReplacePreserveCase(t *testing.T) {
	f := newReplaceFixture(t)
	content := "getuser GETUSER Getuser geTuser\n"
	f.write("a.txt", content)
	f.commitAll("base")

	r := f.engine()
	// 预览：after 逐命中形态跟随
	w := f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace/preview",
		replaceOptions{Pattern: "getuser", Replacement: "fetchUser", PreserveCase: true})
	data := decodeResp(t, w)
	rows := data["files"].([]any)[0].(map[string]any)["rows"].([]any)
	if got := rows[0].(map[string]any)["after"]; got != "fetchUser FETCHUSER FetchUser fetchUser" {
		t.Fatalf("preview after = %v", got)
	}
	// 纯读不写
	if f.read("a.txt") != content {
		t.Fatal("preview must not write")
	}

	// 执行：磁盘写回与预览同形态
	w = f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace",
		replaceOptions{Pattern: "getuser", Replacement: "fetchUser", PreserveCase: true})
	decodeResp(t, w)
	if got, want := f.read("a.txt"), "fetchUser FETCHUSER FetchUser fetchUser\n"; got != want {
		t.Fatalf("executed content = %q, want %q", got, want)
	}

	// 缺省（false）：同 pattern 全部字面量替换——旧行为零变化
	f.write("b.txt", content)
	f.commitAll("reset")
	w = f.do(r, http.MethodPost, "/api/projects/"+f.id+"/replace",
		replaceOptions{Pattern: "getuser", Replacement: "fetchUser"})
	decodeResp(t, w)
	if got, want := f.read("b.txt"), "fetchUser fetchUser fetchUser fetchUser\n"; got != want {
		t.Fatalf("default literal content = %q, want %q", got, want)
	}
}
