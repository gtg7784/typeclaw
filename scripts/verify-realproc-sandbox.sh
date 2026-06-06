#!/usr/bin/env bash
# Manual acceptance check for the sandbox.realProc strategy (src/sandbox/build.ts).
# Not a unit test: it needs a Linux container with CAP_SYS_ADMIN, which the macOS
# dev host and standard CI runners cannot provide, so it lives here as an
# operator-runnable script instead of a skipIf-everywhere test.
#
# Proves two properties of the two-phase `unshare --mount-proc -- bwrap` sandbox:
#   1. An external package runner (bunx) runs to completion (no Bun "NotDir").
#   2. A secret in a sibling process's environment NEVER appears in any
#      /proc/*/environ the sandbox can read (PID-namespace scoping holds).
#
# Usage: scripts/verify-realproc-sandbox.sh [image]
#   image defaults to ghcr.io/typeclaw/typeclaw-base:<version-from-package.json>
set -euo pipefail

IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  version="$(node -p "require('./package.json').version" 2>/dev/null || echo latest)"
  IMAGE="ghcr.io/typeclaw/typeclaw-base:${version}"
fi

secret="TYPECLAW_REALPROC_LEAK_CANARY_$$"

inner='
echo "=== bunx via real-proc sandbox ==="
bunx cowsay "real-proc ok" 2>&1 | tail -6
echo "bunx exit=$?"
echo "=== visible pids (sandbox should NOT see the canary holder) ==="
ls /proc | grep -E "^[0-9]+$" | tr "\n" " "; echo
echo "=== leak scan ==="
found=0
for f in /proc/[0-9]*/environ; do
  if tr "\0" "\n" < "$f" 2>/dev/null | grep -q "CANARY_TOKEN"; then
    echo "LEAK:$f"; found=1
  fi
done
if [ $found -eq 0 ]; then echo "NO_LEAK_CONFIRMED"; else echo "LEAK_DETECTED"; exit 1; fi
'
inner="${inner//CANARY_TOKEN/$secret}"

# The real-proc argv shape mirrors buildArgv() in src/sandbox/build.ts. Keep in
# sync if that helper changes.
runner="
${secret}_holder() { :; }
env CANARY=${secret} sleep 120 &
unshare --pid --fork --mount --mount-proc -- \
  bwrap --unshare-user --unshare-ipc --unshare-uts --unshare-cgroup \
        --new-session --die-with-parent --clearenv \
        --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME /tmp --setenv LANG C.UTF-8 \
        --ro-bind /usr /usr --ro-bind /etc /etc --dev /dev --tmpfs /tmp \
        --ro-bind-try /bin /bin --ro-bind-try /sbin /sbin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
        --ro-bind /proc /proc \
        bash -c '$inner'
"

echo "Image: $IMAGE"
docker run --rm --security-opt seccomp=unconfined --cap-add SYS_ADMIN \
  -e "CANARY=${secret}" "$IMAGE" bash -c "$runner"
