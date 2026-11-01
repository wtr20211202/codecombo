package git

import "testing"

// A6 守护：以 "-" 开头的引用名一律拒绝（防 argument injection），
// 合法引用（origin/main、v1.0、feature/x）不受影响
func TestValidateRef(t *testing.T) {
	bad := []string{"-b x", "--exec", "-D", "-", " -o"}
	for _, name := range bad {
		if err := validateRef(name); err == nil {
			t.Errorf("expected rejection for %q", name)
		}
	}
	good := []string{"main", "origin/main", "v1.0", "feature/x", "HEAD", "a1b2c3d"}
	for _, name := range good {
		if err := validateRef(name); err != nil {
			t.Errorf("unexpected rejection for %q: %v", name, err)
		}
	}
	if err := validateRef(""); err == nil {
		t.Error("expected rejection for empty ref")
	}
	// 多参版本：任一非法即整体拒绝
	if err := validateRef("main", "-x"); err == nil {
		t.Error("expected rejection when any ref is invalid")
	}
}
