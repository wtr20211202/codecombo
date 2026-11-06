package update

import (
	"testing"

	"codecombo/server/config"
)

// TestApplySourceHotRewire 设置保存热接线（P-20261106）：ApplySource 是启动
// Init 与设置保存共用入口——网页形态官方源归一、通道旗标即时生效、非法源
// 停用，三态一个语义不漂移
func TestApplySourceHotRewire(t *testing.T) {
	t.Cleanup(func() { GetManager().SetSource(nil) })

	// 空 URL（官方内置回填，网页形态）+ prerelease 通道 → 源装配、归一、旗标开
	ApplySource(&config.Config{Server: config.ServerConfig{
		UpdateURL:     "",
		UpdateChannel: "prerelease",
	}})
	gs, ok := GetManager().Source().(*GitHubSource)
	if !ok {
		t.Fatalf("source not assembled: %v", GetManager().Source())
	}
	if gs.RepoURL != "https://api.github.com/repos/wtr20211202/codecombo" {
		t.Errorf("RepoURL = %q, want official api form", gs.RepoURL)
	}
	if !gs.IncludePrerelease {
		t.Error("prerelease flag should be on after ApplySource(prerelease)")
	}

	// 通道切回 stable → 旗标关（同一入口，保存即生效）
	ApplySource(&config.Config{Server: config.ServerConfig{
		UpdateURL:     "",
		UpdateChannel: "stable",
	}})
	gs, ok = GetManager().Source().(*GitHubSource)
	if !ok || gs.IncludePrerelease {
		t.Errorf("stable channel must clear prerelease flag (ok=%v flag=%v)", ok, gs != nil && gs.IncludePrerelease)
	}

	// 非法源（http+回环）→ 停用（nil）——供应链入口宁可不更新也不放宽
	ApplySource(&config.Config{Server: config.ServerConfig{UpdateURL: "http://127.0.0.1/x"}})
	if GetManager().Source() != nil {
		t.Error("invalid source must disable update check (nil source)")
	}
}
