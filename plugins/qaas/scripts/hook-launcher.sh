#!/bin/sh
set -eu

launcher_dir=$(
  CDPATH= cd -- "$(dirname -- "$0")"
  pwd -P
)

# Compatibility shim for older packaged references. Registered hooks call
# hook-launcher.mjs directly with exec-form arguments and do not require a shell.
if node "$launcher_dir/hook-launcher.mjs" "$@"; then
  exit 0
fi
exit 2
