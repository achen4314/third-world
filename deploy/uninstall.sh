#!/usr/bin/env bash
# 第三世界 · 精确回滚（只删「我们自己创建的东西」）
#
#   bash uninstall.sh            # 干跑，只列出将删什么
#   bash uninstall.sh --yes      # 真删
#
# 安全设计：
#   • 删除目标是硬编码白名单，逐个断言「路径必须以白名单前缀开头」，否则直接退出。
#   • 遇到 /opt/dify、/var/lib/docker、/etc/nginx 这类路径，**任何情况下**都拒绝并报错退出。
#   • /etc/caddy/Caddyfile 只在文件里含 ARC-MANAGED 标记时才删除；别人的 Caddy 配置一字不动。
#   • 我们不装 nginx、不碰 docker，所以回滚也不需要 stop/restart 任何既有服务。

set -uo pipefail

APPLY=0
[[ "${1:-}" == "--yes" ]] && APPLY=1

ROOT=/opt/arc-training
UNIT=/etc/systemd/system/arc-admin.service
ENVFILE_DIR=/etc/arc-training
SUDOERS=/etc/sudoers.d/arc-admin
CADDY=/etc/caddy/Caddyfile
GUARD=/var/lib/arc-guard
RUNUSER=arcadmin

# 绝对禁止出现在删除目标里的路径（防手误 / 防参数被污染）
FORBIDDEN='/opt/dify|/var/lib/docker|/etc/nginx|/usr/share/nginx|^/opt$|^/var/lib$|^/etc$|^/root$'

die() { echo "✗ $*"; exit 1; }
say() { echo "$*"; }

plan=()
add() {
  local p="$1"
  if [[ "$p" =~ $FORBIDDEN ]]; then die "拒绝操作受保护路径：$p"; fi
  plan+=("$p")
}

[[ $EUID -eq 0 ]] || die "请用 root 执行"

say "── 将停止并禁用的服务（只有我们自己的）──"
say "  arc-admin${USER_UNIT:-}   （caddy 是否停止取决于是否还有别的 Caddyfile，见下）"

say "── 将删除的路径 ──"
for p in "$UNIT" "$ROOT" "$ENVFILE_DIR" "$SUDOERS" "$GUARD"; do
  [[ -e "$p" ]] && add "$p" && say "  $p"
done

if [[ -f "$CADDY" ]]; then
  if grep -q 'ARC-MANAGED' "$CADDY"; then
    add "$CADDY"; say "  $CADDY   （含 ARC-MANAGED 标记，是我们写的）"
  else
    say "  ⚠ $CADDY 不是我们写的（无 ARC-MANAGED 标记）→ 保留不动"
  fi
fi

CADDY_BAKS=$(ls -1 /etc/caddy/Caddyfile.bak.* 2>/dev/null || true)
if [[ -n "$CADDY_BAKS" ]]; then
  say "── 找到我们备份过的原 Caddyfile ──"
  echo "$CADDY_BAKS" | sed 's/^/  /'
  say "  （如需还原：cp <上面最新的一个> /etc/caddy/Caddyfile）"
fi

if [[ $APPLY -eq 0 ]]; then
  say ""
  say "以上为干跑结果。确认无误后执行：bash $0 --yes"
  exit 0
fi

say ""
say "── 1/4 停服务 ──"
systemctl disable --now arc-admin 2>/dev/null && say "  ✓ arc-admin 已停" || say "  · arc-admin 本来就没在跑"

say "── 2/4 删文件 ──"
for p in "${plan[@]}"; do
  # 二次断言：必须是绝对路径、不能是 / 、不能含 ..
  [[ "$p" == /* && "$p" != "/" && "$p" != *..* ]] || die "路径异常，中止：$p"
  rm -rf -- "$p" && say "  ✓ 已删 $p"
done
systemctl daemon-reload

say "── 3/4 清理专用用户 ──"
if id "$RUNUSER" >/dev/null 2>&1; then
  userdel "$RUNUSER" 2>/dev/null && say "  ✓ 已删除用户 $RUNUSER"
else
  say "  · 用户 $RUNUSER 不存在"
fi

say "── 4/4 门面收尾 ──"
if [[ ! -f "$CADDY" ]]; then
  if systemctl is-active --quiet caddy 2>/dev/null; then
    systemctl stop caddy && say "  ✓ Caddyfile 已无，caddy 已停止"
  fi
else
  systemctl reload caddy 2>/dev/null && say "  ✓ caddy 已按保留的配置重载"
fi

say ""
say "完成。请现在验证「另一个挂载点」毫发无损："
say "  curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1/     # 应仍是 307"
say "  curl -s http://127.0.0.1/ | grep -o '<title>[^<]*</title>'      # 应仍是 Dify"
say "  bash $ROOT/deploy/guard-dify.sh diff before after               # 若脚本还在，直接比对"
