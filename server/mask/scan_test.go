package mask

import (
	"encoding/json"
	"strings"
	"testing"
)

// 出域敏感内容扫描（P-20261004-113）单测：双模式命中（凭据形态 + 自定义
// 敏感模式）/ 类型计数 / 「计数结构不附原文」硬约束 / 无敏感零命中。

func hitsByType(hits []ContentHit) map[string]int {
	m := make(map[string]int, len(hits))
	for _, h := range hits {
		m[h.Type] += h.Count
	}
	return m
}

func TestScanContent_HitTypes(t *testing.T) {
	t.Cleanup(func() { SetCustomPatterns(nil) })
	if n := SetCustomPatterns([]string{`scrt_[A-Za-z0-9]{20,}`}); n != 1 {
		t.Fatalf("custom pattern compile = %d, want 1", n)
	}
	text := strings.Join([]string{
		"deploy token: ghp_abcdefghijklmnopqrstuvwxyz0123456789", // 已知厂商前缀 + 赋值形态
		"AWS key AKIAABCDEFGHIJKLMNOP",                           // 云访问密钥
		"password=hunter2",                                       // 内置赋值形态
		"secret=topsecret",                                       // 扩展赋值形态（useAgentFix 词表）
		"url https://alice:s3cret@example.com/repo",              // URL 内嵌凭据
		"-----BEGIN RSA PRIVATE KEY-----",                        // PEM 私钥块
		"Authorization: Bearer abcdefghijklmnopqrstuvwxyz",       // Bearer 令牌
		"agent token sca_agenttoken123",                          // 平台令牌
		"custom scrt_a1B2c3D4e5F6g7H8i9J0",                       // 自定义模式
	}, "\n")

	hits := ScanContent(text)
	got := hitsByType(hits)
	want := map[string]int{
		HitKnownToken:       1,
		HitAWSAccessKey:     1,
		HitSecretAssignment: 3, // token: / password= / secret=
		HitURLCredentials:   1,
		HitPrivateKey:       1,
		HitBearerToken:      1,
		HitPlatformToken:    1,
		HitCustomPattern:    1,
	}
	for typ, n := range want {
		if got[typ] != n {
			t.Errorf("type %q count = %d, want %d (all hits: %+v)", typ, got[typ], n, hits)
		}
	}
	for typ := range got {
		if _, ok := want[typ]; !ok {
			t.Errorf("unexpected hit type %q", typ)
		}
	}

	// 硬约束：命中结构只有类型/计数——序列化后不含任何原值（警示不回流原文）
	raw, err := json.Marshal(hits)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{
		"ghp_abcdefghijklmnopqrstuvwxyz0123456789",
		"AKIAABCDEFGHIJKLMNOP",
		"hunter2", "topsecret", "s3cret",
		"BEGIN RSA PRIVATE KEY",
		"abcdefghijklmnopqrstuvwxyz",
		"sca_agenttoken123", "scrt_a1B2c3D4e5F6g7H8i9J0",
	} {
		if strings.Contains(string(raw), secret) {
			t.Errorf("hit JSON leaked secret %q: %s", secret, raw)
		}
	}
}

func TestScanContent_NoHits(t *testing.T) {
	text := strings.Join([]string{
		"普通会话内容：帮我排查心跳",
		`D:\devtree\go\coding\sample-app`, // 中性绝对路径夹具：本文件随发布包外发，不携带开发机目录拓扑
		"toolu_e1 e2e-exp-a1b2c3d4-e5f6",
		"心跳间隔 30s 正常，问题在网络层",
	}, "\n")
	if hits := ScanContent(text); len(hits) != 0 {
		t.Fatalf("no-hit text produced hits: %+v", hits)
	}
	if hits := ScanContent(""); hits != nil {
		t.Fatalf("empty text produced hits: %+v", hits)
	}
}
