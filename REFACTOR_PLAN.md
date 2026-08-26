# UI Revamp - Issue #7c695da2

## Phase 1: Remove notification/silence + join-with-code
- [x] Remove MuteContext, MuteProvider, useMute
- [x] Remove mute button from NameBar
- [x] Remove playTurnSound and all mutedRef references
- [x] Remove join-with-code section from HomePage
- [x] Remove the "or join an existing clock" divider + code input

## Phase 2: Revamp Home page
- [x] Add lorem ipsum placeholder paragraph
- [x] Replace "Create Clock" with "New Room" button (just navigates, no form)
- [x] Public rooms list shows device count (rename "players" to "devices")
- [x] Remove all setup form fields from home page (time, settings, etc.)

## Phase 3: Revamp lobby / New Room UI
- [x] Collapsible "How to join" section (collapsed by default) with URL + QR
- [x] Time info section (time per player as number input, total max time, expected end time)
- [x] Collapsible "Settings" section (default closed) - editable by all
  - [x] List publicly checkbox
  - [x] Allow users to pass (muted, tooltip: "only pass-order supported atm")
  - [x] Use pass-order (muted, tooltip: "only pass-order supported atm")
  - [x] Dropdown "countdown" (muted, tooltip: "only countdown supported atm")
- [x] Player/Device list with drag-and-drop reorder
  - [x] Each row: 6-dot drag grip, color circle, name (editable), edit icon, trash icon
  - [x] Trash muted for first 2 players (only Player 3+ can be deleted)
  - [x] Name editing: inline input with save button, any device can edit
  - [x] [+ Add Player] button with dotted border and tooltip

## Phase 4: Game page changes
- [x] Remove armed/confirm mechanism - anyone can control anything directly
- [x] Remove "(you)" labels and player-index based permissions
- [x] All cards fully clickable for end turn / pass
- [x] Remove green my-turn background (no device-to-player mapping)
- [x] In-game player renaming (hover pencil, touch visible)
- [x] How to join section available in game room

## Phase 5: Server changes
- [x] Remove "Room is full" check - unlimited devices
- [x] Remove player count from create-room
- [x] Add "add-player" / "remove-player" socket events
- [x] Add "rename-player-by-index" event (any device can rename any player)
- [x] Support dynamic player list in lobby

## Phase 6: CSS updates
- [x] Update styles for new lobby layout
- [x] Collapsible sections styling
- [x] Player row with edit/delete icons
- [x] [+ Add Player] button styling
- [x] Drag-and-drop: 6-dot grip, centered ghost, white glow on target, dragleave cleanup

## Validation
- [x] `b8ba66d` — Fuzz: lobby title, share URL, muted trash, tooltip
- [x] `6b8d492` — Fuzz: touch rename button, green bg removed, in-game rename
- [x] `66cdb80` — Fuzz: WebSocket URL fix (uses window.location.origin)
- [x] `1c6ac05` — Fuzz: green bg removed, in-game rename
- [x] `88b4e25` — Filip: time per player as direct number input
- [x] `161f5f1` — Filip: muted text, game join info, drag-and-drop
- [x] `235fe09` — Fuzz: white glow, centered drag, dragleave cleanup

## Status: COMPLETE
All phases implemented and validated. Service running at http://100.70.0.46:3002/
