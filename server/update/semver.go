package update

import (
	"strconv"
	"strings"
)

// CompareVersions 比较 semver 版本号（含预发布语义）
//
// 遵循 semver 2.0.0 预发布优先级规则：
//   - 无预发布 > 有预发布（1.0.0 > 1.0.0-alpha）
//   - 预发布标识符逐个比较：数字标识符按数值、字母按 ASCII
//   - 标识符数量少者 < 多者（前缀相等时）（1.0.0-alpha < 1.0.0-alpha.1）
//
// 返回 1 表示 a > b，-1 表示 a < b，0 表示相等
func CompareVersions(a, b string) int {
	a = strings.TrimPrefix(a, "v")
	b = strings.TrimPrefix(b, "v")

	if a == "dev" {
		if b == "dev" {
			return 0
		}
		return -1
	}
	if b == "dev" {
		return 1
	}

	mainA, preA := splitPreRelease(a)
	mainB, preB := splitPreRelease(b)

	// 主版本逐段数值比较
	cmp := compareMainVersion(mainA, mainB)
	if cmp != 0 {
		return cmp
	}

	// 主版本相等：semver 规则——无预发布 > 有预发布
	if preA == "" && preB == "" {
		return 0
	}
	if preA == "" {
		return 1
	}
	if preB == "" {
		return -1
	}

	return comparePreRelease(preA, preB)
}

// splitPreRelease 拆分主版本、预发布后缀（剥离构建元数据 +build.N——不影响优先级）
func splitPreRelease(v string) (main, pre string) {
	if idx := strings.IndexByte(v, '+'); idx >= 0 {
		v = v[:idx]
	}
	if idx := strings.IndexByte(v, '-'); idx > 0 {
		return v[:idx], v[idx+1:]
	}
	return v, ""
}

// compareMainVersion 逐段数值比较主版本（缺段补 0）
func compareMainVersion(a, b string) int {
	partsA := strings.SplitN(a, ".", 3)
	partsB := strings.SplitN(b, ".", 3)
	maxLen := len(partsA)
	if len(partsB) > maxLen {
		maxLen = len(partsB)
	}
	for i := 0; i < maxLen; i++ {
		va, vb := 0, 0
		if i < len(partsA) {
			va, _ = strconv.Atoi(partsA[i])
		}
		if i < len(partsB) {
			vb, _ = strconv.Atoi(partsB[i])
		}
		if va > vb {
			return 1
		}
		if va < vb {
			return -1
		}
	}
	return 0
}

// comparePreRelease 逐标识符比较预发布字符串：
// 数字标识符按数值比较，字母/混合按 ASCII；数量少者 < 多者（前缀相等时）
func comparePreRelease(a, b string) int {
	idsA := strings.Split(a, ".")
	idsB := strings.Split(b, ".")
	maxLen := len(idsA)
	if len(idsB) > maxLen {
		maxLen = len(idsB)
	}
	for i := 0; i < maxLen; i++ {
		if i >= len(idsA) {
			return -1 // a 是 b 的前缀 → a < b
		}
		if i >= len(idsB) {
			return 1
		}
		na, ea := strconv.Atoi(idsA[i])
		nb, eb := strconv.Atoi(idsB[i])
		isNumA := ea == nil
		isNumB := eb == nil
		switch {
		case isNumA && isNumB:
			if na > nb {
				return 1
			}
			if na < nb {
				return -1
			}
		case isNumA:
			return -1 // 数字标识符 < 字母标识符
		case isNumB:
			return 1
		default:
			if idsA[i] != idsB[i] {
				if idsA[i] < idsB[i] {
					return -1
				}
				return 1
			}
		}
	}
	return 0
}

// HasUpdate 判断是否有新版本可用
func HasUpdate(current, latest string) bool {
	return CompareVersions(latest, current) > 0
}
