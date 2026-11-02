#!/bin/sh
# Stands in for omo in the e2e test: no model call, it plays a lane that reads its brief, reports and claims done.
set -eu
dori() { sh -c "$DORI_E2E_CMD \"\$@\"" dori "$@"; }
brief=$(printf '%s' "$1" | sed -n 's/.*Read and execute the lane brief at \(.*\) in full\..*/\1/p')
key=$(printf '%s' "$1" | sed -n 's/.*You are the \([a-z0-9._-]*\) lane;.*/\1/p')
test -f "$brief"
dori report "$key" --kind milestone --text "read brief: $(head -n 1 "$brief")"
dori ready "$key" --text "e2e lane finished" --evidence "file://$brief"
