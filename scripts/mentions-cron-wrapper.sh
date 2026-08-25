#!/usr/bin/env bash
# Wrapper so Windows Task Scheduler can run the mention poller inside WSL
# without a login shell (nvm's node is not on PATH otherwise).
set -u
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

cd /home/asus/dev/projects/zyquor || exit 1
node scripts/poll-x-mentions.mjs
exec node services/demo-checker/run-queue.mjs
