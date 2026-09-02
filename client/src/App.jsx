import { useState, useEffect, useRef, useCallback, createContext, useContext } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useParams, useSearchParams, useLocation } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { io } from 'socket.io-client';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Collapsible } from './components/ui/collapsible';
import { Card } from './components/ui/card';
import { Badge } from './components/ui/badge';
import { Checkbox } from './components/ui/checkbox';
import { Select } from './components/ui/select';
import { Check, ChevronDown, ChevronUp, Copy, Link, Pause, Pencil, Play, Plus, QrCode, Trash2 } from 'lucide-react';

const isDev = window.location.port === '5173';
const SOCKET_URL = isDev
  ? 'http://localhost:3002'
  : window.location.origin;

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
  const sign = ms < 0 ? '-' : '';
  const totalSec = Math.ceil(Math.abs(ms) / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${sign}${min}:${sec.toString().padStart(2, '0')}`;
}

const COLOR_NAMES = {
  '#e74c3c': 'Red',
  '#3498db': 'Blue',
  '#2ecc71': 'Green',
  '#f39c12': 'Orange',
  '#9b59b6': 'Purple',
  '#1abc9c': 'Teal',
  '#e67e22': 'Coral',
  '#34495e': 'Navy',
  '#e91e63': 'Pink',
  '#00bcd4': 'Cyan',
};

function DragHandle({ title = 'Drag to reorder' }) {
  return (
    <span className="drag-handle" title={title} aria-hidden="true">
      <svg width="14" height="22" viewBox="0 0 14 22" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        {[3.5, 11.5, 19.5].flatMap(y => [4.5, 9.5].map(x => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.5" />))}
      </svg>
    </span>
  );
}

function ColorPicker({ value, colors, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div className="color-picker" ref={ref}>
      <button
        type="button"
        className="color-picker-trigger"
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        title="Change player color"
      >
        <span className="color-picker-swatch" style={{ background: value }} />
        <span className="color-picker-name">{COLOR_NAMES[value] || value}</span>
        <ChevronDown className="color-picker-caret" />
      </button>
      {open && (
        <div className="color-picker-menu" role="listbox">
          {(colors || []).map(c => (
            <button
              type="button"
              key={c}
              role="option"
              aria-selected={c === value}
              className="color-picker-option"
              onClick={(e) => {
                e.stopPropagation();
                onChange(c);
                setOpen(false);
              }}
            >
              <span className="color-picker-swatch" style={{ background: c }} />
              <span>{COLOR_NAMES[c] || c}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
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
          <Input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
            onBlur={save}
            maxLength={20}
          />
          <Button variant="ghost" size="icon" className="name-bar-save" title="Save" onClick={save}><Check className="size-4" /></Button>
        </div>
      ) : (
        <div className="name-bar-display" onClick={() => { setDraft(name); setEditing(true); }}>
          <span>Device: <strong>{name}</strong></span>
          <Button variant="ghost" size="icon" className="name-bar-edit-btn" title="Edit device name"><Pencil className="size-4" /></Button>
        </div>
      )}
    </div>
  );
}

function AppHeader() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <header className="app-header">
      {location.pathname !== '/' && (
        <Button variant="secondary" size="sm" onClick={() => navigate('/')}>Home</Button>
      )}
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
    <main className="app">
      <section className="setup rounded-2xl border border-border bg-card/70 px-5 shadow-2xl shadow-black/20 backdrop-blur sm:px-8">
        <h1>Multiplayer Chess Clock</h1>
        <p className="home-description">
          A shared clock for board games. Create a room and share the link — any device with the link can join and control the clocks.
        </p>

        <Button className="w-full" onClick={createRoom} disabled={!connected}>
          {connected ? 'New Room' : 'Connecting...'}
        </Button>

        {publicRooms.length > 0 && (
          <>
            <div className="divider">public rooms</div>
            <div className="public-rooms">
              {publicRooms.map(room => (
                <Card key={room.code} className="public-room-item" onClick={() => navigate(`/room/${room.code}`)}>
                  <div className="public-room-code">{room.code}</div>
                  <div className="public-room-meta">
                    <span>{room.deviceCount} device{room.deviceCount !== 1 ? 's' : ''}</span>
                    <Badge variant="secondary" className="public-room-phase">{room.phase}</Badge>
                  </div>
                </Card>
              ))}
            </div>
          </>
        )}

        {error && <div className="error">{error}</div>}
      </section>
    </main>
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

  const [copyState, setCopyState] = useState('idle');
  const [editingPlayer, setEditingPlayer] = useState(null);
  const [editName, setEditName] = useState('');
  const [dragTarget, setDragTarget] = useState(null);
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
    if (e.dataTransfer?.setDragImage) {
      const el = e.currentTarget;
      e.dataTransfer.setDragImage(el, el.offsetWidth / 2, el.offsetHeight / 2);
    }
  }, []);

  const handleDragEnd = useCallback((e) => {
    e.currentTarget.style.opacity = '1';
    dragIndexRef.current = null;
    setDragTarget(null);
  }, []);

  const handleDragOver = useCallback((e, dropIdx) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragTarget(dropIdx === dragIndexRef.current ? null : dropIdx);
  }, []);

  const handleDragEnter = useCallback((e, dropIdx) => {
    e.preventDefault();
    setDragTarget(dropIdx === dragIndexRef.current ? null : dropIdx);
  }, []);

  const handleDrop = useCallback((e, dropIdx) => {
    e.preventDefault();
    const dragIdx = dragIndexRef.current;
    setDragTarget(null);
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
  const handleColorChange = useCallback((pIdx, color) => socket.current?.emit('set-color', { index: pIdx, color }), [socket]);

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
          <Badge variant="outline" className="mb-2">Room</Badge>
          <h2>{code}</h2>
        </div>

        {/* How to join - collapsible, default closed */}
        <Collapsible title="How to join">
              <div className="share-section">
                <div className="share-link-row" onClick={handleCopyLink}>
                  <span className="share-link-text">{shareLink}</span>
                  <Copy className="copy-glyph" aria-label="Copy link" />
                  {copyState === 'copied' && <span className="copy-feedback copied">Copied!</span>}
                  {copyState === 'failed' && <span className="copy-feedback failed">Failed</span>}
                </div>
                <div className="qr-code">
                  <QRCodeSVG value={shareLink} size={128} bgColor="#16213e" fgColor="#eee" />
                </div>
              </div>
        </Collapsible>

        {/* Time info */}
        <Card className="time-info">
          <div className="time-info-row">
            <span>Time per player:</span>
            <div className="time-edit-row">
              <Input
                type="number"
                className="time-info-input"
                value={minutesPerPlayer}
                onChange={e => {
                  const val = parseInt(e.target.value, 10);
                  if (val >= 1 && val <= 999) {
                    socket.current?.emit('update-time', { minutesPerPlayer: val });
                  }
                }}
                min={1}
                max={999}
              />
              <span>min</span>
            </div>
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
        </Card>

        {/* Settings - collapsible, default closed */}
        <Collapsible title="Settings">
              <div className="checkbox-group">
                <label className="checkbox-label">
                  <Checkbox
                    checked={state.settings?.public ?? true}
                    onCheckedChange={checked => socket.current?.emit('update-settings', { public: checked })}
                  />
                  List publicly (visible on home page)
                </label>
                <label className="checkbox-label muted-option" title="Only pass-order is supported for now">
                  <Checkbox checked disabled />
                  Allow users to pass
                </label>
                <label className="checkbox-label muted-option" title="Only pass-order is supported for now">
                  <Checkbox checked disabled />
                  Use pass-order
                </label>
                <label className="checkbox-label muted-option settings-select-row" title="Only countdown is supported for now">
                  <Select disabled className="settings-dropdown" aria-label="Clock direction">
                    <option>countdown</option>
                  </Select>
                </label>
              </div>
        </Collapsible>

        {/* Player list */}
        <div className="player-list" onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setDragTarget(null);
        }}>
          {displayOrder.map((pIdx, pos) => {
            const p = state.players[pIdx];
            if (!p) return null;
            const canDelete = pIdx >= 2 && state.players.length > 2;

            return (
              <div
                key={pIdx}
                className="drag-zone"
                draggable
                onDragStart={(e) => handleDragStart(e, pos)}
                onDragEnd={handleDragEnd}
                onDragEnter={(e) => handleDragEnter(e, pos)}
                onDragOver={(e) => handleDragOver(e, pos)}
                onDrop={(e) => handleDrop(e, pos)}
              >
                <Card className={`player-slot connected${dragTarget === pos ? ' drag-target' : ''}`}>
                  <DragHandle />
                  <ColorPicker
                    value={p.color}
                    colors={state.availableColors}
                    onChange={c => handleColorChange(pIdx, c)}
                  />

                {editingPlayer === pIdx ? (
                  <div className="player-edit-inline">
                    <Input
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleSaveEdit(pIdx)}
                      maxLength={20}
                      autoFocus
                      className="player-name-input"
                    />
                    <Button size="icon" onClick={() => handleSaveEdit(pIdx)} aria-label="Save player name"><Check className="size-4" /></Button>
                  </div>
                ) : (
                  <>
                    <span className="player-name-text">{p.name}</span>
                    <Button variant="ghost" size="icon" title="Rename" onClick={() => handleStartEdit(pIdx)}><Pencil className="size-4" /></Button>
                    <Button
                      variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive"
                      title={canDelete ? 'Remove player' : 'Cannot remove the first 2 players'}
                      onClick={canDelete ? () => handleRemovePlayer(pIdx) : undefined}
                      disabled={!canDelete}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </>
                )}
                </Card>
              </div>
            );
          })}

          {state.players.length < 10 && (
            <Button variant="outline" className="add-player-slot w-full" onClick={handleAddPlayer} title="Add another player">
              <Plus className="size-4" /> Add player
            </Button>
          )}
        </div>

        <Button className="w-full" onClick={startGame} disabled={!canStart}>
          {canStart ? 'Start Game' : 'Need at least 2 players'}
        </Button>

        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}

function GameTopBar({ code, round }) {
  const [copyState, setCopyState] = useState('idle');
  const [qrOpen, setQrOpen] = useState(false);
  const shareLink = `${window.location.origin}/room/${code}`;

  const handleCopyLink = useCallback(() => {
    copyToClipboard(shareLink).then(ok => {
      setCopyState(ok ? 'copied' : 'failed');
      setTimeout(() => setCopyState('idle'), 2000);
    });
  }, [shareLink]);

  return (
    <div className="game-topbar">
      <div className="topbar-round">
        <Badge variant="outline">Round {round}</Badge>
      </div>
      <div className="topbar-actions">
        <Button variant="ghost" size="icon" onClick={handleCopyLink} title="Copy room link" aria-label="Copy room link">
          {copyState === 'copied' ? <Check className="size-4" /> : <Link className="size-4" />}
        </Button>
        {copyState !== 'idle' && (
          <span className={`copy-feedback ${copyState}`} role="status">
            {copyState === 'copied' ? 'Copied!' : 'Failed'}
          </span>
        )}
        <Button variant="ghost" size="icon" onClick={() => setQrOpen(o => !o)} title="Show QR code" aria-label="Show QR code">
          <QrCode className="size-4" />
          {qrOpen ? <ChevronUp className="topbar-qr-caret" /> : null}
        </Button>
      </div>
      {qrOpen && (
        <button className="topbar-qr" type="button" onClick={() => setQrOpen(false)} aria-label="Hide QR code">
          <QRCodeSVG value={shareLink} size={128} bgColor="#16213e" fgColor="#eee" />
          <ChevronUp className="topbar-qr-caret collapse-hint" />
        </button>
      )}
    </div>
  );
}

function GamePage() {
  const { socket, connected } = useSocket();
  const { code } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState(null);
  const [timers, setTimers] = useState([]);
  const [overtime, setOvertime] = useState([]);
  const joinedRef = useRef(false);
  const deviceName = getDeviceName();
  const prevActiveRef = useRef(null);
  const [editingPlayer, setEditingPlayer] = useState(null);
  const [editName, setEditName] = useState('');

  useEffect(() => {
    const s = socket.current;
    if (!s || !connected) return;
    if (joinedRef.current) return;
    joinedRef.current = true;

    s.emit('join-room', { code, name: deviceName, deviceId: getDeviceId() }, (res) => {
      if (res.error) return;
      setState(res.state);
      setTimers(res.state.players.map(p => p.timerMs));
      setOvertime(res.state.players.map(p => p.overtime));
      prevActiveRef.current = res.state.activePlayerIndex;
    });
  }, [code, socket, connected, navigate, deviceName]);

  useEffect(() => {
    const s = socket.current;
    if (!s) return;

    const updateFromState = (newState) => {
      setState(newState);
      setTimers(newState.players.map(p => p.timerMs));
      setOvertime(newState.players.map(p => p.overtime));
      prevActiveRef.current = newState.activePlayerIndex;
    };

    s.on('state-update', ({ state: s }) => updateFromState(s));
    s.on('timer-tick', ({ timers: t, overtime: ot }) => {
      setTimers(t);
      if (Array.isArray(ot)) setOvertime(ot);
    });
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

  const handleStartEdit = useCallback((pIdx) => {
    setEditingPlayer(pIdx);
    setEditName(state.players[pIdx].name);
  }, [state]);

  const handleSaveEdit = useCallback((pIdx) => {
    socket.current?.emit('rename-player', { index: pIdx, name: editName });
    setEditingPlayer(null);
  }, [socket, editName]);

  if (!state) {
    return <div className="app"><p style={{ textAlign: 'center', padding: '40px' }}>Connecting...</p></div>;
  }

  const activeIdx = state.activePlayerIndex;
  const pauseReason = state.pausedBy === 'disconnect'
    ? ' (no connected devices -> auto-paused)'
    : state.pausedBy && state.pausedBy !== 'round-start' && state.pausedBy !== 'manual'
      ? ` ("${state.pausedBy}" paused the game)`
      : '';

  const upcomingInRound = state.turnOrder.slice(state.currentTurnIndex + 1);
  const upcomingFromStart = state.turnOrder.slice(0, state.currentTurnIndex);
  const upcomingRemaining = [...upcomingInRound, ...upcomingFromStart];

  // Merge confirmed + pending passes for display — pending passes are
  // provisional until their turn slot arrives, but should be visually
  // indicated immediately so the UI reflects what happened.
  const allPassed = [...state.passOrder, ...state.pendingPass];

  return (
    <div className="app">
      <div className="game">
        <GameTopBar code={code} round={state.round} />

        <div className="turn-order">
          {state.turnOrder.map((pIdx) => (
            <div
              key={pIdx}
              className={`turn-dot ${state.turnOrder.indexOf(pIdx) === state.currentTurnIndex ? 'current' : ''}`}
              style={{ background: state.players[pIdx].color, color: state.players[pIdx].color }}
            />
          ))}
        </div>

        {state.phase === 'playing' && (upcomingRemaining.length > 0 || allPassed.length > 0) && (
          <div className="upcoming-order">
            {upcomingRemaining.length > 0 && (
              <>
                <div className="upcoming-label">Up next</div>
                {upcomingRemaining.map((pIdx, pos) => {
                  const isPending = state.pendingPass.includes(pIdx);
                  return (
                    <div key={pIdx} className={`upcoming-item${isPending ? ' queued-item' : ''}`}>
                      <span className="upcoming-pos">{pos + 1}.</span>
                      <div className="player-dot" style={{ background: state.players[pIdx].color }} />
                      <span className="upcoming-name">{state.players[pIdx].name}{isPending ? ' (queued)' : ''}</span>
                    </div>
                  );
                })}
              </>
            )}
            {allPassed.length > 0 && (
              <>
                <div className="upcoming-divider">Passed</div>
                {allPassed.map((pIdx) => {
                  const passPos = state.passOrder.indexOf(pIdx);
                  const isPending = state.pendingPass.includes(pIdx);
                  return (
                    <div key={pIdx} className="upcoming-item passed-item">
                      <span className="upcoming-pos">{passPos !== -1 ? (passPos + 1) + '.' : '~'}</span>
                      <div className="player-dot" style={{ background: state.players[pIdx].color }} />
                      <span className="upcoming-name">{state.players[pIdx].name}{isPending ? ' (queued)' : ''}</span>
                      <Button
                        variant="success" size="sm"
                        onClick={() => unpass(pIdx)}
                        title={`Un-pass ${state.players[pIdx].name}`}
                      >
                        Un-pass
                      </Button>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        {state.phase === 'playing' && (
          <div className="pause-control">
            <Button
              variant={state.paused ? 'success' : 'warning'}
              size="sm"
              onClick={togglePause}
              className="btn-pause w-full"
            >
              {state.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
              {state.paused ? `Resume${pauseReason}` : 'Pause'}
            </Button>
          </div>
        )}

        {state.players.map((p, origIdx) => {
          const isActive = activeIdx === origIdx;
          const hasPassed = allPassed.includes(origIdx);
          const passPosition = state.passOrder.indexOf(origIdx);
          const isPending = state.pendingPass.includes(origIdx);
          const timer = timers[origIdx] ?? p.timerMs;
          const isOT = overtime[origIdx] ?? p.overtime;
          const isLow = timer < 30000 && timer > 0 && !isOT;
          const canAct = state.phase === 'playing' && !hasPassed && !state.paused;

          let cardClass = 'player-card';
          if (isActive) cardClass += ' active';
          if (hasPassed) cardClass += ' passed';
          if (isOT) cardClass += ' overtime';
          if (state.paused) cardClass += ' paused';

          return (
            <Card
              key={origIdx}
              className={cardClass}
              style={{ '--player-color': p.color }}
              onClick={isActive && state.phase === 'playing' && !state.paused ? endTurn : undefined}
            >
              <div className="player-info">
                {editingPlayer === origIdx ? (
                  <div className="player-edit-inline">
                    <Input
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleSaveEdit(origIdx)}
                      maxLength={20}
                      autoFocus
                      className="player-name-input"
                      onClick={e => e.stopPropagation()}
                    />
                    <Button size="icon" onClick={(e) => { e.stopPropagation(); handleSaveEdit(origIdx); }} aria-label="Save player name"><Check className="size-4" /></Button>
                  </div>
                ) : (
                  <div className="player-name-row">
                    <div className="player-name" style={{ color: p.color }}>{p.name}</div>
                    <Button
                      variant="ghost" size="icon" className="btn-rename"
                      title="Rename player"
                      onClick={(e) => { e.stopPropagation(); handleStartEdit(origIdx); }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                  </div>
                )}
                <div className="player-status">
                  {hasPassed ? (
                    <Badge variant="secondary">Passed{passPosition !== -1 ? ` #${passPosition + 1}` : ''}{isPending ? ' (queued)' : ''}</Badge>
                  ) : isOT ? (
                    <Badge variant="outline" className="overtime-badge">Overtime</Badge>
                  ) : isActive ? (
                    <span style={{ color: p.color }}>Active</span>
                  ) : (
                    <span>Waiting</span>
                  )}
                </div>
              </div>
              <div className={`player-timer ${isLow ? 'low' : ''} ${isOT ? 'overtime' : ''}`}>{formatTime(timer)}</div>
              {state.paused && isActive && (
                <div className="card-actions" onClick={(e) => e.stopPropagation()}>
                  <Button variant="success" size="sm" onClick={togglePause}>
                    <Play className="size-4" />{`Resume${pauseReason}`}
                  </Button>
                </div>
              )}
              {canAct && (
                <div className="card-actions" onClick={(e) => e.stopPropagation()}>
                  {isActive && (
                    <Button size="sm" onClick={endTurn}>End Turn</Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => pass(origIdx)}>Pass</Button>
                </div>
              )}
            </Card>
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
  const [dragTarget, setDragTarget] = useState(null);
  const handleDragStart = useCallback((e, idx) => {
    dragIndexRef.current = idx;
    e.dataTransfer.effectAllowed = 'move';
    e.currentTarget.style.opacity = '0.4';
    if (e.dataTransfer?.setDragImage) {
      const el = e.currentTarget;
      e.dataTransfer.setDragImage(el, el.offsetWidth / 2, el.offsetHeight / 2);
    }
  }, []);
  const handleDragEnd = useCallback((e) => {
    e.currentTarget.style.opacity = '1';
    dragIndexRef.current = null;
    setDragTarget(null);
  }, []);
  const handleDragOver = useCallback((e, dropIdx) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragTarget(dropIdx === dragIndexRef.current ? null : dropIdx);
  }, []);
  const handleDragEnter = useCallback((e, dropIdx) => {
    e.preventDefault();
    setDragTarget(dropIdx === dragIndexRef.current ? null : dropIdx);
  }, []);
  const handleDrop = useCallback((e, dropIdx) => {
    e.preventDefault();
    const dragIdx = dragIndexRef.current;
    setDragTarget(null);
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
            <div className="player-list" style={{ width: '100%' }} onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) setDragTarget(null);
            }}>
              {state.passOrder.map((pIdx, pos) => {
                const p = state.players[pIdx];
                return (
                  <div
                    key={pIdx}
                    className="drag-zone"
                    draggable
                    onDragStart={(e) => handleDragStart(e, pos)}
                    onDragEnd={handleDragEnd}
                    onDragEnter={(e) => handleDragEnter(e, pos)}
                    onDragOver={(e) => handleDragOver(e, pos)}
                    onDrop={(e) => handleDrop(e, pos)}
                  >
                    <Card className={`player-slot connected${dragTarget === pos ? ' drag-target' : ''}`}>
                      <DragHandle />
                      <span style={{ fontFamily: 'monospace', opacity: 0.6 }}>{pos + 1}.</span>
                      <div className="player-dot" style={{ background: p.color }} />
                      <span>{p.name}</span>
                    </Card>
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
              <Card key={i} className="player-slot connected">
                <div className="player-dot" style={{ background: p.color }} />
                <span>{p.name}</span>
                <span style={{ marginLeft: 'auto', fontFamily: 'monospace' }}>{formatTime(p.timerMs)}</span>
              </Card>
            ))}
          </div>
        )}

        <div className="game-over-actions">
          {isRoundOver && <Button onClick={nextRound}>Next Round</Button>}
          {!isRoundOver && <Button variant="secondary" onClick={resetGame}>New Game</Button>}
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
        <div className="version-footer">{__APP_VERSION__}</div>
      </SocketProvider>
    </BrowserRouter>
  );
}
