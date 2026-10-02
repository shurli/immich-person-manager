#!/usr/bin/env bash
set -euo pipefail
image="${1:-immich-person-manager:test}"
container=''
cleanup() {
  if [ -n "$container" ]; then
    docker logs "$container" || true
    docker rm -f "$container" >/dev/null || true
  fi
}
trap cleanup EXIT
for mode in default custom; do
  port=3003
  options=()
  if [ "$mode" = custom ]; then
    port=43123
    options=(-e "PORT=$port")
  fi
  container="person-manager-ci-$mode"
  docker run --rm -d --name "$container" \
    -p "127.0.0.1::$port" --health-interval=1s --health-start-period=1s \
    -e IMMICH_URL=http://127.0.0.1:9 -e IMMICH_API_KEY=ci-not-a-real-key \
    "${options[@]}" "$image"
  binding="$(docker port "$container" "$port/tcp")"
  base="http://$binding"
  curl --silent --show-error --fail --retry 15 --retry-delay 1 \
    --retry-all-errors --retry-max-time 30 --max-time 3 "$base/healthz" \
    | node -e "let s=''; for await (const c of process.stdin) s+=c; const h=JSON.parse(s); if (!h.ok || h.app!=='immich-person-manager') process.exit(1)" --input-type=module
  curl --silent --show-error --fail "$base/" | grep 'Immich Person Manager' >/dev/null
  test "$(docker exec "$container" id -u)" = 1000
  healthy=false
  for attempt in $(seq 1 30); do
    if [ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" = healthy ]; then
      healthy=true
      break
    fi
    sleep 1
  done
  test "$healthy" = true
  echo "Container checks passed: $mode port $port, HTTP, UI, non-root user and Docker healthcheck."
  cleanup
  container=''
done
