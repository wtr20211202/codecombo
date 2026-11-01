package config

import (
	"strings"
	"testing"
)

// 自定义敏感模式写入口校验单测（P-20261006-11）：合法列表放行；方言纪律
//（内联旗标/命名组/环视）、空匹配、超限逐项拒绝。返回值是进 400 的语言
// 中立原因，只断言拒绝/放行与关键特征子串，不锁全文措辞

func TestValidateCustomSensitivePatterns_OK(t *testing.T) {
	if msg := ValidateCustomSensitivePatterns([]string{
		`(MY_APP_TOKEN=)([^ \t]+)`,     // 捕获组形态（键名保留）
		`scrt_[A-Za-z0-9]{20,}`,        // 值形态自含
		`(?:foo|bar)-[0-9]{8}`,         // 非捕获组放行（双端同语义）
		"[Pp]roject[Aa]pi[Kk]ey[=:].+", // 大小写字符类（方言公约）
	}); msg != "" {
		t.Fatalf("want ok, got %q", msg)
	}
	// 空列表合法（默认零变化形态）
	if msg := ValidateCustomSensitivePatterns(nil); msg != "" {
		t.Fatalf("empty list want ok, got %q", msg)
	}
}

func TestValidateCustomSensitivePatterns_Rejects(t *testing.T) {
	cases := []struct {
		name     string
		pats     []string
		contains string
	}{
		{"too many", make([]string, MaxCustomSensitivePatterns+1), "too many"},
		{"empty entry", []string{"  "}, "empty"},
		{"too long", []string{strings.Repeat("a", CustomSensitivePatternMaxLen+1)}, "too long"},
		// 方言纪律：内联旗标 Go 支持 JS 不支持——写入口拒绝防双端口径分叉
		{"inline flag", []string{`(?i)my_token=.`}, "not supported"},
		{"named group", []string{`(?P<key>tok)`}, "not supported"},
		{"lookahead", []string{`foo(?=bar)`}, "not supported"},
		// RE2 编译失败（反向引用 / 语法错误）
		{"backreference", []string{`(a)\1`}, "invalid"},
		{"bad syntax", []string{`[unclosed`}, "missing closing ]"},
		// 空匹配：遮蔽替换会在任意位置插 ***，双端空匹配推进语义亦有差异
		{"empty match", []string{`a*`}, "empty string"},
		{"empty alternation", []string{`foo|`}, "empty string"},
	}
	for _, c := range cases {
		if msg := ValidateCustomSensitivePatterns(c.pats); !strings.Contains(msg, c.contains) {
			t.Errorf("%s: want msg containing %q, got %q", c.name, c.contains, msg)
		}
	}
}

func TestNormalizeCustomSensitivePatterns(t *testing.T) {
	got := NormalizeCustomSensitivePatterns([]string{"  a  ", "", "\t b\t ", "c"})
	if len(got) != 3 || got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Fatalf("normalize: %q", got)
	}
}
