#!/bin/bash

echo "Setting up D1 database for dice-mcp-server"
echo "=========================================="

# Create the D1 database
echo "Creating D1 database..."
wrangler d1 create dice-mcp-db

echo ""
echo "Database created! You need to update wrangler.toml with the database ID."
echo ""
echo "The database ID will be shown above. Replace 'YOUR_DATABASE_ID_HERE' in wrangler.toml with the actual ID."
echo ""
echo "SQLite-based Durable Object is REQUIRED for SSE endpoints."
echo ""
echo "Example URLs:"
echo "  - Send: https://your-domain/sse/send?sessionId=YOUR_SESSION"
echo "  - Events: https://your-domain/sse/events?sessionId=YOUR_SESSION&lastEventId=0"
echo "  - Stats: https://your-domain/sse/stats?sessionId=YOUR_SESSION"