import { useState, useEffect, useRef, useCallback, createContext, useContext } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useParams, useSearchParams, useLocation } from 'react-router-dom';
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

function getPlayerName() {
  let name = sessionStorage.getItem('mcc-player-name');
  if (!name) {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    name = Array.from({ length: 6 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
    sessionStorage.setItem('mcc-player-name', name);
  }
  return name;
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

// ---------- App Header ----------

function NameBar() {
  const { socket, socketId } = useSocket();
  const [name, setName] = useState(() => getPlayerName());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef(null);

  const save = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) {
      setName(trimmed);
      localStorage.setItem('mcc-player-name', trimmed);
      socket.current?.emit('rename-player', { name: trimmed });
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
        <span className="name-bar-uuid">
          <span className="name-bar-uuid-label">ID:</span> {socketId.slice(0, 8)}
        </span>
      )}
    </div>
  );
}

function AppHeader() {
  const location = useLocation();
  return (
    <header className="app-header">
      {location.pathname !== '/' && <a href="/" className="home-link">← Home</a>}
      <NameBar />
    </header>
  );
}

// ---------- Pages ----------

function HomePage() {
  const { socket, connected } = useSocket();
  const navigate = useNavigate();
  const [minutesPerPlayer, setMinutesPerPlayer] = useState(60);
  const [allowAnyoneToStart, setAllowAnyoneToStart] = useState(true);
  const [allowAnyoneToPause, setAllowAnyoneToPause] = useState(true);
  const [listPublicly, setListPublicly] = useState(true);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');
  const [searchParams] = useSearchParams();
  const autoJoinDone = useRef(false);
  const [publicRooms, setPublicRooms] = useState([]);

  const playerName = getPlayerName();

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
      playerCount: 10,
      minutesPerPlayer,
      settings: { allowAnyoneToStart, allowAnyoneToPause, public: listPublicly },
      name: playerName || undefined,
      deviceId: getDeviceId(),
    }, (res) => {
      if (res.error) { setError(res.error); return; }
      navigate(`/room/${res.state.code}`, { state: { playerIndex: 0, state: res.state } });
    });
  }, [minutesPerPlayer, allowAnyoneToStart, allowAnyoneToPause, listPublicly, navigate, socket]);

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

  return (
    <div className="app">
      <div className="setup">
        <h1>Multiplayer Chess Clock</h1>
        <div className="setup-form">
          <div className="field">
            <label>Minutes per Player</label>
            <input
              type="number"
              min="1"
              max="999"
              value={minutesPerPlayer}
              onChange={e => setMinutesPerPlayer(Math.max(1, Number(e.target.value) || 1))}
            />
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
              placeholder="Enter 8-character code"
              value={joinCode}
              onChange={e => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && joinCode.length >= 4 && joinRoom()}
              maxLength={8}
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
  const playerName = getPlayerName();

  // Join room once socket is connected — always re-join so server tracks this socket
  useEffect(() => {
    const s = socket.current;
    if (!s || !connected) return;

    if (joinedRef.current) return;
    joinedRef.current = true;

    s.emit('join-room', { code, name: playerName || undefined, deviceId: getDeviceId() }, (res) => {
      if (res.error) { setError(res.error); joinedRef.current = false; return; }
      // If game already in progress, redirect to game view
      if (res.state.phase === 'playing' || res.state.phase === 'game-over' || res.state.phase === 'round-over') {
        navigate(`/game/${code}`, { state: { playerIndex: res.playerIndex, state: res.state } });
        return;
      }
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

  const shareLink = `${window.location.origin}/room/${code}`;
  const canStart = state?.players.filter(p => p.connected).length >= 2;
  const isCreator = state?.createdBy === socketId;
  const canIShowStart = isCreator || state?.settings?.allowAnyoneToStart;
  const canReorder = isCreator || state?.settings?.allowAnyoneToStart;
  const [copyState, setCopyState] = useState('idle');
  const dragIndexRef = useRef(null);

  const handleCopyLink = useCallback(() => {
    copyToClipboard(shareLink).then(ok => {
      setCopyState(ok ? 'copied' : 'failed');
      setTimeout(() => setCopyState('idle'), 2000);
    });
  }, [shareLink]);

  const displayOrder = state?.waitingOrder || state?.players.map((_, i) => i) || [];

  const handleDragStart = useCallback((e, idx) => {
    dragIndexRef.current = idx;
    e.dataTransfer.effectAllowed = 'move';
    e.currentTarget.style.opacity = '0.4';
  }, []);

  const handleDragEnd = useCallback((e) => {
    e.currentTarget.style.opacity = '1';
    dragIndexRef.current = null;
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((e, dropIdx) => {
    e.preventDefault();
    const dragIdx = dragIndexRef.current;
    if (dragIdx === null || dragIdx === dropIdx) return;

    const newOrder = [...displayOrder];
    const [moved] = newOrder.splice(dragIdx, 1);
    newOrder.splice(dropIdx, 0, moved);
    socket.current?.emit('reorder-players', { order: newOrder });
  }, [displayOrder, socket]);

  if (!state) {
    return (
      <div className="app">
        
        <div className="waiting">
          {error ? <div className="error">{error}</div> : <p>Loading room...</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      
      <div className="waiting">
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
          {displayOrder.filter(pIdx => state.players[pIdx]?.connected).map((pIdx, pos) => {
            const p = state.players[pIdx];
            const isMe = pIdx === playerIndex;

            return (
              <div
                key={pIdx}
                className={`player-slot connected ${canReorder ? 'draggable' : ''}`}
                draggable={canReorder}
                onDragStart={(e) => handleDragStart(e, pos)}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, pos)}
              >
                {canReorder && <span className="drag-handle" title="Drag to reorder">⠿</span>}
                <span className="turn-order-pos">{pos + 1}.</span>
                <div className="player-dot" style={{ background: p.color }} />
                <div className="player-slot-content">
                  <div className="player-slot-name">
                    <span>{p.name}</span>
                    {isMe && <span className="me-badge">you</span>}
                    {p.index === 0 && state.createdBy && <span className="host-badge">host</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {state && (
          <div className="time-info">
            <div className="time-info-row">
              <span>Time per player:</span>
              {isCreator ? (
                <input
                  type="number"
                  min="1"
                  max="999"
                  value={state.minutesPerPlayer || 60}
                  onChange={e => {
                    const val = Math.max(1, Number(e.target.value) || 1);
                    socket.current?.emit('update-time', { minutesPerPlayer: val });
                  }}
                  className="time-info-input"
                />
              ) : (
                <strong>{state.minutesPerPlayer || 60} min</strong>
              )}
            </div>
            <div className="time-info-row">
              <span>Total max time:</span>
              <span>
                {(() => {
                  const connected = state.players.filter(p => p.connected).length || state.players.length;
                  const total = connected * (state.minutesPerPlayer || 60);
                  return `${Math.floor(total / 60)}h ${total % 60}m`;
                })()}
              </span>
            </div>
            <div className="time-info-row">
              <span>Expected end time:</span>
              <span>
                {(() => {
                  const connected = state.players.filter(p => p.connected).length || state.players.length;
                  const totalMs = connected * (state.minutesPerPlayer || 60) * 60 * 1000;
                  const endTime = new Date(Date.now() + totalMs);
                  return endTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                })()}
              </span>
            </div>
          </div>
        )}

        {isCreator && (
          <div className="settings-section">
            <div className="checkbox-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={state.settings?.allowAnyoneToStart ?? true}
                  onChange={e => socket.current?.emit('update-settings', { allowAnyoneToStart: e.target.checked })}
                />
                Allow anyone to start the game
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={state.settings?.allowAnyoneToPause ?? true}
                  onChange={e => socket.current?.emit('update-settings', { allowAnyoneToPause: e.target.checked })}
                />
                Allow anyone to pause the clock
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={state.settings?.public ?? true}
                  onChange={e => socket.current?.emit('update-settings', { public: e.target.checked })}
                />
                List publicly (visible on home page)
              </label>
            </div>
          </div>
        )}

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

// Simple notification sound via Web Audio API — a short "ding"
let _audioCtx = null;
function playTurnSound() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.connect(gain);
    gain.connect(_audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, _audioCtx.currentTime);
    osc.frequency.setValueAtTime(1100, _audioCtx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.15, _audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + 0.3);
    osc.start(_audioCtx.currentTime);
    osc.stop(_audioCtx.currentTime + 0.3);
  } catch { /* audio blocked */ }
}

function GamePage() {
  const { socket, connected, socketId } = useSocket();
  const { code } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState(null);
  const [playerIndex, setPlayerIndex] = useState(null);
  const [timers, setTimers] = useState([]);
  const joinedRef = useRef(false);
  const playerName = getPlayerName();
  // Track previous active player to detect turn changes for notification
  const prevActiveRef = useRef(null);
  const [isMyTurn, setIsMyTurn] = useState(false);
  const [disconnectedPlayer, setDisconnectedPlayer] = useState(null);
  const [showSettings, setShowSettings] = useState(false);

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
      myIndexRef.current = res.state.myIndex ?? res.playerIndex;
      prevActiveRef.current = res.state.activePlayerIndex;
      setIsMyTurn(res.state.activePlayerIndex === (res.state.myIndex ?? res.playerIndex));
    });
  }, [code, socket, connected, navigate, playerName]);

  useEffect(() => {
    const s = socket.current;
    if (!s) return;
    const onStateUpdate = ({ state: s }) => {
      setState(s); setTimers(s.players.map(p => p.timerMs));
      const myIdx = s.myIndex ?? myIndexRef.current;
      myIndexRef.current = myIdx;
      const nowMyTurn = s.activePlayerIndex === myIdx;
      if (nowMyTurn && prevActiveRef.current !== s.activePlayerIndex) playTurnSound();
      prevActiveRef.current = s.activePlayerIndex;
      setIsMyTurn(nowMyTurn);
    };
    const onTimerTick = ({ timers: t, activePlayerIndex }) => {
      setTimers(t);
      if (activePlayerIndex !== undefined) {
        const myIdx = myIndexRef.current;
        const nowMyTurn = activePlayerIndex === myIdx;
        if (nowMyTurn && prevActiveRef.current !== activePlayerIndex) playTurnSound();
        prevActiveRef.current = activePlayerIndex;
        setIsMyTurn(nowMyTurn);
      }
    };
    const onTurnChanged = ({ state: s }) => {
      setState(s); setTimers(s.players.map(p => p.timerMs));
      const myIdx = s.myIndex ?? myIndexRef.current;
      myIndexRef.current = myIdx;
      const nowMyTurn = s.activePlayerIndex === myIdx;
      if (nowMyTurn && prevActiveRef.current !== s.activePlayerIndex) playTurnSound();
      prevActiveRef.current = s.activePlayerIndex;
      setIsMyTurn(nowMyTurn);
    };
    const onPlayerPassed = ({ state: s }) => {
      setState(s); setTimers(s.players.map(p => p.timerMs));
      const myIdx = s.myIndex ?? myIndexRef.current;
      myIndexRef.current = myIdx;
      const nowMyTurn = s.activePlayerIndex === myIdx;
      if (nowMyTurn && prevActiveRef.current !== s.activePlayerIndex) playTurnSound();
      prevActiveRef.current = s.activePlayerIndex;
      setIsMyTurn(nowMyTurn);
    };
    const onPlayerUnpassed = ({ state: s }) => {
      setState(s); setTimers(s.players.map(p => p.timerMs));
      const myIdx = s.myIndex ?? myIndexRef.current;
      myIndexRef.current = myIdx;
      const nowMyTurn = s.activePlayerIndex === myIdx;
      if (nowMyTurn && prevActiveRef.current !== s.activePlayerIndex) playTurnSound();
      prevActiveRef.current = s.activePlayerIndex;
      setIsMyTurn(nowMyTurn);
    };
    const onGameOver = ({ state: s }) => {
      setState(s);
      setTimers(s.players.map(p => p.timerMs));
      const goMyIdx = s.myIndex ?? myIndexRef.current;
      myIndexRef.current = goMyIdx;
      setIsMyTurn(false);
      navigate(`/gameover/${code}`, { state: { playerIndex: goMyIdx, state: s } });
    };
    const onNewRound = ({ state: s }) => {
      setState(s); setTimers(s.players.map(p => p.timerMs));
      const nrMyIdx = s.myIndex ?? myIndexRef.current;
      myIndexRef.current = nrMyIdx;
      setIsMyTurn(s.activePlayerIndex === nrMyIdx);
    };
    const onRoundOver = ({ state: s }) => {
      setState(s);
      navigate(`/gameover/${code}`, { state: { playerIndex: s.myIndex ?? myIndexRef.current, state: s } });
    };
    const onPlayerLeft = ({ playerIndex: pIdx, playerName, state: s }) => {
      setState(s); setTimers(s.players.map(p => p.timerMs));
      setDisconnectedPlayer({ index: pIdx, name: playerName || s.players[pIdx]?.name || `Player ${pIdx + 1}` });
      const myIdx = s.myIndex ?? myIndexRef.current;
      myIndexRef.current = myIdx;
      setIsMyTurn(s.activePlayerIndex === myIdx);
    };
    const onPlayerReconnected = ({ playerIndex: pIdx, playerName, state: s }) => {
      setState(s); setTimers(s.players.map(p => p.timerMs));
      setDisconnectedPlayer(null);
      const myIdx = s.myIndex ?? myIndexRef.current;
      myIndexRef.current = myIdx;
      setIsMyTurn(s.activePlayerIndex === myIdx);
    };

    s.on('state-update', onStateUpdate);
    s.on('timer-tick', onTimerTick);
    s.on('turn-changed', onTurnChanged);
    s.on('player-passed', onPlayerPassed);
    s.on('player-unpassed', onPlayerUnpassed);
    s.on('game-over', onGameOver);
    s.on('new-round', onNewRound);
    s.on('round-over', onRoundOver);
    s.on('player-left', onPlayerLeft);
    s.on('player-reconnected', onPlayerReconnected);

    return () => {
      s.off('state-update', onStateUpdate);
      s.off('timer-tick', onTimerTick);
      s.off('turn-changed', onTurnChanged);
      s.off('player-passed', onPlayerPassed);
      s.off('player-unpassed', onPlayerUnpassed);
      s.off('game-over', onGameOver);
      s.off('new-round', onNewRound);
      s.off('round-over', onRoundOver);
      s.off('player-left', onPlayerLeft);
      s.off('player-reconnected', onPlayerReconnected);
    };
  // Re-attach when `connected` flips: on a cold load of /room/CODE this effect
  // runs before SocketProvider has created the socket (child effects first),
  // so `socket.current` is still null. Without this dep the room event
  // listeners are never attached and the lobby freezes at the join snapshot.
  }, [code, socket, connected, navigate]);

  const endTurn = useCallback(() => socket.current?.emit('end-turn'), [socket]);
  const pass = useCallback((index) => socket.current?.emit('pass', { index }), [socket]);
  const unpass = useCallback((index) => socket.current?.emit('unpass', { index }), [socket]);
  // Acting on ANOTHER player's clock requires a confirming second click;
  // acting on your own is instant. `armed` tracks the pending other-player action.
  const myIndexRef = useRef(null);
  const [armed, setArmed] = useState(null);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(null), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  useEffect(() => { setArmed(null); setDisconnectedPlayer(null); }, [state?.phase]);

  const handleEndTurn = useCallback((i) => {
    const isDisconnected = state?.players[i] && !state.players[i].connected;
    if (i === playerIndex || isDisconnected) { setArmed(null); endTurn(); return; }
    if (armed && armed.index === i && armed.action === 'end') { setArmed(null); endTurn(); return; }
    setArmed({ index: i, action: 'end' });
  }, [playerIndex, armed, endTurn, state]);

  const handlePass = useCallback((i) => {
    const isDisconnected = state?.players[i] && !state.players[i].connected;
    if (i === playerIndex || isDisconnected) { setArmed(null); pass(i); return; }
    if (armed && armed.index === i && armed.action === 'pass') { setArmed(null); pass(i); return; }
    setArmed({ index: i, action: 'pass' });
  }, [playerIndex, armed, pass, state]);

  const handleUnpass = useCallback((i) => {
    if (i === playerIndex) { setArmed(null); unpass(i); return; }
    if (armed && armed.index === i && armed.action === 'unpass') { setArmed(null); unpass(i); return; }
    setArmed({ index: i, action: 'unpass' });
  }, [playerIndex, armed, unpass]);

  const togglePause = useCallback(() => socket.current?.emit('toggle-pause'), [socket]);

  if (!state) {
    return <div className="app"><p style={{ textAlign: 'center', padding: '40px' }}>Connecting...</p></div>;
  }

  const activeIdx = state.activePlayerIndex;
  const isCreator = state.createdBy === socketId;
  const canIPause = isCreator || state.settings?.allowAnyoneToPause;
  const isPausedByDisconnect = state.paused && String(state.pausedBy).startsWith('disconnected:');
  const canIResume = canIPause || isPausedByDisconnect;

  // Upcoming turn order: remaining players after current + passed players in pass order
  const upcomingInRound = state.turnOrder.slice(state.currentTurnIndex + 1);
  const upcomingFromStart = state.turnOrder.slice(0, state.currentTurnIndex);
  const upcomingRemaining = [...upcomingInRound, ...upcomingFromStart];
  const upcomingPassed = state.passOrder;

  return (
    <div className={`app ${isMyTurn && state.phase === 'playing' && !state.paused ? 'my-turn-active' : ''}`}>
      
      <div className="game">
        <div className="round-header">
          <div className="round-badge">Round {state.round}</div>
          {state.phase === 'playing' && (
            <button
              className={`btn btn-pause ${state.paused ? 'btn-resume' : ''}`}
              onClick={togglePause}
              disabled={!canIPause && !canIResume}
              title={canIPause || canIResume ? undefined : 'Only the host can pause'}
            >
              {state.paused ? 'Resume' : 'Pause'}
            </button>
          )}
          {isCreator && (
            <button
              className="btn btn-small btn-settings"
              onClick={() => setShowSettings(!showSettings)}
              title="Game settings"
            >
              {showSettings ? 'Hide Settings' : 'Settings'}
            </button>
          )}
        </div>

        {isCreator && showSettings && (
          <div className="settings-section">
            <div className="checkbox-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={state.settings?.allowAnyoneToStart ?? true}
                  onChange={e => socket.current?.emit('update-settings', { allowAnyoneToStart: e.target.checked })}
                />
                Allow anyone to start the game
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={state.settings?.allowAnyoneToPause ?? true}
                  onChange={e => socket.current?.emit('update-settings', { allowAnyoneToPause: e.target.checked })}
                />
                Allow anyone to pause the clock
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={state.settings?.public ?? true}
                  onChange={e => socket.current?.emit('update-settings', { public: e.target.checked })}
                />
                List publicly (visible on home page)
              </label>
            </div>
          </div>
        )}

        {state.phase === 'playing' && state.paused && (
          <div className="paused-banner">
            {state.pausedBy === 'round-start'
              ? 'Clocks paused — the first turn of the round resumes them'
              : String(state.pausedBy).startsWith('disconnected:')
                ? `${state.players[Number(String(state.pausedBy).split(':')[1])]?.name ?? 'A player'} disconnected — clock paused`
                : `Paused by ${state.players[state.pausedBy]?.name ?? 'host'} — press Resume to continue`}
          </div>
        )}

        {state.phase === 'playing' && disconnectedPlayer && (
          <div className="disconnect-banner">
            {disconnectedPlayer.name} has left the room — waiting for reconnection
            {state.paused && String(state.pausedBy).startsWith('disconnected:') && (
              <div className="disconnect-actions">
                {activeIdx === disconnectedPlayer.index && (
                  <button
                    className="btn-mini btn-end"
                    onClick={() => handleEndTurn(disconnectedPlayer.index)}
                  >
                    {`End ${disconnectedPlayer.name}'s turn`}
                  </button>
                )}
                <button
                  className="btn-mini btn-pass"
                  onClick={() => handlePass(disconnectedPlayer.index)}
                >
                  {`Pass ${disconnectedPlayer.name}`}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="turn-order">
          {state.turnOrder.filter(pIdx => state.players[pIdx]?.connected).map((pIdx, i) => (
            <div
              key={pIdx}
              className={`turn-dot ${state.turnOrder.indexOf(pIdx) === state.currentTurnIndex ? 'current' : ''}`}
              style={{ background: state.players[pIdx].color, color: state.players[pIdx].color }}
            />
          ))}
        </div>

        {/* Upcoming turn order list */}
        {state.phase === 'playing' && (upcomingRemaining.length > 0 || upcomingPassed.length > 0) && (
          <div className="upcoming-order">
            <div className="upcoming-label">Up next</div>
            {upcomingRemaining.map((pIdx, pos) => (
              <div key={pIdx} className="upcoming-item">
                <span className="upcoming-pos">{pos + 1}.</span>
                <div className="player-dot" style={{ background: state.players[pIdx].color }} />
                <span className="upcoming-name">{state.players[pIdx].name}</span>
              </div>
            ))}
            {upcomingPassed.length > 0 && (
              <>
                <div className="upcoming-divider">Passed</div>
                {upcomingPassed.map((pIdx) => {
                  const passPos = state.passOrder.indexOf(pIdx);
                  const isMe = pIdx === playerIndex;
                  const armedHere = armed && armed.index === pIdx && armed.action === 'unpass';
                  return (
                    <div key={pIdx} className="upcoming-item passed-item">
                      <span className="upcoming-pos">{passPos + 1}.</span>
                      <div className="player-dot" style={{ background: state.players[pIdx].color }} />
                      <span className="upcoming-name">{state.players[pIdx].name}</span>
                      <button
                        className={`btn-mini btn-unpass ${armedHere ? 'armed' : ''}`}
                        onClick={() => handleUnpass(pIdx)}
                        title={isMe ? 'Un-pass yourself' : `Un-pass ${state.players[pIdx].name}`}
                      >
                        {armedHere ? 'Confirm' : 'Un-pass'}
                      </button>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {state.players.filter(p => p.connected).map((p, i) => {
          const origIdx = state.players.indexOf(p);
          const isActive = activeIdx === origIdx;
          const hasPassed = state.passOrder.includes(origIdx);
          const isMe = origIdx === playerIndex;
          const passPosition = state.passOrder.indexOf(origIdx);
          const timer = timers[origIdx] ?? p.timerMs;
          const isLow = timer < 30000 && timer > 0;
          const armedHere = armed && armed.index === origIdx;
          const canAct = state.phase === 'playing' && !hasPassed;

          let cardClass = 'player-card';
          if (isActive) cardClass += ' active';
          if (hasPassed) cardClass += ' passed';
          if (armedHere) cardClass += ' armed-target';

          return (
            <div
              key={origIdx}
              className={cardClass}
              style={{ '--player-color': p.color }}
              onClick={isActive && state.phase === 'playing' ? () => handleEndTurn(origIdx) : undefined}
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
              {canAct && (
                <div className="card-actions" onClick={(e) => e.stopPropagation()}>
                  {isActive && (
                    <button
                      className={`btn-mini btn-end ${armedHere && armed.action === 'end' ? 'armed' : ''}`}
                      title={isMe ? 'End your own turn' : `End ${p.name}'s turn for them`}
                      onClick={() => handleEndTurn(origIdx)}
                    >
                      {armedHere && armed.action === 'end'
                        ? `Confirm: end ${p.name}'s turn`
                        : isMe
                          ? 'End Turn'
                          : `End ${p.name}'s turn`}
                    </button>
                  )}
                  <button
                    className={`btn-mini btn-pass ${armedHere && armed.action === 'pass' ? 'armed' : ''}`}
                    title={isMe ? 'Pass for yourself' : `Pass ${p.name} for them`}
                    onClick={() => handlePass(origIdx)}
                  >
                    {armedHere && armed.action === 'pass'
                      ? `Confirm: pass ${p.name}`
                      : isMe
                        ? 'Pass'
                        : `Pass ${p.name}`}
                  </button>
                </div>
              )}
            </div>
          );
        })}
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
  const playerName = getPlayerName();

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
  if (!state) {
    return <div className="app"><p style={{ textAlign: 'center', padding: '40px' }}>Loading...</p></div>;
  }

  const isRoundOver = state.phase === 'round-over';
  const winner = isRoundOver ? null : state.players[state.activePlayerIndex] || state.players.find((p, i) =>
    !state.passOrder.includes(i) && p.timerMs > 0
  );
  const loser = isRoundOver ? null : state.players.find((p, i) => p.timerMs <= 0);

  return (
    <div className="app">
      
      <div className="game-over">
        <h2>{isRoundOver ? `Round ${state.round} Complete` : 'Game Over'}</h2>
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

        {isRoundOver && (
          <>
            <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
              Everyone passed — next round runs in pass order:
            </p>
            <div className="player-list" style={{ width: '100%' }}>
              {state.passOrder.map((pIdx, pos) => {
                const p = state.players[pIdx];
                return (
                  <div key={pIdx} className="player-slot connected">
                    <span style={{ fontFamily: 'monospace', opacity: 0.6 }}>{pos + 1}.</span>
                    <div className="player-dot" style={{ background: p.color }} />
                    <span>{p.name}</span>
                  </div>
                );
              })}
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
              The next round starts with all clocks paused.
            </p>
          </>
        )}

        {!isRoundOver && (
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
        )}

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
        <AppHeader />
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
