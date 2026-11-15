#!/bin/bash
# check-site-content.sh —— 官网内容防断链门禁（P-20261115-2-S3）。
#
# 动机：features 页（P-20261115-2-S1）与入口联动（S2）落地后，站内锚点引用面
# 成网（README Details → features 页锚、landing 顶导航/页尾 → guide 页、guide
# 三页互链）；S1/S2 执行器提交里的「双语 121/121 配对 + 锚点实存」静态审计是
# 人工执行——评审修正：落成真脚本防纸面。本脚本把两项检查程序化，姊妹于
# check-site-styles.sh（样式防乱），发布链自检位：docs/pages-publishing.md
# 「修改后要过的检查」节；agent 代改官网后同样必跑。
#
# 红条件（任一命中 exit 1）：
# ① 双语 data-lang 配对破坏：各页 HTML 剥注释后按文档序提取 data-lang-en /
#    data-lang-zh 裸属性标记——序列必须 en,zh 严格交替且起于 en，两侧计数相等
#    且 >0（零标记=单语页，同违「双语双份内联」约定）。注意实形：双份内联是
#    「属性存在」形态（<span data-lang-en>），不是 data-lang="en" 值形态——
#    后者是 <html> 上的运行态切换目标（site.js 写入，site.js:15）、data-lang-set
#    是语言按钮态属性（site.js:19），三者互不相干；值形态与 set 不入配对面。
#    「同 PR 双语同改」纪律（单语改动视为半成品不许合入）由此程序化。剥注释
#    后仍残留 data-lang-* 兄弟标记（新属性未登记入本脚本已知集）一并红。
# ② 锚点解析断链：各页 id= 集合 × href 引用对账——
#    - href="#frag"：frag 必须在本页 id 集合；
#    - href="REL#frag"（REL 剥 ?query 后为站内相对 HTML 页，双/单/无引三形态
#      都认）：目标页必须存在（改名/漏建即红），frag 必须在目标页 id 集合；
#      "/..." 形态按 site 根解析（发布树站点根=docs/，与 site/ 根同构）；
#    - href="REL" 无 frag 指向站内 .html：目标页必须存在（顶导航/页尾/侧栏
#      页级链接改名即红）；
#    - 页内重复 id：红（DOM 锚点语义不确定，跳谁随文档序漂）。
#    不在对账面（有意豁免，防假红）：http(s):// / 协议相对 // / mailto 等外部
#    引用（外部锚本地不可验）；非 .html 资产引用——img 的 ../docs/img/ 源码态
#    与 img/ 发布树态两形态由导出正则改写衔接（release-export.sh:215-217 注记），
#    本脚本只看源码态，两态一致性归导出树逐引用解析（pages-publishing.md
#    「一次发布要做的事」）；".. 链逃出 site/ 根"的 .html 引用同样豁免。
#
# 页面枚举：find site -type f -name '*.html'——新页自动纳入对账面（免登记，
# 与 release-export.sh excluded() 白名单外自动导出同向；样式面新页仍须先在
# check-site-styles.sh page_letter() 登记，两门禁分工见各自文件头）。
#
# 用法：bash scripts/check-site-content.sh   （任意 cwd 可跑，脚本自定位仓库根）
# 退出码：0=对账全绿；1=违规（禁止合入/导出发布）；2=环境/结构错误（site/ 缺失）。
# 纯 bash+POSIX 工具（grep/sed/awk/sort/find），无平台分支；读入一律先去 \r——
# 工作树 CRLF 与导出树 LF 两态同一口径（win Git Bash / mac / linux 三平台一致；
# mac 自带 bash 3.2，不用关联数组/mapfile）。

set -euo pipefail
export LC_ALL=C
cd "$(dirname "$0")/.."

fail=0

[ -d site ] || { echo "FATAL: 找不到 site/（应在仓库内运行，官网源勿移动）" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------- 提取器（POSIX awk；输入统一 join 成单行去 \r） ----------
strip_html_comments() {
  # 剥 <!-- ... -->（可跨行），注释体换一个空格保持词法分隔——页头注记/源锚
  # 注释里的旧锚点、data-lang 提及由此退出对账面（与 check-site-styles.sh 同件）
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
          line = substr(line, 1, s - 1) " " substr(rest, e + 3)
        }
      }
      print line
    }' "$@"
}
html_attr_values() {
  # 输出指定属性值原文（每属性一行）；双/单引号与无引号三形态都认，前邻是
  # 词字符（data-view-id= 等子串误命中）不认——防属性名截取假阳
  # 用法：html_attr_values id|href（首参=属性名，其余=输入文件）
  local attr="$1"; shift
  awk -v attr="$attr" '
    BEGIN { a = attr "="; alen = length(a); dq = sprintf("%c", 34); sq = sprintf("%c", 39) }
    { line = $0
      while ((s = index(line, a)) > 0) {
        if (s > 1) {
          prev = substr(line, s - 1, 1)
          if (prev ~ /[A-Za-z0-9_-]/) { line = substr(line, s + alen); continue }
        }
        line = substr(line, s + alen)
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
lang_tokens() {
  # 剥注释后的单行文本 → 双语标记流（每行 EN/ZH/UNKNOWN，文档顺序）。
  # gsub 替换串内 \n 是真换行——print 时自然切行，POSIX awk 无 gsub 捕获组也够。
  # data-lang-set 先剥（按钮态属性）；两标记替换后再查 data-lang- 残留 =
  # 未知兄弟属性（值形态 data-lang="en" 无连字符不误中）
  awk '
    {
      gsub(/data-lang-set/, "\nSET\n")
      gsub(/data-lang-en/, "\nEN\n")
      gsub(/data-lang-zh/, "\nZH\n")
      print
    }' | awk '
    /^EN$/ || /^ZH$/ { print; next }
    /^SET$/ { next }
    /data-lang-/ { printf "UNKNOWN\t%s\n", substr($0, index($0, "data-lang-"), 48) }
  '
}

# ---------- 页面枚举 ----------
find site -type f -name '*.html' | sort > "$WORK/pages.txt"
[ -s "$WORK/pages.txt" ] || { echo "FATAL: site/ 下没有任何 HTML 页——结构异常" >&2; exit 2; }

# ---------- 收集：双语标记流 + id 集 + href 引用 ----------
: > "$WORK/lang_seq.tsv"   # 页路径 \t EN|ZH（文档序）/ 页路径 \t UNKNOWN \t 上下文
: > "$WORK/ids.tsv"        # 页路径 \t id
: > "$WORK/refs.tsv"       # 页路径 \t frag \t 目标页（site 相对；同页引用目标=自身）
while IFS= read -r p; do
  [ -n "$p" ] || continue
  joined="$(tr -d '\r' < "$p" | tr '\n' ' ' | strip_html_comments)"
  printf '%s\n' "$joined" | lang_tokens \
    | awk -v p="$p" -F'\t' '
      $1 == "UNKNOWN" { printf "%s\tUNKNOWN\t%s\n", p, $2; next }
      { printf "%s\t%s\n", p, $1 }' >> "$WORK/lang_seq.tsv"
  printf '%s\n' "$joined" | html_attr_values id \
    | awk -v p="$p" '{ printf "%s\t%s\n", p, $0 }' >> "$WORK/ids.tsv"
  printf '%s\n' "$joined" | html_attr_values href \
    | awk -v p="$p" '{ printf "%s\t%s\n", p, $0 }' >> "$WORK/hrefs.raw"
done < "$WORK/pages.txt"

# ---------- 站内相对路径解析（POSIX bash，无外部调用） ----------
# 用法：within_site <基目录> <相对路径> → 规范化 site 相对路径；逃出 site/ 根输出空串
within_site() {
  local dir="$1" p="$2" out="" seg
  case "$p" in
    /*) dir=""; p="${p#/}" ;;          # "/..." 按站点根解析（发布树根=docs/ 同构）
  esac
  p="$dir${dir:+/}$p"
  while [ -n "$p" ]; do
    seg="${p%%/*}"
    case "$p" in */*) p="${p#*/}" ;; *) p="" ;; esac
    case "$seg" in
      ""|".") ;;
      "..") case "$out" in
              */*) out="${out%/*}" ;;
              *)  return ;;             # 根段再上跳/本就空——逃出 site/，不对账
            esac ;;
      *) out="$out/$seg" ;;
    esac
  done
  printf '%s' "${out#/}"
}

# href 值 → 引用对账行（页路径 \t frag \t 目标页）；断链（目标页缺失）即写红
: > "$WORK/bad_pages.txt"  # 页路径 \t href 原文
while IFS= read -r line; do
  [ -n "$line" ] || continue
  p="${line%%$'\t'*}"
  href="${line#*$'\t'}"
  case "$href" in
    *"#") frag=""; part="${href%#*}" ;;
    *"#"[^#]*) frag="${href#*#}"; part="${href%%#*}" ;;
    *) frag=""; part="$href" ;;
  esac
  part="${part%%\?*}"   # 剥 ?lang=zh-CN 等查询串（fragment 定位与语言参数正交）
  case "$part" in
    *"://"*|"//"*|"mailto:"*) continue ;;   # 外部引用不在对账面（文件头注记）
  esac
  if [ -z "$part" ]; then
    target="$p"                              # href="#frag" 同页
  else
    target="$(within_site "${p%/*}" "$part")" || continue
    [ -n "$target" ] || continue             # 逃出 site/ —— 不对账
  fi
  case "$target" in
    *.html) ;; *) continue ;;                # 非 HTML 资产不在对账面（文件头注记）
  esac
  if [ ! -f "$target" ]; then
    printf '%s\t%s\n' "$p" "$href" >> "$WORK/bad_pages.txt"
    continue
  fi
  [ -n "$frag" ] || continue                 # 页级链接存在性已验完
  printf '%s\t%s\t%s\n' "$p" "$frag" "$target" >> "$WORK/refs.tsv"
done < "$WORK/hrefs.raw"

echo "==> 官网内容防断链对账：site/**/*.html 双语 data-lang 配对 × 锚点解析"

# ---------- ① 双语 data-lang 配对 ----------
n_pages=$(wc -l < "$WORK/pages.txt" | tr -d ' ')
echo "==> [1/2] 双语 data-lang-en/zh 配对（${n_pages} 页；实形=属性存在形态，非 data-lang=\"en\" 值形态）"
grep -v $'\t''UNKNOWN' "$WORK/lang_seq.tsv" > "$WORK/lang_pairs.tsv" || true
grep $'\t''UNKNOWN' "$WORK/lang_seq.tsv" > "$WORK/lang_unknown.tsv" || true
# 计数 + 交替校验聚合（EN 偶位 / ZH 奇位 = 错序）
awk -F'\t' '
  { pos[$1]++
    if ($2 == "EN") { en[$1]++; if (pos[$1] % 2 == 0) alt[$1] = 1 }
    else            { zh[$1]++; if (pos[$1] % 2 == 1) alt[$1] = 1 } }
  END { for (p in en) printf "%s\t%d\t%d\t%d\n", p, en[p], zh[p], (alt[p] ? 1 : 0)
        for (p in zh) if (!(p in en)) printf "%s\t0\t%d\t0\n", p, zh[p] }
' "$WORK/lang_pairs.tsv" | sort > "$WORK/lang_stat.tsv"
n_en=0; n_zh=0
while IFS=$'\t' read -r p en zh alt; do
  n_en=$((n_en + en)); n_zh=$((n_zh + zh))
  if [ "$en" -eq 0 ] && [ "$zh" -eq 0 ]; then
    echo "  RED: $p 双语标记零出现——违反「双语 data-lang-en/zh 双份内联」页面约定"
    fail=1
  elif [ "$en" -ne "$zh" ]; then
    echo "  RED: $p data-lang-en=${en} / data-lang-zh=${zh} 计数不等——单语改动视为半成品（同 PR 双语同改纪律）"
    fail=1
  fi
  if [ "$alt" -eq 1 ]; then
    echo "  RED: $p 双语标记序列非 en,zh 严格交替——查 en/zh 对是否成对相邻（页头注记的双份内联形态）"
    fail=1
  fi
done < "$WORK/lang_stat.tsv"
# 零标记页（不出现在 lang_pairs.tsv 的页）单独亮红
for p in $(cat "$WORK/pages.txt"); do
  grep -qxF "$p" <(cut -f1 "$WORK/lang_pairs.tsv" | sort -u) || {
    echo "  RED: $p 双语标记零出现——违反「双语 data-lang-en/zh 双份内联」页面约定"
    fail=1
  }
done
while IFS=$'\t' read -r p ctx; do
  [ -n "$ctx" ] || continue
  echo "  RED: $p 出现未知 data-lang-* 兄弟标记：${ctx}——新属性先登记本脚本已知集再使用"
  fail=1
done < "$WORK/lang_unknown.tsv"

# ---------- ② 锚点解析 ----------
n_refs=$(wc -l < "$WORK/refs.tsv" | tr -d ' ')
echo "==> [2/2] 锚点解析（id 集合 × href 引用；站内 .html 目标 ${n_refs} 条带 frag）"
# 页级链接断链（目标页缺失）
while IFS=$'\t' read -r p href; do
  echo "  RED: $p 站内页链接断链：href=\"${href}\"——目标 .html 不在 site/ 内（改名/漏建？）"
  fail=1
done < "$WORK/bad_pages.txt"
# 重复 id
awk -F'\t' '{ c[$1 "\t" $2]++ } END { for (k in c) if (c[k] > 1) print k }' \
  "$WORK/ids.tsv" | sort > "$WORK/dup_ids.txt"
while IFS=$'\t' read -r p id; do
  echo "  RED: $p 重复 id=\"${id}\"——DOM 锚点语义不确定，跳转目标随文档序漂移"
  fail=1
done < "$WORK/dup_ids.txt"
# frag × 目标页 id 集合对账（哨兵行保两文件非空；键=target\tfrag）
{ printf '@@\t@@\n'; cat "$WORK/ids.tsv"; } > "$WORK/ids_all.tsv"
{ printf '@@\t@@\t@@\n'; cat "$WORK/refs.tsv"; } > "$WORK/refs_all.tsv"
awk -F'\t' '
  FNR == 1 { fidx++ }
  fidx == 1 { if ($0 == "@@\t@@") next; ids[$1 "\t" $2] = 1; next }
  fidx == 2 { if ($0 == "@@\t@@\t@@") next
    if (!(($3 "\t" $2) in ids)) printf "%s\t%s\t%s\n", $1, $2, $3 }
' "$WORK/ids_all.tsv" "$WORK/refs_all.tsv" | sort > "$WORK/broken_anchors.tsv"
while IFS=$'\t' read -r p frag target; do
  echo "  RED: $p 锚点断链：#${frag} → ${target} 无 id=\"${frag}\"（跨页改锚先查目标页 id 集）"
  fail=1
done < "$WORK/broken_anchors.tsv"

# ---------- 汇总 ----------
n_ids=$(wc -l < "$WORK/ids.tsv" | tr -d ' ')
echo "==> 对账面：${n_pages} 页 / 双语标记 en=${n_en} zh=${n_zh} / id ${n_ids} 个 / 站内锚引用 ${n_refs} 条"
if [ "$fail" -ne 0 ]; then
  echo "==> FAIL——内容对账存在违规，禁止合入/导出发布" >&2
  exit 1
fi
echo "==> PASS——内容对账全绿（双语配对成对交替、站内锚引用与 id 集全等、零重复 id）"
exit 0
