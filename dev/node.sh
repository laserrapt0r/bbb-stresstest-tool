#!/bin/sh
# Runs a command in a Node container. node_modules lives in a Podman volume, so nothing
# is installed locally. Remove it with: podman volume rm bbb-stress-nm
exec podman run --rm -it --memory=2g --cpus=4 --userns=keep-id \
  -v "$PWD":/work:Z -v bbb-stress-nm:/work/node_modules -w /work \
  docker.io/library/node:24-alpine "$@"
