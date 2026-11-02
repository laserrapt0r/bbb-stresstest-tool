#!/bin/sh
# Checks the chart statically, nothing gets deployed.
set -e
RENDERED=$(mktemp)
podman run --rm --memory=512m -v "$PWD/deploy/helm/bbb-stress-tool":/chart:ro,Z -v "$PWD/dev":/dev-values:ro,Z docker.io/alpine/helm:3.19.0 \
  template bbb-stress /chart --namespace loadtest -f /dev-values/values-check.yaml > "$RENDERED"
podman run --rm --memory=512m -i ghcr.io/yannh/kubeconform:v0.7.0 -strict -summary -ignore-missing-schemas -kubernetes-version 1.33.0 < "$RENDERED"
rm -f "$RENDERED"
