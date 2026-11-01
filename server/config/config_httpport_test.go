package config

import "testing"

func TestHTTPPortOrDefault(t *testing.T) {
	mainPort := 9999

	// 未配置：默认开启，端口主端口+3
	plain := &ServerConfig{}
	if port, ok := plain.HTTPPortOrDefault(mainPort); !ok || port != mainPort+3 {
		t.Fatalf("default = %d, %v; want %d, true", port, ok, mainPort+3)
	}

	// 显式 0 / 负数：关闭
	zero := &ServerConfig{HTTPPort: intPtr(0)}
	if _, ok := zero.HTTPPortOrDefault(mainPort); ok {
		t.Fatal("explicit 0 must disable")
	}
	neg := &ServerConfig{HTTPPort: intPtr(-1)}
	if _, ok := neg.HTTPPortOrDefault(mainPort); ok {
		t.Fatal("negative must disable")
	}

	// 正数：指定端口
	custom := &ServerConfig{HTTPPort: intPtr(8080)}
	if port, ok := custom.HTTPPortOrDefault(mainPort); !ok || port != 8080 {
		t.Fatalf("custom = %d, %v; want 8080, true", port, ok)
	}
}

func intPtr(v int) *int { return &v }
