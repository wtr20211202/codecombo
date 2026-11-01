package license

import (
	"fmt"
	"os"
	"path/filepath"
)

// Store 许可证持久化（DataDir/license.key，权限 0600）
type Store struct {
	dataDir string
}

func NewStore(dataDir string) *Store {
	return &Store{dataDir: dataDir}
}

func (s *Store) keyFile() string {
	return filepath.Join(s.dataDir, "license.key")
}

// Save 持久化许可密钥
func (s *Store) Save(key string) error {
	return os.WriteFile(s.keyFile(), []byte(key), 0600)
}

// LoadKey 读取持久化的许可密钥
func (s *Store) LoadKey() (string, error) {
	data, err := os.ReadFile(s.keyFile())
	if err != nil {
		return "", fmt.Errorf("read license key: %w", err)
	}
	return string(data), nil
}

// Remove 删除持久化的许可密钥
func (s *Store) Remove() error {
	return os.Remove(s.keyFile())
}
