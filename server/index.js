import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 4000;

/**
 * Rooms state maintained by the server.
 * @type {Record<string, RoomState>}
 */
const rooms = Object.create(null);

/** Interval handler for cleaning up stale rooms. */
setInterval(() => {
  const now = Date.now();
  const TEN_MINUTES = 10 * 60 * 1000;
  for (const [code, room] of Object.entries(rooms)) {
    if (room.players.length === 0 && now - room.lastActive > TEN_MINUTES) {
      delete rooms[code];
    }
  }
}, 60 * 1000);

app.post("/room", (req, res) => {
  let code = genCode();
  while (rooms[code]) {
    code = genCode();
  }
  rooms[code] = createRoom(code);
  res.json({ code });
});

io.on("connection", (socket) => {
  socket.on("join_room", (payload) => {
    try {
      handleJoinRoom(socket, payload);
    } catch (err) {
      socket.emit("error_msg", err.message || "Failed to join room");
    }
  });

  socket.on("move", (payload) => {
    try {
      handleMove(socket, payload);
    } catch (err) {
      socket.emit("error_msg", err.message || "Failed to apply move");
    }
  });

  socket.on("disconnect", () => {
    handleDisconnect(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

/**
 * Generate a six character uppercase room code.
 * @returns {string}
 */
export function genCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    const index = Math.floor(Math.random() * chars.length);
    code += chars[index];
  }
  return code;
}

/**
 * Create a new room state object.
 * @param {string} code
 * @returns {RoomState}
 */
function createRoom(code) {
  return {
    code,
    players: [],
    state: initialState(),
    sideToMove: "WHITE",
    lastActive: Date.now(),
  };
}

/**
 * Handle a client joining a room.
 * @param {import('socket.io').Socket} socket
 * @param {{ code?: string, uid?: string }} payload
 */
function handleJoinRoom(socket, payload = {}) {
  const { code, uid } = payload;
  if (!code || typeof code !== "string") {
    throw new Error("Room code is required");
  }
  if (!uid || typeof uid !== "string") {
    throw new Error("User id is required");
  }
  const room = rooms[code];
  if (!room) {
    throw new Error("Room not found");
  }

  const existing = room.players.find((p) => p.uid === uid);
  if (!existing && room.players.length >= 2) {
    throw new Error("Room is full");
  }

  const previousMembership = socket.data.membership;
  if (previousMembership && previousMembership.code !== code) {
    socket.leave(previousMembership.code);
    handleDisconnect(socket);
  }

  let player;
  if (existing) {
    existing.socketId = socket.id;
    player = existing;
  } else {
    const color = room.players.length === 0 ? "WHITE" : "BLACK";
    player = { uid, color, socketId: socket.id };
    room.players.push(player);
  }
  socket.data.membership = { code, uid };
  socket.join(code);
  room.lastActive = Date.now();

  emitRoomState(room);
}

/**
 * Handle a move request from a client.
 * @param {import('socket.io').Socket} socket
 * @param {{ code?: string, move?: ChessMove }} payload
 */
function handleMove(socket, payload = {}) {
  const membership = socket.data.membership;
  if (!membership) {
    throw new Error("You are not joined to a room");
  }

  const { code, move } = payload;
  if (!code || typeof code !== "string") {
    throw new Error("Room code is required");
  }
  if (membership.code !== code) {
    throw new Error("You are not part of this room");
  }
  if (!move || typeof move !== "object") {
    throw new Error("Move payload is required");
  }

  const room = rooms[code];
  if (!room) {
    throw new Error("Room not found");
  }

  const player = room.players.find((p) => p.uid === membership.uid);
  if (!player) {
    throw new Error("Player not found in room");
  }
  if (player.color !== room.sideToMove) {
    throw new Error("Not your turn");
  }

  validateMovePayload(move);

  // TODO: integrate real chess validation.
  if (!validateLegalMove(room.state, move)) {
    throw new Error("Illegal move");
  }

  applyMoveServer(room, move);

  const response = {
    move,
    sideToMove: room.sideToMove,
    state: room.state,
  };

  io.to(code).emit("move_applied", response);
  room.lastActive = Date.now();
}

/**
 * Validate the move payload has minimally correct structure.
 * @param {ChessMove} move
 */
function validateMovePayload(move) {
  const { from, to } = move;
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new Error("Move coordinates must be integers");
  }
  if (from < 0 || from > 63 || to < 0 || to > 63) {
    throw new Error("Squares must be between 0 and 63");
  }
  if (from === to) {
    throw new Error("From and to squares must differ");
  }
}

/**
 * Apply the move server side. For now this only tracks the last move and flips the turn.
 * @param {RoomState} room
 * @param {ChessMove} move
 */
export function applyMoveServer(room, move) {
  room.state.lastMove = { ...move };
  room.sideToMove = room.sideToMove === "WHITE" ? "BLACK" : "WHITE";
}

/**
 * Placeholder for real chess move validation.
 * @param {GameState} state
 * @param {ChessMove} move
 * @returns {boolean}
 */
export function validateLegalMove(state, move) {
  // TODO: implement actual chess validation logic.
  return true;
}

/**
 * Create the initial game state object.
 * @returns {GameState}
 */
export function initialState() {
  return {
    lastMove: null,
    boardFEN: "startpos",
  };
}

/**
 * Emit the current room state to all clients in the room.
 * @param {RoomState} room
 */
function emitRoomState(room) {
  const payload = {
    code: room.code,
    players: room.players.map(({ uid, color }) => ({ uid, color })),
    sideToMove: room.sideToMove,
    state: room.state,
  };
  io.to(room.code).emit("room_state", payload);
}

/**
 * Handle socket disconnects by removing the player from their room if necessary.
 * @param {import('socket.io').Socket} socket
 */
function handleDisconnect(socket) {
  const membership = socket.data.membership;
  if (!membership) {
    return;
  }
  const room = rooms[membership.code];
  if (!room) {
    return;
  }

  const index = room.players.findIndex((p) => p.uid === membership.uid);
  if (index !== -1) {
    room.players.splice(index, 1);
    room.lastActive = Date.now();
    emitRoomState(room);
  }

  if (room.players.length === 0) {
    room.sideToMove = "WHITE";
    room.state = initialState();
  }

  delete socket.data.membership;
}

/**
 * @typedef {Object} ChessMove
 * @property {number} from
 * @property {number} to
 * @property {'Q'|'R'|'B'|'N'} [promo]
 * @property {boolean} [isCastle]
 * @property {boolean} [isEnPassant]
 * @property {boolean} [isDoublePawnPush]
 */

/**
 * @typedef {Object} GameState
 * @property {ChessMove|null} lastMove
 * @property {string} boardFEN
 */

/**
 * @typedef {Object} PlayerInfo
 * @property {string} uid
 * @property {'WHITE'|'BLACK'} color
 * @property {string} socketId
 */

/**
 * @typedef {Object} RoomState
 * @property {string} code
 * @property {PlayerInfo[]} players
 * @property {GameState} state
 * @property {'WHITE'|'BLACK'} sideToMove
 * @property {number} lastActive
 */
