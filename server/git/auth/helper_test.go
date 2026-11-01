package auth

import (
	"bytes"
	"strings"
	"testing"
)

// TestParseHelperInputBasic 验证正常 KV 解析
func TestParseHelperInputBasic(t *testing.T) {
	input := "protocol=https\nhost=github.com\n\n"
	kv, err := parseHelperInput(strings.NewReader(input))
	if err != nil {
		t.Fatalf("parseHelperInput: %v", err)
	}
	if kv["protocol"] != "https" {
		t.Errorf("protocol = %q", kv["protocol"])
	}
	if kv["host"] != "github.com" {
		t.Errorf("host = %q", kv["host"])
	}
}

// TestParseHelperInputRejectsNewline 验证值中含换行符被拒绝
// 注意：bufio.Scanner 默认按行分割，多行内容会被当作独立行
// 第二行 "hub.com" 无 '='，会被忽略；但如果第一行末尾带 \r 也应拒绝
func TestParseHelperInputRejectsNewline(t *testing.T) {
	// \r 字节应被拒绝（防止 CRLF 注入）
	input := "protocol=https\nhost=git\rhub.com\n\n"
	_, err := parseHelperInput(strings.NewReader(input))
	if err == nil {
		t.Error("expected error for value with embedded CR")
	}
}

// TestParseHelperInputRejectsNUL 验证值中含 NUL 字节被拒绝
func TestParseHelperInputRejectsNUL(t *testing.T) {
	input := "protocol=https\nhost=git\x00hub.com\n\n"
	_, err := parseHelperInput(strings.NewReader(input))
	if err == nil {
		t.Error("expected error for value with NUL")
	}
}

// TestParseHelperInputMaxSize 验证单行 > 8KB 被拒绝
func TestParseHelperInputMaxSize(t *testing.T) {
	var sb strings.Builder
	sb.WriteString("host=")
	for i := 0; i < 9000; i++ {
		sb.WriteByte('a')
	}
	sb.WriteString("\n\n")
	_, err := parseHelperInput(strings.NewReader(sb.String()))
	if err == nil {
		t.Error("expected error for line > 8KB")
	}
}

// TestParseHelperInputRejectsBadFieldName 验证非法字段名被跳过（不报错）
func TestParseHelperInputRejectsBadFieldName(t *testing.T) {
	input := "123bad=value\n\n"
	kv, err := parseHelperInput(strings.NewReader(input))
	if err != nil {
		t.Fatalf("parseHelperInput should ignore bad field, not error: %v", err)
	}
	if _, exists := kv["123bad"]; exists {
		t.Error("bad field name should be ignored")
	}
}

// TestParseHelperInputEmptyTermination 验证空行后字段被忽略
func TestParseHelperInputEmptyTermination(t *testing.T) {
	input := "protocol=https\nhost=x.com\n\npassword=ignored\n\n"
	kv, err := parseHelperInput(strings.NewReader(input))
	if err != nil {
		t.Fatalf("parseHelperInput: %v", err)
	}
	if _, exists := kv["password"]; exists {
		t.Error("fields after empty line should be ignored")
	}
}

// TestRunCredentialHelperGetEmpty 验证无 op 参数时退出 0
func TestRunCredentialHelperGetEmpty(t *testing.T) {
	stdin := &bytes.Buffer{}
	stdout := &bytes.Buffer{}
	code := RunCredentialHelper([]string{}, stdin, stdout)
	if code != 0 {
		t.Errorf("exit code = %d, want 0", code)
	}
}

// TestRunCredentialHelperStoreEraseNoop 验证 store/erase 在 P0 阶段为 no-op
func TestRunCredentialHelperStoreEraseNoop(t *testing.T) {
	tests := []string{"store", "erase"}
	for _, op := range tests {
		t.Run(op, func(t *testing.T) {
			stdin := bytes.NewBufferString("protocol=https\nhost=github.com\n\n")
			stdout := &bytes.Buffer{}
			code := RunCredentialHelper([]string{op}, stdin, stdout)
			if code != 0 {
				t.Errorf("%s exit = %d, want 0", op, code)
			}
			if stdout.Len() != 0 {
				t.Errorf("%s should output nothing, got %q", op, stdout.String())
			}
		})
	}
}

// TestRunCredentialHelperUnknownOp 验证未知 op 返回 0（让 git 走下一个 helper）
func TestRunCredentialHelperUnknownOp(t *testing.T) {
	stdin := bytes.NewBufferString("protocol=https\nhost=github.com\n\n")
	stdout := &bytes.Buffer{}
	code := RunCredentialHelper([]string{"unknown"}, stdin, stdout)
	if code != 0 {
		t.Errorf("unknown op exit = %d, want 0", code)
	}
}

// TestRunCredentialHelperParseErrorReturnsZero 验证 stdin 解析失败时返回 0
func TestRunCredentialHelperParseErrorReturnsZero(t *testing.T) {
	// 含 NUL 字节触发解析错误
	stdin := bytes.NewBufferString("host=git\x00hub.com\n\n")
	stdout := &bytes.Buffer{}
	code := RunCredentialHelper([]string{"get"}, stdin, stdout)
	if code != 0 {
		t.Errorf("parse error exit = %d, want 0", code)
	}
}
