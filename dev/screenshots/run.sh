#!/bin/bash
# Checks the web UI with invented sample data and writes docs/screenshots.
set -u
POD=bbb-stress-shots; DATA=$(mktemp -d); OUT=$PWD/docs/screenshots
podman pod rm -f "$POD" >/dev/null 2>&1
cleanup() { podman pod rm -f "$POD" >/dev/null 2>&1; podman unshare rm -rf "$DATA" 2>/dev/null; podman unshare chown -R 0:0 "$OUT"; chmod 755 "$OUT"; }
trap cleanup EXIT
rm -f "$OUT"/*.png; chmod 777 "$DATA" "$OUT"
podman run --rm --memory=256m --user 0 -v "$DATA":/d -v "$PWD/dev/screenshots":/s:ro docker.io/library/node:24-alpine sh -c 'node /s/seed.mjs /d && chmod -R a+rwX /d'
podman pod create --name "$POD" >/dev/null
cp dev/e2e-config.yaml "$DATA/config.yaml"
podman run -d --pod "$POD" --name "$POD-ctl" --memory=256m --cpus=1 --user 1001 --security-opt no-new-privileges --cap-drop=ALL -v "$DATA":/data -v "$DATA/config.yaml":/etc/bbb-stress/config.yaml:ro localhost/bbb-stress-controller:dev >/dev/null
sleep 3
podman run --rm --pod "$POD" --memory=2g --cpus=3 --shm-size=512m --user 1001 -e HOME=/tmp -v "$OUT":/out -v "$PWD/dev/screenshots":/s:ro localhost/bbb-stress-bot:dev node /s/shoot.mjs /out
