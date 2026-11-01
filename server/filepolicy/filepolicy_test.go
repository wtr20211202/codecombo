package filepolicy

import "testing"

func TestKindFor_TextWithinLimit(t *testing.T) {
	d := KindFor(".go", 1024, false)
	if d.Kind != KindText || d.Size != 1024 {
		t.Fatalf("got %+v", d)
	}
}

func TestKindFor_TooLargeKeepsPartialMax(t *testing.T) {
	d := KindFor(".log", 300*1024*1024, false)
	if d.Kind != KindTooLarge || d.Limit != TextPreviewLimit || d.PartialMax != PartialPreviewLimit {
		t.Fatalf("got %+v", d)
	}
	if d.SizeHuman == "" {
		t.Fatal("sizeHuman empty")
	}
}

func TestKindFor_BinaryByExtension(t *testing.T) {
	for _, name := range []string{".png", ".zip", ".exe", ".woff2", ".pdf", ".PNG"} {
		d := KindFor(name, 100, false)
		if d.Kind != KindBinary {
			t.Fatalf("%s: want binary, got %+v", name, d)
		}
		if d.Reason == "" {
			t.Fatalf("%s: reason should name the ext", name)
		}
	}
}

func TestKindFor_SniffNULByte(t *testing.T) {
	// 未知扩展名 + 内容含 NUL → 二进制
	d := KindFor(".dat", 4096, true)
	if d.Kind != KindBinary || d.Reason != "sniff:nul-byte" {
		t.Fatalf("got %+v", d)
	}
	// 超大未知扩展名 + NUL → 同样判二进制（防「大二进制被当超限文本」）
	d = KindFor(".bin2", 200*1024*1024, true)
	if d.Kind != KindBinary {
		t.Fatalf("got %+v", d)
	}
}

func TestNeedsSniff(t *testing.T) {
	if NeedsSniff(".png") {
		t.Fatal("known binary ext should not need sniff")
	}
	if !NeedsSniff(".dat") {
		t.Fatal("unknown ext should need sniff")
	}
}

func TestHumanBytes(t *testing.T) {
	cases := map[int64]string{
		512:               "512 B",
		10 * 1024:         "10.0 KB",
		300 * 1024 * 1024: "300.0 MB",
	}
	for in, want := range cases {
		if got := HumanBytes(in); got != want {
			t.Fatalf("HumanBytes(%d) = %q, want %q", in, got, want)
		}
	}
}
