package files

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 单文件下载端点 Content-Disposition 契约（P-20261003-109）：头值统一经
// shared.ContentDispositionFile 产出——ASCII 名与历史手拼形态逐字节兼容
//（端点切换的行为兼容断言），中文名走 RFC 5987 且不残留多字节。helper 本体
// 的全量边界用例在 shared 包 contentdisposition_test.go
func TestDownloadFileDisposition(t *testing.T) {
	r, projPath := setupFileOpsTest(t)
	g := r.Group("/api/projects/:id")
	g.GET("/file/download", DownloadFile)

	for _, tc := range []struct {
		name string
		file string
		want string
	}{
		{
			name: "ASCII 名与历史手拼输出逐字节兼容",
			file: "note.txt",
			want: `attachment; filename="note.txt"; filename*=UTF-8''note.txt`,
		},
		{
			name: "中文名走 RFC 5987 编码且兜底折叠",
			file: "报告.txt",
			want: `attachment; filename="__.txt"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := os.WriteFile(filepath.Join(projPath, tc.file), []byte("x"), 0o644); err != nil {
				t.Fatal(err)
			}
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest(http.MethodGet,
				"/api/projects/proj-test/file/download?path="+tc.file, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
			}
			got := w.Header().Get("Content-Disposition")
			if got != tc.want {
				t.Fatalf("Content-Disposition = %q, want %q", got, tc.want)
			}
			for _, rn := range got {
				if rn > 0x7f {
					t.Fatalf("non-ASCII rune leaked into header value: %q", got)
				}
			}
			if !strings.HasPrefix(got, "attachment") {
				t.Fatalf("value = %q, want attachment prefix", got)
			}
		})
	}
}
