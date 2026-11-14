#!/usr/bin/env bash
# 第三世界 · Dify 不受干扰的取证工具（纯只读，不改任何东西）
#
#   bash guard-dify.sh snapshot before      # 部署前拍一张
#   ... 执行部署 ...
#   bash guard-dify.sh snapshot after       # 部署后再拍
#   bash guard-dify.sh diff before after    # 逐项比对，给出「有没有打扰到 Dify」的结论
#
# 设计原则：
#   • 只记录「若被我们改动就说明出了大事」的客观事实：端口归属、容器集合、
#     80 端口的 HTTP 响应、既有站点目录的 mtime。
#   • 不做 find 全盘扫描（会碰到别人的文件、也可能很慢）。
#   • 状态存在 /var/lib/arc-guard，删掉它不影响任何人。

set -uo pipefail
DIR=/var/lib/arc-guard
mkdir -p "$DIR"

snapshot() {
  local label="$1" out="$DIR/$label.txt"
  [[ -n "$label" ]] || { echo "用法：snapshot <label>"; exit 1; }
  {
    echo "# taken $(date -Is)"
    echo "# host $(hostname)"

    echo "## port-owner"
    for p in 80 443 8080 8787; do
      local owner
      owner=$(ss -lntp 2>/dev/null | awk -v P=":$p\$" '$4 ~ P {print $6}' | sed 's/users://;s/("//;s/".*//' | tr '\n' ',')
      echo "port.$p=${owner:-none}"
    done

    echo "## docker"
    if docker info >/dev/null 2>&1; then
      docker ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}' 2>/dev/null | sort | sed 's/^/ctr=/'
      docker images --format '{{.Repository}}:{{.Tag}}|{{.ID}}' 2>/dev/null | sort | sed 's/^/img=/'
    else
      echo "ctr=(docker unavailable)"
    fi

    echo "## http-80"
    echo "http80.code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 http://127.0.0.1/ 2>/dev/null || echo 000)"
    echo "http80.title=$(curl -s --max-time 6 http://127.0.0.1/ 2>/dev/null | tr -d '\n' | grep -oiE '<title>[^<]*</title>' | head -1)"
    echo "http80.server=$(curl -sI --max-time 6 http://127.0.0.1/ 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1)=="server"{print $2}' | head -1)"

    echo "## sites-mtime"
    for d in /opt /opt/dify /root /var/www /www/wwwroot /etc/nginx; do
      [[ -e "$d" ]] && echo "mtime.$d=$(stat -c '%y' "$d" 2>/dev/null | cut -c1-19)"
    done

    echo "## docker-root-mtime"
    [[ -e /var/lib/docker ]] && echo "mtime./var/lib/docker=$(stat -c '%y' /var/lib/docker 2>/dev/null | cut -c1-19)"

    echo "## memory"
    echo "mem.available=$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo)"
  } > "$out"
  echo "  ✓ 快照已存：$out"
}

diffit() {
  local a="$DIR/${1}.txt" b="$DIR/${2}.txt"
  [[ -f "$a" && -f "$b" ]] || { echo "缺少快照：$a / $b"; exit 1; }

  # 只比对这些 key：它们一旦变化就说明我们动到了别人的东西
  local keys='^port\.|^http80\.|^ctr=|^mtime\./opt/dify|^mtime\./etc/nginx'
  local A B
  A=$(grep -E "$keys" "$a" | sort)
  B=$(grep -E "$keys" "$b" | sort)

  echo "════ 与 Dify 相关的关键项比对 ════"
  if [[ "$A" == "$B" ]]; then
    echo "  ✓ 全部一致：端口归属、容器集合、80 端口响应、Dify 目录 mtime 均未变化"
    echo "    → 结论：本次操作没有触碰另一个挂载点"
  else
    echo "  ⚠ 发现差异："
    diff <(echo "$A") <(echo "$B") | sed 's/^/    /'
    echo "    → 逐条确认上面每一行是否由本次操作造成；不是自己造成的就必须查清"
  fi

  echo
  echo "════ 参考信息（允许变化，仅供判断）════"
  diff <(grep -E '^mem\.|^port\.8787|^port\.443' "$a") <(grep -E '^mem\.|^port\.8787|^port\.443' "$b") | sed 's/^/    /' || echo "    （无变化）"
}

case "${1:-}" in
  snapshot) snapshot "${2:-}" ;;
  diff)     diffit "${2:-}" "${3:-}" ;;
  *) echo "用法：$(basename "$0") snapshot <label> | diff <labelA> <labelB>"; exit 1 ;;
esac
