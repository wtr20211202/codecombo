package store_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// newDeployTestStoreWithSeed 在临时数据面预置一份 deployconfig 原始文档
// （升级兼容审计 P-20261005-197：旧格式样例 + 新二进制读取形态），
// 返回 store 与底层 DocumentStore（供断言读落盘原文）
func newDeployTestStoreWithSeed(t *testing.T, raw []byte) (*store.Store, store.DocumentStore) {
	t.Helper()
	// filestore.New 的根语义 = DataDir，文档落在 <root>/data/<kind>/
	root := t.TempDir()
	kindDir := filepath.Join(root, "data", "deployconfig")
	if err := os.MkdirAll(kindDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(kindDir, "default.json"), raw, 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	doc := filestore.New(root)
	return store.New(doc), doc
}

// 旧版四槽位模型字段文档（ed8e33c3 合并前的落盘形态；token 已是存储态密文）
const legacyDeployConfigJSON = `{"anthropicToken":"enc:abcd1234","anthropicBaseUrl":"http://old.example:3000/","opusModel":"glm-4.6","sonnetModel":"glm-4.5-air","haikuModel":"glm-4-flash","subagentModel":"glm-4-air","binaryDir":"/old/bin"}`

func TestDeployConfig_MigrateLegacyModelFields(t *testing.T) {
	s, doc := newDeployTestStoreWithSeed(t, []byte(legacyDeployConfigJSON))

	n, err := s.DeployConfig.MigrateLegacyModelFields()
	if err != nil {
		t.Fatalf("MigrateLegacyModelFields: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 migrated, got %d", n)
	}

	// 迁移后读取：model = 首个非空槽位（opus 优先），其余字段原样保留
	cfg, err := s.DeployConfig.Get()
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if cfg.Model != "glm-4.6" {
		t.Errorf("expected model glm-4.6, got %q", cfg.Model)
	}
	if cfg.AnthropicBaseURL != "http://old.example:3000/" {
		t.Errorf("expected base url preserved, got %q", cfg.AnthropicBaseURL)
	}
	if cfg.BinaryDir != "/old/bin" {
		t.Errorf("expected binaryDir preserved, got %q", cfg.BinaryDir)
	}

	// 落盘文档不再携带旧字段（新结构序列化自然消失）
	data, err := doc.Get("deployconfig", "default")
	if err != nil {
		t.Fatalf("raw get: %v", err)
	}
	raw := string(data)
	for _, legacy := range []string{"opusModel", "sonnetModel", "haikuModel", "subagentModel"} {
		if strings.Contains(raw, legacy) {
			t.Errorf("expected legacy field %s gone from disk doc, got %s", legacy, raw)
		}
	}
	// 落盘文档仍是合法 JSON 且 model 在位
	var disk map[string]any
	if json.Unmarshal(data, &disk) != nil {
		t.Fatalf("disk doc is not valid JSON: %s", raw)
	}
	if disk["model"] != "glm-4.6" {
		t.Errorf("expected disk model glm-4.6, got %v", disk["model"])
	}
	// 存储态密文 token 原样保留（迁移走原始文档，不经 Get 的解密链，防双重加密）
	if disk["anthropicToken"] != "enc:abcd1234" {
		t.Errorf("expected encrypted token untouched, got %v", disk["anthropicToken"])
	}

	// 幂等：第二遍不动
	n2, err := s.DeployConfig.MigrateLegacyModelFields()
	if err != nil {
		t.Fatalf("second MigrateLegacyModelFields: %v", err)
	}
	if n2 != 0 {
		t.Errorf("expected 0 on second run, got %d", n2)
	}
}

func TestDeployConfig_MigrateLegacyModelFields_Noop(t *testing.T) {
	t.Run("model already set keeps it", func(t *testing.T) {
		s, _ := newDeployTestStoreWithSeed(t, []byte(`{"model":"kept-model","opusModel":"old-model"}`))
		n, err := s.DeployConfig.MigrateLegacyModelFields()
		if err != nil {
			t.Fatalf("MigrateLegacyModelFields: %v", err)
		}
		if n != 0 {
			t.Errorf("expected 0, got %d", n)
		}
		cfg, _ := s.DeployConfig.Get()
		if cfg.Model != "kept-model" {
			t.Errorf("expected model untouched, got %q", cfg.Model)
		}
	})

	t.Run("no legacy fields", func(t *testing.T) {
		s, _ := newDeployTestStoreWithSeed(t, []byte(`{"anthropicBaseUrl":"http://x/"}`))
		n, err := s.DeployConfig.MigrateLegacyModelFields()
		if err != nil {
			t.Fatalf("MigrateLegacyModelFields: %v", err)
		}
		if n != 0 {
			t.Errorf("expected 0, got %d", n)
		}
	})

	t.Run("empty store", func(t *testing.T) {
		s := store.New(filestore.New(filepath.Join(t.TempDir(), "data")))
		n, err := s.DeployConfig.MigrateLegacyModelFields()
		if err != nil {
			t.Fatalf("MigrateLegacyModelFields: %v", err)
		}
		if n != 0 {
			t.Errorf("expected 0, got %d", n)
		}
	})

	t.Run("subagent fallback when opus empty", func(t *testing.T) {
		s, _ := newDeployTestStoreWithSeed(t, []byte(`{"sonnetModel":"","haikuModel":"","subagentModel":"sub-model"}`))
		n, err := s.DeployConfig.MigrateLegacyModelFields()
		if err != nil {
			t.Fatalf("MigrateLegacyModelFields: %v", err)
		}
		if n != 1 {
			t.Fatalf("expected 1, got %d", n)
		}
		cfg, _ := s.DeployConfig.Get()
		if cfg.Model != "sub-model" {
			t.Errorf("expected model sub-model, got %q", cfg.Model)
		}
	})
}
