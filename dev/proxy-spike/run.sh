#!/bin/bash
# The bot sits in an internal network without a route out. Its only way is a proxy attached to both networks.
set -u
P=bbb-spike; DIR=$(cd "$(dirname "$0")" && pwd)
cleanup() { podman rm -f $P-squid $P-turn >/dev/null 2>&1; podman network rm -f $P-int $P-ext >/dev/null 2>&1; rm -rf "$DIR/.certs"; }
trap cleanup EXIT; cleanup
podman network create --internal $P-int >/dev/null
podman network create $P-ext >/dev/null
mkdir -p "$DIR/.certs"
podman run --rm -v "$DIR/.certs":/c:Z docker.io/library/alpine:3.22 sh -c 'apk add -q openssl >/dev/null 2>&1; openssl req -x509 -newkey rsa:2048 -nodes -keyout /c/key.pem -out /c/cert.pem -days 1 -subj /CN=turn.test -addext subjectAltName=DNS:turn.test >/dev/null 2>&1; chmod 644 /c/*'
podman run -d --name $P-turn --network $P-ext --network-alias turn.test --memory=256m --cpus=1 -v "$DIR/.certs":/c:ro,Z docker.io/coturn/coturn:4.7 \
  -n --log-file=stdout --lt-cred-mech --user=test:test --realm=test --listening-port=3478 --tls-listening-port=5349 --cert=/c/cert.pem --pkey=/c/key.pem \
  --allow-loopback-peers --no-cli --min-port=49160 --max-port=49200 >/dev/null
podman run -d --name $P-squid --network $P-ext --memory=256m --cpus=1 -v "$DIR/squid.conf":/etc/squid/squid.conf:ro,Z docker.io/ubuntu/squid:latest >/dev/null
podman network connect $P-int $P-squid
sleep 5
TURN_IP=$(podman inspect -f "{{(index .NetworkSettings.Networks \"$P-ext\").IPAddress}}" $P-turn)
SQUID_IP=$(podman inspect -f "{{(index .NetworkSettings.Networks \"$P-int\").IPAddress}}" $P-squid)
echo "turn=$TURN_IP squid=$SQUID_IP"
probe() { # name, TURN URL, proxy, policy
  echo "=== $1"
  timeout 60 podman run --rm --network $P-int --memory=1500m --cpus=2 --shm-size=256m --user 1001 --cap-drop=ALL --security-opt no-new-privileges --add-host turn.test:$TURN_IP \
    -e HOME=/tmp -e TURN_URL="$2" -e PROXY="$3" -e POLICY="$4" -v "$DIR/probe.mjs":/probe.mjs:ro,Z localhost/bbb-stress-bot:dev node /probe.mjs 2>&1 | grep -v 'ambient capability' | tail -2
}
probe "Control: TCP without proxy (must fail)" "turn:turn.test:3478?transport=tcp" "" ""
probe "TURN/TCP through proxy, no policy"           "turn:turn.test:3478?transport=tcp" "http://$SQUID_IP:3128" ""
probe "TURN/TCP through proxy, disable_non_proxied_udp" "turn:turn.test:3478?transport=tcp" "http://$SQUID_IP:3128" "disable_non_proxied_udp"
probe "TURNS/TLS through proxy, disable_non_proxied_udp" "turns:turn.test:5349?transport=tcp" "http://$SQUID_IP:3128" "disable_non_proxied_udp"
probe "TURN/UDP through proxy (must fail)"       "turn:turn.test:3478?transport=udp" "http://$SQUID_IP:3128" ""
echo '=== Squid log (CONNECT)'; podman logs $P-squid 2>&1 | grep -E 'CONNECT' | tail -8
