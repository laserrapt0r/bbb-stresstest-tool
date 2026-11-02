#!/bin/bash
# Full run against fake-bbb in a Podman pod. All containers run as under the "restricted"
# profile: read-only, no capabilities, no privilege escalation, UID 1001, with limits.
set -u
CFG=${1:?absolute path to config.yaml}; SCN=${2:?path to scenario.json}; BOTS=${3:-3}; POD=bbb-stress-e2e
cleanup() { podman pod rm -f "$POD" >/dev/null 2>&1; }
trap cleanup EXIT; cleanup
podman pod create --name "$POD" >/dev/null
podman run -d --pod "$POD" --name "$POD-fake" --memory=256m --cpus=1 -v "$PWD/fake-bbb":/fake:ro \
  docker.io/library/node:24-alpine node /fake/server.mjs >/dev/null
podman run -d --pod "$POD" --name "$POD-ctl" --memory=256m --cpus=1 --user 1001 --read-only --tmpfs /data:rw,mode=1777 \
  --security-opt no-new-privileges --cap-drop=ALL -v "$CFG":/etc/bbb-stress/config.yaml:ro localhost/bbb-stress-controller:dev >/dev/null
sleep 3
call() { podman exec "$POD-fake" node -e "
  const [m,p,f]=process.argv.slice(1);fetch('http://localhost:8080'+p,{method:m,headers:{authorization:'Bearer e2e-admin-token-1234',...(f?{'content-type':'application/json'}:{})},body:f||undefined}).then(async r=>console.log(await r.text()))" "$@"; }
echo '--- Preflight'; call POST /api/preflight "$(cat "$SCN")"
echo '--- Start'; OUT=$(call POST /api/runs "$(cat "$SCN")"); echo "${OUT%%botToken*}"
RUN=$(echo "$OUT" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'); TOKEN=$(echo "$OUT" | sed -n 's/.*"botToken":"\([^"]*\)".*/\1/p')
[ -n "$RUN" ] || { podman logs "$POD-ctl"; exit 1; }
for i in $(seq 1 "$BOTS"); do
  podman run -d --pod "$POD" --name "$POD-bot$i" --memory=1500m --cpus=1.5 --shm-size=256m --user 1001 --read-only \
    --tmpfs /tmp:rw,mode=1777,size=512m --security-opt no-new-privileges --cap-drop=ALL \
    -e CONTROLLER_URL=http://localhost:8080 -e RUN_ID="$RUN" -e BOT_TOKEN="$TOKEN" -e BOT_ID="bot$i" localhost/bbb-stress-bot:dev >/dev/null
done
for _ in $(seq 1 ${E2E_TIMEOUT:-90}); do
  sleep 2; R=$(call GET "/api/runs/$RUN")
  echo "$R" | grep -q '"phase":"finished"' && break
done
echo "--- Log (ctl status: $(podman inspect -f "{{.State.ExitCode}} oom={{.State.OOMKilled}}" "$POD-ctl"))"; podman logs "$POD-ctl" 2>&1 | tail -25
echo '--- Result'; echo "$R" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(JSON.stringify({outcome:r.outcome,capacityUsers:r.capacityUsers,message:r.message},null,1));for(const x of r.steps)console.log(JSON.stringify(x))})" 2>/dev/null || echo "$R"
echo '--- CSV'; call GET "/api/runs/$RUN/report.csv"
echo '--- Bot logs'; for i in $(seq 1 "$BOTS"); do echo "bot$i: exit=$(podman inspect -f '{{.State.ExitCode}} {{.State.Status}}' "$POD-bot$i")"; podman logs "$POD-bot$i" 2>&1 | tail -4; done
echo '--- fake-bbb: meetings after the end'; podman exec "$POD-fake" wget -qO- http://localhost:8090/fake/state; echo
