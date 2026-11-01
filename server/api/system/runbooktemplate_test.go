package system

import (
	"reflect"
	"testing"
)

// textTemplate Go 侧移植的对账单测（P-20261004-108）：样本与
// web/src/utils/textTemplate.ts 的 TS 语义逐条对照（占位符/转义/旧双括号/
// shell 变量排除），两端不漂移是「同一本运行书」契约的一部分。

func TestExtractRunbookParams(t *testing.T) {
	cases := []struct {
		tmpl string
		want []string
		note string
	}{
		{"deploy {env} to {host}", []string{"env", "host"}, "基础双参"},
		{"echo {a} {b} {a}", []string{"a", "b"}, "按出现序去重"},
		{"no placeholder", []string{}, "无占位符"},
		{"scp file.txt {host}:", []string{"host"}, "名字允许点与连字符：{a.b}/{a-b} 同合法"},
		{"git push {remote_name} {branch}", []string{"remote_name", "branch"}, "下划线开头与组成"},
		{"{{legacy}} {modern}", []string{"legacy", "modern"}, "旧双大括号形式继续按占位符识别"},
		{`awk '{print $1}' {file}`, []string{"file"}, "字面花括号命令不算占位符"},
		{`echo ${VAR}`, []string{}, "shell 变量语法（紧邻 $）排除"},
		{"{} {a b} {，}", []string{}, "空名/含空格/非标识符不命中"},
		{"{{ }}", []string{}, "双括号空白内容按转义还原非占位符"},
	}
	for _, c := range cases {
		if got := extractRunbookParams(c.tmpl); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: extractRunbookParams(%q) = %v, want %v", c.note, c.tmpl, got, c.want)
		}
	}
	if got := extractRunbookParams("{αльфа}-{文件}"); !reflect.DeepEqual(got, []string{"αльфа", "文件"}) {
		t.Errorf("unicode names: got %v", got)
	}
}

func TestInterpolateRunbookTemplate(t *testing.T) {
	cases := []struct {
		tmpl   string
		values map[string]string
		want   string
		note   string
	}{
		{"deploy {env} to {host}", map[string]string{"env": "prod", "host": "web-1"}, "deploy prod to web-1", "双参填充"},
		{"echo {missing}", map[string]string{}, "echo {missing}", "缺失保留占位符原样"},
		{"echo {blank}", map[string]string{"blank": "   "}, "echo {blank}", "空白值保留占位符（不静默清空）"},
		{"tag-{v}-{v}", map[string]string{"v": "1.2"}, "tag-1.2-1.2", "同名多处全替换"},
		{`awk '{print $1}' {file}`, map[string]string{"file": "a.txt"}, `awk '{print $1}' a.txt`, "字面花括号保真"},
		{`echo ${HOME} ok`, map[string]string{}, `echo ${HOME} ok`, "shell 变量不受插值影响"},
		{"{{legacy}} {x}", map[string]string{"legacy": "L", "x": "1"}, "L 1", "旧双括号占位符同插值"},
		{`awk '{{print $1}}' {x}`, map[string]string{"x": "a.csv"}, `awk '{print $1}' a.csv`, "非标识符双括号按转义还原单括号"},
		{"{{x}}", map[string]string{}, "{{x}}", "旧双括号缺值保留占位符原样"},
	}
	for _, c := range cases {
		if got := interpolateRunbookTemplate(c.tmpl, c.values); got != c.want {
			t.Errorf("%s: interpolate(%q) = %q, want %q", c.note, c.tmpl, got, c.want)
		}
	}
}

func TestTokenizeRoundTrip(t *testing.T) {
	// 无值插值 = 原样还原（未提供值时插值不破坏模板）：这是「缺失校验先行」
	// 安全网失效时也不写坏命令的最后防线
	tmpl := `deploy {env} --awk '{print $1}' ${PATH} {{x}} end`
	if got := interpolateRunbookTemplate(tmpl, map[string]string{}); got != tmpl {
		t.Errorf("no-value interpolation must be identity, got %q", got)
	}
}
