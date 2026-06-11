#!/bin/bash
cd /Users/ignitabull/Desktop/Work/webpull
echo "Starting webpull server on http://localhost:3456"
WEBPULL_PORT=3456 bun run src/index.ts
