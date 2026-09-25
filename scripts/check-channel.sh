#!/data/data/com.termux/files/usr/bin/bash
# 检查 dsh-termux-notify 依赖的通知通道是否可用。
#
#   bash scripts/check-channel.sh
#
# 退出码：0 = 通道可用；1 = 缺少命令；2 = 缺少 Termux:API 应用；3 = 超时（应用没响应）
set -u

ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }

echo "Termux 通知通道自检"
echo

# 1) 命令是否存在
if ! command -v termux-notification >/dev/null 2>&1; then
  bad "找不到 termux-notification"
  info "修复：pkg install termux-api"
  exit 1
fi
ok "termux-notification 存在（$(command -v termux-notification)）"

# 2) Termux:API 应用是否安装
PACKAGES="$(cmd package list packages 2>/dev/null || pm list packages 2>/dev/null || true)"
if [ -n "$PACKAGES" ] && ! printf '%s' "$PACKAGES" | grep -q 'package:com\.termux\.api'; then
  bad "Termux:API 应用未安装（com.termux.api 不存在）"
  info "请安装 APK：https://f-droid.org/packages/com.termux.api/"
  info "或：https://github.com/termux/termux-api/releases"
  info "缺少应用时 termux-notification 不会报错，而是一直播挂等待 —— 所以先别急着测。"
  exit 2
elif [ -z "$PACKAGES" ]; then
  info "无法枚举应用列表（cmd/pm 都不可用），跳过应用检查"
else
  ok "Termux:API 应用已安装"
fi

# 3) 真发一条通知（带硬超时，避免挂死）
echo
echo "发送一条测试通知（最多等 10 秒）…"
if timeout 10 termux-notification --title "DSH 通知自检" --content "看到这条通知就说明通道打通了" --priority high --sound; then
  ok "已发送 —— 看看手机通知栏"
  exit 0
else
  status=$?
  bad "发送失败或超时（退出码 $status）"
  if [ "$status" -eq 124 ]; then
    info "超时通常意味着 Termux:API 应用没装好、或应用被系统限制了后台运行。"
  else
    info "检查 Termux:API 应用是否已安装并授权通知权限。"
  fi
  info "兜底方案：把插件的 backend 改成 command，转发到 ntfy / Bark / Telegram 等。"
  exit 3
fi
