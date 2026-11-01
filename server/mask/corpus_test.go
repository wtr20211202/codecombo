package mask

import (
	"encoding/json"
	"os"
	"testing"
)

// 双端一致性锚定（P-20261006-11）：共享语料 testdata/custom_patterns_corpus.json
// 是 Go（RE2，本文件）与 TS（RegExp，web/src/utils/sensitiveMask.test.ts）的
// 同一事实源——两侧各自编译 patterns 注入各自遮蔽链，逐 sample 断言全链
// 遮蔽输出一致。任一侧实现/方言假设漂移即测试红。语料选择与方言纪律见
// JSON 头部 comment 与 config.ValidateCustomSensitivePatterns。

type customCorpus struct {
	Patterns []string `json:"patterns"`
	Samples  []struct {
		Input  string `json:"input"`
		Masked string `json:"masked"`
	} `json:"samples"`
}

func TestCustomPatterns_CorpusConsistency(t *testing.T) {
	raw, err := os.ReadFile("testdata/custom_patterns_corpus.json")
	if err != nil {
		t.Fatalf("read corpus: %v", err)
	}
	var corpus customCorpus
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatalf("parse corpus: %v", err)
	}
	if len(corpus.Patterns) == 0 || len(corpus.Samples) == 0 {
		t.Fatalf("corpus must not be empty (patterns=%d samples=%d)", len(corpus.Patterns), len(corpus.Samples))
	}

	t.Cleanup(func() { SetCustomPatterns(nil) })
	if n := SetCustomPatterns(corpus.Patterns); n != len(corpus.Patterns) {
		t.Fatalf("corpus patterns must all compile on Go side: %d/%d", n, len(corpus.Patterns))
	}
	for _, s := range corpus.Samples {
		if got := MaskText(s.Input); got != s.Masked {
			t.Errorf("MaskText(%q) = %q, want %q", s.Input, got, s.Masked)
		}
	}
}
