#!/bin/sh
set -eu

if [ ! -t 0 ]; then
  echo 'Run this command in an interactive terminal.' >&2
  exit 1
fi

restore_echo() { stty echo; }
trap restore_echo EXIT HUP INT TERM
printf 'New password (10-256 characters): ' >&2
stty -echo
IFS= read -r first
printf '\nConfirm new password: ' >&2
IFS= read -r second
printf '\n' >&2
stty echo
trap - EXIT HUP INT TERM

if [ "$first" != "$second" ]; then
  first=''; second=''
  echo 'Passwords do not match.' >&2
  exit 1
fi

printf '%s\n%s\n' "$first" "$second" | \
  /home/mikey/.nvm/versions/node/v24.21.0/bin/node \
  /home/mikey/apps/astra-trade/current/scripts/reset-password.mjs
first=''; second=''
