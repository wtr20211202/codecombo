package app

import (
	"testing"

	"codecombo/server/config"
	"codecombo/server/notification"
)

// config.json 损坏降级告知卡单测（P-20261006-10）：保全成功/失败两分支的
// 卡片形态契约——类型/类别决定 webhook important 外发与 UI 语义色，模板键
// 与 MsgParams 决定前端 i18n 渲染，Title/Body 明文是无模板消费方的回退
func TestConfigCorruptNotificationPreserved(t *testing.T) {
	rep := &config.ConfigCorruption{
		Path:          "/data/config.json",
		PreservedPath: "/data/config.json.corrupt-20260101-000000.000000000",
		Err:           "invalid character '}' looking for beginning of object key string",
	}
	n := configCorruptNotification(rep)
	if n.Type != "warning" || n.Category != notification.CategorySystem {
		t.Fatalf("type/category = %q/%q, want warning/system", n.Type, n.Category)
	}
	if n.TitleKey != config.ConfigCorruptTitleKey {
		t.Fatalf("titleKey = %q, want %q", n.TitleKey, config.ConfigCorruptTitleKey)
	}
	if n.BodyKey != config.ConfigCorruptBodyKey {
		t.Fatalf("bodyKey = %q, want preserved variant %q", n.BodyKey, config.ConfigCorruptBodyKey)
	}
	if n.Body != rep.PreservedPath {
		t.Fatalf("body fallback = %q, want preserved path %q", n.Body, rep.PreservedPath)
	}
	if n.MsgParams["file"] != rep.PreservedPath || n.MsgParams["err"] != rep.Err {
		t.Fatalf("msgParams = %v, want file/err carried", n.MsgParams)
	}
}

func TestConfigCorruptNotificationUnpreserved(t *testing.T) {
	rep := &config.ConfigCorruption{
		Path: "/data/config.json",
		Err:  "unexpected end of JSON input",
	}
	n := configCorruptNotification(rep)
	if n.BodyKey != config.ConfigCorruptBodyUnpreserved {
		t.Fatalf("bodyKey = %q, want unpreserved variant %q", n.BodyKey, config.ConfigCorruptBodyUnpreserved)
	}
	if n.Body != rep.Path {
		t.Fatalf("body fallback = %q, want original path %q", n.Body, rep.Path)
	}
}
