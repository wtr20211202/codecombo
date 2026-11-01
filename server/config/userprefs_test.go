package config

import (
	"encoding/json"
	"strings"
	"testing"
)

// 用户偏好漫游单键（P-20261007-1）config 面测试：两道校验（合法 JSON + 大小
// 上限）+ 归一化 compact。内部键域 schema 前端自治，服务端不做结构白名单——
// 任意合法 JSON 对象/数组/标量都应通过（前端读侧自行判形）

func TestValidateUserPrefs(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		wantErr bool
	}{
		{"空对象", `{}`, false},
		{"稀疏偏差集", `{"keymap":{"quickOpen":"ctrl+alt+p"},"notify":{"sound":false}}`, false},
		{"数组也合法（schema 前端自治）", `[1,2,3]`, false},
		{"标量同样合法", `"x"`, false},
		{"嵌套深对象", `{"a":{"b":{"c":[true,null]}}}`, false},
		{"非法 JSON", `{"keymap":`, true},
		{"截断数组", `["unclosed`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateUserPrefs(json.RawMessage(tc.raw))
			if (err != nil) != tc.wantErr {
				t.Fatalf("ValidateUserPrefs(%q) err = %v, wantErr = %v", tc.raw, err, tc.wantErr)
			}
		})
	}
}

func TestValidateUserPrefsSizeLimit(t *testing.T) {
	// 恰好 64KB：合法（上限含等号）
	exact := `{"pad":"` + strings.Repeat("a", MaxUserPrefsBytes-10) + `"}`
	if len(exact) != MaxUserPrefsBytes {
		t.Fatalf("fixture size = %d, want %d", len(exact), MaxUserPrefsBytes)
	}
	if err := ValidateUserPrefs(json.RawMessage(exact)); err != nil {
		t.Fatalf("exact 64KB should pass, got %v", err)
	}
	// 超限 1 字节：拒绝
	over := `{"pad":"` + strings.Repeat("a", MaxUserPrefsBytes-10+1) + `"}`
	if err := ValidateUserPrefs(json.RawMessage(over)); err == nil {
		t.Fatal("over-limit should be rejected")
	}
}

func TestNormalizeUserPrefs(t *testing.T) {
	got := NormalizeUserPrefs(json.RawMessage(`  { "keymap" :  { "closeTab" :  "ctrl+alt+x" } }  `))
	want := `{"keymap":{"closeTab":"ctrl+alt+x"}}`
	if string(got) != want {
		t.Fatalf("NormalizeUserPrefs = %s, want %s", got, want)
	}
	// 幂等：归一结果再归一不变
	if again := NormalizeUserPrefs(got); string(again) != want {
		t.Fatalf("normalize not idempotent: %s", again)
	}
}

// 落盘回路：ServerConfig 经 JSON 出入界 UserPrefs 原样往返（filestore config
// 文档即此形态）；旧配置缺字段 unmarshal 得 nil = 存量升级零迁移
func TestServerConfigUserPrefsRoundTrip(t *testing.T) {
	orig := ServerConfig{UserPrefs: json.RawMessage(`{"notify":{"sound":false}}`)}
	data, err := json.Marshal(orig)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"userPrefs"`) {
		t.Fatalf("marshal lost userPrefs: %s", data)
	}
	var back ServerConfig
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	if string(back.UserPrefs) != `{"notify":{"sound":false}}` {
		t.Fatalf("round-trip userPrefs = %s", back.UserPrefs)
	}
	// 旧数据面：无 userPrefs 键 → nil（omitempty 序列化后也不出现该键）
	var legacy ServerConfig
	if err := json.Unmarshal([]byte(`{"port":9999}`), &legacy); err != nil {
		t.Fatal(err)
	}
	if len(legacy.UserPrefs) != 0 {
		t.Fatalf("legacy config UserPrefs = %s, want empty", legacy.UserPrefs)
	}
	out, _ := json.Marshal(legacy)
	if strings.Contains(string(out), "userPrefs") {
		t.Fatalf("empty UserPrefs should be omitted: %s", out)
	}
}
