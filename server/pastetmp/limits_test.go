package pastetmp

// limits_test.go —— 限额值类型与默认值锚定（P-20261123-6）：三端默认 = P-5 定稿
// （owner 100/20、share/remote 20/10）；BodyMax 推导 = per-context 信封余量
// （owner +4MB、share/remote +2MB）；MBText 文案形态（一位小数 + " MB"）——前端
// KNOWN_ERROR_I18N 正则按此形态匹配（[\d.]+ MB），改形态须两侧同步。
// 生效值钳制/纠偏（0/负回落默认、超上限钳制、image>file 取 min）在
// server/config pastePairEffective，由 config 包单测覆盖。
import "testing"

func TestDefaults(t *testing.T) {
	if Owner.FileMB != 100 || Owner.ImageMB != 20 {
		t.Errorf("Owner = %d/%d, want 100/20", Owner.FileMB, Owner.ImageMB)
	}
	if Share.FileMB != 20 || Share.ImageMB != 10 {
		t.Errorf("Share = %d/%d, want 20/10", Share.FileMB, Share.ImageMB)
	}
	if Remote.FileMB != 20 || Remote.ImageMB != 10 {
		t.Errorf("Remote = %d/%d, want 20/10", Remote.FileMB, Remote.ImageMB)
	}
}

func TestBodyMaxDerivation(t *testing.T) {
	if got := OwnerBodyMax(); got != 104<<20 {
		t.Errorf("OwnerBodyMax = %d, want 104MiB", got)
	}
	if got := ShareBodyMax(); got != 22<<20 {
		t.Errorf("ShareBodyMax = %d, want 22MiB", got)
	}
	if got := RemoteBodyMax(); got != 22<<20 {
		t.Errorf("RemoteBodyMax = %d, want 22MiB", got)
	}
	// 统一算式与常量推导一致（防两处漂移）
	if BodyMaxForMB(100, 4) != OwnerBodyMax() {
		t.Errorf("BodyMaxForMB(100,4) drifted from OwnerBodyMax")
	}
	if BodyMaxForMB(20, 2) != ShareBodyMax() {
		t.Errorf("BodyMaxForMB(20,2) drifted from ShareBodyMax")
	}
}

func TestMBText(t *testing.T) {
	cases := []struct {
		n    int64
		want string
	}{
		{100 << 20, "100.0 MB"},
		{20 << 20, "20.0 MB"},
		{26528819, "25.3 MB"},
		{512 << 10, "0.5 MB"},
	}
	for _, c := range cases {
		if got := MBText(c.n); got != c.want {
			t.Errorf("MBText(%d) = %q, want %q", c.n, got, c.want)
		}
	}
}
