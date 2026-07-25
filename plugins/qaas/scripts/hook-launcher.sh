#!/bin/sh
set -eu
PATH=/usr/bin:/bin
export PATH

launcher_succeeded=0

normalize_launcher_exit() {
  status=$?
  trap - 0
  if [ "$launcher_succeeded" -eq 1 ]; then
    exit "$status"
  fi
  exit 2
}

launcher_fail() {
  echo "$1" >&2
  exit 2
}

trap normalize_launcher_exit 0

if [ "$#" -ne 1 ]; then
  launcher_fail "QaaS hook launcher requires one fixed plugin script"
fi

launcher_dir=$(
  CDPATH= cd -- "$(dirname -- "$0")"
  pwd -P
)
requested_script=$1
script_name=$(basename -- "$requested_script")
case "$script_name" in
  pretool-safety.mjs|posttool-ledger.mjs|session-state.mjs) ;;
  *)
    launcher_fail "QaaS hook launcher rejected an unknown script"
    ;;
esac

script_dir=$(
  CDPATH= cd -- "$(dirname -- "$requested_script")"
  pwd -P
)
canonical_script="$script_dir/$script_name"
if [ "$script_dir" != "$launcher_dir" ] || [ ! -f "$canonical_script" ] || [ -L "$canonical_script" ]; then
  launcher_fail "QaaS hook launcher rejected a script outside its attested directory"
fi

canonical_optional_dir() {
  candidate_dir=$1
  if [ -n "$candidate_dir" ] && [ -d "$candidate_dir" ]; then
    (
      CDPATH= cd -- "$candidate_dir"
      pwd -P
    )
  fi
}

project_dir=$(canonical_optional_dir "${CLAUDE_PROJECT_DIR:-}")
plugin_data_dir=$(canonical_optional_dir "${CLAUDE_PLUGIN_DATA:-}")

is_protected_location() {
  candidate_path=$1
  for protected_dir in "$project_dir" "$plugin_data_dir" "$launcher_dir"; do
    if [ -n "$protected_dir" ]; then
      case "$candidate_path" in
        "$protected_dir"|"$protected_dir"/*) return 0 ;;
      esac
    fi
  done
  return 1
}

try_node() {
  candidate=$1
  case "$candidate" in
    [A-Za-z]:[\\/]*)
      candidate=$(cygpath -u "$candidate")
      ;;
  esac
  [ -f "$candidate" ] && [ -x "$candidate" ] || return 1
  if [ -L "$candidate" ]; then
    command -v realpath >/dev/null 2>&1 || return 1
    canonical_candidate=$(realpath "$candidate") || return 1
  else
    candidate_dir=$(
      CDPATH= cd -- "$(dirname -- "$candidate")"
      pwd -P
    )
    canonical_candidate="$candidate_dir/$(basename -- "$candidate")"
  fi
  [ -f "$canonical_candidate" ] && [ -x "$canonical_candidate" ] || return 1
  is_protected_location "$canonical_candidate" && return 1
  version=$("$canonical_candidate" --version 2>/dev/null || true)
  case "$version" in
    v24.*)
      if "$canonical_candidate" "$canonical_script"; then
        launcher_succeeded=1
        exit 0
      fi
      launcher_fail "QaaS Node hook process failed closed"
      ;;
  esac
  return 1
}

if [ -n "${QAAS_TRUSTED_NODE24:-}" ]; then
  case "$QAAS_TRUSTED_NODE24" in
    /*|[A-Za-z]:[\\/]*)
      try_node "$QAAS_TRUSTED_NODE24" || true
      ;;
    *)
      echo "QAAS_TRUSTED_NODE24 must be an absolute path" >&2
      ;;
  esac
fi

for candidate in \
  /usr/bin/node \
  /usr/local/bin/node \
  /opt/homebrew/bin/node \
  /opt/local/bin/node
do
  try_node "$candidate" || true
done

for drive_letter in \
  c d e f g h i j k l m n o p q r s t u v w x y z
do
  drive="/$drive_letter"
  try_node "$drive/Program Files/nodejs/node.exe" || true
  try_node "$drive/Program Files (x86)/nodejs/node.exe" || true
done

launcher_fail "QaaS requires Node 24 at a fixed system location; project/PATH runtimes are denied"
