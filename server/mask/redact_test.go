package mask

import "testing"

// 审批面密钥脱敏单测（P-20261003-197）：语料与 web/src/utils/sensitiveMask.test.ts
// 的 maskApprovalSecrets 组互锁（同语料双实现，改任一侧同步另一侧）

// ④已知前缀：前缀保留 + 值段 *** + 尾 4（首尾可读性）
func TestMaskApprovalText_SecretTokenPrefixes(t *testing.T) {
	cases := []struct{ in, want string }{
		// 动机样例：curl 带 Bearer sk- 令牌（OpenAI 系）
		{`curl -H "Authorization: Bearer sk-proj-abc123XYZdef456GHI789" api.example.com`,
			`curl -H "Authorization: Bearer sk-***I789" api.example.com`},
		{`ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456`, `ghp_***3456`},
		{`xoxb-123456789012-abcdef`, `xoxb-***cdef`},
		{`glpat-abcdefghij1234`, `glpat-***1234`},
		{`npm_f1e2d3c4b5a69788`, `npm_***9788`},
		{`sk_live_abcdefghijklmnopqrst`, `sk_live_***qrst`},
		// 值段不足 12：不构成命中（短串遮了白遮）
		{`sk-short1`, `sk-short1`},
		// 起始边界：词字符内嵌的 "sk-" 嵌段不误遮（task- 连字 ID）
		{`task-20241103-0012345`, `task-20241103-0012345`},
		// 多字节边界字符（中文标点）完整还原——按字节劈 rune 会坏前缀判定与
		// 首部可读性（回归语料）
		{"部署触发：ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456", "部署触发：ghp_***3456"},
	}
	for _, c := range cases {
		if got := MaskApprovalText(c.in); got != c.want {
			t.Fatalf("MaskApprovalText(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// ⑤高熵长串：三类字符齐备才遮，首 4 尾 4 保留
func TestMaskApprovalText_HighEntropy(t *testing.T) {
	cases := []struct{ in, want string }{
		// JWT 头段（base64url，三类齐备）
		{"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJh***VCJ9"},
		// 误判容忍：git SHA（纯 hex 无大写）/ 时间戳段（无大写）原样
		{"a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e",
			"a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e"},
		{"task-20241103-0012345678901234", "task-20241103-0012345678901234"},
		// 路径不误伤（分隔符不在候选字符集，段长不足）
		{"/home/user/project/src/main.go", "/home/user/project/src/main.go"},
	}
	for _, c := range cases {
		if got := MaskApprovalText(c.in); got != c.want {
			t.Fatalf("MaskApprovalText(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// 与 P-108 模式集叠加：①sc 令牌 ②赋值形态照旧整段遮蔽，④补 Bearer 形态
func TestMaskApprovalText_ComposesMaskText(t *testing.T) {
	got := MaskApprovalText("password=hunter2 scl_locktok sk-abcdefghijklmnopqrst")
	want := "password=" + tokenMask + " " + tokenMask + " " + "sk-***qrst"
	if got != want {
		t.Fatalf("MaskApprovalText = %q, want %q", got, want)
	}
	// 普通命令语境零改动（误伤防护语料）
	plain := "git push origin main && npm run check"
	if got := MaskApprovalText(plain); got != plain {
		t.Fatalf("MaskApprovalText false positive = %q", got)
	}
}
