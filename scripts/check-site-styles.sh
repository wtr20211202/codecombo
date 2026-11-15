#!/bin/bash
# check-site-styles.sh —— 官网样式防乱门禁（P-20261115-1-S4）。
#
# 动机（P-20261115-1）：把 site.css 文件头 SHARED-CLASS REGISTRY 登记表的口头
# 纪律变成程序化对账，终结「每次改官网都会乱样式」——同时服务人工评审与
# agent 代改官网后的自检。发布链自检位：docs/pages-publishing.md
# 「修改后要过的检查」+「样式防乱纪律」节。
#
# 红条件（任一命中 exit 1）：
# ① 页内 <style> 重定义共享类：各 site/**/*.html <style> 块的类选择器 ×
#    site.css 类选择器定义集（程序化提取——非手工清单，手工清单会漂移成新
#    土法）求交，命中即红。页内 <style> 新增未登记类会被 ③ 拦下（HTML 用到
#    未登记类即红），故 <style> 实际只容得下白名单内的显式豁免——确属合法的
#    页级微调在 STYLE_WHITELIST 开 `页路径:类名` 豁免行（循 duplicates-baseline
#    渐进先例；当前三页零 <style>，白名单为空=零误报起点）。
# ② 登记表解析契约：SHARED-CLASS REGISTRY 块以含「SHARED-CLASS REGISTRY」的
#    行起、「END SHARED-CLASS」行止。注意：文件头注记与块内契约散文自身都
#    引用了这两标记串——起始锚取首现行（多算的头注散文无碍：登记项只认
#    「|」起始行）；END 必须锚**最后一次**出现（锚首现会把块腰斩在散文句内，
#    S3 合并时已实锚此坑）。登记项=块内以「|」起始的行，去空白后恰 5 字段
#    class|scope|pages|定义分区|说明（说明内不得含「|」）；scope 词汇、pages
#    字符集（LGEF）、类名形态逐项校验，类名重复登记即红。
# ③ 三方对账（登记表 × site.css 定义集 × 各页 HTML class 使用集）：
#    - 未登记：site.css 或 HTML 任一侧出现登记表外的类即红（新增类先登记
#      再写规则，registry 契约 ④）；
#    - 有名无实/无名有实：shared/guide/landing/start/faq 五类 scope 必须在
#      site.css 有定义；hook 必须 site.css 零规则且不进任何页内 <style>；
#      state 必须 site.css 有定义且静态 HTML 不可见（site.js 动态挂摘）；
#    - pages 对账：五类 scope 与 hook 的 HTML 实际使用页集合必须与 pages
#      字段逐类相等——页内私有类外溢、登记页未用、用了漏登记，同一条双向拦；
#      state 的 pages 是参考面不做相等检查。
#
# 页字母映射（registry pages 字段词汇）：L=site/index.html、
# G=site/guide/getting-started.html、F=site/guide/faq.html、
# E=site/guide/features.html（features 尾字母——首字母 F 已被 faq 占用）。
# 新增站点页必须先在下方 page_letter() 登记字母映射、同步 registry 契约
# 散文（scope 语义/pages 字符集行）与相关 shared 类 pages 字段再建页
# （P-20261115-2 建页联动点，实勘矩阵=docs/features-page-matrix.md）——
# 出现未登记字母的页即红，「先登记再写规则」对新页同样成立。
#
# 用法：bash scripts/check-site-styles.sh   （任意 cwd 可跑，脚本自定位仓库根）
# 退出码：0=对账全绿；1=违规（禁止合入/导出发布）；2=环境/结构错误（文件缺失）。
# 纯 bash+POSIX 工具（grep/sed/awk/sort/comm/find），无平台分支；读入一律先
# 去 \r——工作树 CRLF 与导出树 LF 两态同一口径（win Git Bash / mac / linux
# 三平台一致；mac 自带 bash 3.2，不用关联数组/mapfile）。

set -euo pipefail
export LC_ALL=C
cd "$(dirname "$0")/.."

CSS=site/assets/site.css
fail=0

[ -f "$CSS" ] || { echo "FATAL: 找不到 $CSS（应在仓库内运行，site/ 结构勿移动）" >&2; exit 2; }

# ---------- 页字母映射：新站点页在此登记（见文件头「页字母映射」注记） ----------
page_letter() {
  case "$1" in
    site/index.html)                 echo L ;;
    site/guide/getting-started.html) echo G ;;
    site/guide/faq.html)             echo F ;;
    site/guide/features.html)        echo E ;;
    *) return 1 ;;
  esac
}

# ---------- 合法页级微调白名单（循 duplicates-baseline 渐进先例） ----------
# 当前为零 <style> 干净基线。将来出现首个合法的页内 <style> 覆盖时，在此开
# `页路径:类名` 行并附缘由注释；豁免只放开 ① 的重定义红，③ 三方对账不豁免
# （该类仍须登记进 registry、仍受 pages 对账约束）。
STYLE_WHITELIST=(
  # 示例（勿取消注释）：site/guide/faq.html:faq-item  # faq 页 Xxx 微调，缘由…
)
wl_hit() {
  needle="$1"
  # ${arr[@]+…} 卫星展开：bash 3.2（mac）空数组在 set -u 下会炸，此写法三版本皆安
  for w in ${STYLE_WHITELIST[@]+"${STYLE_WHITELIST[@]}"}; do
    [ "$w" = "$needle" ] && return 0
  done
  return 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------- 提取器（POSIX awk，输入已 join 成单行去 \r） ----------
strip_css_comments() {
  # /* ... */ 剥除（可跨行），注释体换一个空格保持词法分隔——登记表/头注等
  # 注释面由此退出对账面，选择器提取不再吃到散文里的 `.css`/`.woff2` 等
  awk '
    { line = $0
      while (1) {
        if (incmt) {
          e = index(line, "*/")
          if (e == 0) { line = ""; break }
          incmt = 0; line = substr(line, e + 2)
        } else {
          s = index(line, "/*")
          if (s == 0) break
          rest = substr(line, s + 2)
          e = index(rest, "*/")
          if (e == 0) { incmt = 1; line = substr(line, 1, s - 1); break }
          line = substr(line, 1, s - 1) " " substr(rest, e + 2)
        }
      }
      print line
    }' "$@"
}
strip_html_comments() {
  awk '
    { line = $0
      while (1) {
        if (incmt) {
          e = index(line, "-->")
          if (e == 0) { line = ""; break }
          incmt = 0; line = substr(line, e + 3)
        } else {
          s = index(line, "<!--")
          if (s == 0) break
          rest = substr(line, s + 4)
          e = index(rest, "-->")
          if (e == 0) { incmt = 1; line = substr(line, 1, s - 1); break }
          line = substr(line, 1, s - 1) substr(rest, e + 3)
        }
      }
      print line
    }' "$@"
}
html_class_attrs() {
  # 输出 class 属性值原文（每属性一行）；双/单引号与无引号三形态都认，
  # 前邻是词字符（data-class= 等）不认——防属性名子串误命中
  awk '
    BEGIN { dq = sprintf("%c", 34); sq = sprintf("%c", 39) }
    { line = $0
      while ((s = index(line, "class=")) > 0) {
        if (s > 1) {
          prev = substr(line, s - 1, 1)
          if (prev ~ /[A-Za-z0-9_-]/) { line = substr(line, s + 6); continue }
        }
        line = substr(line, s + 6)
        q = substr(line, 1, 1)
        if (q == dq || q == sq) {
          e = index(substr(line, 2), q)
          if (e == 0) break
          print substr(line, 2, e - 1)
          line = substr(line, e + 1)
        } else {
          n = match(line, /[ \t>]/)
          if (n == 0) { print line; break }
          if (n > 1) print substr(line, 1, n - 1)
          line = substr(line, n)
        }
      }
    }' "$@"
}
html_style_blocks() {
  # 输出 <style>…</style> 块内容（join 成单行后开闭同行的形态也覆盖）
  awk '
    { line = $0; instyle = 0; out = ""
      while (1) {
        if (instyle) {
          e = index(line, "</style>")
          if (e == 0) { out = out line; break }
          out = out substr(line, 1, e - 1)
          instyle = 0; line = substr(line, e + 8); continue
        }
        s = index(line, "<style")
        if (s == 0) break
        tail = substr(line, s)
        g = index(tail, ">")
        if (g == 0) { instyle = 1; break }
        rest = substr(tail, g + 1)
        e = index(rest, "</style>")
        if (e == 0) { out = out rest; instyle = 1; break }
        if (e > 1) out = out substr(rest, 1, e - 1)
        line = substr(rest, e + 8)
      }
      if (out != "") print out
    }' "$@"
}
css_class_tokens() {
  # 类选择器提取：只取「选择器上下文」（{ 前且不含 } ; 的文本段），声明值里
  # 的小数/url 后缀不会混入；输入须已剥 CSS 注释
  grep -oE '[^{};]*\{' | grep -oE '\.[A-Za-z][A-Za-z0-9_-]*' | sed 's/^\.//'
}

# ---------- 对账面 1：site.css 类定义集（程序化提取） ----------
: > "$WORK/css_classes.txt"
tr -d '\r' < "$CSS" | tr '\n' ' ' | strip_css_comments | css_class_tokens \
  | sort -u > "$WORK/css_classes.txt" || true

# ---------- 对账面 2：各页 HTML class 使用集 + 页内 <style> 类集 ----------
: > "$WORK/html_cls.tsv"     # class \t 页字母（聚合前）
: > "$WORK/html_by_page.tsv" # 页路径 \t class（未登记类归属页用）
: > "$WORK/style_cls.tsv"    # 页路径 \t class（页内 <style>）
: > "$WORK/unmapped_pages.txt"
while IFS= read -r p; do
  [ -n "$p" ] || continue
  # <style> 对账对未登记字母的页也做（rogue 页两红并存：未登记页 + 重定义）
  tr -d '\r' < "$p" | tr '\n' ' ' | strip_html_comments | html_style_blocks \
    | strip_css_comments | css_class_tokens | sort -u > "$WORK/pstyle.txt" || true
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    printf '%s\t%s\n' "$p" "$c" >> "$WORK/style_cls.tsv"
  done < "$WORK/pstyle.txt"

  letter=$(page_letter "$p" || true)
  if [ -z "$letter" ]; then
    printf '%s\n' "$p" >> "$WORK/unmapped_pages.txt"
    continue
  fi
  tr -d '\r' < "$p" | tr '\n' ' ' | strip_html_comments | html_class_attrs \
    | tr -s ' \t' '\n' | grep -v '^$' | sort -u > "$WORK/pcls.txt" || true
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    printf '%s\t%s\n' "$c" "$letter" >> "$WORK/html_cls.tsv"
    printf '%s\t%s\n' "$p" "$c" >> "$WORK/html_by_page.tsv"
  done < "$WORK/pcls.txt"
done < <(find site -type f -name '*.html' | sort)
[ -s "$WORK/html_by_page.tsv" ] || { echo "FATAL: site/ 下没有任何 HTML 页——结构异常" >&2; exit 2; }
# class → 实际使用页字母集聚合（字母序随页面枚举序，③ 侧 canon 统一按 LGEF 固定序规范化后比较）
awk -F'\t' '{ u[$1] = u[$1] $2 } END { for (c in u) print c "\t" u[c] }' \
  "$WORK/html_cls.tsv" | sort > "$WORK/html_used.tsv"

echo "==> 官网样式防乱对账：site.css × site/**/*.html × SHARED-CLASS REGISTRY"

# ---------- ① 页内 <style> 重定义对账 ----------
n_style=$(cut -f2 "$WORK/style_cls.tsv" | sort -u | grep -c . || true)
echo "==> [1/3] 页内 <style> 重定义对账（页内 <style> 类 ${n_style} 个）"
while IFS=$'\t' read -r p c; do
  [ -n "$c" ] || continue
  grep -Fxq "$c" "$WORK/css_classes.txt" || continue
  if wl_hit "$p:$c"; then
    echo "    豁免（白名单）：$p 页内 <style> 定义 .$c"
  else
    echo "  RED: $p 页内 <style> 重定义共享类 .$c——site.css 已定义，页级覆盖会「改一页乱全站」"
    echo "       确属合法页级微调 → 脚本 STYLE_WHITELIST 开「$p:$c」豁免行并附缘由；否则改回 site.css 单点"
    fail=1
  fi
done < "$WORK/style_cls.tsv"

# ---------- ② 登记表解析契约 ----------
echo "==> [2/3] SHARED-CLASS REGISTRY 解析契约（END 锚末次出现）"
reg_ok=1
: > "$WORK/t_reg.tsv"
reg_start=$(grep -n 'SHARED-CLASS REGISTRY' "$CSS" | head -n1 | cut -d: -f1 || true)
reg_end=$(grep -n 'END SHARED-CLASS' "$CSS" | tail -n1 | cut -d: -f1 || true)
if [ -z "$reg_start" ] || [ -z "$reg_end" ]; then
  echo "  RED: SHARED-CLASS REGISTRY 块标记缺失（起始行或 END 行不见——块被删/改名）"
  fail=1; reg_ok=0
elif [ "$reg_end" -le "$reg_start" ]; then
  echo "  RED: SHARED-CLASS REGISTRY 块范围非法（start=$reg_start end=$reg_end——END 行在起始标记之前？）"
  fail=1; reg_ok=0
else
  sed -n "$((reg_start + 1)),$((reg_end - 1))p" "$CSS" | tr -d '\r' \
    | grep -E '^[[:space:]]*[|]' \
    | sed -e 's/^[[:space:]]*//' \
          -e 's/^[|]//' \
          -e 's/\*\/[[:space:]]*$//' \
          -e 's/[[:space:]]*$//' \
          -e 's/[|][[:space:]]*$//' \
          -e 's/[[:space:]]*$//' \
    | awk -F'|' '
      function trims(t) { gsub(/^[ \t]+/, "", t); gsub(/[ \t]+$/, "", t); return t }
      {
        if (NF != 5) { printf "RED\tregistry 行字段数=%d（契约=5，说明内不得含「|」）：%s\n", NF, $1; next }
        cls = trims($1); scope = trims($2); pages = trims($3); sect = trims($4); desc = trims($5)
        if (cls !~ /^[a-z][a-z0-9-]*$/) { printf "RED\tregistry 类名形态非法（须 ^[a-z][a-z0-9-]*$）：%s\n", cls; next }
        if (scope !~ /^(shared|guide|landing|start|faq|hook|state)$/) { printf "RED\tregistry scope 词汇非法：%s（%s）\n", scope, cls; next }
        if (pages !~ /^[LGEF]+$/) { printf "RED\tregistry pages 字符集非法（须 LGEF 组合）：%s（%s）\n", pages, cls; next }
        if (sect == "" || desc == "") { printf "RED\tregistry 定义分区/说明不得留空：%s\n", cls; next }
        if (cls in seen) { printf "RED\tregistry 类重复登记：%s\n", cls; next }
        seen[cls] = 1
        print cls "\t" scope "\t" pages
      }' > "$WORK/reg_raw.txt"
  while IFS= read -r line; do
    case "$line" in
      RED$'\t'*) fail=1; echo "  RED: ${line#RED$'\t'}" ;;
      ?*)        printf '%s\n' "$line" >> "$WORK/t_reg.tsv" ;;
    esac
  done < "$WORK/reg_raw.txt"
fi

# ---------- ③ 三方对账：登记表 × site.css 定义集 × HTML class 使用集 ----------
echo "==> [3/3] 三方对账（登记表 × site.css 定义集 × HTML class 使用集）"
if [ "$reg_ok" -eq 1 ]; then
  # 3a 未登记 CSS 类
  cut -f1 "$WORK/t_reg.tsv" | sort -u > "$WORK/reg_cls.txt"
  comm -23 "$WORK/css_classes.txt" "$WORK/reg_cls.txt" > "$WORK/css_unreg.txt" || true
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    echo "  RED: site.css 类 .$c 未入 SHARED-CLASS REGISTRY——新增类先登记再写规则（registry 契约 ④）"
    fail=1
  done < "$WORK/css_unreg.txt"
  # 3b 未登记 HTML 类
  cut -f2 "$WORK/html_by_page.tsv" | sort -u | comm -23 - "$WORK/reg_cls.txt" > "$WORK/html_unreg.txt" || true
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    hits=$(awk -F'\t' -v c="$c" '$2 == c { printf "%s ", $1 }' "$WORK/html_by_page.tsv")
    echo "  RED: HTML 类 .$c 未入 SHARED-CLASS REGISTRY（页：$hits）——新增类先登记再写规则"
    fail=1
  done < "$WORK/html_unreg.txt"
  # 3c/3d 逐登记项：scope 语义 × CSS 定义 × 页内 <style> × pages 字段相等
  # 三个查找集各垫一行 @@ 哨兵保证非空（链式 FNR==NR 需要前文件非空；类名不可能为 @）
  { echo '@@'; cat "$WORK/html_used.tsv"; } > "$WORK/in_used.txt"
  { echo '@@'; cut -f2 "$WORK/style_cls.tsv" | sort -u; } > "$WORK/in_style.txt"
  { echo '@@'; cat "$WORK/css_classes.txt"; } > "$WORK/in_css.txt"
  awk -F'\t' '
    function canon(s,   i, c, r) {
      # 页字母集规范化：按 LGEF 固定序重排（registry 侧与聚合侧写序不同也等值比较）
      r = ""
      for (i = 1; i <= length("LGEF"); i++) {
        c = substr("LGEF", i, 1)
        if (index(s, c) > 0) r = r c
      }
      return r
    }
    # 文件序靠 FNR==1 计数区分（FNR==NR 只对首文件成立，链式同条件判不了后续文件）；
    # @@ 哨兵保证每个查找集至少一行、fidx 计数不错位（空文件不会触发 FNR==1）
    FNR==1 { fidx++ }
    fidx==1 { if ($0 == "@@") next; used[$1] = $2; next }
    fidx==2 { if ($0 == "@@") next; style[$0] = 1; next }
    fidx==3 { if ($0 == "@@") next; css[$0] = 1; next }
    {
      cls = $1; scope = $2; pages = $3
      u = canon((cls in used) ? used[cls] : "")
      p = canon(pages)
      if (scope == "state") {
        if (!(cls in css))
          printf "RED\t%s (state)：site.css 无定义——state 是 site.js 运行态类，样式须落 site.css\n", cls
        else if (u != "")
          printf "RED\t%s (state)：出现在静态 HTML（页 %s）——state 只能由 site.js 动态挂摘，静态写死会让无 JS 态错乱\n", cls, u
        next
      }
      if (scope == "hook") {
        if (cls in css)
          printf "RED\t%s (hook)：site.css 出现规则——hook 契约=无样式结构钩子，要加样式先改 scope 再登记\n", cls
        else if (cls in style)
          printf "RED\t%s (hook)：出现在页内 <style>——hook 零样式契约对页内样式同样成立\n", cls
      } else {
        if (!(cls in css))
          printf "RED\t%s (%s)：登记表有名、site.css 无规则——删类须连登记一起删，写样式须落 site.css\n", cls, scope
      }
      if (u != p)
        printf "RED\t%s (%s)：pages 字段=%s 与 HTML 实际使用页=%s 不一致——页内私有类外溢/登记页未用/漏登记页皆算漂移\n", cls, scope, p, u
    }' "$WORK/in_used.txt" "$WORK/in_style.txt" "$WORK/in_css.txt" "$WORK/t_reg.tsv" > "$WORK/item_reds.txt"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "  RED: ${line#RED$'\t'}"
    fail=1
  done < "$WORK/item_reds.txt"
fi
while IFS= read -r p; do
  [ -n "$p" ] || continue
  echo "  RED: 页 $p 未登记页字母映射——先在 check-site-styles.sh page_letter() 登记、同步 registry 契约散文与相关 shared 类 pages 字段，再建页（P-20261115-2 联动点）"
  fail=1
done < "$WORK/unmapped_pages.txt"

# ---------- 汇总 ----------
n_reg=$(wc -l < "$WORK/t_reg.tsv" | tr -d ' ')
n_css=$(grep -c . "$WORK/css_classes.txt" || true)
n_html=$(cut -f1 "$WORK/html_used.tsv" | grep -c . || true)
echo "==> 对账面：registry ${n_reg} 项 / site.css ${n_css} 类 / HTML ${n_html} 类 / 页内 <style> ${n_style} 类"
if [ "$fail" -ne 0 ]; then
  echo "==> FAIL——样式对账存在违规，禁止合入/导出发布" >&2
  exit 1
fi
echo "==> PASS——样式对账全绿（页内零 <style> 重定义、登记表契约、三方一致）"
exit 0
