import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { io } from 'socket.io-client';

const port = 39000 + Math.floor(Math.random() * 1000);
const dbPath = `/tmp/multiplayer-chess-clock-${process.pid}.db`;

function startServer() {
  return spawn(process.execPath, ['index.js'], {
    cwd: new URL('.', import.meta.url),
    env: { ...process.env, PORT: String(port), CHESS_CLOCK_DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

let server = startServer();

async function emit(socket, event, payload) {
  return new Promise(resolve => socket.emit(event, payload, resolve));
}

async function waitFor(socket, event) {
  const [payload] = await once(socket, event);
  return payload;
}

async function waitForState(socket, predicate) {
  while (true) {
    const [{ state }] = await once(socket, 'state-update');
    if (predicate(state)) return state;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function join(socket, code, deviceId = 'test-device') {
  return emit(socket, 'join-room', { code, name: 'Test device', deviceId });
}

async function restartServer() {
  server.kill('SIGTERM');
  await once(server, 'exit');
  server = startServer();
  await once(server.stdout, 'data');
}

async function runRound(socket, passes) {
  for (const [position, index] of passes.entries()) {
    const roundOver = position === passes.length - 1 ? waitFor(socket, 'round-over') : null;
    socket.emit('pass', { index });
    if (roundOver) return (await roundOver).state;
    await once(socket, 'player-passed');
  }
}

try {
  await once(server.stdout, 'data');
  const socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
  await once(socket, 'connect');

  let response = await emit(socket, 'create-room', {
    minutesPerPlayer: 60,
    settings: { orderMode: 'normal', allowPass: true },
    deviceId: 'test-device',
  });
  assert.equal(response.state.settings.orderMode, 'normal');
  assert.equal(response.state.settings.allowPass, true);
  assert.equal(response.state.settings.timerMode, 'countdown');

  socket.emit('start-game');
  let state = (await once(socket, 'game-started'))[0].state;
  assert.deepEqual(state.turnOrder, [0, 1]);
  state = await runRound(socket, [1, 0]);
  assert.deepEqual(state.passOrder, [0, 1]);

  socket.emit('next-round');
  state = (await once(socket, 'new-round'))[0].state;
  assert.deepEqual(state.turnOrder, [0, 1]);

  socket.emit('reset-game', {});
  state = await waitForState(socket, next => next.phase === 'lobby');
  socket.emit('update-settings', { orderMode: 'normal', allowPass: false });
  state = await waitForState(socket, next => next.settings.allowPass === false);
  socket.emit('start-game');
  state = (await once(socket, 'game-started'))[0].state;
  socket.emit('pass', { index: 0 });
  await new Promise(resolve => setTimeout(resolve, 50));
  response = await emit(socket, 'join-room', {
    code: state.code,
    name: 'Test device',
    deviceId: 'test-device',
  });
  assert.deepEqual(response.state.passOrder, []);
  assert.deepEqual(response.state.pendingPass, []);

  socket.emit('update-settings', { orderMode: 'pass-order' });
  await new Promise(resolve => setTimeout(resolve, 50));
  response = await emit(socket, 'join-room', {
    code: state.code,
    name: 'Test device',
    deviceId: 'test-device',
  });
  assert.equal(response.state.settings.orderMode, 'normal');
  assert.equal(response.state.settings.allowPass, false);

  socket.emit('reset-game', {});
  await waitForState(socket, next => next.phase === 'lobby');
  socket.emit('update-settings', { orderMode: 'pass-order', allowPass: false });
  state = await waitForState(socket, next => next.settings.orderMode === 'pass-order');
  assert.equal(state.settings.allowPass, true);
  socket.emit('reorder-players', { order: [1, 0] });
  state = await waitForState(socket, next => next.waitingOrder[0] === 1);
  socket.emit('start-game');
  state = (await once(socket, 'game-started'))[0].state;
  assert.deepEqual(state.turnOrder, [1, 0]);
  state = await runRound(socket, [0, 1]);
  assert.deepEqual(state.passOrder, [1, 0]);
  socket.emit('next-round');
  state = (await once(socket, 'new-round'))[0].state;
  assert.deepEqual(state.turnOrder, [1, 0]);

  socket.emit('reset-game', {});
  state = await waitForState(socket, next => next.phase === 'lobby');
  socket.emit('update-time', { minutesPerPlayer: 1 });
  state = await waitForState(socket, next => next.minutesPerPlayer === 1);
  socket.emit('update-settings', { timerMode: 'invalid' });
  await sleep(50);
  response = await join(socket, state.code);
  assert.equal(response.state.settings.timerMode, 'countdown');

  socket.emit('update-settings', { timerMode: 'count-up' });
  state = await waitForState(socket, next => next.settings.timerMode === 'count-up');
  assert.equal(state.minutesPerPlayer, 1);
  assert.deepEqual(state.players.map(player => player.timerMs), [0, 0]);
  assert.deepEqual(state.players.map(player => player.overtime), [false, false]);
  socket.emit('update-time', { minutesPerPlayer: 999 });
  await sleep(50);
  response = await join(socket, state.code);
  assert.equal(response.state.minutesPerPlayer, 1);

  socket.emit('start-game');
  state = (await once(socket, 'game-started'))[0].state;
  await sleep(250);
  response = await join(socket, state.code);
  state = response.state;
  assert.ok(state.players[0].elapsedMs >= 100);
  assert.equal(state.players[1].elapsedMs, 0);
  assert.equal(state.players[0].timerMs, state.players[0].elapsedMs);
  assert.equal(state.players[0].overtime, false);

  socket.emit('toggle-pause');
  state = await waitForState(socket, next => next.paused);
  const pausedElapsed = state.players[0].elapsedMs;
  await sleep(250);
  response = await join(socket, state.code);
  assert.equal(response.state.players[0].elapsedMs, pausedElapsed);
  socket.emit('toggle-pause');
  await waitForState(socket, next => !next.paused);
  await sleep(150);
  response = await join(socket, state.code);
  assert.ok(response.state.players[0].elapsedMs > pausedElapsed);

  socket.emit('end-turn');
  state = (await once(socket, 'turn-changed'))[0].state;
  assert.equal(state.activePlayerIndex, 1);
  const firstPlayerElapsed = state.players[0].elapsedMs;
  await sleep(200);
  response = await join(socket, state.code);
  assert.equal(response.state.players[0].elapsedMs, firstPlayerElapsed);
  assert.ok(response.state.players[1].elapsedMs >= 100);

  state = await runRound(socket, [1, 0]);
  assert.equal(state.settings.timerMode, 'count-up');
  assert.equal(state.phase, 'round-over');
  socket.emit('next-round');
  state = (await once(socket, 'new-round'))[0].state;
  assert.equal(state.settings.timerMode, 'count-up');
  assert.equal(state.paused, true);
  assert.deepEqual(state.players.map(player => player.overtime), [false, false]);
  socket.emit('toggle-pause');
  state = await waitForState(socket, next => !next.paused);
  socket.emit('toggle-pause');
  state = await waitForState(socket, next => next.paused);

  const persisted = new Database(dbPath, { readonly: true });
  const persistedRoom = JSON.parse(persisted.prepare('SELECT data FROM rooms WHERE code = ?').get(state.code).data);
  persisted.close();
  persistedRoom.players[1].elapsedMs = persistedRoom.limitMs + 1000;
  assert.equal(persistedRoom.settings.timerMode, 'count-up');
  const writable = new Database(dbPath);
  writable.prepare('UPDATE rooms SET data = ? WHERE code = ?').run(JSON.stringify(persistedRoom), state.code);
  writable.close();

  const persistedCode = state.code;
  socket.disconnect();
  await restartServer();
  const restartedSocket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
  await once(restartedSocket, 'connect');
  response = await join(restartedSocket, persistedCode, 'restart-device');
  assert.equal(response.state.settings.timerMode, 'count-up');
  assert.equal(response.state.paused, true);
  assert.ok(response.state.players[0].elapsedMs >= firstPlayerElapsed);
  assert.ok(response.state.players[1].elapsedMs > response.state.limitMs);
  assert.equal(response.state.players[1].timerMs, response.state.players[1].elapsedMs);
  assert.equal(response.state.players[1].overtime, false);

  restartedSocket.emit('reset-game', {});
  state = await waitForState(restartedSocket, next => next.phase === 'lobby');
  assert.equal(state.settings.timerMode, 'count-up');
  assert.equal(state.minutesPerPlayer, 1);
  assert.deepEqual(state.players.map(player => player.timerMs), [0, 0]);
  restartedSocket.emit('update-settings', { timerMode: 'countdown' });
  state = await waitForState(restartedSocket, next => next.settings.timerMode === 'countdown');
  assert.equal(state.minutesPerPlayer, 1);
  assert.deepEqual(state.players.map(player => player.timerMs), [60000, 60000]);

  restartedSocket.disconnect();
  server.kill('SIGTERM');
  await once(server, 'exit');

  const legacyCode = 'LEGACY22';
  const legacyDb = new Database(dbPath);
  const legacyRoom = {
    code: legacyCode,
    players: [
      { name: 'Player 1', color: '#e74c3c', elapsedMs: 0 },
      { name: 'Player 2', color: '#3498db', elapsedMs: 0 },
    ],
    devices: [],
    minutesPerPlayer: 5,
    limitMs: 300000,
    waitingOrder: [0, 1],
    turnOrder: [0, 1],
    currentTurnIndex: 0,
    round: 1,
    passOrder: [],
    pendingPass: [],
    phase: 'lobby',
    paused: false,
    pausedBy: null,
    createdAt: Date.now(),
    settings: { public: true },
  };
  legacyDb.prepare('INSERT OR REPLACE INTO rooms (code, data, created_at) VALUES (?, ?, ?)')
    .run(legacyCode, JSON.stringify(legacyRoom), legacyRoom.createdAt);
  legacyDb.close();

  server = startServer();
  await once(server.stdout, 'data');
  const legacySocket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
  await once(legacySocket, 'connect');
  response = await join(legacySocket, legacyCode, 'legacy-device');
  assert.equal(response.state.settings.timerMode, 'countdown');
  assert.deepEqual(response.state.players.map(player => player.timerMs), [300000, 300000]);
  legacySocket.disconnect();

  console.log('server integration checks passed');
} finally {
  if (!server.killed) server.kill('SIGTERM');
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
}
