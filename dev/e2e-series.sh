#!/bin/bash
# Test series against fake-bbb: two saved scenarios, bots started per run as under the
# "external" backend. Checks /metrics during the run and the reports afterwards.
set -u
CFG=${1:?absolute path to config.yaml}; SCN=${2:?path to scenario.json}; POD=bbb-stress-series
cleanup() { podman pod rm -f "$POD" >/dev/null 2>&1; }
trap cleanup EXIT; cleanup
podman pod create --name "$POD" >/dev/null
podman run -d --pod "$POD" --name "$POD-fake" --memory=256m --cpus=1 -v "$PWD/fake-bbb":/fake:ro docker.io/library/node:24-alpine node /fake/server.mjs >/dev/null
podman run -d --pod "$POD" --name "$POD-ctl" --memory=256m --cpus=1 --user 1001 --read-only --tmpfs /data:rw,mode=1777 \
  --security-opt no-new-privileges --cap-drop=ALL -v "$CFG":/etc/bbb-stress/config.yaml:ro localhost/bbb-stress-controller:dev >/dev/null
sleep 3
call() { podman exec "$POD-fake" node -e "
  const [m,p,f]=process.argv.slice(1);fetch('http://localhost:8080'+p,{method:m,headers:{authorization:'Bearer e2e-admin-token-1234',...(f?{'content-type':'application/json'}:{})},body:f||undefined}).then(async r=>console.log(await r.text()))" "$@"; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);console.log(eval(process.argv[1]))})" "$1"; }
call PUT /api/scenarios "$(sed 's/"name":"e2e"/"name":"series-a"/' "$SCN")" >/dev/null
call PUT /api/scenarios "$(sed 's/"name":"e2e"/"name":"series-b"/' "$SCN")" >/dev/null
SERIES=$(call POST /api/series '{"name":"e2e series","scenarios":["series-a","series-b"],"pauseSeconds":3}' | json 'd.id'); echo "series=$SERIES"
SEEN=""; METRICS=0
for _ in $(seq 1 ${E2E_TIMEOUT:-120}); do
  sleep 2
  RUN=$(call GET /api/runs | json "(d.find(r=>r.phase==='waiting-for-bots')||{}).id||''")
  if [ -n "$RUN" ] && [[ "$SEEN" != *"$RUN"* ]]; then
    SEEN="$SEEN $RUN"; TOKEN=$(call GET "/api/runs/$RUN" | json 'd.botToken')
    for i in 1 2 3; do
      podman run -d --pod "$POD" --name "$POD-$RUN-$i" --memory=1500m --cpus=1.5 --shm-size=256m --user 1001 --read-only --tmpfs /tmp:rw,mode=1777,size=512m \
        --security-opt no-new-privileges --cap-drop=ALL -e CONTROLLER_URL=http://localhost:8080 -e RUN_ID="$RUN" -e BOT_TOKEN="$TOKEN" -e BOT_ID="bot$i" localhost/bbb-stress-bot:dev >/dev/null
    done
  fi
  if [ "$METRICS" = 0 ]; then M=$(podman exec "$POD-fake" wget -qO- http://localhost:8080/metrics | grep -E '^bbb_stress_(freezes|audio_loss|bot_cpu)' | head -3); [ -n "$M" ] && { echo '--- metrics during the run'; echo "$M"; METRICS=1; }; fi
  S=$(call GET /api/series | json 'd[0].state'); [ "$S" != running ] && break
done
echo "--- series state: $S"; call GET /api/series | json 'JSON.stringify(d[0])'
IDS=$(call GET /api/series | json 'd[0].runIds.join(",")')
echo '--- outcomes'; call GET /api/runs | json 'd.map(r=>r.scenario.name+": "+r.outcome+" stable="+r.capacityUsers+" series="+(r.seriesId||"")).join("\n")'
echo '--- reports'; R1=${IDS%%,*}
call GET "/api/runs/$R1/report.html?lang=de" | grep -c 'Lasttest-Bericht'
call GET "/api/compare/report.html?ids=$IDS&lang=en" | grep -c 'Load test comparison'
