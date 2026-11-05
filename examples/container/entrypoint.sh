#!/bin/sh
set -eu

# dori-superagent container entrypoint: start the herdr server, then run the
# container's command. Panes are hosted by the server, so they are reachable from any
# `docker exec -it` session. nohup keeps the server alive past the exec below.

nohup herdr server >/dev/null 2>&1 </dev/null &

exec "$@"
