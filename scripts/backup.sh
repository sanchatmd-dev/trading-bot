#!/bin/sh
set -eu
mkdir -p backups
stamp=$(date -u +%Y%m%d-%H%M%S)
docker compose exec -T bot node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/astra-v2.db');d.exec(\"VACUUM INTO '/data/backup.db'\");d.close()"
docker compose cp bot:/data/backup.db "backups/astra-trade-${stamp}.db"
docker compose exec -T bot rm -f /data/backup.db
echo "Backup saved: backups/astra-trade-${stamp}.db"
