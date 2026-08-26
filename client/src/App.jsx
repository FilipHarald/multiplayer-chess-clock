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
    id = crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
    localStorage.setItem('mcc-device-id', id);
  }
  return id;
}

function getDeviceName() {
  let name = localStorage.getItem('mcc-device-name');
  if (!name) {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    name = Array.from({ length: 6 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
    localStorage.setItem('mcc-device-name', name);
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

  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    return () => socket.disconnect();
  }, []);

  return (
    <SocketCtx.Provider value={{ socket: socketRef, connected }}>
      {children}
    </SocketCtx.Provider>
  );
}

function useSocket() {
  return useContext(SocketCtx);
}

// ---------- Device Name Bar ----------

function DeviceNameBar() {
  const { socket } = useSocket();
  const [name, setName] = useState(() => getDeviceName());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef(null);

  const save = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) {
      setName(trimmed);
      localStorage.setItem('mcc-device-name', trimmed);
      socket.current?.emit('set-device-name', { name: trimmed });
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
          <span>Device:</span>
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
          <span>Device: <strong>{name}</strong></span>
          <span className="name-bar-edit-hint">(click to edit)</span>
        </div>
      )}
    </div>
  );
}

function AppHeader() {
  const location = useLocation();
  return (
    <header className="app-header">
      {location.pathname !== '/' && <a href="/" className="home-link">&larr; Home</a>}
      <DeviceNameBar />
    </header>
  );
}

// ---------- Pages ----------

function HomePage() {
  const { socket, connected } = useSocket();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [searchParams] = useSearchParams();
  const autoJoinDone = useRef(false);
  const [publicRooms, setPublicRooms] = useState([]);

  const deviceName = getDeviceName();

  useEffect(() => {
    fetch('/api/rooms').then(r => r.json()).then(setPublicRooms).catch(() => {});
    const interval = setInterval(() => {
      fetch('/api/rooms').then(r => r.json()).then(setPublicRooms).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Auto-join from URL ?room=CODE
  useEffect(() => {
    const roomCode = searchParams.get('room');
    if (roomCode && connected && !autoJoinDone.current) {
      autoJoinDone.current = true;
      const s = socket.current;
      s.emit('join-room', { code: roomCode.toUpperCase(), name: deviceName, deviceId: getDeviceId() }, (res) => {
        if (res.error) { setError(res.error); autoJoinDone.current = false; return; }
        navigate(`/room/${roomCode.toUpperCase()}`, { state: { state: res.state } });
      });
    }
  }, [searchParams, connected, socket, navigate, deviceName]);

  const createRoom = useCallback(() => {
    const s = socket.current;
    if (!s) return;
    s.emit('create-room', {
      minutesPerPlayer: 60,
      settings: { public: true },
      name: deviceName,
      deviceId: getDeviceId(),
    }, (res) => {
      if (res.error) { setError(res.error); return; }
      navigate(`/room/${res.state.code}`, { state: { state: res.state } });
    });
  }, [navigate, socket, deviceName]);

  return (
    <div className="app">
      <div className="setup">
        <h1>Multiplayer Chess Clock</h1>
        <p className="home-description">
          A shared clock for board games. Create a room and share the link — any device with the link can join and control the clocks.
        </p>

        <button className="btn btn-primary" onClick={createRoom} disabled={!connected} style={{ width: '100%' }}>
          {connected ? 'New Room' : 'Connecting...'}
        </button>

        {publicRooms.length > 0 && (
          <>
            <div className="divider">public rooms</div>
            <div className="public-rooms">
              {publicRooms.map(room => (
                <div key={room.code} className="public-room-item" onClick={() => navigate(`/room/${room.code}`)}>
                  <div className="public-room-code">{room.code}</div>
                  <div className="public-room-meta">
                    <span>{room.deviceCount} device{room.deviceCount !== 1 ? 's' : ''}</span>
                    <span className="public-room-phase">{room.phase}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}

function NewRoom() {
  const { socket, connected } = useSocket();
  const { code } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const joinedRef = useRef(false);
  const deviceName = getDeviceName();

  useEffect(() => {
    const s = socket.current;
    if (!s || !connected) return;
    if (joinedRef.current) return;
    joinedRef.current = true;

    s.emit('join-room', { code, name: deviceName, deviceId: getDeviceId() }, (res) => {
      if (res.error) { setError(res.error); joinedRef.current = false; return; }
      if (res.state.phase === 'playing' || res.state.phase === 'game-over' || res.state.phase === 'round-over') {
        navigate(`/game/${code}`, { state: { state: res.state } });
        return;
      }
      setState(res.state);
    });
  }, [code, socket, connected, navigate, deviceName]);

  useEffect(() => {
    const s = socket.current;
    if (!s) return;
    const onStateUpdate = ({ state: s }) => setState(s);
    const onDeviceJoined = ({ state: s }) => setState(s);
    const onDeviceLeft = ({ state: s }) => setState(s);
    const onGameStarted = ({ state: s }) => {
      navigate(`/game/${code}`, { state: { state: s } });
    };
    s.on('state-update', onStateUpdate);
    s.on('device-joined', onDeviceJoined);
    s.on('device-left', onDeviceLeft);
    s.on('game-started', onGameStarted);
    return () => {
      s.off('state-update', onStateUpdate);
      s.off('device-joined', onDeviceJoined);
      s.off('device-left', onDeviceLeft);
      s.off('game-started', onGameStarted);
    };
  }, [code, socket, connected, navigate]);

  const startGame = useCallback(() => socket.current?.emit('start-game'), [socket]);

  const shareLink = `${window.location.origin}/room/${code}`;
  const canStart = state && state.players.length >= 2;

  const [showJoinInfo, setShowJoinInfo] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [copyState, setCopyState] = useState('idle');
  const [editingPlayer, setEditingPlayer] = useState(null);
  const [editName, setEditName] = useState('');
  const [editingTime, setEditingTime] = useState(false);
  const [timeDraft, setTimeDraft] = useState('');
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

  const handleStartEdit = useCallback((pIdx) => {
    setEditingPlayer(pIdx);
    setEditName(state.players[pIdx].name);
  }, [state]);

  const handleSaveEdit = useCallback((pIdx) => {
    socket.current?.emit('rename-player', { index: pIdx, name: editName });
    setEditingPlayer(null);
  }, [socket, editName]);

  const handleAddPlayer = useCallback(() => socket.current?.emit('add-player'), [socket]);
  const handleRemovePlayer = useCallback((pIdx) => socket.current?.emit('remove-player', { index: pIdx }), [socket]);

  const handleStartTimeEdit = useCallback(() => {
    setEditingTime(true);
    setTimeDraft(String(state?.minutesPerPlayer || 60));
  }, [state]);

  const handleSaveTime = useCallback(() => {
    const val = parseInt(timeDraft, 10);
    if (val >= 1 && val <= 999) {
      socket.current?.emit('update-time', { minutesPerPlayer: val });
    }
    setEditingTime(false);
  }, [socket, timeDraft]);

  if (!state) {
    return (
      <div className="app">
        <div className="waiting">
          {error ? <div className="error">{error}</div> : <p>Loading room...</p>}
        </div>
      </div>
    );
  }

  const minutesPerPlayer = state.minutesPerPlayer || 60;
  const deviceCount = state.devices?.length || 0;

  return (
    <div className="app">
      <div className="waiting">
        <div className="room-code-header">
          <h2>New Room</h2>
        </div>

        {/* How to join - collapsible, default closed */}
        <div className="collapsible-section">
          <button className="collapsible-toggle" onClick={() => setShowJoinInfo(!showJoinInfo)}>
            <span>How to join</span>
            <span className={`chevron ${showJoinInfo ? 'open' : ''}`}>&#9662;</span>
          </button>
          {showJoinInfo && (
            <div className="collapsible-content">
              <div className="share-section">
                <div className="share-link-row" onClick={handleCopyLink}>
                  <span className="share-link-text">{shareLink}</span>
                  <span className="copy-glyph" title="Copy link">&#128203;</span>
                  {copyState === 'copied' && <span className="copy-feedback copied">Copied!</span>}
                  {copyState === 'failed' && <span className="copy-feedback failed">Failed</span>}
                </div>
                <div className="qr-code">
                  <QRCodeSVG value={shareLink} size={128} bgColor="#16213e" fgColor="#eee" />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Time info */}
        <div className="time-info">
          <div className="time-info-row">
            <span>Time per player:</span>
            {editingTime ? (
              <div className="time-edit-row">
                <input
                  type="number"
                  className="time-info-input"
                  value={timeDraft}
                  onChange={e => setTimeDraft(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSaveTime()}
                  min={1}
                  max={999}
                  autoFocus
                />
                <span>min</span>
                <button className="btn-mini btn-save" onClick={handleSaveTime}>&#10003;</button>
              </div>
            ) : (
              <strong className="time-editable" onClick={handleStartTimeEdit} title="Click to edit">
                {minutesPerPlayer} min &#9998;
              </strong>
            )}
          </div>
          <div className="time-info-row">
            <span>Total max time:</span>
            <span>{(() => {
              const total = state.players.length * minutesPerPlayer;
              return `${Math.floor(total / 60)}h ${total % 60}m`;
            })()}</span>
          </div>
          <div className="time-info-row">
            <span>Expected end time:</span>
            <span>{(() => {
              const totalMs = state.players.length * minutesPerPlayer * 60 * 1000;
              return new Date(Date.now() + totalMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            })()}</span>
          </div>
          <div className="time-info-row">
            <span>Connected devices:</span>
            <span>{deviceCount}</span>
          </div>
        </div>

        {/* Settings - collapsible, default closed */}
        <div className="collapsible-section">
          <button className="collapsible-toggle" onClick={() => setShowSettings(!showSettings)}>
            <span>Settings</span>
            <span className={`chevron ${showSettings ? 'open' : ''}`}>&#9662;</span>
          </button>
          {showSettings && (
            <div className="collapsible-content">
              <div className="checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={state.settings?.public ?? true}
                    onChange={e => socket.current?.emit('update-settings', { public: e.target.checked })}
                  />
                  List publicly (visible on home page)
                </label>
                <label className="checkbox-label muted-option">
                  <input type="checkbox" checked disabled />
                  Allow users to pass
                  <span className="muted-tooltip" title="Only pass-order is supported for now">muted</span>
                </label>
                <label className="checkbox-label muted-option">
                  <input type="checkbox" checked disabled />
                  Use pass-order
                  <span className="muted-tooltip" title="Only pass-order is supported for now">muted</span>
                </label>
                <label className="checkbox-label muted-option">
                  <select disabled className="settings-dropdown">
                    <option>countdown</option>
                  </select>
                  <span className="muted-tooltip" title="Only countdown is supported for now">muted</span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Player list */}
        <div className="player-list">
          {displayOrder.map((pIdx, pos) => {
            const p = state.players[pIdx];
            if (!p) return null;
            const canDelete = pIdx >= 2 && state.players.length > 2;

            return (
              <div
                key={pIdx}
                className="player-slot connected draggable"
                draggable
                onDragStart={(e) => handleDragStart(e, pos)}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, pos)}
              >
                <span className="drag-handle" title="Drag to reorder">&#9663;</span>
                <div className="player-dot" style={{ background: p.color }} />

                {editingPlayer === pIdx ? (
                  <div className="player-edit-inline">
                    <input
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleSaveEdit(pIdx)}
                      maxLength={20}
                      autoFocus
                      className="player-name-input"
                    />
                    <button className="btn-mini btn-save" onClick={() => handleSaveEdit(pIdx)}>&#10003;</button>
                  </div>
                ) : (
                  <>
                    <span className="player-name-text">{p.name}</span>
                    <button className="btn-icon" title="Rename" onClick={() => handleStartEdit(pIdx)}>&#9998;</button>
                    <button
                      className={`btn-icon btn-delete ${!canDelete ? 'muted-delete' : ''}`}
                      title={canDelete ? 'Remove player' : 'Cannot remove the first 2 players'}
                      onClick={canDelete ? () => handleRemovePlayer(pIdx) : undefined}
                      disabled={!canDelete}
                    >
                      &#10005;
                    </button>
                  </>
                )}
              </div>
            );
          })}

          {state.players.length < 10 && (
            <div className="player-slot add-player-slot" onClick={handleAddPlayer} title="Click to add another player">
              <span className="add-player-icon">+</span>
            </div>
          )}
        </div>

        <button className="btn btn-primary btn-start-game" onClick={startGame} disabled={!canStart}>
          {canStart ? 'Start Game' : 'Need at least 2 players'}
        </button>

        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}

function GamePage() {
  const { socket, connected } = useSocket();
  const { code } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState(null);
  const [timers, setTimers] = useState([]);
  const joinedRef = useRef(false);
  const deviceName = getDeviceName();
  const prevActiveRef = useRef(null);
  const [isMyTurn, setIsMyTurn] = useState(false);
  const myIndexRef = useRef(null);

  useEffect(() => {
    const s = socket.current;
    if (!s || !connected) return;
    if (joinedRef.current) return;
    joinedRef.current = true;

    s.emit('join-room', { code, name: deviceName, deviceId: getDeviceId() }, (res) => {
      if (res.error) return;
      setState(res.state);
      setTimers(res.state.players.map(p => p.timerMs));
      prevActiveRef.current = res.state.activePlayerIndex;
    });
  }, [code, socket, connected, navigate, deviceName]);

  useEffect(() => {
    const s = socket.current;
    if (!s) return;

    const updateFromState = (newState) => {
      setState(newState);
      setTimers(newState.players.map(p => p.timerMs));
      prevActiveRef.current = newState.activePlayerIndex;
    };

    s.on('state-update', ({ state: s }) => updateFromState(s));
    s.on('timer-tick', ({ timers: t }) => setTimers(t));
    s.on('turn-changed', ({ state: s }) => updateFromState(s));
    s.on('player-passed', ({ state: s }) => updateFromState(s));
    s.on('player-unpassed', ({ state: s }) => updateFromState(s));
    s.on('game-over', ({ state: s }) => {
      updateFromState(s);
      navigate(`/gameover/${code}`, { state: { state: s } });
    });
    s.on('new-round', ({ state: s }) => updateFromState(s));
    s.on('round-over', ({ state: s }) => {
      updateFromState(s);
      navigate(`/gameover/${code}`, { state: { state: s } });
    });
    s.on('device-left', ({ state: s }) => updateFromState(s));
    s.on('device-joined', ({ state: s }) => updateFromState(s));

    return () => {
      s.off('state-update');
      s.off('timer-tick');
      s.off('turn-changed');
      s.off('player-passed');
      s.off('player-unpassed');
      s.off('game-over');
      s.off('new-round');
      s.off('round-over');
      s.off('device-left');
      s.off('device-joined');
    };
  }, [code, socket, connected, navigate]);

  const endTurn = useCallback(() => socket.current?.emit('end-turn'), [socket]);
  const pass = useCallback((index) => socket.current?.emit('pass', { index }), [socket]);
  const unpass = useCallback((index) => socket.current?.emit('unpass', { index }), [socket]);
  const togglePause = useCallback(() => socket.current?.emit('toggle-pause'), [socket]);

  if (!state) {
    return <div className="app"><p style={{ textAlign: 'center', padding: '40px' }}>Connecting...</p></div>;
  }

  const activeIdx = state.activePlayerIndex;

  const upcomingInRound = state.turnOrder.slice(state.currentTurnIndex + 1);
  const upcomingFromStart = state.turnOrder.slice(0, state.currentTurnIndex);
  const upcomingRemaining = [...upcomingInRound, ...upcomingFromStart];

  return (
    <div className={`app ${state.phase === 'playing' && !state.paused ? 'my-turn-active' : ''}`}>
      <div className="game">
        <div className="round-header">
          <div className="round-badge">Round {state.round}</div>
          {state.phase === 'playing' && (
            <button
              className={`btn btn-pause ${state.paused ? 'btn-resume' : ''}`}
              onClick={togglePause}
            >
              {state.paused ? 'Resume' : 'Pause'}
            </button>
          )}
        </div>

        {state.phase === 'playing' && state.paused && (
          <div className="paused-banner">
            {state.pausedBy === 'round-start'
              ? 'Clocks paused — the first turn of the round resumes them'
              : 'Paused — press Resume to continue'}
          </div>
        )}

        <div className="turn-order">
          {state.turnOrder.map((pIdx) => (
            <div
              key={pIdx}
              className={`turn-dot ${state.turnOrder.indexOf(pIdx) === state.currentTurnIndex ? 'current' : ''}`}
              style={{ background: state.players[pIdx].color, color: state.players[pIdx].color }}
            />
          ))}
        </div>

        {state.phase === 'playing' && upcomingRemaining.length > 0 && (
          <div className="upcoming-order">
            <div className="upcoming-label">Up next</div>
            {upcomingRemaining.map((pIdx, pos) => (
              <div key={pIdx} className="upcoming-item">
                <span className="upcoming-pos">{pos + 1}.</span>
                <div className="player-dot" style={{ background: state.players[pIdx].color }} />
                <span className="upcoming-name">{state.players[pIdx].name}</span>
              </div>
            ))}
            {state.passOrder.length > 0 && (
              <>
                <div className="upcoming-divider">Passed</div>
                {state.passOrder.map((pIdx) => {
                  const passPos = state.passOrder.indexOf(pIdx);
                  return (
                    <div key={pIdx} className="upcoming-item passed-item">
                      <span className="upcoming-pos">{passPos + 1}.</span>
                      <div className="player-dot" style={{ background: state.players[pIdx].color }} />
                      <span className="upcoming-name">{state.players[pIdx].name}</span>
                      <button
                        className="btn-mini btn-unpass"
                        onClick={() => unpass(pIdx)}
                        title={`Un-pass ${state.players[pIdx].name}`}
                      >
                        Un-pass
                      </button>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {state.players.map((p, origIdx) => {
          const isActive = activeIdx === origIdx;
          const hasPassed = state.passOrder.includes(origIdx);
          const passPosition = state.passOrder.indexOf(origIdx);
          const timer = timers[origIdx] ?? p.timerMs;
          const isLow = timer < 30000 && timer > 0;
          const canAct = state.phase === 'playing' && !hasPassed;

          let cardClass = 'player-card';
          if (isActive) cardClass += ' active';
          if (hasPassed) cardClass += ' passed';

          return (
            <div
              key={origIdx}
              className={cardClass}
              style={{ '--player-color': p.color }}
              onClick={isActive && state.phase === 'playing' ? endTurn : undefined}
            >
              <div className="player-info">
                <div className="player-name" style={{ color: p.color }}>{p.name}</div>
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
              <div className={`player-timer ${isLow ? 'low' : ''}`}>{formatTime(timer)}</div>
              {canAct && (
                <div className="card-actions" onClick={(e) => e.stopPropagation()}>
                  {isActive && (
                    <button className="btn-mini btn-end" onClick={endTurn}>End Turn</button>
                  )}
                  <button className="btn-mini btn-pass" onClick={() => pass(origIdx)}>Pass</button>
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
  const { socket, connected } = useSocket();
  const { code } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState(null);
  const joinedRef = useRef(false);
  const deviceName = getDeviceName();

  useEffect(() => {
    const s = socket.current;
    if (!s || !connected) return;
    if (joinedRef.current) return;
    joinedRef.current = true;

    s.emit('join-room', { code, name: deviceName, deviceId: getDeviceId() }, (res) => {
      if (res.error) return;
      setState(res.state);
    });
  }, [code, socket, connected, navigate, deviceName]);

  useEffect(() => {
    const s = socket.current;
    if (!s) return;
    const onStateUpdate = ({ state: s }) => setState(s);
    const onGameOver = ({ state: s }) => setState(s);
    const onNewRound = ({ state: s }) => {
      setState(s);
      navigate(`/game/${code}`, { state: { state: s } });
    };
    s.on('state-update', onStateUpdate);
    s.on('game-over', onGameOver);
    s.on('new-round', onNewRound);
    return () => {
      s.off('state-update', onStateUpdate);
      s.off('game-over', onGameOver);
      s.off('new-round', onNewRound);
    };
  }, [code, socket, connected, navigate]);

  const nextRound = useCallback(() => socket.current?.emit('next-round'), [socket]);
  const resetGame = useCallback(() => {
    socket.current?.emit('reset-game', {});
    navigate('/');
  }, [socket, navigate]);

  const isRoundOver = state?.phase === 'round-over';

  const dragIndexRef = useRef(null);
  const handleDragStart = useCallback((e, idx) => {
    dragIndexRef.current = idx;
    e.dataTransfer.effectAllowed = 'move';
    e.currentTarget.style.opacity = '0.4';
  }, []);
  const handleDragEnd = useCallback((e) => { e.currentTarget.style.opacity = '1'; dragIndexRef.current = null; }, []);
  const handleDragOver = useCallback((e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }, []);
  const handleDrop = useCallback((e, dropIdx) => {
    e.preventDefault();
    const dragIdx = dragIndexRef.current;
    if (dragIdx === null || dragIdx === dropIdx) return;
    const newOrder = [...state.passOrder];
    const [moved] = newOrder.splice(dragIdx, 1);
    newOrder.splice(dropIdx, 0, moved);
    socket.current?.emit('reorder-players', { order: newOrder });
  }, [state, socket]);

  if (!state) {
    return <div className="app"><p style={{ textAlign: 'center', padding: '40px' }}>Loading...</p></div>;
  }

  const winner = isRoundOver ? null : state.players[state.activePlayerIndex];
  const loser = isRoundOver ? null : state.players.find((p, i) => p.timerMs <= 0);

  return (
    <div className="app">
      <div className="game-over">
        <h2>{isRoundOver ? `Round ${state.round} Complete` : 'Game Over'}</h2>
        {winner && (
          <div className="winner-name" style={{ color: winner.color }}>{winner.name} Wins!</div>
        )}
        {loser && (
          <p style={{ color: 'var(--text-secondary)' }}>{loser.name} ran out of time</p>
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
                  <div
                    key={pIdx}
                    className="player-slot connected draggable"
                    draggable
                    onDragStart={(e) => handleDragStart(e, pos)}
                    onDragEnd={handleDragEnd}
                    onDragOver={handleDragOver}
                    onDrop={(e) => handleDrop(e, pos)}
                  >
                    <span className="drag-handle" title="Drag to reorder">&#9663;</span>
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
                <span style={{ marginLeft: 'auto', fontFamily: 'monospace' }}>{formatTime(p.timerMs)}</span>
              </div>
            ))}
          </div>
        )}

        <div className="game-over-actions">
          <button className="btn btn-primary" onClick={nextRound}>Next Round</button>
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
          <Route path="/room/:code" element={<NewRoom />} />
          <Route path="/game/:code" element={<GamePage />} />
          <Route path="/gameover/:code" element={<GameOverPage />} />
        </Routes>
      </SocketProvider>
    </BrowserRouter>
  );
}
