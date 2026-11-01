package remote

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"os"
	"path"
	"strings"
	"testing"

	"codecombo/server/sshclient"
)

// fakeFileClient 内存版 fileClient：目录树 → 条目表 / 文件表
type fakeFileClient struct {
	dirs  map[string][]sshclient.DirEntry
	files map[string]string
}

func (f *fakeFileClient) ListDir(p string) ([]sshclient.DirEntry, error) {
	if e, ok := f.dirs[p]; ok {
		return e, nil
	}
	return nil, &pathError{op: "list", path: p}
}

func (f *fakeFileClient) Stat(p string) (int64, bool, error) {
	if _, ok := f.dirs[p]; ok {
		return 0, true, nil
	}
	if c, ok := f.files[p]; ok {
		return int64(len(c)), false, nil
	}
	return 0, false, &pathError{op: "stat", path: p}
}

func (f *fakeFileClient) Open(p string) (io.ReadCloser, error) {
	if c, ok := f.files[p]; ok {
		return io.NopCloser(strings.NewReader(c)), nil
	}
	return nil, &pathError{op: "open", path: p}
}

func (f *fakeFileClient) Upload(io.Reader, string) error   { return nil }
func (f *fakeFileClient) Mkdir(string) error               { return nil }
func (f *fakeFileClient) MkdirAll(string) error            { return nil }
func (f *fakeFileClient) Rename(string, string) error      { return nil }
func (f *fakeFileClient) RemoveAll(string) error           { return nil }
func (f *fakeFileClient) Chmod(string, os.FileMode) error  { return nil }
func (f *fakeFileClient) Mode(string) (os.FileMode, error) { return 0, os.ErrNotExist }
func (f *fakeFileClient) Close() error                     { return nil }

type pathError struct{ op, path string }

func (e *pathError) Error() string { return e.op + " " + e.path + ": not found" }

func newFakeTree() *fakeFileClient {
	return &fakeFileClient{
		dirs: map[string][]sshclient.DirEntry{
			"/root": {
				{Name: "a.txt", Size: 5},
				{Name: "sub", IsDir: true},
				{Name: "empty", IsDir: true},
			},
			"/root/sub": {
				{Name: "b.txt", Size: 3},
				{Name: "deep", IsDir: true},
			},
			"/root/sub/deep": {
				{Name: "c.log", Size: 2},
			},
			"/root/empty": {},
		},
		files: map[string]string{
			"/root/a.txt":          "hello",
			"/root/sub/b.txt":      "abc",
			"/root/sub/deep/c.log": "ok",
		},
	}
}

func zipEntryNames(t *testing.T, buf *bytes.Buffer) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatalf("open zip: %v", err)
	}
	out := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open entry %s: %v", f.Name, err)
		}
		content, _ := io.ReadAll(rc)
		rc.Close()
		out[f.Name] = string(content)
	}
	return out
}

func TestAppendTreeZipPackagesTree(t *testing.T) {
	fc := newFakeTree()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	entries, truncated, err := appendTreeZip(context.Background(), zw, fc, "/root", "root")
	if cerr := zw.Close(); cerr != nil {
		t.Fatalf("close zip: %v", cerr)
	}
	if err != nil || truncated {
		t.Fatalf("appendTreeZip: err=%v truncated=%v", err, truncated)
	}
	if entries != 3 {
		t.Fatalf("entries = %d, want 3", entries)
	}
	got := zipEntryNames(t, &buf)
	for name, want := range map[string]string{
		"root/a.txt":          "hello",
		"root/sub/b.txt":      "abc",
		"root/sub/deep/c.log": "ok",
	} {
		if got[name] != want {
			t.Fatalf("entry %s = %q, want %q", name, got[name], want)
		}
	}
}

func TestWalkRemoteTreeDepthGuard(t *testing.T) {
	// 构造超过 zipMaxDepth 的深链目录，遍历应报深而不是栈溢出/死循环
	dirs := map[string][]sshclient.DirEntry{}
	p := "/"
	for i := 0; i < 64; i++ {
		dirs[p] = []sshclient.DirEntry{{Name: "d", IsDir: true}}
		p = path.Join(p, "d")
	}
	fc := &fakeFileClient{dirs: dirs, files: map[string]string{}}
	err := walkRemoteTree(context.Background(), fc, "/", "", 1, func(string, string, entryMeta) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "too deep") {
		t.Fatalf("want depth guard error, got %v", err)
	}
}
