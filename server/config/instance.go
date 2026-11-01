package config

// InstanceConfig 远程实例配置
type InstanceConfig struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	URL       string `json:"url"`
	Token     string `json:"token,omitempty"`
	// PairingKey 手动携密同步的配对密钥（32B 随机，hex 配对码形态双端人工
	// 抄录交换——out-of-band 不走网络，P-20261024-3）。落盘 enc: 态（instance
	// repo Save 链 EncryptToken 同款，与 Token 同等机器密钥静态加密）；API 面
	// 永不回传明文（生成/录入时刻一次性展示，之后只出 pairFp 短指纹）
	PairingKey string `json:"pairingKey,omitempty"`
	IsLocal    bool   `json:"isLocal"`
	ParentID   string `json:"parentId,omitempty"`
	CreatedAt  string `json:"createdAt"`
	UpdatedAt  string `json:"updatedAt"`
}

// BuildInstanceRoleMap 构建实例角色映射（纯函数，不依赖 I/O）。
//
// 角色语义（与 UI 徽章一一对应），优先级 child > center > local > standalone：
//   - child      指定了上级（parentId）的子实例——含本机：本机也可声明
//                从某个中心更新（"我从谁更新"由每台机器自己登记，视角对称）
//   - center     被至少一个实例引用为上级的中心实例——含本机（中心方登记
//                与子实例方声明两个方向的呈现对称）
//   - local      本机实例（无上级也未被引用）
//   - standalone 独立远程实例——无上级也未被引用
//
// 注意：无上级 ≠ 中心。旧实现把"非 child"一律判为 parent，导致两个互添
// 对方的独立实例互相显示"中心"徽章，与"从未设置所属中心"的事实矛盾
func BuildInstanceRoleMap(instances []InstanceConfig) map[string]string {
	// 被引用为上级的实例集合
	referenced := make(map[string]bool, len(instances))
	for _, inst := range instances {
		if inst.ParentID != "" {
			referenced[inst.ParentID] = true
		}
	}

	roleMap := make(map[string]string, len(instances))
	for _, inst := range instances {
		switch {
		case inst.ParentID != "":
			roleMap[inst.ID] = "child"
		case referenced[inst.ID]:
			roleMap[inst.ID] = "center"
		case inst.IsLocal:
			roleMap[inst.ID] = "local"
		default:
			roleMap[inst.ID] = "standalone"
		}
	}
	return roleMap
}
