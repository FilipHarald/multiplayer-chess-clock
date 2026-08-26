# UI Revamp - Issue #7c695da2

## Phase 1: Remove notification/silence + join-with-code
- [x] Remove MuteContext, MuteProvider, useMute
- [x] Remove mute button from NameBar
- [x] Remove playTurnSound and all mutedRef references
- [x] Remove join-with-code section from HomePage
- [x] Remove the "or join an existing clock" divider + code input

## Phase 2: Revamp Home page
- [ ] Add lorem ipsum placeholder paragraph
- [ ] Replace "Create Clock" with "New Room" button (just navigates, no form)
- [ ] Public rooms list shows device count (rename "players" to "devices")
- [ ] Remove all setup form fields from home page (time, settings, etc.)

## Phase 3: Revamp lobby / New Room UI
- [ ] Collapsible "How to join" section (collapsed by default) with URL + QR
- [ ] Time info section (time per player, total max time, expected end time)
- [ ] Collapsible "Settings" section (default closed) - editable by all
  - [ ] List publicly checkbox
  - [ ] Allow users to pass (muted, tooltip: "only pass-order supported atm")
  - [ ] Use pass-order (muted, tooltip: "only pass-order supported atm")
  - [ ] Dropdown "countdown" (muted, tooltip: "only countdown supported atm")
- [ ] Player/Device list with drag-and-drop reorder
  - [ ] Each row: drag grip, color circle, name (editable), edit icon, trash icon
  - [ ] Trash muted for first 2 players (only Player 3+ can be deleted)
  - [ ] Name editing: inline input with save button, any device can edit
  - [ ] [+ Add Player] button with dotted border

## Phase 4: Game page changes
- [ ] Remove armed/confirm mechanism - anyone can control anything directly
- [ ] Remove "(you)" labels and player-index based permissions
- [ ] All cards fully clickable for end turn / pass

## Phase 5: Server changes
- [ ] Remove "Room is full" check - unlimited devices
- [ ] Remove player count from create-room
- [ ] Add "add-player" / "remove-player" socket events
- [ ] Add "rename-player-by-index" event (any device can rename any player)
- [ ] Support dynamic player list in lobby

## Phase 6: CSS updates
- [ ] Update styles for new lobby layout
- [ ] Collapsible sections styling
- [ ] Player row with edit/delete icons
- [ ] [+ Add Player] button styling
