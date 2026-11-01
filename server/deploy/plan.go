package deploy

import (
	"fmt"

	"codecombo/server/config"
)

// ResolvePlan 解析用户输入：补齐依赖、去重、拓扑排序
// - 校验所有 ID 存在
// - AllowMultiple=false 的不重复
// - 递归补齐 DependsOn（依赖先加入）
// - 单例工具在最终列表中只保留第一次出现
// - 多例工具每次都加入
func ResolvePlan(input []config.DeployerInstance) ([]config.DeployerInstance, error) {
	// 1. 校验所有 ID 存在 + 应用默认参数 + 必填检查
	for i := range input {
		d := Get(input[i].DeployerID)
		if d == nil {
			return nil, fmt.Errorf("unknown deployer: %s", input[i].DeployerID)
		}
		input[i].Params = ApplyParamDefaults(d.ParamsSchema(), input[i].Params)
		if err := ValidateParams(d.ParamsSchema(), input[i].Params); err != nil {
			return nil, fmt.Errorf("deployer %s: %w", input[i].DeployerID, err)
		}
	}

	// 2. 校验 AllowMultiple=false 的不重复
	seenSingle := map[string]bool{}
	for _, inst := range input {
		d := Get(inst.DeployerID)
		if !d.AllowMultiple() {
			if seenSingle[inst.DeployerID] {
				return nil, fmt.Errorf("deployer %s does not allow multiple instances", inst.DeployerID)
			}
			seenSingle[inst.DeployerID] = true
		}
	}

	// 3. 递归补齐依赖（依赖在自身之前）
	resolved := []config.DeployerInstance{}
	added := map[string]bool{} // 单例工具是否已加入（包括作为依赖）

	var addWithDeps func(inst config.DeployerInstance)
	addWithDeps = func(inst config.DeployerInstance) {
		d := Get(inst.DeployerID)
		for _, depID := range d.DependsOn() {
			dep := Get(depID)
			if dep == nil {
				continue
			}
			if !dep.AllowMultiple() && added[depID] {
				continue
			}
			addWithDeps(config.DeployerInstance{
				DeployerID: depID,
				Params:     ApplyParamDefaults(dep.ParamsSchema(), nil),
			})
			added[depID] = true
		}
		if d.AllowMultiple() {
			resolved = append(resolved, inst)
		} else if !added[inst.DeployerID] {
			resolved = append(resolved, inst)
			added[inst.DeployerID] = true
		}
	}

	for _, inst := range input {
		addWithDeps(inst)
	}

	return resolved, nil
}
