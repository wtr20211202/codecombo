package filestore

import (
	"strings"
	"testing"

	"codecombo/server/store"
)

// TestInvalidKeyRejected 校验非法 key 在所有写/读入口被拒绝（防路径穿越）
func TestInvalidKeyRejected(t *testing.T) {
	s := New(t.TempDir()).(*fileDocStore)
	bad := []string{
		"../lock/config",         // 相对穿越（URL 解码后形态）
		"..\\..\\lock",           // Windows 反斜杠穿越
		"../../etc/passwd",       // 深层穿越
		"/abs/path",              // 绝对路径
		"C:\\win",                // Windows 盘符
		"a:b",                    // 冒号（Windows NTFS 流）
		".hidden",                // 点开头（隐藏文件/相对段）
		"a..b",                   // 连续点（.. 穿越段）
		strings.Repeat("a", 257), // 超长
		"",
	}
	// 断言错误信息含 "invalid"：区别于 ErrNotFound/ErrAlreadyExists 等业务错误，
	// 防止"无校验时恰好因文件不存在而误过"
	for _, k := range bad {
		if err := s.Create("testkind", k, []byte(`{}`)); err == nil || !strings.Contains(err.Error(), "invalid") {
			t.Errorf("Create should reject key %q with invalid error, got: %v", k, err)
		}
		if err := s.Update("testkind", k, []byte(`{}`)); err == nil || !strings.Contains(err.Error(), "invalid") {
			t.Errorf("Update should reject key %q with invalid error, got: %v", k, err)
		}
		if err := s.Delete("testkind", k); err == nil || !strings.Contains(err.Error(), "invalid") {
			t.Errorf("Delete should reject key %q with invalid error, got: %v", k, err)
		}
	}
	// 合法 key 仍可用（含现有 sc_ 前缀、uuid、projectId 形态）
	for _, k := range []string{"sc_rh_abc-123", "project-42", "A_b-c.d", strings.Repeat("a", 128)} {
		if err := s.Create("testkind", k, []byte(`{}`)); err != nil {
			t.Errorf("Create should accept key %q: %v", k, err)
		}
	}
}

// TestInvalidKindRejected 校验非法 kind 在集合级入口被拒绝
// （kind=".." 时 Clear 会 RemoveAll 数据根目录、List/Count 会越出 kind 目录列举）
func TestInvalidKindRejected(t *testing.T) {
	s := New(t.TempDir()).(*fileDocStore)
	if err := s.Clear(".."); err == nil || !strings.Contains(err.Error(), "invalid") {
		t.Errorf(`Clear should reject kind ".." with invalid error, got: %v`, err)
	}
	if _, _, err := s.List("..", store.ListOpts{}); err == nil || !strings.Contains(err.Error(), "invalid") {
		t.Errorf(`List should reject kind ".." with invalid error, got: %v`, err)
	}
	if _, err := s.Count("..", store.ListOpts{}); err == nil || !strings.Contains(err.Error(), "invalid") {
		t.Errorf(`Count should reject kind ".." with invalid error, got: %v`, err)
	}
}
