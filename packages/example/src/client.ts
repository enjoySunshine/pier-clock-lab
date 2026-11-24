import '@colyseus/sdk/debug';
import { Client, Callbacks, Room } from '@colyseus/sdk';

import type { server } from './server/vite.ts';
import type { MyRoom } from './MyRoom.ts';
import { PierClock, type PierClockSnapshot } from './clock.ts';
import { drawPierPlayer } from './pier-renderer.ts';

export * from './clock.ts';
export * from './pier-renderer.ts';

const logElement = document.querySelector<HTMLPreElement>('#log');
const button = document.querySelector<HTMLButtonElement>('#connect');
const statusEl = document.querySelector<HTMLSpanElement>('#status');
const canvas = document.querySelector<HTMLCanvasElement>('#game');
const ctx = canvas?.getContext('2d');

let room: Room<MyRoom> | null;
const players = new Map<string, { x: number; y: number }>();

// The canvas clock is a follower only. Every room TIMED/control snapshot
// re-bases it to the authoritative millisecond so pause, resume, rate changes
// and hitch catch-up cannot leave the dot one 2px step away.
const serverClock = new PierClock({ name: 'server' });
const canvasClock = new PierClock({ name: 'canvas' });

type PierClockLabGlobal = {
  server: PierClock;
  canvas: PierClock;
  sync: (snapshot: PierClockSnapshot) => void;
  pause: () => void;
  resume: () => void;
  setRate: (rate: number) => void;
  catchUp: (ms?: number) => void;
};

const pierClockLab: PierClockLabGlobal = {
  server: serverClock,
  canvas: canvasClock,
  sync(snapshot) {
    serverClock.syncFrom(snapshot);
    canvasClock.syncFrom(snapshot);
  },
  pause() {
    serverClock.pause();
    canvasClock.pause();
    room?.send('pier-clock', { action: 'pause' });
  },
  resume() {
    serverClock.resume();
    canvasClock.resume();
    room?.send('pier-clock', { action: 'resume' });
  },
  setRate(rate: number) {
    serverClock.setRate(rate);
    canvasClock.setRate(rate);
    room?.send('pier-clock', { rate });
  },
  catchUp(ms = 100) {
    serverClock.catchUp(ms);
    canvasClock.syncFrom(serverClock.snapshot());
  },
};

declare global {
  interface Window {
    __pierClockLab?: PierClockLabGlobal;
  }
}
window.__pierClockLab = pierClockLab;
Object.assign(window, {
  pierClockLab,
  clockLab: pierClockLab,
  clockSync: pierClockLab,
  serverClock,
  canvasClock,
  __pierClock: pierClockLab,
  __pierClockLab: pierClockLab,
  __PIER_CLOCK__: pierClockLab,
  __PIER_CLOCK_LAB__: pierClockLab,
  __CLOCK_LAB__: pierClockLab,
  __CLOCK_SYNC__: pierClockLab,
});

// HTTP endpoint buttons — work without a room connection
const httpClient = new Client<typeof server>(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);

document.getElementById('btn-hello')?.addEventListener('click', async () => {
  const res = await httpClient.http.get('/hello');
  log(`/hello: ${JSON.stringify(res.data)}`);
});

document.getElementById('btn-time')?.addEventListener('click', async () => {
  const res = await httpClient.http.get('/time');
  log(`/time: ${JSON.stringify(res.data)}`);
});

document.getElementById('btn-express')?.addEventListener('click', async () => {
  const res = await fetch(`${location.origin}/express-hello`);
  log(`/express-hello: ${JSON.stringify(await res.json())}`);
});

const rateButton = document.querySelector<HTMLButtonElement>('#clock-rate');
document.getElementById('clock-pause')?.addEventListener('click', () => pierClockLab.pause());
document.getElementById('clock-resume')?.addEventListener('click', () => pierClockLab.resume());
rateButton?.addEventListener('click', () => {
  const nextRate = serverClock.rate === 1 ? 2 : 1;
  pierClockLab.setRate(nextRate);
  rateButton.textContent = `Rate ${nextRate}×`;
});

function log(message: string) {
  if (logElement) {
    logElement.textContent = message;
  }
}

function setStatus(state: 'idle' | 'connecting' | 'connected' | 'disconnected', text: string) {
  if (!statusEl) return;
  statusEl.className = state;
  statusEl.innerHTML = `<span class="dot"></span>${text}`;
}

function draw() {
  if (!ctx || !canvas) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  players.forEach((player, sessionId) => {
    const isMe = sessionId === room?.sessionId;
    drawPierPlayer(ctx, player.x, player.y, sessionId, {
      color: isMe ? '#2563eb' : '#6b7280',
    });
  });

  requestAnimationFrame(draw);
}

button?.addEventListener('click', async () => {
  if (room) {
    room.leave();
    return;
  }

  button.textContent = 'Connecting...';
  button.disabled = true;
  setStatus('connecting', 'Connecting...');

  try {
    const client = new Client<typeof server>(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    // room = await client.joinOrCreate('my_room');
    room = await client.joinOrCreate('my_room_2');

    // allow reconnection immediately.
    room.reconnection.minUptime = 0;

    setStatus('connected', `Room ${room.roomId} | Session ${room.sessionId}`);
    button.textContent = 'Leave';
    button.disabled = false;

    room.onMessage('pier-clock', (snapshot: PierClockSnapshot) => {
      pierClockLab.sync(snapshot);
    });

    // Sync players from state using Callbacks API
    const callbacks = Callbacks.get(room);

    callbacks.onAdd("players", (player, sessionId) => {
      players.set(sessionId, { x: player.x, y: player.y });
      callbacks.listen(player, "x", (value) => {
        const p = players.get(sessionId);
        if (p) p.x = value;
      });
      callbacks.listen(player, "y", (value) => {
        const p = players.get(sessionId);
        if (p) p.y = value;
      });
      log(`Player joined: ${sessionId}`);
    });

    callbacks.onRemove("players", (_, sessionId) => {
      players.delete(sessionId);
      log(`Player left: ${sessionId}`);
    });

    room.onLeave((code) => {
      setStatus('disconnected', `Disconnected (code: ${code})`);
      log(`Left room (code: ${code})`);
      button.textContent = 'Join my_room';
      button.disabled = false;
      room = null;
      players.clear();
      serverClock.reset();
      canvasClock.reset();
    });

    room.onError((code, message) => {
      log(`Error ${code}: ${message}`);
    });

    // Arrow key movement
    const speed = 5;
    const keys = new Set<string>();

    const onKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd'].includes(e.key)) {
        e.preventDefault();
        keys.add(e.key);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    const moveLoop = setInterval(() => {
      if (keys.size === 0 || !room) return;
      let x = 0, y = 0;
      if (keys.has('ArrowLeft') || keys.has('a')) x -= speed;
      if (keys.has('ArrowRight') || keys.has('d')) x += speed;
      if (keys.has('ArrowUp') || keys.has('w')) y -= speed;
      if (keys.has('ArrowDown') || keys.has('s')) y += speed;
      if (x !== 0 || y !== 0) {
        const me = players.get(room.sessionId);
        room.send('move', { x: (me?.x ?? 0) + x, y: (me?.y ?? 0) + y });
      }
    }, 1000 / 30);

    room.onLeave(() => {
      clearInterval(moveLoop);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    });

    // Start render loop
    requestAnimationFrame(draw);

  } catch (e) {
    setStatus('disconnected', 'Connection failed');
    log(`Connection failed: ${e instanceof Error ? e.message : String(e)}`);
    button.textContent = 'Join my_room';
    button.disabled = false;
    room = null;
  }
});
