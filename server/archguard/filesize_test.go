package archguard

// 单文件体量守卫（2026-11-18 用户定向「避免单文件过大」，流水线决议 33）：
// 大文件是分层退化与职责堆积的滞后指标——体量在 diff 里长出来时拦最便宜，
// 拆分在它成型后做最贵。本测试扫 server/ 全部 .go（testdata 除外），超阈值
// 文件与基线（testdata/filesize-baseline.txt）对账：
//   - 超阈且不在基线 → FAIL（新犯零容忍）；
//   - 在基线但实际行数 > 登记值 → FAIL（基线条目继续增长 = 拆分欠账加深，
//     更新基线必须附拆分立项理由，不许静默放宽）；
//   - 基线条目对应的文件已降到阈下 → 提示清理（stale，不 FAIL）。
//
// 阈值口径：Go 1500 行（存量最大 office.go 2154）。豁免唯一通道 = 基线 +
// 理由（拆分立项），与 check-motion 的 motion-baseline.json 同族纪律。
// 前端侧同源闸见 web/scripts/check-file-size.mjs（vue/ts/css 阈值不同）。
import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const fileSizeLimitGo = 1500

var updateFileSizeBaseline = flag.Bool("update-baseline", false, "重写体量基线（存量超阈文件登记；登记须附拆分立项理由）")

type fileSizeOffender struct {
	rel   string
	lines int
}

func countFileLines(path string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	n := strings.Count(string(data), "\n")
	if len(data) > 0 && !strings.HasSuffix(string(data), "\n") {
		n++
	}
	return n, nil
}

func TestFileSizeLimits(t *testing.T) {
	repo := filepath.Join("..", "..") // 测试 cwd=server/archguard，两级回仓库根
	var offenders []fileSizeOffender
	err := filepath.WalkDir(filepath.Join(repo, "server"), func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "testdata" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") {
			return nil
		}
		n, cerr := countFileLines(p)
		if cerr != nil {
			return cerr
		}
		if n > fileSizeLimitGo {
			rel, _ := filepath.Rel(repo, p)
			offenders = append(offenders, fileSizeOffender{rel: filepath.ToSlash(rel), lines: n})
		}
		return nil
	})
	if err != nil {
		t.Fatalf("扫描失败: %v", err)
	}

	baselinePath := filepath.Join(repo, "server", "archguard", "testdata", "filesize-baseline.txt")
	baseline := map[string]int{}
	stale := []string{}
	if raw, rerr := os.ReadFile(baselinePath); rerr == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			parts := strings.SplitN(line, "\t", 3)
			if len(parts) < 2 {
				continue
			}
			n := 0
			// 解析失败（行格式坏）→ n 保持 0，登记 0 行被下方「实际行数>
			// 登记值」判定红——fail-closed 语义成立，错误无须另路处理
			_, _ = fmt.Sscanf(parts[1], "%d", &n)
			baseline[parts[0]] = n
		}
	} else if !*updateFileSizeBaseline {
		t.Fatalf("基线缺失（首跑请 -update-baseline 生成）: %v", rerr)
	}

	if *updateFileSizeBaseline {
		sort.Slice(offenders, func(i, j int) bool { return offenders[i].rel < offenders[j].rel })
		var b strings.Builder
		b.WriteString("# 单文件体量基线：rel\\tlines\\treason（行）——豁免唯一通道=基线+拆分立项理由\n")
		b.WriteString("# 每个条目隐含承诺：该文件拆分收敛另行立项，登记后继续增长会被本测试拦下\n")
		for _, o := range offenders {
			b.WriteString(fmt.Sprintf("%s\t%d\t存量遗留，拆分收敛另行立项\n", o.rel, o.lines))
		}
		if werr := os.WriteFile(baselinePath, []byte(b.String()), 0o644); werr != nil {
			t.Fatalf("写基线失败: %v", werr)
		}
		t.Logf("基线已重写：%d 个超阈文件", len(offenders))
		return
	}

	sort.Slice(offenders, func(i, j int) bool { return offenders[i].rel < offenders[j].rel })
	var fresh []string
	var grown []string
	for _, o := range offenders {
		if recorded, ok := baseline[o.rel]; !ok {
			fresh = append(fresh, fmt.Sprintf("%s: %d 行（阈值 %d）——拆分或经拆分立项后 -update-baseline 登记", o.rel, o.lines, fileSizeLimitGo))
		} else if o.lines > recorded {
			grown = append(grown, fmt.Sprintf("%s: %d 行 > 基线登记 %d 行——拆分欠账加深，更新基线须附拆分立项理由", o.rel, o.lines, recorded))
		}
	}
	for rel, recorded := range baseline {
		actual, aerr := countFileLines(filepath.Join(repo, filepath.FromSlash(rel)))
		if aerr != nil {
			stale = append(stale, fmt.Sprintf("%s: 基线条目文件已不存在", rel))
			continue
		}
		if actual <= fileSizeLimitGo {
			stale = append(stale, fmt.Sprintf("%s: %d 行已回到阈下，基线条目可清理", rel, actual))
		} else if recorded > actual {
			t.Logf("基线条目已过时（登记 %d > 实际 %d）：%s —— 可 -update-baseline 收紧", recorded, actual, rel)
		}
	}
	if len(fresh) > 0 || len(grown) > 0 {
		for _, s := range append(append([]string{}, fresh...), grown...) {
			t.Errorf("%s", s)
		}
	}
	for _, s := range stale {
		t.Logf("stale: %s", s)
	}
}
