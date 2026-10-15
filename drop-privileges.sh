#!/bin/sh
# Container entrypoint shared by all three images (issue #100). Identical copies live in
# radicale/ and sync-worker/ because each image has its own build context.
#
# All three services open the same SQLite file, so they run under one fixed uid:gid, 1000:1000
# (the `node` user of node:22-alpine). When the container is started as root — the store template
# sets `user: "0:0"` because shard_core creates the bind-mounted data directory root-owned — this
# script hands every directory in DATA_DIRS to 1000:1000 and re-executes itself as that uid. The
# service process itself never runs as root. Started as any other uid it changes nothing and
# refuses to start if a data directory is not writable.
set -eu

APP_UID=1000
APP_GID=1000

: "${DATA_DIRS:?DATA_DIRS must list the directories the service writes to}"

if [ "$(id -u)" = "0" ]; then
  for dir in $DATA_DIRS; do
    mkdir -p "$dir"
    chown -R "$APP_UID:$APP_GID" "$dir"
  done
  # A root start leaves HOME=/root (mode 0700), which uid 1000 cannot use.
  export HOME=/tmp
  exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --clear-groups --inh-caps=-all --no-new-privs -- "$0" "$@"
fi

for dir in $DATA_DIRS; do
  if [ ! -d "$dir" ] || [ ! -w "$dir" ]; then
    echo "[entrypoint] FATAL: data directory $dir is not writable by uid $(id -u)." >&2
    echo "[entrypoint] Start the container as root so it can take ownership, or chown $dir to $APP_UID:$APP_GID." >&2
    exit 1
  fi
done

exec "$@"
