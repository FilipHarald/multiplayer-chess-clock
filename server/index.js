import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { customAlphabet } from 'nanoid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------- SQLite persistence ----------

const db = new Database(join(__dirname, 'chess-clock.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

function saveRoom(room) {
  const { timerInterval, ...serializable } = room;
  db.prepare('INSERT OR REPLACE INTO rooms (code, data, created_at) VALUES (?, ?, ?)')
    .run(room.code, JSON.stringify(serializable), room.createdAt);
}

function loadRooms() {
  const rows = db.prepare('SELECT code, data, created_at FROM rooms').all();
  const loaded = [];
  for (const row of rows) {
    try {
      const room = JSON.parse(row.data);
      room.timerInterval = null;
      room.pausedBy = room.pausedBy ?? null;
      loaded.push(room);
    } catch { /* skip corrupt row */ }
  }
  return loaded;
}

function deleteRoom(code) {
  db.prepare('DELETE FROM rooms WHERE code = ?').run(code);
}

// Cleanup rooms older than 24h — run every 6h
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const stale = db.prepare('SELECT code FROM rooms WHERE created_at < ?').all(cutoff);
  for (const { code } of stale) {
    deleteRoom(code);
    rooms.delete(code);
    console.log(`Cleaned up stale room ${code}`);
  }
  if (stale.length > 0) console.log(`Purged ${stale.length} rooms older than 24h`);
}, 6 * 60 * 60 * 1000);

// ---------- Express + Socket.IO ----------

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PORT = process.env.PORT || 3001;
const rooms = new Map();

// Restore persisted rooms into memory
for (const room of loadRooms()) {
  rooms.set(room.code, room);
}
console.log(`Restored ${rooms.size} rooms from database`);

const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 8);

const PLAYER_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#34495e', '#e91e63', '#00bcd4',
];

// ---------- helpers ----------

function createRoom(playerCount, minutesPerPlayer, settings = {}) {
  const code = nanoid();
  const players = Array.from({ length: playerCount }, (_, i) => ({
    id: null,
    deviceId: null,
    name: `Player ${i + 1}`,
    color: PLAYER_COLORS[i % PLAYER_COLORS.length],
    timerMs: minutesPerPlayer * 60 * 1000,
    connected: false,
  }));

  const room = {
    code,
    players,
    waitingOrder: Array.from({ length: playerCount }, (_, i) => i),
    turnOrder: Array.from({ length: playerCount }, (_, i) => i),
    currentTurnIndex: 0,
    round: 1,
    passOrder: [],
    phase: 'lobby',
    timerInterval: null,
    paused: false,
    pausedBy: null,
    createdAt: Date.now(),
    createdBy: null,
    creatorName: null,
    settings: {
      allowAnyoneToStart: settings.allowAnyoneToStart ?? false,
      allowAnyoneToPause: settings.allowAnyoneToPause ?? false,
      public: settings.public ?? false,
    },
  };

  rooms.set(code, room);
  saveRoom(room);
  return room;
}

function persistRoom(code) {
  const room = rooms.get(code);
  if (room) saveRoom(room);
}

function startTimerTick(code) {
  const room = rooms.get(code);
  if (!room || room.timerInterval) return;

  room.timerInterval = setInterval(() => {
    if (room.phase !== 'playing' || room.paused) return;

    const activeIdx = room.turnOrder[room.currentTurnIndex];
    const player = room.players[activeIdx];
    if (!player) return;

    player.timerMs -= 100;
    if (player.timerMs <= 0) {
      player.timerMs = 0;
      clearInterval(room.timerInterval);
      room.timerInterval = null;
      room.phase = 'game-over';
      persistRoom(code);
      io.to(code).emit('game-over', { loserId: activeIdx, state: serializeState(room) });
      return;
    }

    io.to(code).emit('timer-tick', {
      activePlayerIndex: activeIdx,
      timers: room.players.map((p) => p.timerMs),
    });
  }, 100);
}

function stopTimerTick(code) {
  const room = rooms.get(code);
  if (room?.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
}

function advanceTurn(code) {
  const room = rooms.get(code);
  if (!room || room.phase !== 'playing' || room.turnOrder.length === 0) return;

  room.currentTurnIndex++;
  if (room.currentTurnIndex >= room.turnOrder.length) {
    room.currentTurnIndex = 0;
  }

  io.to(code).emit('turn-changed', {
    activePlayerIndex: room.turnOrder[room.currentTurnIndex],
    state: serializeState(room),
  });
}

// A round ends only once every connected player has passed — the last player
// keeps taking turns (their End Turn cycles back to themselves) until they pass too.
function checkRoundOver(code) {
  const room = rooms.get(code);
  if (!room) return false;

  const stillInRound = room.players.filter((p, i) => p.connected && !room.passOrder.includes(i));

  if (stillInRound.length === 0) {
    stopTimerTick(code);
    room.phase = 'round-over';
    persistRoom(code);
    io.to(code).emit('round-over', { state: serializeState(room) });
    return true;
  }

  return false;
}

function startNextRound(code) {
  const room = rooms.get(code);
  if (!room) return;

  room.round++;
  room.turnOrder = [...room.passOrder];
  room.currentTurnIndex = 0;
  room.passOrder = [];
  room.phase = 'playing';
  room.paused = true;
  room.pausedBy = 'round-start';

  startTimerTick(code);
  persistRoom(code);
  io.to(code).emit('new-round', { state: serializeState(room) });
}

function serializeState(room, forSocketId) {
  let playerIdx = null;
  if (forSocketId) {
    playerIdx = room.players.findIndex((p) => p.id === forSocketId);
    if (playerIdx === -1) playerIdx = null;
  }
  return {
    code: room.code,
    players: room.players.map((p, i) => ({
      index: i,
      name: p.name,
      color: p.color,
      timerMs: p.timerMs,
      connected: p.connected,
    })),
    waitingOrder: room.waitingOrder,
    turnOrder: room.turnOrder,
    currentTurnIndex: room.currentTurnIndex,
    activePlayerIndex: room.turnOrder[room.currentTurnIndex],
    round: room.round,
    passOrder: room.passOrder,
    phase: room.phase,
    paused: room.paused,
    pausedBy: room.pausedBy,
    createdBy: room.createdBy,
    settings: room.settings,
    myIndex: playerIdx,
  };
}

// ---------- socket events ----------

io.on('connection', (socket) => {
  let currentRoom = null;
  let playerIndex = null;

  socket.on('create-room', ({ playerCount, minutesPerPlayer, settings, name, deviceId }, cb) => {
    const room = createRoom(playerCount || 3, minutesPerPlayer || 60, settings);
    socket.join(room.code);
    currentRoom = room.code;
    playerIndex = 0;
    room.createdBy = socket.id;
    room.creatorName = name || 'Player 1';
    room.players[0].id = socket.id;
    room.players[0].deviceId = deviceId || null;
    room.players[0].connected = true;
    if (name) room.players[0].name = name;
    persistRoom(room.code);
    cb({ state: serializeState(room), playerIndex: 0 });
  });

  socket.on('join-room', ({ code, name, deviceId }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb({ error: 'Room not found' });

    // Check if this device is already in the room (same device, new socket).
    // Allowed in any phase: this is how players re-enter after a page refresh
    // or when navigating from the lobby into the started game.
    if (deviceId) {
      const existingIdx = room.players.findIndex((p) => p.deviceId === deviceId);
      if (existingIdx !== -1) {
        // Device already has a slot — reassign this socket to that slot
        const oldSocketId = room.players[existingIdx].id;
        room.players[existingIdx].id = socket.id;
        const wasDisconnected = !room.players[existingIdx].connected;
        room.players[existingIdx].connected = true;
        if (name) room.players[existingIdx].name = name;
        socket.join(code);
        currentRoom = code;
        playerIndex = existingIdx;
        persistRoom(code);

        io.to(code).emit(wasDisconnected ? 'player-reconnected' : 'player-joined', {
          playerIndex: existingIdx,
          playerName: room.players[existingIdx].name,
          state: serializeState(room),
        });
        cb({ state: serializeState(room), playerIndex: existingIdx });
        return;
      }
    }

    // Check if this is the creator rejoining (name matches creatorName and slot 0 is empty)
    const isCreatorRejoin = name && room.creatorName && name === room.creatorName && !room.players[0].connected;

    if (isCreatorRejoin) {
      room.players[0].id = socket.id;
      room.players[0].deviceId = deviceId || null;
      const wasDisconnected = !room.players[0].connected;
      room.players[0].connected = true;
      room.players[0].name = name;
      socket.join(code);
      currentRoom = code;
      playerIndex = 0;
      persistRoom(code);

      io.to(code).emit(wasDisconnected ? 'player-reconnected' : 'player-joined', {
        playerIndex: 0,
        playerName: name,
        state: serializeState(room),
      });
      cb({ state: serializeState(room), playerIndex: 0 });
      return;
    }

    // Brand-new players (no existing slot) may only join before the game starts
    if (room.phase === 'playing') return cb({ error: 'Game already in progress' });

    const freeSlot = room.players.findIndex((p) => p.id === null);
    if (freeSlot === -1) return cb({ error: 'Room is full' });

    room.players[freeSlot].id = socket.id;
    room.players[freeSlot].deviceId = deviceId || null;
    room.players[freeSlot].connected = true;
    if (name) room.players[freeSlot].name = name;

    socket.join(code);
    currentRoom = code;
    playerIndex = freeSlot;

    persistRoom(code);
    io.to(code).emit('player-joined', { state: serializeState(room) });
    cb({ state: serializeState(room), playerIndex: freeSlot });
  });

  socket.on('rename-player', ({ index, name }) => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    // Use server-tracked playerIndex, not client-sent index
    if (playerIndex === null) return;
    room.players[playerIndex].name = name;
    persistRoom(currentRoom);
    io.to(currentRoom).emit('state-update', { state: serializeState(room) });
  });

  socket.on('reorder-players', ({ order }) => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'lobby') return;

    // Only creator or allowAnyoneToStart may reorder
    const isCreator = room.createdBy === socket.id;
    if (!isCreator && !room.settings.allowAnyoneToStart) return;

    // Validate: must be an array of valid player indices with no duplicates
    if (!Array.isArray(order)) return;
    const valid = new Set(room.players.map((_, i) => i));
    if (order.length !== room.players.length) return;
    if (!order.every((idx) => valid.has(idx))) return;
    if (new Set(order).size !== order.length) return;

    room.waitingOrder = order;
    persistRoom(currentRoom);
    io.to(currentRoom).emit('state-update', { state: serializeState(room) });
  });

  socket.on('start-game', () => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (room.phase !== 'lobby') return;

    // Permission check: creator or allowAnyoneToStart
    const isCreator = room.createdBy === socket.id;
    if (!isCreator && !room.settings.allowAnyoneToStart) return;

    const connectedPlayers = room.players
      .map((p, i) => ({ ...p, originalIndex: i }))
      .filter((p) => p.connected);

    if (connectedPlayers.length < 2) return;

    // Use waitingOrder if available, otherwise fall back to connected order
    const connectedIndices = new Set(connectedPlayers.map((p) => p.originalIndex));
    const ordered = (room.waitingOrder || []).filter((idx) => connectedIndices.has(idx));
    // Add any connected players not in waitingOrder (e.g. joined after order was set)
    for (const idx of connectedIndices) {
      if (!ordered.includes(idx)) ordered.push(idx);
    }
    room.turnOrder = ordered;
    room.currentTurnIndex = 0;
    room.phase = 'playing';
    room.round = 1;
    room.passOrder = [];
    room.paused = false;
    room.pausedBy = null;

    startTimerTick(currentRoom);
    persistRoom(currentRoom);
    io.to(currentRoom).emit('game-started', { state: serializeState(room) });
  });

  socket.on('end-turn', () => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'playing') return;
    if (room.turnOrder.length === 0) return;

    // Any connected room member may end the turn of the active player
    const senderIdx = room.players.findIndex((p) => p.id === socket.id);
    if (senderIdx === -1 || !room.players[senderIdx].connected) return;

    // A manual pause is a hard stop: no turn actions until resumed.
    if (room.paused && room.pausedBy !== 'round-start') return;

    if (room.pausedBy === 'round-start') {
      room.paused = false;
      room.pausedBy = null;
    }

    advanceTurn(currentRoom);
    persistRoom(currentRoom);
  });

  socket.on('pass', ({ index } = {}) => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'playing') return;

    // Any connected room member may pass for anyone; default is your own slot
    const senderIdx = room.players.findIndex((p) => p.id === socket.id);
    if (senderIdx === -1 || !room.players[senderIdx].connected) return;

    const targetIdx = Number.isInteger(index) ? index : senderIdx;
    const target = room.players[targetIdx];
    if (!target || !target.connected || room.passOrder.includes(targetIdx)) return;

    // A manual pause is a hard stop: no turn actions until resumed.
    if (room.paused && room.pausedBy !== 'round-start') return;

    if (room.pausedBy === 'round-start') {
      room.paused = false;
      room.pausedBy = null;
    }
    room.passOrder.push(targetIdx);

    // Remove the passer from the turn rotation; keep currentTurnIndex pointing
    // at the same position so the clock hands over to the next player.
    const orderPos = room.turnOrder.indexOf(targetIdx);
    if (orderPos !== -1) {
      room.turnOrder.splice(orderPos, 1);
      if (orderPos < room.currentTurnIndex) {
        room.currentTurnIndex--;
      }
      if (room.currentTurnIndex >= room.turnOrder.length && room.turnOrder.length > 0) {
        room.currentTurnIndex = 0;
      }
    }

    persistRoom(currentRoom);
    io.to(currentRoom).emit('player-passed', {
      playerIndex: targetIdx,
      state: serializeState(room),
    });

    checkRoundOver(currentRoom);
  });

  socket.on('unpass', ({ index }) => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'playing') return;

    const senderIdx = room.players.findIndex((p) => p.id === socket.id);
    if (senderIdx === -1 || !room.players[senderIdx].connected) return;

    const targetIdx = Number.isInteger(index) ? index : senderIdx;
    const passPos = room.passOrder.indexOf(targetIdx);
    if (passPos === -1) return;

    // Remove from passOrder
    room.passOrder.splice(passPos, 1);

    // Re-add to turnOrder — insert after the current position so they play next
    // or at end if currentTurnIndex is past the insertion point
    const insertAt = Math.min(room.currentTurnIndex + 1, room.turnOrder.length);
    room.turnOrder.splice(insertAt, 0, targetIdx);

    persistRoom(currentRoom);
    io.to(currentRoom).emit('player-unpassed', {
      playerIndex: targetIdx,
      state: serializeState(room),
    });
  });

  socket.on('next-round', () => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room || (room.phase !== 'game-over' && room.phase !== 'round-over')) return;

    // Permission: creator or allowAnyoneToStart
    const isCreator = room.createdBy === socket.id;
    if (!isCreator && !room.settings.allowAnyoneToStart) return;

    startNextRound(currentRoom);
  });

  socket.on('toggle-pause', () => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'playing') return;

    // Permission: creator or allowAnyoneToPause
    const senderIdx = room.players.findIndex((p) => p.id === socket.id);
    if (senderIdx === -1 || !room.players[senderIdx].connected) return;
    const isCreator = room.createdBy === socket.id;
    if (!isCreator && !room.settings.allowAnyoneToPause) return;

    // A manual pause stays until resumed explicitly; a round-start pause is
    // lifted by the first turn action instead (see end-turn/pass below).
    room.paused = !room.paused;
    room.pausedBy = room.paused ? senderIdx : null;

    persistRoom(currentRoom);
    io.to(currentRoom).emit('state-update', { state: serializeState(room) });
  });

  socket.on('update-settings', (settings) => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (room.phase !== 'lobby' && room.phase !== 'playing') return;

    const isCreator = room.createdBy === socket.id;
    if (!isCreator) return;

    const allowed = ['allowAnyoneToStart', 'allowAnyoneToPause', 'public'];
    for (const key of allowed) {
      if (typeof settings[key] === 'boolean') {
        room.settings[key] = settings[key];
      }
    }

    persistRoom(currentRoom);
    io.to(currentRoom).emit('state-update', { state: serializeState(room) });
  });

  socket.on('reset-game', ({ playerCount, minutesPerPlayer }) => {
    if (currentRoom === null) return;
    stopTimerTick(currentRoom);

    const room = rooms.get(currentRoom);
    if (!room) return;

    const count = playerCount || room.players.length;
    const minutes = minutesPerPlayer || room.players[0].timerMs / 60000;

    room.players = Array.from({ length: count }, (_, i) => ({
      id: null,
      deviceId: null,
      name: `Player ${i + 1}`,
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      timerMs: minutes * 60 * 1000,
      connected: false,
    }));

    const sockets = Array.from(io.sockets.adapter.rooms.get(currentRoom) || []);
    sockets.forEach((sid) => {
      const idx = room.players.findIndex((p) => p.id === null);
      if (idx !== -1) {
        room.players[idx].id = sid;
        room.players[idx].connected = true;
      }
    });

    room.turnOrder = room.players.map((_, i) => i);
    room.waitingOrder = room.players.map((_, i) => i);
    room.currentTurnIndex = 0;
    room.round = 1;
    room.passOrder = [];
    room.phase = 'lobby';
    room.paused = false;
    room.pausedBy = null;
    // Keep createdBy and settings

    persistRoom(currentRoom);
    io.to(currentRoom).emit('state-update', { state: serializeState(room) });
  });

  socket.on('disconnect', () => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const pIdx = room.players.findIndex((p) => p.id === socket.id);
    if (pIdx !== -1) {
      room.players[pIdx].connected = false;
      room.players[pIdx].id = null;
    }

    // Auto-pause when a player disconnects during gameplay
    if (room.phase === 'playing' && pIdx !== -1) {
      if (!room.paused) {
        stopTimerTick(currentRoom);
        room.paused = true;
        room.pausedBy = `disconnected:${pIdx}`;
      }
    }

    persistRoom(currentRoom);
    io.to(currentRoom).emit('player-left', {
      playerIndex: pIdx,
      playerName: pIdx !== -1 ? room.players[pIdx].name : null,
      state: serializeState(room),
    });

    const anyConnected = room.players.some((p) => p.connected);
    if (!anyConnected) {
      setTimeout(() => {
        const r = rooms.get(currentRoom);
        if (r && !r.players.some((p) => p.connected)) {
          stopTimerTick(currentRoom);
          rooms.delete(currentRoom);
          deleteRoom(currentRoom);
        }
      }, 60000);
    }
  });
});

// Serve static client in production
app.use(express.static(join(__dirname, '../client/dist')));

// List public rooms in lobby
app.get('/api/rooms', (req, res) => {
  const publicRooms = [];
  for (const [code, room] of rooms) {
    if (room.settings.public && room.phase === 'lobby') {
      publicRooms.push({
        code,
        playerCount: room.players.length,
        connectedCount: room.players.filter(p => p.connected).length,
        createdAt: room.createdAt,
      });
    }
  }
  res.json(publicRooms);
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '../client/dist/index.html'));
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Multiplayer Chess Clock server running on port ${PORT}`);
});
