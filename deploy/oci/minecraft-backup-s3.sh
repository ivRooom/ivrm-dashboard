#!/usr/bin/env bash
set -Eeuo pipefail

BUCKET="${IVRM_BACKUP_BUCKET:?IVRM_BACKUP_BUCKET is required}"
REGION="${IVRM_BACKUP_REGION:-ap-northeast-1}"
BACKUP_DIR="${IVRM_BACKUP_DIR:-/opt/ivrm/backup/minecraft}"
DAILY_KEEP="${IVRM_BACKUP_DAILY_KEEP:-14}"
AWS_BIN="${IVRM_AWS_BIN:-/usr/local/bin/aws}"
BACKUP_BIN="${IVRM_BACKUP_BIN:-/usr/local/bin/mc-backup}"
EVIDENCE_BIN="${IVRM_BACKUP_EVIDENCE_BIN:-/usr/local/libexec/ivrm-backup-evidence}"

export AWS_PAGER=""

[[ "${DAILY_KEEP}" =~ ^[1-9][0-9]*$ ]] || {
  echo "ERROR: IVRM_BACKUP_DAILY_KEEP must be a positive integer" >&2
  exit 2
}

OBJECTS_JSON="$(mktemp)"
HEAD_JSON="$(mktemp)"
EVIDENCE_DIR="${IVRM_BACKUP_EVIDENCE_DIR:-/run/ivrm-backup/evidence}"
cleanup() { rm -f -- "${OBJECTS_JSON}" "${HEAD_JSON}"; }
trap cleanup EXIT
install -d -m 0750 "${EVIDENCE_DIR}"

set +e
"${BACKUP_BIN}"
PRODUCER_RC=$?
set -e

mapfile -d '' PENDING_MARKERS < <(
  find "${BACKUP_DIR}" -maxdepth 1 -type f -name '*.tar.gz.pending' -print0 | sort -z
)

process_marker() {
  local marker="$1" file base key evidence sha256_hex verified_evidence evidence_tmp dow dom hour
  file="${marker%.pending}"
  if [[ ! -f "${file}" ]]; then
    echo "ERROR: pending marker has no archive: ${marker}" >&2
    return 1
  fi
  base="$(basename "${file}")"
  key="minecraft/daily/${base}"
  if ! evidence="$("${EVIDENCE_BIN}" "${file}")"; then
    return 1
  fi
  if ! sha256_hex="$(jq -er '.sha256Hex' <<<"${evidence}")"; then
    return 1
  fi

  if ! "${AWS_BIN}" s3 cp "${file}" "s3://${BUCKET}/${key}" \
    --region "${REGION}" \
    --checksum-algorithm SHA256 \
    --metadata "ivrm-sha256=${sha256_hex}" \
    --only-show-errors \
    --no-cli-pager; then
    return 1
  fi

  if ! "${AWS_BIN}" s3api head-object \
    --bucket "${BUCKET}" \
    --key "${key}" \
    --checksum-mode ENABLED \
    --region "${REGION}" \
    --output json \
    --no-cli-pager >"${HEAD_JSON}"; then
    return 1
  fi
  if ! verified_evidence="$("${EVIDENCE_BIN}" "${file}" --head-json "${HEAD_JSON}")"; then
    return 1
  fi
  evidence_tmp="${EVIDENCE_DIR}/${base}.json.tmp"
  if ! printf '%s\n' "${verified_evidence}" >"${evidence_tmp}" ||
    ! chmod 0640 "${evidence_tmp}" ||
    ! mv -- "${evidence_tmp}" "${EVIDENCE_DIR}/${base}.json"; then
    rm -f -- "${evidence_tmp}"
    return 1
  fi

  dow="$(TZ=Asia/Tokyo date +%u)" dom="$(TZ=Asia/Tokyo date +%d)" hour="$(TZ=Asia/Tokyo date +%H)"
  if [[ "${dow}" == 7 && "$((10#${hour}))" -lt 12 ]]; then
    if ! "${AWS_BIN}" s3 cp "s3://${BUCKET}/${key}" "s3://${BUCKET}/minecraft/weekly/${base}" \
      --region "${REGION}" --copy-props all --only-show-errors --no-cli-pager; then
      return 1
    fi
  fi
  if [[ "${dom}" == 01 && "$((10#${hour}))" -lt 12 ]]; then
    if ! "${AWS_BIN}" s3 cp "s3://${BUCKET}/${key}" "s3://${BUCKET}/minecraft/monthly/${base}" \
      --region "${REGION}" --copy-props all --only-show-errors --no-cli-pager; then
      return 1
    fi
  fi
}

UPLOAD_FAILED=0
for marker in "${PENDING_MARKERS[@]}"; do
  if ! process_marker "${marker}"; then
    echo "ERROR: failed to process pending archive: ${marker}" >&2
    UPLOAD_FAILED=1
  fi
done

if "${AWS_BIN}" s3api list-objects-v2 \
  --bucket "${BUCKET}" --prefix minecraft/daily/ --region "${REGION}" \
  --output json --no-cli-pager >"${OBJECTS_JSON}"; then

  mapfile -d '' DELETE_KEYS < <(python3 - "${OBJECTS_JSON}" "${DAILY_KEEP}" <<'PY'
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
keep = int(sys.argv[2])
pattern = re.compile(r"^minecraft/daily/(?P<server>.+)-(?P<stamp>\d{8}-\d{6})\.tar\.gz$")
groups = defaultdict(list)
for item in data.get("Contents", []):
    match = pattern.fullmatch(item.get("Key", ""))
    if match:
        groups[match.group("server")].append((match.group("stamp"), item["Key"]))
for entries in groups.values():
    entries.sort(reverse=True)
    for _, key in entries[keep:]:
        sys.stdout.write(key + "\0")
PY
  )

  for key in "${DELETE_KEYS[@]}"; do
    if ! "${AWS_BIN}" s3api delete-object \
      --bucket "${BUCKET}" --key "${key}" --region "${REGION}" --no-cli-pager >/dev/null; then
      UPLOAD_FAILED=1
    fi
  done
else
  echo "ERROR: failed to list daily backup objects; pruning skipped" >&2
  UPLOAD_FAILED=1
fi

if ! find "${BACKUP_DIR}" -maxdepth 1 -type f -name '*.partial' -mtime +1 -print -delete; then
  UPLOAD_FAILED=1
fi

if [[ "${PRODUCER_RC}" -ne 0 ]]; then
  exit "${PRODUCER_RC}"
fi
exit "${UPLOAD_FAILED}"
