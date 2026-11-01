package store_test

import (
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 车道 1 新 repo 主路径单测（docs/PERSISTENCE_LANES.md review 清单）：
// Get/Put/All/Reset 全链路 + IPv6 host（含 ':' 的键派生安全）
func TestPeerCertStoreRoundtrip(t *testing.T) {
	s := store.New(filestore.New(t.TempDir()))

	if _, ok, err := s.PeerCert.GetFingerprint("node-a.local"); err != nil || ok {
		t.Fatalf("empty store: ok=%v err=%v", ok, err)
	}
	if err := s.PeerCert.PutFingerprint("node-a.local", "fp1"); err != nil {
		t.Fatal(err)
	}
	if err := s.PeerCert.PutFingerprint("[::1]:9999", "fp6"); err != nil {
		t.Fatalf("IPv6-ish host must be storable (hashed key): %v", err)
	}
	// 覆盖语义：重新 pin 同 host
	if err := s.PeerCert.PutFingerprint("node-a.local", "fp1b"); err != nil {
		t.Fatal(err)
	}

	fp, ok, err := s.PeerCert.GetFingerprint("node-a.local")
	if err != nil || !ok || fp != "fp1b" {
		t.Fatalf("get after overwrite: %q %v %v", fp, ok, err)
	}
	all, err := s.PeerCert.AllFingerprints()
	if err != nil || len(all) != 2 || all["node-a.local"] != "fp1b" || all["[::1]:9999"] != "fp6" {
		t.Fatalf("AllFingerprints: %v %v", all, err)
	}

	if err := s.PeerCert.ResetPeerCerts(); err != nil {
		t.Fatal(err)
	}
	if all, err := s.PeerCert.AllFingerprints(); err != nil || len(all) != 0 {
		t.Fatalf("after reset: %v %v", all, err)
	}
}
