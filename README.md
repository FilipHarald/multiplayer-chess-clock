# Multiplayer Chess Clock

A multiplayer chess clock web app with a pass-based turn order mechanic.

## How it works

- One player creates a room and sets the time per player
- Share the room link (with QR code) for others to join
- Players take turns — only the active player's clock ticks
- When a player presses **Pass**, they're removed from the current round
- Choose Normal order to keep the same turn order each round, or Pass order to make passing determine the next round's order
- Last player standing wins the round
- Game continues until a player runs out of time

## Features

- Share links with QR codes
- Persistent player names (saved in browser)
- Public lobbies visible on the home page
- Creator permissions: anyone can start / anyone can pause toggles
- Round history with pass order display
- Real-time sync via Socket.IO

## Running locally

```bash
npm install
npm run build -w client
PORT=3002 node server/index.js
```

## Access

**Tailscale:** http://100.70.0.46:3002

Agents can follow [AGENT_BROWSER_GUIDE.md](AGENT_BROWSER_GUIDE.md) to verify
reachability, create a room through Chromium, and capture screenshots.
