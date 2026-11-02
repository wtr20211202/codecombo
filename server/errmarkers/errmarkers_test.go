package errmarkers

import (
	"strings"
	"testing"
)

// 注册表内部不变量（跨端对账由 web/scripts/check-errmarkers.mjs 守卫负责，
// 这里只把「注册表自身健康」固化：重复条目/空元数据/非法占位符在 Go 侧即红，
// 不必等到 npm check 才暴露）。
func TestRegistryInvariants(t *testing.T) {
	if len(Registry) < 25 {
		t.Fatalf("Registry 条目数 %d < 25：提取/注册面疑似失明（正常存量 30+），先核对注册表", len(Registry))
	}
	seenSymbol := map[string]bool{}
	seenText := map[string]bool{}
	for i, m := range Registry {
		switch {
		case m.Symbol == "":
			t.Errorf("Registry[%d] Symbol 为空", i)
		case seenSymbol[m.Symbol]:
			t.Errorf("Symbol 重复：%s（守卫按 Symbol 归因，重复即歧义）", m.Symbol)
		case m.Text == "" || strings.TrimSpace(m.Text) != m.Text:
			t.Errorf("%s Text 为空或带首尾空白：%q", m.Symbol, m.Text)
		case seenText[m.Text]:
			t.Errorf("Text 重复：%s（与既有条目同文——同文应复用同一条目）", m.Symbol)
		case m.LocaleKey == "" || !strings.Contains(m.LocaleKey, "."):
			t.Errorf("%s LocaleKey 非点分式键：%q", m.Symbol, m.LocaleKey)
		case m.Kind != KindEmitted && m.Kind != KindExternal:
			t.Errorf("%s Kind 非法：%q", m.Symbol, m.Kind)
		case m.Note == "":
			t.Errorf("%s 缺 Note（语义注记是注册表纪律的一部分）", m.Symbol)
		}
		seenSymbol[m.Symbol] = true
		seenText[m.Text] = true

		// fmt 模板占位符白名单：跨端守卫以「%s→xx / %d→1 / %v→err」实例化
		// 文本对前端正则测试，出现其他动词（%w/%q）会让实例化失真
		for j := 0; j < len(m.Text)-1; j++ {
			if m.Text[j] != '%' {
				continue
			}
			switch m.Text[j+1] {
			case 's', 'd', 'v':
				j++
			default:
				t.Errorf("%s Text 含守卫不支持的占位符 %%%c（仅 %%s/%%d/%%v 可实例化）：%q", m.Symbol, m.Text[j+1], m.Text)
				j = len(m.Text)
			}
		}
	}
}

// kindShape Emitted 条目的 Text 必须取值自本包 const 块（行内字面量 = 绕过
// 唯一事实源）；External 反之不得与任何常量同值（仓外原文不该有仓内常量，
// 免得制造「已接线」的假象）。constExists 与常量表逐一比对——注册表行引用的
// 就是常量标识符，Text 值相等即视为引用成立。
func TestRegistryKindShape(t *testing.T) {
	consts := []string{
		IndexLockStale, GitWriteBusy, GitGateBusy, HunkDiscardConflict, ConflictStale,
		RebaseAbortedPrefix, StashStagedUnsupported, StashEntryGone, BranchExistsTemplate, ChangelistExists,
		ProjectLocked, DeployHostBusyTemplate, LogExpired, ApplyConflict,
		ReplaceBackupStale,
		HostKeyChanged, AuthRejectedPrefix, AuthenticationFailed, AuthHeaderInvalid,
		TooManyAuthFailures, PrecheckRuntimeMissingTemplate, PrecheckVersionCheckTemplate,
		CloneDestExists, CloneURLInvalid, QueueFull, QueueInvalid,
		FrozenTooLarge, FrozenQuota, ReplayTooLarge, RevealNoDisplay, RevealXdgMissing, RevealXdgExitTemplate,
		UpdateSourceNotConfigured, UpdateNpmManaged, CenterBinaryMissingTemplate, RemoteUnreachable,
		SessionBusy, MaxWsConnections, WrongPassphraseExport,
		SearchRateLimited,
		CredSyncUnverified, CredSyncEnvelopeRejected, CredSyncManualOnly,
	}
	constSet := map[string]bool{}
	for _, c := range consts {
		constSet[c] = true
	}
	for _, m := range Registry {
		inConsts := constSet[m.Text]
		if m.Kind == KindEmitted && !inConsts {
			t.Errorf("Emitted 条目 %s 的 Text %q 不来自 const 块——Emitted 必须引用常量（唯一事实源），勿写行内字面量", m.Symbol, m.Text)
		}
		if m.Kind == KindExternal && inConsts {
			t.Errorf("External 条目 %s 的 Text %q 与本包常量同值——External 是仓外原文，不该有仓内常量", m.Symbol, m.Text)
		}
	}
}
