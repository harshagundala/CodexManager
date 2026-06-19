#!/bin/bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo "--------------------------------------------------------"
echo "🪐 Starting Codex Account Hot Swapper Daemon..."
echo "🔗 Access Dashboard at: http://localhost:19000"
echo "🛑 Press Ctrl+C to stop the server"
echo "--------------------------------------------------------"

# Launch Node server in background
node server.js &
SERVER_PID=$!

# Handle graceful shutdown
cleanup() {
  echo ""
  echo "Stopping Codex Hot Swapper server..."
  kill $SERVER_PID 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

# Give the server a moment to bind to the port
sleep 1

# Open the dashboard in the default macOS browser
open "http://localhost:19000"

# Keep script active to forward server logs and wait on process
wait $SERVER_PID
