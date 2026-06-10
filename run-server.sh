#!/bin/bash
cd /Users/ignitabull/Desktop/Work/webpull
while true; do
  bun run src/index.ts 2>&1
  EXIT=$?
  echo "SERVER EXITED WITH CODE: $EXIT at $(date)" >> /tmp/wp-exit.log
  sleep 1
done
