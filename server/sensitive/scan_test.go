package sensitive

import (
	"strings"
	"testing"
)

// 出域敏感扫描组合层（P-20261004-113）：文件名级模式（share 单一事实源）与
// 内容凭据形态组合、流式 Counter 汇总、审计摘要的确定性/不含原文。

func TestScanContent_FilenameMentions(t *testing.T) {
	text := strings.Join([]string{
		`cat config/.env`,
		`ssh -i D:\home\me\id_rsa deploy@host`,
		`openssl x509 -in cert.pem`,
		`cat ~/.npmrc`,
		`notes.md docs/plan.md`, // 非敏感文件名零命中
	}, "\n")
	hits := ScanContent(text)
	if len(hits) != 1 || hits[0].Type != HitSensitiveFileName || hits[0].Count != 4 {
		t.Fatalf("hits = %+v, want sensitive-file-name ×4", hits)
	}
}

func TestScanContent_CombinedStableOrder(t *testing.T) {
	text := "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 in .env"
	hits := ScanContent(text)
	if len(hits) != 2 {
		t.Fatalf("hits = %+v, want 2 types", hits)
	}
	// hitOrder：known-token 在 sensitive-file-name 之前（稳定序，前端/审计同序）
	if hits[0].Type != "known-token" || hits[1].Type != HitSensitiveFileName {
		t.Fatalf("order = %v, want known-token, sensitive-file-name", hits)
	}
	if sum := Summary(hits); sum != "known-token×1, sensitive-file-name×1" {
		t.Fatalf("summary = %q", sum)
	}
	for _, secret := range []string{"ghp_abcdefghijklmnopqrstuvwxyz0123456789", ".env"} {
		if strings.Contains(Summary(hits), secret) {
			t.Fatalf("summary leaked %q", secret)
		}
	}
}

func TestCounter_StreamingMerge(t *testing.T) {
	var c Counter
	c.AddText("first AKIAABCDEFGHIJKLMNOP")
	c.AddText("second password=hunter2 AKIAABCDEFGHIJKLMNOP")
	hits := c.Hits()
	if len(hits) != 2 {
		t.Fatalf("hits = %+v, want 2 types", hits)
	}
	m := map[string]int{}
	for _, h := range hits {
		m[h.Type] = h.Count
	}
	if m["aws-access-key"] != 2 || m["secret-assignment"] != 1 {
		t.Fatalf("counts = %v", m)
	}
	if hits := (&Counter{}).Hits(); hits != nil {
		t.Fatalf("empty counter hits = %+v", hits)
	}
}
