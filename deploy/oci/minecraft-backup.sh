#!/usr/bin/env bash
set -uo pipefail

BACKUP_DIR="${IVRM_BACKUP_DIR:-/opt/ivrm/backup/minecraft}"
LOCAL_KEEP="${IVRM_BACKUP_LOCAL_KEEP:-2}"
DATE="$(TZ=Asia/Tokyo date '+%Y%m%d-%H%M%S')"
FAILED=0
FROZEN_CONTAINER=""

[[ "${LOCAL_KEEP}" =~ ^[1-9][0-9]*$ ]] || {
  echo "ERROR: IVRM_BACKUP_LOCAL_KEEP must be a positive integer" >&2
  exit 2
}

mkdir -p "${BACKUP_DIR}"

container_state() {
  local state
  if ! state="$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)"; then
    return 1
  fi
  case "${state}" in
    true) echo running ;;
    false) echo stopped ;;
    *) return 1 ;;
  esac
}

rcon_exec() {
  local container="$1"
  shift
  docker exec "${container}" rcon-cli "$@" >/dev/null 2>&1
}

restore_saves() {
  local container="$1" state
  if ! state="$(container_state "${container}")"; then
    return 1
  fi
  if [[ "${state}" == "running" ]]; then
    rcon_exec "${container}" save-on || return 1
    rcon_exec "${container}" save-all flush || rcon_exec "${container}" save-all || return 1
  fi
}

cleanup() {
  local rc=$?
  if [[ -n "${FROZEN_CONTAINER}" ]]; then
    if restore_saves "${FROZEN_CONTAINER}"; then
      FROZEN_CONTAINER=""
    else
      echo "CRITICAL: world saves could not be re-enabled for ${FROZEN_CONTAINER}" >&2
      rc=1
    fi
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

has_existing_backup() {
  compgen -G "${BACKUP_DIR}/$1-*.tar.gz" >/dev/null
}

backup_server() {
  local name="$1" container="$2" compose_dir="$3"
  local data_dir="${compose_dir}/data"
  local output="${BACKUP_DIR}/${name}-${DATE}.tar.gz"
  local partial="${output}.partial"
  local running=0 save_off=0 tar_rc=0 restore_failed=0 state

  if [[ ! -d "${data_dir}" ]]; then
    echo "Skip ${name}: data directory not found."
    return 0
  fi
  if ! state="$(container_state "${container}")"; then
    echo "ERROR: unable to inspect container state for ${container}" >&2
    FAILED=1
    return 1
  fi
  if [[ "${state}" == "stopped" ]]; then
    if has_existing_backup "${name}"; then
      echo "Skip ${name}: ${container} is stopped and an existing backup is available."
      return 0
    fi
    echo "Baseline backup: ${container} is stopped and no local backup exists."
  else
    running=1
  fi

  if [[ "${running}" -eq 1 ]]; then
    if ! rcon_exec "${container}" save-all flush && ! rcon_exec "${container}" save-all; then
      echo "ERROR: pre-backup save failed for ${container}" >&2
      FAILED=1
      return 1
    fi
    if ! rcon_exec "${container}" save-off; then
      echo "ERROR: save-off failed for ${container}" >&2
      FAILED=1
      return 1
    fi
    save_off=1
    FROZEN_CONTAINER="${container}"
    sleep 2
    if ! rcon_exec "${container}" save-all flush && ! rcon_exec "${container}" save-all; then
      echo "ERROR: frozen-world flush failed for ${container}" >&2
      FAILED=1
      if restore_saves "${container}"; then
        FROZEN_CONTAINER=""
      fi
      return 1
    fi
  fi

  local -a items=(data)
  if [[ "${name}" == "minecraft-main" ]]; then
    [[ -f "${compose_dir}/compose.yml" ]] && items+=(compose.yml)
    [[ -f "${compose_dir}/image-digest.txt" ]] && items+=(image-digest.txt)
    [[ -d "${compose_dir}/mods" ]] && items+=(mods)
    [[ -d "${compose_dir}/config" ]] && items+=(config)
    [[ -d "${compose_dir}/extras" ]] && items+=(extras)
  fi

  rm -f -- "${partial}"
  tar -C "${compose_dir}" \
    --exclude='data/.rcon-cli.env' \
    --exclude='data/.rcon-cli.yaml' \
    --exclude='data/config/spark/tmp' \
    --exclude='data/config/spark/tmp/*' \
    --exclude='data/logs' \
    --exclude='data/crash-reports' \
    --exclude='data/.cache' \
    --exclude='data/backups' \
    --exclude='secrets' \
    --exclude='secrets/*' \
    -czf "${partial}" "${items[@]}"
  tar_rc=$?

  if [[ "${running}" -eq 1 && "${save_off}" -eq 1 ]]; then
    if restore_saves "${container}"; then
      FROZEN_CONTAINER=""
    else
      echo "CRITICAL: world saves could not be re-enabled for ${container}" >&2
      FAILED=1
      restore_failed=1
    fi
  fi

  if [[ "${tar_rc}" -ne 0 ]]; then
    echo "ERROR: Failed to backup ${name}" >&2
    rm -f -- "${partial}"
    FAILED=1
    return 1
  fi

  if ! mv -- "${partial}" "${output}"; then
    echo "ERROR: Failed to finalize ${output}" >&2
    FAILED=1
    return 1
  fi
  if ! touch -- "${output}.pending"; then
    echo "ERROR: Failed to create pending marker for ${output}" >&2
    rm -f -- "${output}"
    FAILED=1
    return 1
  fi
  echo "Created: ${output}"
  [[ "${restore_failed}" -eq 0 ]]
}

while IFS='|' read -r name container compose_dir; do
  if ! backup_server "${name}" "${container}" "${compose_dir}"; then
    FAILED=1
    break
  fi
done <<'TARGETS'
minecraft-paper|mc-paper|/opt/ivrm/compose/minecraft-paper
minecraft-skyblock|mc-skyblock|/opt/ivrm/compose/minecraft-skyblock
minecraft-hardcore|mc-hardcore|/opt/ivrm/compose/minecraft-hardcore
minecraft-gtnh|mc-gtnh|/opt/ivrm/compose/minecraft-gtnh
minecraft-atm10|mc-atm10|/opt/ivrm/compose/minecraft-atm10
minecraft-main|mc-main|/opt/ivrm/compose/minecraft-main
TARGETS

for prefix in minecraft-paper minecraft-skyblock minecraft-hardcore minecraft-gtnh minecraft-atm10 minecraft-main; do
  mapfile -t backups < <(find "${BACKUP_DIR}" -maxdepth 1 -type f -name "${prefix}-*.tar.gz" ! -exec test -e '{}.pending' \; -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
  if (( ${#backups[@]} > LOCAL_KEEP )); then
    printf '%s\0' "${backups[@]:LOCAL_KEEP}" | xargs -0r rm -f --
  fi
done

exit "${FAILED}"
