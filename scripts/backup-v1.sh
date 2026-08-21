#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$PROJECT_DIR/backups"
DB_NAME="pasarpintar"

STAMP="$(date '+%Y%m%d-%H%M%S')"
NAME="pasarpintar-$STAMP.dump"
TMP_FILE="/tmp/$NAME"
FINAL_FILE="$BACKUP_DIR/$NAME"

mkdir -p "$BACKUP_DIR"

echo "===== PASAR PINTAR V1 BACKUP ====="
echo "Database : $DB_NAME"
echo "Output   : $FINAL_FILE"
echo

echo "[1/4] Membuat backup sementara..."
sudo -u postgres pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="$TMP_FILE" \
  "$DB_NAME"

echo "[2/4] Memverifikasi archive..."
sudo -u postgres pg_restore \
  --list "$TMP_FILE" >/dev/null

echo "[3/4] Memindahkan backup..."
sudo mv "$TMP_FILE" "$FINAL_FILE"
sudo chown ubuntu:ubuntu "$FINAL_FILE"
chmod 600 "$FINAL_FILE"

echo "[4/4] Memeriksa hasil..."
if [ ! -s "$FINAL_FILE" ]; then
  echo "FAIL: backup kosong"
  rm -f "$FINAL_FILE"
  exit 1
fi

SIZE="$(du -h "$FINAL_FILE" | awk '{print $1}')"

echo
echo "===== BACKUP RESULT ====="
echo "FILE   : $FINAL_FILE"
echo "SIZE   : $SIZE"
echo "STATUS : VERIFIED"

echo
echo "[CLEANUP] Menghapus backup lebih dari 14 hari..."
find "$BACKUP_DIR"   -type f   -name 'pasarpintar-*.dump'   -mtime +14   -delete

echo "RETENTION : 14 days"
