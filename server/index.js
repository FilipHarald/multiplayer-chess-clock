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
      room.devices = [];
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

function createRoom(minutesPerPlayer, settings = {}) {
  const code = nanoid();
  const players = Array.from({ length: 2 }, (_, i) => ({
    name: `Player ${i + 1}`,
    color: PLAYER_COLORS[i % PLAYER_COLORS.length],
    elapsedMs: 0,
  }));

  const room = {
    code,
    players,
    devices: [],
    minutesPerPlayer: minutesPerPlayer || 60,
    limitMs: (minutesPerPlayer || 60) * 60 * 1000,
    waitingOrder: [0, 1],
    turnOrder: [0, 1],
    currentTurnIndex: 0,
    round: 1,
    passOrder: [],
    phase: 'lobby',
    timerInterval: null,
    paused: false,
    pausedBy: null,
    createdAt: Date.now(),
    settings: {
      public: settings.public ?? true,
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

    // Clocks always count upward from 0. The display runs down from the room's
    // limit and goes negative in overtime; a player whose elapsed passes the
    // limit is flagged overtime and keeps counting (never eliminated by time).
    player.elapsedMs += 100;

    io.to(code).emit('timer-tick', {
      activePlayerIndex: activeIdx,
      timers: room.players.map((p) => room.limitMs - p.elapsedMs),
      overtime: room.players.map((p) => p.elapsedMs >= room.limitMs),
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

function checkRoundOver(code) {
  const room = rooms.get(code);
  if (!room) return false;

  const stillInRound = room.players.filter((_, i) => !room.passOrder.includes(i));

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

function serializeState(room) {
  return {
    code: room.code,
    players: room.players.map((p, i) => ({
      index: i,
      name: p.name,
      color: p.color,
      elapsedMs: p.elapsedMs,
      timerMs: room.limitMs - p.elapsedMs,
      overtime: p.elapsedMs >= room.limitMs,
    })),
    devices: room.devices.map(d => ({ id: d.deviceId, name: d.name })),
    waitingOrder: room.waitingOrder,
    turnOrder: room.turnOrder,
    currentTurnIndex: room.currentTurnIndex,
    activePlayerIndex: room.turnOrder[room.currentTurnIndex],
    round: room.round,
    passOrder: room.passOrder,
    phase: room.phase,
    paused: room.paused,
    pausedBy: room.pausedBy,
    settings: room.settings,
    minutesPerPlayer: room.minutesPerPlayer,
    limitMs: room.limitMs,
    availableColors: PLAYER_COLORS,
  };
}

// ---------- socket events ----------

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create-room', ({ minutesPerPlayer, settings, name, deviceId }, cb) => {
    const room = createRoom(minutesPerPlayer || 60, settings);
    if (currentRoom && currentRoom !== room.code) socket.leave(currentRoom);
    socket.join(room.code);
    currentRoom = room.code;

    // Add creator as first device
    room.devices.push({ socketId: socket.id, deviceId: deviceId || socket.id, name: name || 'Device 1' });
    persistRoom(room.code);
    cb({ state: serializeState(room) });
  });

  socket.on('join-room', ({ code, name, deviceId }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb({ error: 'Room not found' });
    if (currentRoom && currentRoom !== room.code) socket.leave(currentRoom);
    socket.join(code);
    currentRoom = code;

    // Check if device is already tracked (reconnect)
    const existingDevice = room.devices.find(d => d.deviceId === deviceId);
    if (existingDevice) {
      existingDevice.socketId = socket.id;
      if (name) existingDevice.name = name;
      persistRoom(code);
      io.to(code).emit('state-update', { state: serializeState(room) });
      cb({ state: serializeState(room) });
      return;
    }

    // Add new device
    room.devices.push({ socketId: socket.id, deviceId: deviceId || socket.id, name: name || `Device ${room.devices.length + 1}` });
    persistRoom(code);
    io.to(code).emit('device-joined', { state: serializeState(room) });
    cb({ state: serializeState(room) });
  });

  socket.on('set-device-name', ({ name }) => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const device = room.devices.find(d => d.socketId === socket.id);
    if (device && typeof name === 'string' && name.trim()) {
      device.name = name.trim().slice(0, 20);
      persistRoom(currentRoom);
      io.to(currentRoom).emit('state-update', { state: serializeState(room) });
    }
  });

  socket.on('rename-player', ({ index, name }) => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (typeof index !== 'number' || index < 0 || index >= room.players.length) return;
    if (typeof name !== 'string' || name.length > 30) return;
    room.players[index].name = name.trim() || room.players[index].name;
    persistRoom(currentRoom);
    io.to(currentRoom).emit('state-update', { state: serializeState(room) });
  });

  socket.on('set-color', ({ index, color }) => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (typeof index !== 'number' || index < 0 || index >= room.players.length) return;
    if (!PLAYER_COLORS.includes(color)) return;

    const otherIdx = room.players.findIndex((p, i) => i !== index && p.color === color);
    if (otherIdx !== -1) {
      // Color taken — swap: previous owner takes this player's old color, this player gets the requested one
      room.players[otherIdx].color = room.players[index].color;
    }
    room.players[index].color = color;
    persistRoom(currentRoom);
    io.to(currentRoom).emit('state-update', { state: serializeState(room) });
  });

  socket.on('add-player', () => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (room.phase !== 'lobby') return;
    if (room.players.length >= 10) return;

    const newIdx = room.players.length;
    room.players.push({
      name: `Player ${newIdx + 1}`,
      color: PLAYER_COLORS[newIdx % PLAYER_COLORS.length],
      elapsedMs: 0,
    });
    room.waitingOrder.push(newIdx);

    persistRoom(currentRoom);
    io.to(currentRoom).emit('state-update', { state: serializeState(room) });
  });

  socket.on('remove-player', ({ index }) => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (room.phase !== 'lobby') return;
    if (typeof index !== 'number') return;
    if (index < 2 || index >= room.players.length) return;

    room.players.splice(index, 1);
    room.waitingOrder = room.waitingOrder
      .filter(i => i !== index)
      .map(i => i > index ? i - 1 : i);

    persistRoom(currentRoom);
    io.to(currentRoom).emit('state-update', { state: serializeState(room) });
  });

  socket.on('reorder-players', ({ order }) => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room || (room.phase !== 'lobby' && room.phase !== 'round-over')) return;

    if (!Array.isArray(order)) return;
    const valid = new Set(room.players.map((_, i) => i));

    if (room.phase === 'round-over') {
      if (order.length !== room.players.length) return;
    } else {
      if (order.length !== room.players.length) return;
    }
    if (!order.every((idx) => valid.has(idx))) return;
    if (new Set(order).size !== order.length) return;

    if (room.phase === 'round-over') {
      room.passOrder = order;
    } else {
      room.waitingOrder = order;
    }
    persistRoom(currentRoom);
    io.to(currentRoom).emit('state-update', { state: serializeState(room) });
  });

  socket.on('start-game', () => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (room.phase !== 'lobby') return;
    if (room.players.length < 2) return;

    const ordered = [...room.waitingOrder];
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

    // Any device may end the turn
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

    // Any device may pass for any player
    const targetIdx = Number.isInteger(index) ? index : 0;
    const target = room.players[targetIdx];
    if (!target || room.passOrder.includes(targetIdx)) return;

    if (room.paused && room.pausedBy !== 'round-start') return;

    if (room.pausedBy === 'round-start') {
      room.paused = false;
      room.pausedBy = null;
    }
    room.passOrder.push(targetIdx);

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

    const targetIdx = Number.isInteger(index) ? index : 0;
    const passPos = room.passOrder.indexOf(targetIdx);
    if (passPos === -1) return;

    room.passOrder.splice(passPos, 1);
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

    startNextRound(currentRoom);
  });

  socket.on('toggle-pause', () => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'playing') return;

    room.paused = !room.paused;
    room.pausedBy = room.paused ? 'manual' : null;

    if (!room.paused) startTimerTick(currentRoom);

    persistRoom(currentRoom);
    io.to(currentRoom).emit('state-update', { state: serializeState(room) });
  });

  socket.on('update-settings', (settings) => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (room.phase !== 'lobby' && room.phase !== 'playing') return;

    // Any device can change settings
    const allowed = ['public'];
    for (const key of allowed) {
      if (typeof settings[key] === 'boolean') {
        room.settings[key] = settings[key];
      }
    }

    persistRoom(currentRoom);
    io.to(currentRoom).emit('state-update', { state: serializeState(room) });
  });

  socket.on('update-time', ({ minutesPerPlayer }) => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (room.phase !== 'lobby') return;
    if (typeof minutesPerPlayer !== 'number' || minutesPerPlayer < 1 || minutesPerPlayer > 999) return;

    room.minutesPerPlayer = minutesPerPlayer;
    room.limitMs = minutesPerPlayer * 60 * 1000;
    for (const p of room.players) {
      p.elapsedMs = 0;
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
    const minutes = minutesPerPlayer || room.minutesPerPlayer || room.limitMs / 60000 || 60;
    room.minutesPerPlayer = minutes;
    room.limitMs = minutes * 60 * 1000;

    room.players = Array.from({ length: count }, (_, i) => ({
      name: `Player ${i + 1}`,
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      elapsedMs: 0,
    }));

    room.turnOrder = room.players.map((_, i) => i);
    room.waitingOrder = room.players.map((_, i) => i);
    room.currentTurnIndex = 0;
    room.round = 1;
    room.passOrder = [];
    room.phase = 'lobby';
    room.paused = false;
    room.pausedBy = null;

    persistRoom(currentRoom);
    io.to(currentRoom).emit('state-update', { state: serializeState(room) });
  });

  socket.on('disconnect', () => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    // Remove device from room
    const devIdx = room.devices.findIndex(d => d.socketId === socket.id);
    if (devIdx !== -1) {
      room.devices.splice(devIdx, 1);
    }

    persistRoom(currentRoom);
    io.to(currentRoom).emit('device-left', { state: serializeState(room) });

    // Clean up empty rooms after 60s
    if (room.devices.length === 0) {
      setTimeout(() => {
        const r = rooms.get(currentRoom);
        if (r && r.devices.length === 0) {
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

// List public rooms
app.get('/api/rooms', (req, res) => {
  const publicRooms = [];
  for (const [code, room] of rooms) {
    if (room.settings.public) {
      publicRooms.push({
        code,
        deviceCount: room.devices.length,
        playerCount: room.players.length,
        phase: room.phase,
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
