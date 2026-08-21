import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { nanoid } from 'nanoid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PORT = process.env.PORT || 3001;
const rooms = new Map();

const PLAYER_COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#34495e', '#e91e63', '#00bcd4',
];

// ---------- helpers ----------

function createRoom(playerCount, minutesPerPlayer, settings = {}) {
  const code = nanoid(6);
  const players = Array.from({ length: playerCount }, (_, i) => ({
    id: null,
    deviceId: null,
    name: `Player ${i + 1}`,
    color: PLAYER_COLORS[i % PLAYER_COLORS.length],
    timerMs: minutesPerPlayer * 60 * 1000,
    connected: false,
  }));

  rooms.set(code, {
    code,
    players,
    turnOrder: Array.from({ length: playerCount }, (_, i) => i),
    currentTurnIndex: 0,
    round: 1,
    passOrder: [],
    phase: 'lobby',
    timerInterval: null,
    createdAt: Date.now(),
    createdBy: null,
    creatorName: null,
    settings: {
      allowAnyoneToStart: settings.allowAnyoneToStart ?? false,
      allowAnyoneToPause: settings.allowAnyoneToPause ?? false,
      public: settings.public ?? false,
    },
  });

  return rooms.get(code);
}

function startTimerTick(code) {
  const room = rooms.get(code);
  if (!room || room.timerInterval) return;

  room.timerInterval = setInterval(() => {
    if (room.phase !== 'playing') return;

    const activeIdx = room.turnOrder[room.currentTurnIndex];
    const player = room.players[activeIdx];
    if (!player) return;

    player.timerMs -= 100;
    if (player.timerMs <= 0) {
      player.timerMs = 0;
      clearInterval(room.timerInterval);
      room.timerInterval = null;
      room.phase = 'game-over';
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
  if (!room || room.phase !== 'playing') return;

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
  if (!room) return;

  const stillInRound = room.turnOrder.filter((pIdx) => !room.passOrder.includes(pIdx));

  if (stillInRound.length <= 1) {
    stopTimerTick(code);

    if (stillInRound.length === 1) {
      const winnerIdx = stillInRound[0];
      room.phase = 'game-over';
      io.to(code).emit('game-over', { winnerId: winnerIdx, state: serializeState(room) });
    } else {
      room.phase = 'round-over';
      io.to(code).emit('round-over', { state: serializeState(room) });
    }
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

  startTimerTick(code);
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
    turnOrder: room.turnOrder,
    currentTurnIndex: room.currentTurnIndex,
    activePlayerIndex: room.turnOrder[room.currentTurnIndex],
    round: room.round,
    passOrder: room.passOrder,
    phase: room.phase,
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
    cb({ state: serializeState(room), playerIndex: 0 });
  });

  socket.on('join-room', ({ code, name, deviceId }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb({ error: 'Room not found' });
    if (room.phase === 'playing') return cb({ error: 'Game already in progress' });

    // Check if this device is already in the room (same device, new socket)
    if (deviceId) {
      const existingIdx = room.players.findIndex((p) => p.deviceId === deviceId);
      if (existingIdx !== -1) {
        // Device already has a slot — reassign this socket to that slot
        const oldSocketId = room.players[existingIdx].id;
        room.players[existingIdx].id = socket.id;
        room.players[existingIdx].connected = true;
        if (name) room.players[existingIdx].name = name;
        socket.join(code);
        currentRoom = code;
        playerIndex = existingIdx;
        io.to(code).emit('player-joined', { state: serializeState(room) });
        cb({ state: serializeState(room), playerIndex: existingIdx });
        return;
      }
    }

    // Check if this is the creator rejoining (name matches creatorName and slot 0 is empty)
    const isCreatorRejoin = name && room.creatorName && name === room.creatorName && !room.players[0].connected;

    if (isCreatorRejoin) {
      room.players[0].id = socket.id;
      room.players[0].deviceId = deviceId || null;
      room.players[0].connected = true;
      room.players[0].name = name;
      socket.join(code);
      currentRoom = code;
      playerIndex = 0;
      io.to(code).emit('player-joined', { state: serializeState(room) });
      cb({ state: serializeState(room), playerIndex: 0 });
      return;
    }

    const freeSlot = room.players.findIndex((p) => p.id === null);
    if (freeSlot === -1) return cb({ error: 'Room is full' });

    room.players[freeSlot].id = socket.id;
    room.players[freeSlot].deviceId = deviceId || null;
    room.players[freeSlot].connected = true;
    if (name) room.players[freeSlot].name = name;

    socket.join(code);
    currentRoom = code;
    playerIndex = freeSlot;

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

    room.turnOrder = connectedPlayers.map((p) => p.originalIndex);
    room.currentTurnIndex = 0;
    room.phase = 'playing';
    room.round = 1;
    room.passOrder = [];

    startTimerTick(currentRoom);
    io.to(currentRoom).emit('game-started', { state: serializeState(room) });
  });

  socket.on('end-turn', () => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'playing') return;

    const activeIdx = room.turnOrder[room.currentTurnIndex];
    if (room.players[activeIdx]?.id !== socket.id) return;

    advanceTurn(currentRoom);
  });

  socket.on('pass', () => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'playing') return;

    const activeIdx = room.turnOrder[room.currentTurnIndex];
    if (room.players[activeIdx]?.id !== socket.id) return;

    room.passOrder.push(activeIdx);
    room.turnOrder.splice(room.currentTurnIndex, 1);

    if (room.currentTurnIndex >= room.turnOrder.length) {
      room.currentTurnIndex = 0;
    }

    io.to(currentRoom).emit('player-passed', {
      playerIndex: activeIdx,
      state: serializeState(room),
    });

    checkRoundOver(currentRoom);
  });

  socket.on('next-round', () => {
    if (currentRoom === null) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'game-over') return;

    // Permission: creator or allowAnyoneToStart
    const isCreator = room.createdBy === socket.id;
    if (!isCreator && !room.settings.allowAnyoneToStart) return;

    startNextRound(currentRoom);
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
    room.currentTurnIndex = 0;
    room.round = 1;
    room.passOrder = [];
    room.phase = 'lobby';
    // Keep createdBy and settings

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

    io.to(currentRoom).emit('player-left', {
      playerIndex: pIdx,
      state: serializeState(room),
    });

    const anyConnected = room.players.some((p) => p.connected);
    if (!anyConnected) {
      setTimeout(() => {
        const r = rooms.get(currentRoom);
        if (r && !r.players.some((p) => p.connected)) {
          stopTimerTick(currentRoom);
          rooms.delete(currentRoom);
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
