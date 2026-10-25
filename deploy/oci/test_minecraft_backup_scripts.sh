#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
LOCAL="${ROOT}/deploy/oci/minecraft-backup.sh"
S3="${ROOT}/deploy/oci/minecraft-backup-s3.sh"
ENV_EXAMPLE="${ROOT}/deploy/oci/backup.env.example"
DROP_IN="${ROOT}/deploy/oci/mc-backup-s3-hardening.conf"

bash -n "${LOCAL}"
bash -n "${S3}"

grep -Fq -- "--exclude='data/.rcon-cli.env'" "${LOCAL}"
grep -Fq -- "--exclude='data/.rcon-cli.yaml'" "${LOCAL}"
grep -Fq -- 'IVRM_BACKUP_LOCAL_KEEP:-2' "${LOCAL}"
grep -Fq -- 'IVRM_BACKUP_DAILY_KEEP:-14' "${S3}"
grep -Fq -- '--checksum-algorithm SHA256' "${S3}"
grep -Fq -- '--checksum-mode ENABLED' "${S3}"
grep -Fq -- 'ivrm-sha256=' "${S3}"
grep -Fq -- '*.tar.gz.pending' "${S3}"
grep -Fq -- 'process_marker()' "${S3}"
grep -Fq -- 'UPLOAD_FAILED=1' "${S3}"
grep -Fq -- 'touch -- "${output}.pending"' "${LOCAL}"
grep -Fq -- "--exclude='data/server.properties'" "${LOCAL}"
grep -Fq -- 'rcon\.password' "${LOCAL}"
grep -Fq -- 'CRITICAL: world saves could not be re-enabled' "${LOCAL}"
grep -Fq -- 'ERROR: pre-backup save failed' "${LOCAL}"
grep -Fq -- 'ERROR: unable to inspect container state' "${LOCAL}"
grep -Fq -- 'break' "${LOCAL}"
grep -Fq -- 'IVRM_BACKUP_BUCKET=replace-with-production-bucket' "${ENV_EXAMPLE}"
grep -Fq -- 'EnvironmentFile=/etc/ivrm-agent/backup.env' "${DROP_IN}"

if grep -Eq '(AWS_SECRET_ACCESS_KEY|IVRM_AGENT_TOKEN)=' "${LOCAL}" "${S3}"; then
  echo 'ERROR: backup scripts must not embed credentials' >&2
  exit 1
fi
