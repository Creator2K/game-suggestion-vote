#!/bin/sh
set -e

# 用 root 启动时（compose 默认行为），先把挂进来的目录交给 node 用户，
# 否则 bind mount 的目录属于宿主机的 root，容器里的 node 写不进去。
# 降权之后再跑应用，容器内部不用 root。
if [ "$(id -u)" = "0" ]; then
  DATA_DIR="${DATA_DIR:-/app/data}"
  BACKUP_DIR="${BACKUP_DIR:-/app/backups}"

  mkdir -p "$DATA_DIR" "$BACKUP_DIR"

  if [ "$(stat -c '%u' "$DATA_DIR")" != "$(id -u node)" ]; then
    chown -R node:node "$DATA_DIR" "$BACKUP_DIR"
  fi

  exec su-exec node "$@"
fi

exec "$@"
