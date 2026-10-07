const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Math.max(1, Math.min(65535, Number(process.env.PORT) || 3000));
const MAX_ROOM_SIZE = 8;
const MIN_PLAYERS_TO_START = 2;
const MATCH_SECONDS = 180;
const RESPAWN_MS = 2600;
const ARENA_LIMIT = 54;
const MAX_RUN_SPEED = 12;
const SHOT_COOLDOWN_MS = 180;
const app = express();
const rooms = new Map();
const clients = new Map();

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("/health", (_request, response) => response.json({ status: "ok", rooms: rooms.size }));
app.get("/api/app", (_request, response) => {
  response.set("Cache-Control", "no-store");
  response.json({
    apkAvailable: fs.existsSync(path.join(__dirname, "downloads", "moonshot-arena.apk"))
  });
});
app.get("/api/rooms", (_request, response) => {
  response.set("Cache-Control", "no-store");
  response.json({ rooms: Array.from(rooms.values()).filter((room) => room.visibility === "public" && !room.ended).map(roomSummary) });
});
app.get("/downloads/moonshot-arena.apk", (_request, response) => {
  response.sendFile(path.join(__dirname, "downloads", "moonshot-arena.apk"), (error) => {
    if (error && !response.headersSent) response.status(404).send("Android app is not built on this server yet.");
  });
});

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Moonshot Arena listening on port ${PORT}`);
});
const wss = new WebSocketServer({ server: httpServer, maxPayload: 4096, perMessageDeflate: false });

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function cleanName(value) {
  if (typeof value !== "string") return "Pilot";
  const name = value.replace(/[<>&"'`]/g, "").trim().slice(0, 16);
  return name || "Pilot";
}

function validRoomName(value) {
  if (typeof value !== "string") return "Arena";
  return value.replace(/[<>&"'`]/g, "").trim().slice(0, 24) || "Arena";
}

function roomSummary(room) {
  return {
    id: room.id,
    name: room.name,
    players: room.players.size,
    capacity: MAX_ROOM_SIZE,
    status: room.started ? "playing" : "waiting",
    visibility: room.visibility,
    host: room.host.name,
    hostId: room.host.id
  };
}

function playerSnapshot(player) {
  return {
    id: player.id,
    name: player.name,
    team: player.team,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    hp: player.hp,
    ammo: player.ammo,
    alive: player.hp > 0,
    reloading: player.reloading
  };
}

function broadcast(room, message) {
  for (const player of room.players.values()) send(player.socket, message);
}

function broadcastRoster(room) {
  broadcast(room, {
    type: "roster",
    room: roomSummary(room),
    players: Array.from(room.players.values(), playerSnapshot)
  });
}

function createRoom(host, visibility, requestedName) {
  let id;
  do {
    id = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(id));
  const room = {
    id,
    name: validRoomName(requestedName),
    visibility,
    host,
    players: new Map(),
    score: [0, 0],
    started: false,
    ended: false,
    endsAt: 0
  };
  rooms.set(id, room);
  joinRoom(host, room);
  return room;
}

function joinRoom(player, room) {
  if (!room || room.ended || room.players.size >= MAX_ROOM_SIZE || player.room) return false;
  const matchWasStarted = room.started;
  const team = Array.from(room.players.values()).filter((member) => member.team === 0).length
    <= Array.from(room.players.values()).filter((member) => member.team === 1).length ? 0 : 1;
  const spawn = randomSpawn(team);
  Object.assign(player, {
    room,
    team,
    x: spawn.x,
    y: 1.7,
    z: spawn.z,
    yaw: team === 0 ? Math.PI / 2 : -Math.PI / 2,
    hp: 100,
    ammo: 30,
    reloading: false,
    lastShotAt: 0,
    respawnAt: 0,
    lastMoveAt: Date.now()
  });
  room.players.set(player.id, player);
  send(player.socket, {
    type: "room-joined",
    playerId: player.id,
    room: roomSummary(room),
    team,
    arenaLimit: ARENA_LIMIT,
    position: { x: player.x, y: player.y, z: player.z },
    yaw: player.yaw
  });
  broadcastRoster(room);
  if (matchWasStarted) send(player.socket, { type: "match-started", duration: Math.ceil((room.endsAt - Date.now()) / 1000), score: room.score });
  if (room.visibility === "public") {
    for (const client of clients.values()) send(client.socket, { type: "rooms-changed" });
  }
  if (room.players.size >= MIN_PLAYERS_TO_START && room.visibility === "public" && !room.started) startMatch(room);
  return true;
}

function randomSpawn(team) {
  return {
    x: (team === 0 ? -1 : 1) * (18 + Math.random() * 5),
    y: 1.7,
    z: (Math.random() - 0.5) * 42
  };
}

function startMatch(room, player) {
  if (player && room.host !== player) {
    send(player.socket, { type: "error", message: "Only the room host can start this match." });
    return;
  }
  if (room.started || room.ended) return;
  if (room.players.size < MIN_PLAYERS_TO_START) {
    if (player) send(player.socket, { type: "error", message: "At least two players are needed to start." });
    return;
  }
  room.started = true;
  room.endsAt = Date.now() + MATCH_SECONDS * 1000;
  broadcast(room, { type: "match-started", duration: MATCH_SECONDS, score: room.score });
}

function leaveRoom(player) {
  const room = player.room;
  if (!room) return;
  room.players.delete(player.id);
  player.room = null;
  player.respawning = false;
  if (room.players.size === 0) {
    rooms.delete(room.id);
  } else {
    if (room.host === player) room.host = room.players.values().next().value;
    broadcastRoster(room);
  }
  if (room.visibility === "public") {
    for (const client of clients.values()) send(client.socket, { type: "rooms-changed" });
  }
}

function endMatch(room) {
  if (!rooms.has(room.id) || room.ended) return;
  room.ended = true;
  const [blue, red] = room.score;
  broadcast(room, {
    type: "match-ended",
    winner: blue === red ? null : blue > red ? 0 : 1,
    score: room.score
  });
  for (const player of room.players.values()) player.room = null;
  room.players.clear();
  rooms.delete(room.id);
}

function handleJoin(player, message) {
  if (player.room) {
    send(player.socket, { type: "error", message: "Leave your current room before joining another." });
    return;
  }
  if (message.action === "create") {
    const visibility = message.visibility === "private" ? "private" : "public";
    const room = createRoom(player, visibility, message.name);
    if (message.autoStart === true && room.visibility === "private") startMatch(room, player);
    return;
  }
  if (message.action === "quick") {
    const room = Array.from(rooms.values()).find((candidate) =>
      candidate.visibility === "public" && !candidate.ended && candidate.players.size < MAX_ROOM_SIZE
    ) || createRoom(player, "public", "Quick Match");
    if (room.host !== player) joinRoom(player, room);
    return;
  }
  if (message.action === "code") {
    const room = rooms.get(typeof message.code === "string" ? message.code.trim().toUpperCase() : "");
    if (!room) {
      send(player.socket, { type: "error", message: "Private room code not found." });
      return;
    }
    if (room.visibility === "private" && room.started) {
      send(player.socket, { type: "error", message: "This match has already started." });
      return;
    }
    if (!joinRoom(player, room)) send(player.socket, { type: "error", message: "This room is full." });
    return;
  }
  if (message.action === "list") {
    send(player.socket, {
      type: "room-list",
      rooms: Array.from(rooms.values())
        .filter((room) => room.visibility === "public" && !room.ended && room.players.size < MAX_ROOM_SIZE)
        .map(roomSummary)
    });
  }
}

function shoot(player, message) {
  const room = player.room;
  const now = Date.now();
  if (!room || !room.started || player.hp <= 0 || player.reloading || player.ammo <= 0 || now - player.lastShotAt < SHOT_COOLDOWN_MS) return;
  const directionX = Number(message.directionX);
  const directionZ = Number(message.directionZ);
  if (!Number.isFinite(directionX) || !Number.isFinite(directionZ)) return;
  const magnitude = Math.hypot(directionX, directionZ);
  if (magnitude < 0.8 || magnitude > 1.2) return;
  const aimX = directionX / magnitude;
  const aimZ = directionZ / magnitude;
  player.lastShotAt = now;
  player.ammo -= 1;
  let hit = false;
  let killed = false;
  for (const target of room.players.values()) {
    if (target.team === player.team || target.hp <= 0) continue;
    const dx = target.x - player.x;
    const dz = target.z - player.z;
    const distance = Math.hypot(dx, dz);
    if (distance > 66 || distance < 0.5) continue;
    const aimDot = aimX * (dx / distance) + aimZ * (dz / distance);
    if (aimDot < 0.994) continue;
    target.hp = Math.max(0, target.hp - 34);
    hit = true;
    killed = target.hp === 0;
    send(target.socket, { type: "hit-taken", damage: 34, hp: target.hp });
    if (killed) {
      room.score[player.team] += 1;
      target.respawnAt = now + RESPAWN_MS;
      send(target.socket, {
        type: "eliminated",
        by: player.name,
        respawnIn: RESPAWN_MS,
        score: room.score
      });
      send(player.socket, { type: "elimination", target: target.name, score: room.score });
    }
    break;
  }
  broadcast(room, {
    type: "shot-fired",
    playerId: player.id,
    origin: { x: player.x, y: player.y - 0.15, z: player.z },
    direction: { x: aimX, z: aimZ },
    ammo: player.ammo,
    hit,
    score: room.score
  });
}

function handleMessage(player, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    send(player.socket, { type: "error", message: "Invalid message." });
    return;
  }
  if (!message || typeof message.type !== "string") return;
  if (message.type === "join") {
    player.name = cleanName(message.name);
    handleJoin(player, message);
    return;
  }
  if (message.type === "leave") {
    leaveRoom(player);
    send(player.socket, { type: "left-room" });
    return;
  }
  const room = player.room;
  if (!room || !room.players.has(player.id)) return;
  if (message.type === "start") {
    startMatch(room, player);
  } else if (message.type === "move" && room.started && player.hp > 0) {
    const x = Number(message.x);
    const z = Number(message.z);
    const yaw = Number(message.yaw);
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) return;
    const now = Date.now();
    const elapsedSeconds = Math.max(0.025, Math.min((now - player.lastMoveAt) / 1000, 0.3));
    const maxDistance = MAX_RUN_SPEED * elapsedSeconds + 0.5;
    const dx = x - player.x;
    const dz = z - player.z;
    const distance = Math.hypot(dx, dz);
    if (distance > maxDistance) {
      const ratio = maxDistance / distance;
      player.x += dx * ratio;
      player.z += dz * ratio;
    } else {
      player.x = x;
      player.z = z;
    }
    player.x = Math.max(-ARENA_LIMIT, Math.min(ARENA_LIMIT, player.x));
    player.z = Math.max(-ARENA_LIMIT, Math.min(ARENA_LIMIT, player.z));
    player.yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    player.lastMoveAt = now;
  } else if (message.type === "shoot") {
    shoot(player, message);
  } else if (message.type === "reload" && room.started && player.hp > 0 && !player.reloading && player.ammo < 30) {
    player.reloading = true;
    send(player.socket, { type: "reload-start", duration: 1200 });
    setTimeout(() => {
      if (!player.room || player.room !== room || !room.players.has(player.id)) return;
      player.ammo = 30;
      player.reloading = false;
      send(player.socket, { type: "reload-end", ammo: 30 });
    }, 1200);
  }
}

wss.on("connection", (socket) => {
  const player = { id: crypto.randomUUID(), socket, name: "Pilot", room: null, lastMoveAt: Date.now() };
  clients.set(player.id, player);
  send(socket, { type: "connected", playerId: player.id });
  socket.on("message", (raw) => handleMessage(player, raw));
  socket.on("close", () => {
    leaveRoom(player);
    clients.delete(player.id);
  });
  socket.on("error", (error) => console.warn(`WebSocket error: ${error.message}`));
});

const tick = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.started) continue;
    if (now >= room.endsAt) {
      endMatch(room);
      continue;
    }
    for (const player of room.players.values()) {
      if (player.hp === 0 && player.respawnAt && now >= player.respawnAt) {
        const spawn = randomSpawn(player.team);
        player.x = spawn.x;
        player.y = spawn.y;
        player.z = spawn.z;
        player.hp = 100;
        player.ammo = 30;
        player.respawnAt = 0;
        send(player.socket, { type: "respawn", position: spawn, hp: 100, ammo: 30 });
      }
      send(player.socket, {
        type: "state",
        players: Array.from(room.players.values(), playerSnapshot),
        score: room.score,
        timeRemaining: Math.max(0, Math.ceil((room.endsAt - now) / 1000))
      });
    }
  }
}, 100);

function closeServer() {
  clearInterval(tick);
  wss.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", closeServer);
process.on("SIGTERM", closeServer);
