package filestore_test

import (
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// TestFileDocStoreConformance 文件实现对拍 DocumentStore 全量契约
// （未来 SQLite 实现接入时跑同一 suite，见 store/conformance.go）
func TestFileDocStoreConformance(t *testing.T) {
	store.RunConformance(t, func(t *testing.T) store.DocumentStore {
		return filestore.New(t.TempDir())
	})
}
