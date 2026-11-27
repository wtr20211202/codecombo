package config

// pastelimits_test.go —— 粘贴限额生效值推导矩阵（P-20261123-6）：0/负回落默认、
// 超上限钳制、低于下限抬升、image>file 取 min（防手改 settings 文档写脏锁死
// 上传链）；BodyMax 由调用方经 pastetmp.BodyMaxForMB 按 file 生效值推导（本测试
// 同时断言该链路）。share/remote 的范围=默认值（只允许下调）。
import "testing"

func TestEffectivePasteLimits(t *testing.T) {
	// 零值 = 全默认（owner 100/20、share/remote 20/10）
	var zero ServerConfig
	owner, share, remote := zero.EffectivePasteLimits()
	if owner.FileMB != 100 || owner.ImageMB != 20 {
		t.Errorf("zero owner = %d/%d, want 100/20", owner.FileMB, owner.ImageMB)
	}
	if share.FileMB != 20 || share.ImageMB != 10 {
		t.Errorf("zero share = %d/%d, want 20/10", share.FileMB, share.ImageMB)
	}
	if remote.FileMB != 20 || remote.ImageMB != 10 {
		t.Errorf("zero remote = %d/%d, want 20/10", remote.FileMB, remote.ImageMB)
	}

	// 超上限钳制：owner 1024→512、image 128→64；share 100→20（只许下调）
	cfg := ServerConfig{}
	cfg.PasteLimits.Owner = PasteLimitPair{FileMB: 1024, ImageMB: 128}
	cfg.PasteLimits.Share = PasteLimitPair{FileMB: 100, ImageMB: 50}
	o, sh, _ := cfg.EffectivePasteLimits()
	if o.FileMB != 512 || o.ImageMB != 64 {
		t.Errorf("clamped owner = %d/%d, want 512/64", o.FileMB, o.ImageMB)
	}
	if sh.FileMB != 20 || sh.ImageMB != 10 {
		t.Errorf("clamped share = %d/%d, want 20/10", sh.FileMB, sh.ImageMB)
	}

	// 低于下限抬升（0 值语义是「恢复默认」非「关闭」）：owner file 0→100、
	// 显式 1 保留；share file 0→20
	cfg2 := ServerConfig{}
	cfg2.PasteLimits.Owner = PasteLimitPair{FileMB: 0, ImageMB: 1}
	o2, _, _ := cfg2.EffectivePasteLimits()
	if o2.FileMB != 100 || o2.ImageMB != 1 {
		t.Errorf("owner zero-fallback = %d/%d, want 100/1", o2.FileMB, o2.ImageMB)
	}

	// 负值 = 回落默认（与 0 同语义）
	cfg3 := ServerConfig{}
	cfg3.PasteLimits.Owner = PasteLimitPair{FileMB: -5, ImageMB: -5}
	o3, _, _ := cfg3.EffectivePasteLimits()
	if o3.FileMB != 100 || o3.ImageMB != 20 {
		t.Errorf("owner negative-fallback = %d/%d, want 100/20", o3.FileMB, o3.ImageMB)
	}

	// image > file 取 min（写脏防护）
	cfg4 := ServerConfig{}
	cfg4.PasteLimits.Owner = PasteLimitPair{FileMB: 2, ImageMB: 64}
	o4, _, _ := cfg4.EffectivePasteLimits()
	if o4.ImageMB != 2 || o4.FileMB != 2 {
		t.Errorf("image>file = %d/%d, want 2/2", o4.FileMB, o4.ImageMB)
	}

	// 范围内合法值原样保留
	cfg5 := ServerConfig{}
	cfg5.PasteLimits.Owner = PasteLimitPair{FileMB: 512, ImageMB: 20}
	cfg5.PasteLimits.Remote = PasteLimitPair{FileMB: 5, ImageMB: 5}
	o5, _, r5 := cfg5.EffectivePasteLimits()
	if o5.FileMB != 512 || o5.ImageMB != 20 {
		t.Errorf("owner at-cap = %d/%d, want 512/20", o5.FileMB, o5.ImageMB)
	}
	if r5.FileMB != 5 || r5.ImageMB != 5 {
		t.Errorf("remote lowered = %d/%d, want 5/5", r5.FileMB, r5.ImageMB)
	}
}
