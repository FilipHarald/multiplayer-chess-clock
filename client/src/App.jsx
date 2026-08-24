import { useState, useEffect, useRef, useCallback, createContext, useContext } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { io } from 'socket.io-client';

const isDev = window.location.port === '5173';
const SOCKET_URL = isDev
  ? 'http://localhost:3002'
  : `${window.location.protocol}//${window.location.hostname}:3002`;

function getDeviceId() {
  let id = localStorage.getItem('mcc-device-id');
  if (!id) {
    if (crypto.randomUUID) {
      id = crypto.randomUUID();
    } else {
      id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }
    localStorage.setItem('mcc-device-id', id);
  }
  return id;
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

// navigator.clipboard only exists in secure contexts (HTTPS/localhost);
// fall back to execCommand so copy works on plain HTTP too.
function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function formatTime(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

// ---------- Shared socket ----------

const SocketCtx = createContext(null);

function SocketProvider({ children }) {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [socketId, setSocketId] = useState(null);

  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    socket.on('connect', () => {
      setConnected(true);
      setSocketId(socket.id);
    });
    socket.on('disconnect', () => setConnected(false));
    return () => socket.disconnect();
  }, []);

  return (
    <SocketCtx.Provider value={{ socket: socketRef, connected, socketId }}>
      {children}
    </SocketCtx.Provider>
  );
}

function useSocket() {
  return useContext(SocketCtx);
}

// ---------- Name Bar ----------

function NameBar({ onNameChange }) {
  const { socketId } = useSocket();
  const [name, setName] = useState(() => localStorage.getItem('mcc-player-name') || '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef(null);

  const save = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) {
      setName(trimmed);
      localStorage.setItem('mcc-player-name', trimmed);
      onNameChange?.(trimmed);
    }
    setEditing(false);
  };

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  return (
    <div className="name-bar">
      {editing ? (
        <div className="name-bar-edit">
          <span>You are</span>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
            onBlur={save}
            maxLength={20}
          />
          <button className="btn btn-small btn-primary" onClick={save}>Save</button>
        </div>
      ) : (
        <div className="name-bar-display" onClick={() => { setDraft(name); setEditing(true); }}>
          <span>You are <strong>{name || 'Anonymous'}</strong></span>
          <span className="name-bar-edit-hint">(click to edit)</span>
        </div>
      )}
      {socketId && (
        <span className="name-bar-uuid" title="Your connection ID">
          {socketId.slice(0, 8)}
        </span>
      )}
    </div>
  );
}

// ---------- Pages ----------

function HomePage() {
  const { socket, connected } = useSocket();
  const navigate = useNavigate();
  const [playerCount, setPlayerCount] = useState(3);
  const [minutesPerPlayer, setMinutesPerPlayer] = useState(60);
  const [allowAnyoneToStart, setAllowAnyoneToStart] = useState(false);
  const [allowAnyoneToPause, setAllowAnyoneToPause] = useState(false);
  const [listPublicly, setListPublicly] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');
  const [searchParams] = useSearchParams();
  const autoJoinDone = useRef(false);
  const [publicRooms, setPublicRooms] = useState([]);

  const playerName = localStorage.getItem('mcc-player-name') || '';

  // Fetch public rooms on mount
  useEffect(() => {
    fetch('/api/rooms')
      .then(r => r.json())
      .then(setPublicRooms)
      .catch(() => {});
  }, []);

  // Auto-join from URL ?room=CODE (backward compat)
  useEffect(() => {
    const roomCode = searchParams.get('room');
    if (roomCode && connected && !autoJoinDone.current) {
      autoJoinDone.current = true;
      const s = socket.current;
      s.emit('join-room', { code: roomCode.toUpperCase(), name: playerName || undefined, deviceId: getDeviceId() }, (res) => {
        if (res.error) { setError(res.error); autoJoinDone.current = false; return; }
        navigate(`/room/${roomCode.toUpperCase()}`, { state: { playerIndex: res.playerIndex, state: res.state } });
      });
    }
  }, [searchParams, connected, socket, navigate, playerName]);

  const createRoom = useCallback(() => {
    const s = socket.current;
    if (!s) return;
    s.emit('create-room', {
      playerCount,
      minutesPerPlayer,
      settings: { allowAnyoneToStart, allowAnyoneToPause, public: listPublicly },
      name: playerName || undefined,
      deviceId: getDeviceId(),
    }, (res) => {
      if (res.error) { setError(res.error); return; }
      navigate(`/room/${res.state.code}`, { state: { playerIndex: 0, state: res.state } });
    });
  }, [playerCount, minutesPerPlayer, allowAnyoneToStart, allowAnyoneToPause, listPublicly, navigate, socket]);

  const joinRoom = useCallback(() => {
    const s = socket.current;
    if (!s) return;
    const code = joinCode.toUpperCase();
    if (!code) return;
    s.emit('join-room', { code, name: playerName || undefined, deviceId: getDeviceId() }, (res) => {
      if (res.error) { setError(res.error); return; }
      navigate(`/room/${code}`, { state: { playerIndex: res.playerIndex, state: res.state } });
    });
  }, [joinCode, playerName, navigate, socket]);

  const totalTime = playerCount * minutesPerPlayer;

  return (
    <div className="app">
      <NameBar />
      <div className="setup">
        <h1>Multiplayer Chess Clock</h1>
        <div className="setup-form">
          <div className="field">
            <label>Number of Players</label>
            <select value={playerCount} onChange={e => setPlayerCount(Number(e.target.value))}>
              {[2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                <option key={n} value={n}>{n} Players</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Minutes per Player</label>
            <div className="time-input-group">
              <input
                type="number"
                min="1"
                max="999"
                value={minutesPerPlayer}
                onChange={e => setMinutesPerPlayer(Math.max(1, Number(e.target.value) || 1))}
              />
              <select
                value={minutesPerPlayer}
                onChange={e => setMinutesPerPlayer(Number(e.target.value))}
              >
                <option value={10}>10 min</option>
                <option value={30}>30 min</option>
                <option value={60}>60 min</option>
                <option value={90}>90 min</option>
              </select>
            </div>
          </div>
          <div className="total-time">
            Total max time: {Math.floor(totalTime / 60)}h {totalTime % 60}m ({totalTime} min)
          </div>

          <div className="checkbox-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={allowAnyoneToStart}
                onChange={e => setAllowAnyoneToStart(e.target.checked)}
              />
              Allow anyone to start the game
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={allowAnyoneToPause}
                onChange={e => setAllowAnyoneToPause(e.target.checked)}
              />
              Allow anyone to pause the clock
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={listPublicly}
                onChange={e => setListPublicly(e.target.checked)}
              />
              List publicly (visible on home page)
            </label>
          </div>

          <button className="btn btn-primary" onClick={createRoom} disabled={!connected}>
            {connected ? 'Create Clock' : 'Connecting...'}
          </button>
        </div>

        <div className="divider">or join an existing clock</div>

        <div className="setup-form">
          <div className="field">
            <label>Room Code</label>
            <input
              type="text"
              placeholder="Enter 6-character code"
              value={joinCode}
              onChange={e => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && joinCode.length >= 4 && joinRoom()}
              maxLength={6}
              style={{ textTransform: 'uppercase', fontFamily: 'monospace', letterSpacing: '0.15em' }}
            />
          </div>
          <button className="btn btn-secondary" onClick={joinRoom} disabled={joinCode.length < 4 || !connected}>
            Join
          </button>
        </div>

        {publicRooms.length > 0 && (
          <>
            <div className="divider">public rooms</div>
            <div className="public-rooms">
              {publicRooms.map(room => (
                <div key={room.code} className="public-room-item" onClick={() => navigate(`/room/${room.code}`)}>
                  <div className="public-room-code">{room.code}</div>
                  <div className="public-room-players">{room.connectedCount}/{room.playerCount} players</div>
                </div>
              ))}
            </div>
          </>
        )}

        {error && <div className="error">{error}</div>}
      </div>
      <div className="version-footer">{__APP_VERSION__}</div>
    </div>
  );
}

function WaitingRoom() {
  const { socket, connected, socketId } = useSocket();
  const { code } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState(null);
  const [playerIndex, setPlayerIndex] = useState(null);
  const [error, setError] = useState('');
  const joinedRef = useRef(false);
  const playerName = localStorage.getItem('mcc-player-name') || '';

  // Join room once socket is connected — always re-join so server tracks this socket
  useEffect(() => {
    const s = socket.current;
    if (!s || !connected) return;

    if (joinedRef.current) return;
    joinedRef.current = true;

    s.emit('join-room', { code, name: playerName || undefined, deviceId: getDeviceId() }, (res) => {
      if (res.error) { setError(res.error); joinedRef.current = false; return; }
      setState(res.state);
      setPlayerIndex(res.playerIndex);
    });
  }, [code, socket, connected, navigate, playerName]);

  useEffect(() => {
    const s = socket.current;
    if (!s) return;

    const onStateUpdate = ({ state: s }) => setState(s);
    const onPlayerJoined = ({ state: s }) => setState(s);
    const onPlayerLeft = ({ state: s }) => setState(s);
    const onGameStarted = ({ state: s }) => {
      navigate(`/game/${code}`, { state: { playerIndex: s.myIndex ?? playerIndex, state: s } });
    };

    s.on('state-update', onStateUpdate);
    s.on('player-joined', onPlayerJoined);
    s.on('player-left', onPlayerLeft);
    s.on('game-started', onGameStarted);

    return () => {
      s.off('state-update', onStateUpdate);
      s.off('player-joined', onPlayerJoined);
      s.off('player-left', onPlayerLeft);
      s.off('game-started', onGameStarted);
    };
  // Re-attach when `connected` flips: on a cold load of /room/CODE this effect
  // runs before SocketProvider has created the socket (child effects first),
  // so `socket.current` is still null. Without this dep the room event
  // listeners are never attached and the lobby freezes at the join snapshot.
  }, [code, socket, connected, navigate]);

  const startGame = useCallback(() => {
    socket.current?.emit('start-game');
  }, [socket]);

  const handleNameChange = useCallback((name) => {
    if (playerIndex !== null) {
      socket.current?.emit('rename-player', { index: playerIndex, name });
    }
  }, [socket, playerIndex]);

  const shareLink = `${window.location.origin}/room/${code}`;
  const canStart = state?.players.filter(p => p.connected).length >= 2;
  const isCreator = state?.createdBy === socketId;
  const canIShowStart = isCreator || state?.settings?.allowAnyoneToStart;
  const [copyState, setCopyState] = useState('idle');

  const handleCopyLink = useCallback(() => {
    copyToClipboard(shareLink).then(ok => {
      setCopyState(ok ? 'copied' : 'failed');
      setTimeout(() => setCopyState('idle'), 2000);
    });
  }, [shareLink]);

  if (!state) {
    return (
      <div className="app">
        <NameBar onNameChange={handleNameChange} />
        <div className="waiting">
          {error ? <div className="error">{error}</div> : <p>Loading room...</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <NameBar onNameChange={handleNameChange} />
      <div className="waiting">
        <a href="/" className="home-link">← Home</a>
        <h2>Waiting Room</h2>
        <div className="room-code">{code}</div>

        <div className="share-section">
          <div className="share-link" onClick={handleCopyLink}>
            {shareLink}
            <br />
            <small style={{ color: copyState === 'copied' ? '#4ade80' : copyState === 'failed' ? '#f87171' : '#888' }}>
              {copyState === 'copied' ? 'Copied!' : copyState === 'failed' ? 'Copy failed — select the link manually' : '(click to copy)'}
            </small>
          </div>
          <div className="qr-code">
            <QRCodeSVG value={shareLink} size={128} bgColor="#16213e" fgColor="#eee" />
          </div>
        </div>

        <div className="player-list">
          {state.players.map((p, i) => {
            const isHost = p.index === 0 && state.createdBy;
            const isMe = i === playerIndex;
            const isThisSlotHost = state.createdBy && p.connected && (() => {
              // Check if this player slot's socket matches the creator
              // We can't directly compare socket IDs from the player list,
              // but slot 0 is the creator's original slot
              return i === 0;
            })();

            return (
              <div key={i} className={`player-slot ${p.connected ? 'connected' : 'empty'}`}>
                <div className="player-dot" style={{ background: p.color }} />
                {p.connected ? (
                  <div className="player-slot-content">
                    <div className="player-slot-name">
                      <span>{p.name}</span>
                      {isMe && <span className="me-badge">you</span>}
                      {i === 0 && state.createdBy && <span className="host-badge">host</span>}
                    </div>
                  </div>
                ) : (
                  <span>Waiting for player...</span>
                )}
              </div>
            );
          })}
        </div>

        {canIShowStart ? (
          <button className="btn btn-primary" onClick={startGame} disabled={!canStart}>
            {canStart ? 'Start Game' : 'Need at least 2 players'}
          </button>
        ) : (
          <p style={{ color: 'var(--text-secondary)', textAlign: 'center' }}>
            Waiting for host to start the game...
          </p>
        )}

        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}

function GamePage() {
  const { socket, connected, socketId } = useSocket();
  const { code } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState(null);
  const [playerIndex, setPlayerIndex] = useState(null);
  const [timers, setTimers] = useState([]);
  const joinedRef = useRef(false);
  const playerName = localStorage.getItem('mcc-player-name') || '';

  useEffect(() => {
    const s = socket.current;
    if (!s || !connected) return;

    if (joinedRef.current) return;
    joinedRef.current = true;

    s.emit('join-room', { code, name: playerName || undefined, deviceId: getDeviceId() }, (res) => {
      if (res.error) return;
      setState(res.state);
      setPlayerIndex(res.playerIndex);
      setTimers(res.state.players.map(p => p.timerMs));
    });
  }, [code, socket, connected, navigate, playerName]);

  useEffect(() => {
    const s = socket.current;
    if (!s) return;
    const onStateUpdate = ({ state: s }) => { setState(s); setTimers(s.players.map(p => p.timerMs)); };
    const onTimerTick = ({ timers: t }) => setTimers(t);
    const onTurnChanged = ({ state: s }) => { setState(s); setTimers(s.players.map(p => p.timerMs)); };
    const onPlayerPassed = ({ state: s }) => { setState(s); setTimers(s.players.map(p => p.timerMs)); };
    const onGameOver = ({ state: s }) => {
      setState(s);
      setTimers(s.players.map(p => p.timerMs));
      navigate(`/gameover/${code}`, { state: { playerIndex: s.myIndex ?? playerIndex, state: s } });
    };
    const onNewRound = ({ state: s }) => { setState(s); setTimers(s.players.map(p => p.timerMs)); };

    s.on('state-update', onStateUpdate);
    s.on('timer-tick', onTimerTick);
    s.on('turn-changed', onTurnChanged);
    s.on('player-passed', onPlayerPassed);
    s.on('game-over', onGameOver);
    s.on('new-round', onNewRound);

    return () => {
      s.off('state-update', onStateUpdate);
      s.off('timer-tick', onTimerTick);
      s.off('turn-changed', onTurnChanged);
      s.off('player-passed', onPlayerPassed);
      s.off('game-over', onGameOver);
      s.off('new-round', onNewRound);
    };
  // Re-attach when `connected` flips: on a cold load of /room/CODE this effect
  // runs before SocketProvider has created the socket (child effects first),
  // so `socket.current` is still null. Without this dep the room event
  // listeners are never attached and the lobby freezes at the join snapshot.
  }, [code, socket, connected, navigate]);

  const endTurn = useCallback(() => socket.current?.emit('end-turn'), [socket]);
  const pass = useCallback(() => socket.current?.emit('pass'), [socket]);
  const handleNameChange = useCallback((name) => {
    if (playerIndex !== null) {
      socket.current?.emit('rename-player', { index: playerIndex, name });
    }
  }, [socket, playerIndex]);

  if (!state) {
    return <div className="app"><NameBar onNameChange={handleNameChange} /><p style={{ textAlign: 'center', padding: '40px' }}>Connecting...</p></div>;
  }

  const activeIdx = state.activePlayerIndex;
  const amActive = state.turnOrder[state.currentTurnIndex] === playerIndex;
  const amPassed = state.passOrder.includes(playerIndex);

  return (
    <div className="app">
      <NameBar onNameChange={handleNameChange} />
      <div className="game">
        <a href="/" className="home-link">← Home</a>
        <div className="round-badge">Round {state.round}</div>

        <div className="turn-order">
          {state.turnOrder.map((pIdx, i) => (
            <div
              key={pIdx}
              className={`turn-dot ${i === state.currentTurnIndex ? 'current' : ''}`}
              style={{ background: state.players[pIdx].color, color: state.players[pIdx].color }}
            />
          ))}
        </div>

        {state.players.map((p, i) => {
          const isActive = activeIdx === i;
          const hasPassed = state.passOrder.includes(i);
          const isMe = i === playerIndex;
          const passPosition = state.passOrder.indexOf(i);
          const timer = timers[i] ?? p.timerMs;
          const isLow = timer < 30000 && timer > 0;

          let cardClass = 'player-card';
          if (isActive) cardClass += ' active';
          if (hasPassed) cardClass += ' passed';

          return (
            <div
              key={i}
              className={cardClass}
              style={{ '--player-color': p.color }}
              onClick={isActive && amActive ? endTurn : undefined}
            >
              <div className="player-info">
                <div className="player-name" style={{ color: p.color }}>
                  {p.name} {isMe && <span style={{ fontSize: '0.7em', opacity: 0.6 }}>(you)</span>}
                </div>
                <div className="player-status">
                  {hasPassed ? (
                    <span className="pass-badge">Passed #{passPosition + 1}</span>
                  ) : isActive ? (
                    <span style={{ color: p.color }}>Active</span>
                  ) : (
                    <span>Waiting</span>
                  )}
                </div>
              </div>
              <div className={`player-timer ${isLow ? 'low' : ''}`}>
                {formatTime(timer)}
              </div>
            </div>
          );
        })}

        {state.phase === 'playing' && (
          <div className="game-actions">
            <button className="btn btn-pass" onClick={pass} disabled={!amActive || amPassed}>
              Pass
            </button>
            <button className="btn btn-end-turn" onClick={endTurn} disabled={!amActive}>
              End Turn
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function GameOverPage() {
  const { socket, connected, socketId } = useSocket();
  const { code } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState(null);
  const [playerIndex, setPlayerIndex] = useState(null);
  const joinedRef = useRef(false);
  const playerName = localStorage.getItem('mcc-player-name') || '';

  useEffect(() => {
    const s = socket.current;
    if (!s || !connected) return;

    if (joinedRef.current) return;
    joinedRef.current = true;

    s.emit('join-room', { code, name: playerName || undefined, deviceId: getDeviceId() }, (res) => {
      if (res.error) return;
      setState(res.state);
      setPlayerIndex(res.playerIndex);
    });
  }, [code, socket, connected, navigate, playerName]);

  useEffect(() => {
    const s = socket.current;
    if (!s) return;

    const onStateUpdate = ({ state: s }) => setState(s);
    const onGameOver = ({ state: s }) => setState(s);
    const onNewRound = ({ state: s }) => {
      setState(s);
      navigate(`/game/${code}`, { state: { playerIndex: s.myIndex ?? playerIndex, state: s } });
    };

    s.on('state-update', onStateUpdate);
    s.on('game-over', onGameOver);
    s.on('new-round', onNewRound);

    return () => {
      s.off('state-update', onStateUpdate);
      s.off('game-over', onGameOver);
      s.off('new-round', onNewRound);
    };
  // Re-attach when `connected` flips: on a cold load of /room/CODE this effect
  // runs before SocketProvider has created the socket (child effects first),
  // so `socket.current` is still null. Without this dep the room event
  // listeners are never attached and the lobby freezes at the join snapshot.
  }, [code, socket, connected, navigate]);

  const isCreator = state?.createdBy === socketId;
  const canINextRound = isCreator || state?.settings?.allowAnyoneToStart;

  const nextRound = useCallback(() => socket.current?.emit('next-round'), [socket]);
  const resetGame = useCallback(() => {
    socket.current?.emit('reset-game', {});
    navigate('/');
  }, [socket, navigate]);
  const handleNameChange = useCallback((name) => {
    if (playerIndex !== null) {
      socket.current?.emit('rename-player', { index: playerIndex, name });
    }
  }, [socket, playerIndex]);

  if (!state) {
    return <div className="app"><NameBar onNameChange={handleNameChange} /><p style={{ textAlign: 'center', padding: '40px' }}>Loading...</p></div>;
  }

  const winner = state.players[state.activePlayerIndex] || state.players.find((p, i) =>
    !state.passOrder.includes(i) && p.timerMs > 0
  );
  const loser = state.players.find((p, i) => p.timerMs <= 0);

  return (
    <div className="app">
      <NameBar onNameChange={handleNameChange} />
      <div className="game-over">
        <a href="/" className="home-link">← Home</a>
        <h2>Game Over</h2>
        {winner && (
          <div className="winner-name" style={{ color: winner.color }}>
            {winner.name} Wins!
          </div>
        )}
        {loser && (
          <p style={{ color: 'var(--text-secondary)' }}>
            {loser.name} ran out of time
          </p>
        )}

        <div className="player-list" style={{ width: '100%' }}>
          {state.players.map((p, i) => (
            <div key={i} className="player-slot connected">
              <div className="player-dot" style={{ background: p.color }} />
              <span>{p.name}</span>
              <span style={{ marginLeft: 'auto', fontFamily: 'monospace' }}>
                {formatTime(p.timerMs)}
              </span>
            </div>
          ))}
        </div>

        <div className="game-over-actions">
          {canINextRound && (
            <button className="btn btn-primary" onClick={nextRound}>Next Round</button>
          )}
          <button className="btn btn-secondary" onClick={resetGame}>New Game</button>
        </div>
      </div>
    </div>
  );
}

// ---------- App ----------

export default function App() {
  return (
    <BrowserRouter>
      <SocketProvider>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/room/:code" element={<WaitingRoom />} />
          <Route path="/game/:code" element={<GamePage />} />
          <Route path="/gameover/:code" element={<GameOverPage />} />
        </Routes>
      </SocketProvider>
    </BrowserRouter>
  );
}
