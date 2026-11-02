#!/bin/bash
set -e

# 版本号取最近可达的 v* tag（剥 v 前缀，存裸 semver）；无 tag（CI 浅克隆需先
# git fetch --tags）或非 git 环境回落 dev——运行时比较器将其按最旧版本处理
VERSION="$(git describe --tags --match 'v[0-9]*' --abbrev=0 2>/dev/null | sed 's/^v//' || true)"
VERSION="${VERSION:-dev}"
COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
BUILD_TIME=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# ============================================================
# A5 发布侧配套（自更新验签）：
#   - CC_UPDATE_PUBKEY（base64 ed25519 公钥）→ 注入 ldflags，
#     运行时据此对更新包做 ed25519 验签（server/update/verify.go）
#   - CC_UPDATE_PRIVATE_KEY（base64 ed25519 私钥）→ 构建后为每个
#     二进制产出伴随资产 <binary>.sha256（hex 摘要）与 <binary>.sig
#     （对 hex 摘要字符串的 ed25519 签名，base64）
#   - 两者皆未设置 → 纯开发构建，不产出验签资产（运行时默认拒绝
#     无校验更新，除非 CC_UPDATE_ALLOW_UNVERIFIED=1）
#   - 密钥轮换：公钥编译进客户端体内，客户端只信「自己体内」的公钥。
#     过渡版本必须 CC_UPDATE_PUBKEY=新公钥 + CC_UPDATE_PRIVATE_KEY=旧私钥
#     ——老客户端验过旧私钥签名装上新包，体内公钥换新后，后续更新才
#     改用新私钥签。两者若同时换新，已部署客户端会验签失败拒绝更新。
#   密钥对生成：go run ./tools/updatekey keygen
# ============================================================

LDFLAGS="-s -w -X main.version=$VERSION -X main.commit=$COMMIT -X main.buildTime=$BUILD_TIME"

if [ -n "$CC_UPDATE_PUBKEY" ]; then
    LDFLAGS="$LDFLAGS -X codecombo/server/update.updatePubKey=$CC_UPDATE_PUBKEY"
    echo "==> Update verification pubkey: INJECTED (ed25519)"
else
    echo "==> Update verification pubkey: NOT SET (dev build; updates will require CC_UPDATE_ALLOW_UNVERIFIED=1)"
fi

# 支持的平台列表
PLATFORMS=(
    "windows/amd64"
    "windows/arm64"
    "linux/amd64"
    "linux/arm64"
    "darwin/amd64"
    "darwin/arm64"
)

echo "==> Version: $VERSION ($COMMIT, $BUILD_TIME)"

# 可选 lint 门禁位（P-20261002-68）：CC_LINT=1 时构建前跑 golangci-lint
#（配置见 .golangci.yml；lint 不绿则构建中止；二进制缺失则提示后跳过）
if [ "${CC_LINT:-0}" = "1" ]; then
    export PATH="$(go env GOPATH)/bin:$PATH"
    if command -v golangci-lint >/dev/null 2>&1; then
        echo "==> Lint (golangci-lint)..."
        golangci-lint run ./...
    else
        echo "==> CC_LINT=1 但 golangci-lint 未安装，已跳过（go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0）"
    fi
fi

echo "==> Building frontend..."
cd web
# npm ci（锁文件精确安装）：发布构建要确定性——npm install 的重新解析在
# runner 上曾致构建失败嫌疑（本地 npm install 可过的解析在干净环境会 ERESOLVE）
npm ci
npm run build
cd ..

rm -rf dist
mkdir -p dist

# sign_artifact 为构建产物生成伴随校验资产（需 CC_UPDATE_PRIVATE_KEY）
sign_artifact() {
    local file=$1
    if [ -z "$CC_UPDATE_PRIVATE_KEY" ]; then
        return 0
    fi
    # .sha256：小写 hex 摘要（verifyChecksum 直接比对）
    sha256sum "$file" | awk '{print $1}' > "$file.sha256"
    # .sig：对 hex 摘要字符串的 ed25519 签名（base64；verifySignature 直接验签）
    go run ./tools/updatekey sign "$CC_UPDATE_PRIVATE_KEY" < "$file" > "$file.sig"
    echo "    Signed: $(basename "$file") (+.sha256 +.sig)"
}

build_target() {
    local os=$1
    local arch=$2
    local ext=""
    if [ "$os" = "windows" ]; then ext=".exe"; fi
    local output="dist/codecombo-${os}-${arch}${ext}"
    echo "    Building $os/$arch..."
    CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -ldflags "$LDFLAGS" -o "$output" .
    sign_artifact "$output"
}

TARGET="${1:-}"

if [ "$TARGET" = "keygen" ]; then
    # 便捷入口：生成发布签名密钥对（私钥妥善保管，勿入仓库）
    go run ./tools/updatekey keygen
    exit 0
elif [ "$TARGET" = "all" ]; then
    echo "==> Building all platforms..."
    for p in "${PLATFORMS[@]}"; do
        os="${p%%/*}"
        arch="${p##*/}"
        build_target "$os" "$arch"
    done
elif [ -n "$TARGET" ]; then
    # 支持指定单个平台，如 windows/amd64 或 windows
    if [[ "$TARGET" == */* ]]; then
        os="${TARGET%%/*}"
        arch="${TARGET##*/}"
    else
        os="$TARGET"
        arch="amd64"
    fi
    echo "==> Building $os/$arch..."
    build_target "$os" "$arch"
else
    echo "==> Building current platform..."
    # 与 build_target 一致：禁用 cgo，避免本机构建动态链接 libc（交叉编译分支均为纯静态）
    CGO_ENABLED=0 go build -ldflags "$LDFLAGS" -o dist/codecombo .
    sign_artifact dist/codecombo
fi

echo "==> Output:"
ls -lh dist/
echo "==> Done!"
