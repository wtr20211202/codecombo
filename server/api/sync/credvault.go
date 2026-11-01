package sync

import (
	"encoding/json"
	"fmt"
	"time"

	"codecombo/server/store"
)

// 手动携密同步——凭据档载荷（P-20261024-3 方案②）。
//
// 范围写死（提案评审定稿）：credential 库 + SSH 主机（含私钥）+ 部署凭据 +
// Agent Token 逐枚随档；实例 Token 不作载荷（它是通道凭据，新机加实例时各自
// 建立）；锁密码哈希永不携（新机首设）。quickdrop 投递凭据为仅哈希落盘（
// store/quickdrop.go 无明文出口，哈希盐机器本机）——明文不可恢复、携出无效，
// 与 P-20261003-147 迁移包「不可迁家族」同口径：档内只带占位标记，接收端
// 预览提示「新机需重签」。
//
// 聚合口径与迁移包共享（migration_export.go collectCredentials/collectTokens
// 唯一事实源，本文件不另建同职责收集器）：明文只在 E2E 信封密文内存在，落盘
// 侧走 store encrypt-on-write 既有链重加密（目标机 master-key，与源机同强度）。

// credVaultSchema / credVaultVersion E2E 信封内层载荷标识（对端 schema 门禁，
// 防拿错信封 / 旧版载荷误入新版解链）
const (
	credVaultSchema   = "simple-coding.credvault"
	credVaultVersion  = 1
	credVaultMaxBytes = 32 << 20 // 凭据档体量护栏（KB~MB 级；信封整体驻内存）
)

// CredVault E2E 信封内层明文载荷。Credentials/Tokens 复用迁移包形状
// （MigrationCredentials/MigrationTokens——三 store 聚合口径单一事实源）
type CredVault struct {
	Schema  string    `json:"schema"`
	Version int       `json:"version"`
	Host    string    `json:"host"` // 源机 hostname 摘要（密文体内，防拿错对端）
	SentAt  time.Time `json:"sentAt"`

	Credentials *MigrationCredentials `json:"credentials,omitempty"`
	Tokens      *MigrationTokens      `json:"tokens,omitempty"`
	// QuickdropPlaceholder 投递凭据占位（仅哈希不可携——预览/审计提示重签）
	QuickdropPlaceholder bool `json:"quickdropPlaceholder,omitempty"`
}

// buildCredVault 收集凭据档（collectCredentials/collectTokens 迁移链同源复用）
func buildCredVault() (*CredVault, error) {
	cred, err := collectCredentials()
	if err != nil {
		return nil, err
	}
	v := &CredVault{
		Schema:      credVaultSchema,
		Version:     credVaultVersion,
		Host:        hostnameSummary(),
		SentAt:      time.Now().UTC(),
		Credentials: cred,
		Tokens:      collectTokens(),
	}
	if store.Get().QuickdropToken.Meta().Exists {
		v.QuickdropPlaceholder = true
	}
	return v, nil
}

// parseCredVault 信封内层 schema 门禁
func parseCredVault(b []byte) (*CredVault, error) {
	var v CredVault
	if err := json.Unmarshal(b, &v); err != nil {
		return nil, fmt.Errorf("credential vault not parseable")
	}
	if v.Schema != credVaultSchema || v.Version != credVaultVersion {
		return nil, fmt.Errorf("unsupported credential vault schema/version")
	}
	return &v, nil
}

// credVaultSummary 审计/展示用的计数元数据行（绝不含凭据内容）。
// 固定序语言中立：git=N sshHosts=N sshKeys=N deploy=Y|N agentToken=Y|N qdrop=Y|N
func credVaultSummary(v *CredVault) string {
	if v == nil {
		return "git=0 sshHosts=0 sshKeys=0 deploy=N agentToken=N qdrop=N"
	}
	git, hosts, keys := 0, 0, 0
	deploy := "N"
	if v.Credentials != nil {
		git, hosts, keys = len(v.Credentials.Git), len(v.Credentials.SSHHosts), len(v.Credentials.SSHKeys)
		if v.Credentials.Deploy != nil && v.Credentials.Deploy.AnthropicToken != "" {
			deploy = "Y"
		}
	}
	agentToken := "N"
	if v.Tokens != nil && v.Tokens.AgentToken != "" {
		agentToken = "Y"
	}
	qdrop := "N"
	if v.QuickdropPlaceholder {
		qdrop = "Y"
	}
	return fmt.Sprintf("git=%d sshHosts=%d sshKeys=%d deploy=%s agentToken=%s qdrop=%s",
		git, hosts, keys, deploy, agentToken, qdrop)
}

// manifestCredEntry 凭据档单元的 manifest 条目（仅显式 credentials=1 请求面
// 出现——指纹=载荷哈希，规模供同步中心展示；不参与 plan 四态与账本）
func manifestCredEntry() (UnitEntry, bool) {
	v, err := buildCredVault()
	if err != nil {
		return UnitEntry{}, false
	}
	b, err := json.Marshal(v)
	if err != nil {
		return UnitEntry{}, false
	}
	return UnitEntry{
		Key: UnitCredentials, Kind: UnitCredentials,
		Name:        "密钥凭据档（手动携密同步）",
		Fingerprint: hashBytes(b), Size: int64(len(b)), Files: 1, Exists: true,
	}, true
}
