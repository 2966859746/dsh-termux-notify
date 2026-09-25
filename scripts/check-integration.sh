#!/data/data/com.termux/files/usr/bin/bash
# 检查 dsh-termux-notify 是否被 DSH 正确装好并接线。
#
#   bash scripts/check-integration.sh
#
# 退出码 0 = 全部通过。它按 DSH 自己查找插件的方式逐层验证，不需要重启 DSH：
#   1. profile 里有没有这个 bundle、配置树里有没有这一行
#   2. 宿主半侧能不能按包名 import，且宿主/客户端共享的常量是否一致
#   3. 客户端 bundle 能不能被 dsh-client-modules 发现（复刻它的定位逻辑）
#   4. 三套测试全部通过
#
# 第 2、3 步的检查脚本各自是独立文件（scripts/check-*.mjs），避免在 bash 双引号里
# 嵌套 JS 字符串这种易错写法。
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/web"
DSH_BIN="${DSH_BIN:-$HOME/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js}"

ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
fail=0

echo "dsh-termux-notify 接线自检"
echo

# ---- 1) profile 组合 ----
echo "[1/4] profile 组合"
if [ ! -f "$DSH_BIN" ]; then
  bad "找不到 dsh 的 bin.js：$DSH_BIN"
  info "用 DSH_BIN=/path/to/bin.js 覆盖"
  exit 1
fi
if grep -q 'dsh-termux-notify' "$PROFILE_DIR/package.json" 2>/dev/null; then
  ok "profile package.json 里有依赖与 bundles 条目"
else
  bad "profile package.json 里没有 dsh-termux-notify"
  info "修复：node $DSH_BIN plugin --profile web add link:$PLUGIN_DIR"
  fail=1
fi
if node "$DSH_BIN" --profile web --dump-config 2>/dev/null | grep -q 'id: dsh-termux-notify'; then
  ok "配置树里有一行 dsh-termux-notify"
else
  bad "配置树里没有这一行"
  fail=1
fi

# ---- 2) 宿主半侧 + 宿主/客户端常量一致性 ----
echo
echo "[2/4] 宿主半侧（Node 按包名 import）"
if (cd "$PROFILE_DIR" && node "$SCRIPT_DIR/check-host.mjs" 2>&1); then
  ok "apply / name / SETTINGS_NAMESPACE / SettingsSchema 可用，且与客户端常量一致"
else
  bad "宿主半侧 import 或常量一致性检查失败（见上面的错误）"
  fail=1
fi

# ---- 3) 客户端 bundle 发现 ----
echo
echo "[3/4] 客户端 bundle 发现"
if (cd "$PROFILE_DIR" && node "$SCRIPT_DIR/check-client-bundle.mjs" 2>&1); then
  ok "dsh.client 声明、./client 导出、bundle 文件与内部 id 都对得上"
else
  bad "客户端 bundle 发现失败（见上面的错误）"
  fail=1
fi

# ---- 4) 测试 ----
echo
echo "[4/4] 测试套件"
for suite in run integration client; do
  if out=$(cd "$PLUGIN_DIR" && node "test/$suite.mjs" 2>&1); then
    ok "test/$suite.mjs — $(printf '%s' "$out" | grep -E '^[0-9]+ 通过' | tail -1)"
  else
    bad "test/$suite.mjs 失败"
    printf '%s\n' "$out" | tail -20
    fail=1
  fi
done

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32m全部通过\033[0m —— 重启 DSH 后，设置左侧导航里会多出「Termux 通知」这一页。\n'
else
  printf '\033[31m有检查未通过\033[0m —— 见上面的 ✗。\n'
fi
exit "$fail"
