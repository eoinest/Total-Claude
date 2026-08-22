#!/bin/sh
# Who owns each of my ports, by the server's own cwd.
#
# `ensureServer` reuses any listener on the port without asking what it is serving, and
# MAP-METHOD's own log records an agent grading another branch's modules that way. So the
# mapping port -> arm is verified from `lsof -a -p <pid> -d cwd` rather than remembered.
for p in 5960 5961 5962 5963 5964 5965 5966 5967 5968 5969; do
  pid=$(lsof -nP -iTCP:$p -sTCP:LISTEN -t 2>/dev/null | head -1)
  if [ -z "$pid" ]; then printf '%s  (free)\n' "$p"; continue; fi
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  printf '%s  pid %-7s %s\n' "$p" "$pid" "$cwd"
done
