#!/bin/sh
set -eu
umask 077
mkdir -p backups
stamp=$(date -u +%Y%m%d-%H%M%S)
# Each invocation gets a separate container directory. Leave a failed backup for diagnosis.
backup_dir=$(docker compose exec -T bot mktemp -d /data/backup-XXXXXXXX)
case "$backup_dir" in
  /data/backup-*) ;;
  *) echo "Unexpected backup path" >&2; exit 1 ;;
esac
docker compose exec -T bot node scripts/backup.mjs "$backup_dir/snapshot.db"
docker compose cp "bot:$backup_dir/snapshot.db" "backups/astra-trade-${stamp}-$$.db"
docker compose exec -T bot rm -- "$backup_dir/snapshot.db"
docker compose exec -T bot rmdir -- "$backup_dir"
echo "Verified backup copied to backups/astra-trade-${stamp}-$$.db"
