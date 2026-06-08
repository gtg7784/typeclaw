#!/usr/bin/env bash
# Manual acceptance check for the default 'proc-bind' sandbox strategy
# (src/sandbox/build.ts). Not a unit test: it needs a Linux container with bwrap,
# which the macOS dev host cannot provide, so it lives here as an operator-
# runnable script instead of a skipIf-everywhere test.
#
# The point of proc-bind is that it needs NEITHER `unshare --mount-proc` NOR
# CAP_SYS_ADMIN — so this runs WITHOUT --cap-add (unlike verify-realproc-sandbox).
# It proves two properties of `bwrap --unshare-all … --ro-bind /proc /proc`:
#   1. An external package runner (bunx) runs to completion (no Bun "NotDir").
#   2. A secret in a sibling process's environment is UNREADABLE from the sandbox
#      (the --unshare-all child userns blocks cross-userns /proc/<pid>/environ).
# The signal boundary (kill/ptrace fail EPERM across the userns) is a corollary
# of the same userns isolation property (2) proves, so it is not re-tested here.
#
# Usage: scripts/verify-procbind-sandbox.sh [image]
#   image defaults to ghcr.io/typeclaw/typeclaw-base:<version-from-package.json>
set -euo pipefail

IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  version="$(node -p "require('./package.json').version" 2>/dev/null || echo latest)"
  IMAGE="ghcr.io/typeclaw/typeclaw-base:${version}"
fi

secret="TYPECLAW_PROCBIND_LEAK_CANARY_$$"

inner='
echo "=== bunx via proc-bind sandbox (no CAP_SYS_ADMIN) ==="
bunx cowsay "proc-bind ok" 2>&1 | tail -6
echo "bunx exit=$?"
echo "=== leak scan (sandbox must NOT read the canary holders env) ==="
found=0
for f in /proc/[0-9]*/environ; do
  if tr "\0" "\n" < "$f" 2>/dev/null | grep -q "CANARY_TOKEN"; then
    echo "LEAK:$f"; found=1
  fi
done
if [ $found -eq 0 ]; then echo "NO_LEAK_CONFIRMED"; else echo "LEAK_DETECTED"; exit 1; fi
echo "=== self /proc must be usable (the property that makes bunx work) ==="
test -r /proc/self/fd && test -r /proc/self/maps && echo "SELF_PROC_OK" || { echo "SELF_PROC_MISSING"; exit 1; }
'
inner="${inner//CANARY_TOKEN/$secret}"

# The proc-bind argv shape mirrors buildArgv() in src/sandbox/build.ts. Keep in
# sync if that helper changes. Note: NO `unshare` prefix and NO --cap-add below.
runner="
env CANARY=${secret} sleep 120 &
bwrap --unshare-all \
      --new-session --die-with-parent --clearenv \
      --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME /tmp --setenv LANG C.UTF-8 \
      --ro-bind /usr /usr --ro-bind /etc /etc --dev /dev --tmpfs /tmp \
      --ro-bind-try /bin /bin --ro-bind-try /sbin /sbin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 \
      --share-net \
      --ro-bind /proc /proc \
      bash -c '$inner'
"

echo "Image: $IMAGE"
docker run --rm --security-opt seccomp=unconfined \
  -e "CANARY=${secret}" "$IMAGE" bash -c "$runner"
