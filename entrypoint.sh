#!/bin/sh
set -eu

# SliceDock entrypoint: fixes ownership of /appdata, checks /data, then runs
# the backend as PUID:PGID (default 99:100 = nobody:users, Unraid-friendly).
# PUID=0 runs as root.

PUID=${PUID:-99}
PGID=${PGID:-100}
UMASK=${UMASK:-002}
APPDATA_DIR=${APPDATA_ROOT:-/appdata}
DATA_DIR=${DATA_ROOT:-/data}

case "$PUID$PGID" in
    *[!0-9]*)
        echo "[ENTRYPOINT] PUID and PGID must be numbers, got PUID=$PUID PGID=$PGID"
        exit 1
        ;;
esac
case "$UMASK" in
    [0-7][0-7][0-7] | [0-7][0-7][0-7][0-7]) ;;
    *)
        echo "[ENTRYPOINT] UMASK must be octal like 002, got $UMASK"
        exit 1
        ;;
esac

mkdir -p "$APPDATA_DIR" "$DATA_DIR"

if [ "$PUID" != 0 ]; then
    # /appdata only holds what SliceDock wrote, so it is handed over whole.
    find "$APPDATA_DIR" \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown -h "$PUID:$PGID" {} +

    # /data is user content: only take an empty folder, otherwise just warn.
    if ! gosu "$PUID:$PGID" test -w "$DATA_DIR" && [ -z "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
        chown "$PUID:$PGID" "$DATA_DIR"
    fi
    if ! gosu "$PUID:$PGID" test -w "$DATA_DIR"; then
        echo "[ENTRYPOINT] WARNING: $DATA_DIR is not writable by $PUID:$PGID — uploads will fail."
        echo "[ENTRYPOINT] Fix on the host: chown -R $PUID:$PGID <host folder>"
    fi
fi

umask "$UMASK"

if [ "$PUID" = 0 ]; then
    echo "[ENTRYPOINT] starting SliceDock as root (umask $UMASK)"
    exec "$@"
fi

echo "[ENTRYPOINT] starting SliceDock as $PUID:$PGID (umask $UMASK)"
exec gosu "$PUID:$PGID" "$@"
