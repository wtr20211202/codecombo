package quickdrop

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/share"
)

// 主人侧接收面（P-20261117-3）纪律锁：下载端点 fid 取件键（同批同名双文件
// 消歧 + attachment/octet-stream 附件红线 + 归属链强校验/缺链旧文件放行）、
// 清单投影 sidecar 单一事实源（store 五字段不扩）、摘除联动即时回收配额
// （残留由 TTL GC 兜底的语义不在此重复验证——gcQuickdropFiles 套件已钉）。

// qdDiskState 目录内（本体，sidecar）两组文件名——落盘残留断言用
func qdDiskState(t *testing.T, token string) (bodies, sidecars []string) {
	t.Helper()
	entries, err := os.ReadDir(qdTokenDir(t, token))
	if err != nil {
		return nil, nil
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), share.DropSidecarSuffix) {
			sidecars = append(sidecars, e.Name())
		} else {
			bodies = append(bodies, e.Name())
		}
	}
	return bodies, sidecars
}

// qdDownload 发一次下载请求（带锁外裸请求形态——handler 在鉴权组内的事实
// 由路由装配保证，本套件直接打 handler 面）
func qdDownload(t *testing.T, r http.Handler, id, fid string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	path := "/api/quickdrop/dropfile/" + id
	if fid != "" {
		path += "?fid=" + fid
	}
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestDownloadDropFileFidDisambiguates(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	// 同批同名双文件：落盘名靠 id 前缀天然唯一，取件靠 fid 消歧（评审必改②）
	bodyA := []byte("report A first-run output")
	bodyB := []byte("report B second-run output")
	code, out := postFiles(t, r, "/drop/"+token, "同名双文件", []mpFile{
		{name: "report.txt", data: bodyA},
		{name: "report.txt", data: bodyB},
	})
	if code != http.StatusOK {
		t.Fatalf("status = %d: %v", code, out)
	}
	docID, _ := out["data"].(map[string]any)["id"].(string)
	if docID == "" {
		t.Fatalf("missing doc id: %v", out)
	}
	added, _ := out["added"].([]any)
	if len(added) != 2 {
		t.Fatalf("added len = %d", len(added))
	}
	fidA, _ := added[0].(map[string]any)["id"].(string)
	fidB, _ := added[1].(map[string]any)["id"].(string)
	if fidA == "" || fidB == "" || fidA == fidB {
		t.Fatalf("fids must be distinct non-empty: %q vs %q", fidA, fidB)
	}

	// 逐 fid 取回字节等值——同名不歧义
	for i, tc := range []struct {
		fid  string
		want []byte
	}{{fidA, bodyA}, {fidB, bodyB}} {
		w := qdDownload(t, r, docID, tc.fid, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("download[%d] status = %d: %s", i, w.Code, w.Body.String())
		}
		if w.Body.String() != string(tc.want) {
			t.Fatalf("download[%d] bytes mismatch: %q", i, w.Body.String())
		}
		// 附件红线：octet-stream + attachment（上传素材永不内联渲染）
		if ct := w.Header().Get("Content-Type"); ct != "application/octet-stream" {
			t.Fatalf("download[%d] content-type = %q, want octet-stream", i, ct)
		}
		cd := w.Header().Get("Content-Disposition")
		if !strings.HasPrefix(cd, "attachment") || !strings.Contains(cd, "report.txt") {
			t.Fatalf("download[%d] content-disposition = %q", i, cd)
		}
	}

	// Range 断点（ServeContent 自带——下载直链的原生进度基础）
	w := qdDownload(t, r, docID, fidA, map[string]string{"Range": "bytes=0-4"})
	if w.Code != http.StatusPartialContent || w.Body.String() != string(bodyA[:5]) {
		t.Fatalf("range: code=%d body=%q", w.Code, w.Body.String())
	}

	// 未知 fid / 缺 fid / 未知条目：404 / 400 / 404
	if w := qdDownload(t, r, docID, "999999", nil); w.Code != http.StatusNotFound {
		t.Fatalf("unknown fid status = %d", w.Code)
	}
	if w := qdDownload(t, r, docID, "", nil); w.Code != http.StatusBadRequest {
		t.Fatalf("missing fid status = %d", w.Code)
	}
	if w := qdDownload(t, r, "sc_qd_unknown", fidA, nil); w.Code != http.StatusNotFound {
		t.Fatalf("unknown doc status = %d", w.Code)
	}
}

// 归属链强校验：批次链（dropId）在场时，拿条目 A 的链接取条目 B 的文件
// 不允许（跨条目 fid 不伺服）
func TestDownloadDropFileDropIDOwnership(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	_, outA := mustUpload(t, r, token, "batch A")
	_, outB := mustUpload(t, r, token, "batch B")
	docA := outA["data"].(map[string]any)["id"].(string)
	fidB := outB["added"].([]any)[0].(map[string]any)["id"].(string)

	if w := qdDownload(t, r, docA, fidB, nil); w.Code != http.StatusNotFound {
		t.Fatalf("cross-doc fid status = %d, want 404", w.Code)
	}
}

// 缺链旧文件（升级窗口 ≤24h 的存量 sidecar 无 dropId）：清单投影不显示、
// 下载按 fid 等值自证放行——升级兼容「旧数据面 + 新二进制」形态
func TestLegacySidecarWithoutDropID(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	_, out := mustUpload(t, r, token, "legacy batch")
	docID := out["data"].(map[string]any)["id"].(string)
	fid := out["added"].([]any)[0].(map[string]any)["id"].(string)
	want, _ := out["added"].([]any)[0].(map[string]any)["size"].(float64)

	// 手工抹掉 sidecar 的 dropId（模拟升级前落盘的旧 sidecar）
	bodies, _ := qdDiskState(t, token)
	if len(bodies) != 1 {
		t.Fatalf("disk bodies = %v", bodies)
	}
	scPath := filepath.Join(qdTokenDir(t, token), bodies[0]+share.DropSidecarSuffix)
	raw, err := os.ReadFile(scPath)
	if err != nil {
		t.Fatalf("read sidecar: %v", err)
	}
	var sc map[string]any
	if json.Unmarshal(raw, &sc) != nil {
		t.Fatalf("sidecar not json: %s", raw)
	}
	if _, had := sc["dropId"]; !had {
		t.Fatalf("sidecar missing dropId after upload — backfill broken: %s", raw)
	}
	delete(sc, "dropId")
	fixed, _ := json.Marshal(sc)
	if err := os.WriteFile(scPath, fixed, 0o600); err != nil {
		t.Fatalf("rewrite sidecar: %v", err)
	}

	// 清单投影不显示缺链文件
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/quickdrop", nil)
	r.ServeHTTP(w, req)
	var list struct {
		Data []struct {
			ID    string            `json:"id"`
			Files []json.RawMessage `json:"files"`
		} `json:"data"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &list)
	for _, item := range list.Data {
		if item.ID == docID && len(item.Files) != 0 {
			t.Fatalf("legacy sidecar must not project into files: %s", item.Files)
		}
	}
	// 下载按 fid 自证放行（字节等值）
	dw := qdDownload(t, r, docID, fid, nil)
	if dw.Code != http.StatusOK || dw.Body.Len() != int(want) {
		t.Fatalf("legacy download: code=%d len=%d want=%v", dw.Code, dw.Body.Len(), want)
	}
}

// 清单投影：文件投递条目带逐文件清单（含 absPath 主人侧投影），文本投递
// files 为空数组；凭据轮换（隔离区清盘）后在册条目投影清零
func TestListDropsFilesProjection(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	_, out := mustUpload(t, r, token, "投影锚文本")
	docID := out["data"].(map[string]any)["id"].(string)

	// 纯文本投递（文本通道）：files 空数组
	if code, _ := doJSON(r, http.MethodPost, "/api/quickdrop",
		`{"token":"`+token+`","content":"plain text drop"}`); code != http.StatusOK {
		t.Fatal("text drop failed")
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/quickdrop", nil)
	r.ServeHTTP(w, req)
	var list struct {
		Data []struct {
			ID      string `json:"id"`
			Content string `json:"content"`
			Files   []struct {
				ID      string `json:"id"`
				Name    string `json:"name"`
				Size    int64  `json:"size"`
				Kind    string `json:"kind"`
				AbsPath string `json:"absPath"`
			} `json:"files"`
		} `json:"data"`
	}
	if json.Unmarshal(w.Body.Bytes(), &list) != nil {
		t.Fatalf("list not json: %s", w.Body.String())
	}
	if len(list.Data) != 2 {
		t.Fatalf("list len = %d", len(list.Data))
	}
	var fileDoc, textDoc *struct {
		ID      string `json:"id"`
		Content string `json:"content"`
		Files   []struct {
			ID      string `json:"id"`
			Name    string `json:"name"`
			Size    int64  `json:"size"`
			Kind    string `json:"kind"`
			AbsPath string `json:"absPath"`
		} `json:"files"`
	}
	for i := range list.Data {
		if list.Data[i].ID == docID {
			fileDoc = &list.Data[i]
		} else {
			textDoc = &list.Data[i]
		}
	}
	if fileDoc == nil || textDoc == nil {
		t.Fatalf("docs missing: %+v", list.Data)
	}
	if len(fileDoc.Files) != 1 {
		t.Fatalf("file doc files = %d", len(fileDoc.Files))
	}
	f := fileDoc.Files[0]
	if f.Name != "shot.png" || f.Kind != "image" || f.Size <= 0 {
		t.Fatalf("file projection wrong: %+v", f)
	}
	// absPath 主人侧投影 = 隔离区内本体的绝对路径
	wantPrefix := qdTokenDir(t, token) + string(filepath.Separator)
	if !strings.HasPrefix(f.AbsPath, wantPrefix) || !strings.HasSuffix(f.AbsPath, "_shot.png") {
		t.Fatalf("absPath wrong: %q (want prefix %q)", f.AbsPath, wantPrefix)
	}
	if _, err := os.Stat(f.AbsPath); err != nil {
		t.Fatalf("absPath not a real file: %v", err)
	}
	if len(textDoc.Files) != 0 {
		t.Fatalf("text doc files = %d, want empty", len(textDoc.Files))
	}

	// 轮换凭据（隔离区显式清盘）：在册条目保留、投影清零
	if code, _ := doJSON(r, http.MethodPost, "/api/quickdrop/token", ""); code != http.StatusOK {
		t.Fatal("rotate failed")
	}
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, httptest.NewRequest(http.MethodGet, "/api/quickdrop", nil))
	_ = json.Unmarshal(w2.Body.Bytes(), &list)
	for _, item := range list.Data {
		if item.ID == docID && len(item.Files) != 0 {
			t.Fatalf("files must be empty after purge: %+v", item.Files)
		}
	}
}

// 摘除联动（P-20261117-3④）：DELETE 后本条目落盘文件+sidecar 即时清账
// （配额回收的落盘真相），其余批次不受涉；未知 id 幂等成功
func TestDeleteDropReclaimsFiles(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	_, outA := mustUpload(t, r, token, "batch A")
	_, outB := mustUpload(t, r, token, "batch B")
	docA := outA["data"].(map[string]any)["id"].(string)
	docB := outB["data"].(map[string]any)["id"].(string)

	bodies, sidecars := qdDiskState(t, token)
	if len(bodies) != 2 || len(sidecars) != 2 {
		t.Fatalf("pre-delete disk: bodies=%v sidecars=%v", bodies, sidecars)
	}

	if code, _ := doJSON(r, http.MethodDelete, "/api/quickdrop/"+docA, ""); code != http.StatusOK {
		t.Fatal("delete A failed")
	}
	bodies, sidecars = qdDiskState(t, token)
	if len(bodies) != 1 || len(sidecars) != 1 {
		t.Fatalf("post-delete-A disk: bodies=%v sidecars=%v (batch B must survive)", bodies, sidecars)
	}
	if code, _ := doJSON(r, http.MethodDelete, "/api/quickdrop/"+docB, ""); code != http.StatusOK {
		t.Fatal("delete B failed")
	}
	bodies, sidecars = qdDiskState(t, token)
	if len(bodies) != 0 || len(sidecars) != 0 {
		t.Fatalf("post-delete-B disk not clean: bodies=%v sidecars=%v", bodies, sidecars)
	}
	// 未知 id 幂等（dismiss 语义不因联动面改变）
	if code, _ := doJSON(r, http.MethodDelete, "/api/quickdrop/sc_qd_none", ""); code != http.StatusOK {
		t.Fatal("idempotent delete failed")
	}
	// 摘除后条目与文件双亡：下载 404
	if w := qdDownload(t, r, docA, "123", nil); w.Code != http.StatusNotFound {
		t.Fatalf("download after delete = %d, want 404", w.Code)
	}
}

// mustUpload 发一图一文的标准批次并断言 200（多测共用）
func mustUpload(t *testing.T, r http.Handler, token, content string) (int, map[string]any) {
	t.Helper()
	code, out := postFiles(t, r, "/drop/"+token, content, []mpFile{
		{name: "shot.png", data: []byte("\x89PNG-fake")},
	})
	if code != http.StatusOK {
		t.Fatalf("upload status = %d: %v", code, out)
	}
	return code, out
}
