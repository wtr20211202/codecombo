package deploy

import (
	"fmt"
	"strings"
	"testing"

	"codecombo/server/errmarkers"
)

// P-20261005-160 门禁：TriggerDeploy 互斥拒绝的附码识别依据——hostBusyPrefix
// 从 errmarkers.DeployHostBusyTemplate 派生（首个占位符前的稳定段）。本测试钉住
// 「实例化后的完整互斥句必含该前缀」：模板改动时前缀随之自动派生不漂移，但
// 若有人把占位符挪到句首（前缀退化为空）或改写句式，此处翻红提醒核对
// deploy.host_busy 的识别面
func TestHostBusyPrefixMatchesInstantiated(t *testing.T) {
	if hostBusyPrefix == "" {
		t.Fatal("hostBusyPrefix derived empty (placeholder at start of template?)")
	}
	instantiated := fmt.Sprintf(errmarkers.DeployHostBusyTemplate, "task-xyz")
	if !strings.Contains(instantiated, hostBusyPrefix) {
		t.Errorf("instantiated busy message %q must contain derived prefix %q", instantiated, hostBusyPrefix)
	}
	// 他类触发失败不得误判为互斥拒绝
	if strings.Contains("load deploy config failed", hostBusyPrefix) {
		t.Error("unrelated error must not match hostBusyPrefix")
	}
}
