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
  console.log(`[DEBUG] Room created: ${code} at ${new Date().toISOString()}`);
  console.log(`[DEBUG] Total active rooms: ${Object.keys(rooms).length}`);
  res.json({ code });
});

io.on("connection", (socket) => {
  console.log(`[DEBUG] Client connected: ${socket.id}`);

  socket.on("join_room", (payload) => {
    try {
      console.log(`[DEBUG] Join room request from ${socket.id}:`, payload);
      handleJoinRoom(socket, payload);
    } catch (err) {
      console.log(`[DEBUG] Join room error for ${socket.id}:`, err.message);
      socket.emit("error_msg", {
        message: err.message || "Failed to join room",
      });
    }
  });

  socket.on("move", (payload) => {
    try {
      console.log(`[DEBUG] Move request from ${socket.id}:`, payload);
      handleMove(socket, payload);
    } catch (err) {
      console.log(`[DEBUG] Move error for ${socket.id}:`, err.message);
      socket.emit("error_msg", {
        message: err.message || "Failed to apply move",
      });
    }
  });

  socket.on("disconnect", () => {
    console.log(`[DEBUG] Client disconnected: ${socket.id}`);
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
    console.log(
      `[DEBUG] Player ${uid} reconnected to room ${code} as ${player.color}`
    );
  } else {
    const color = room.players.length === 0 ? "WHITE" : "BLACK";
    player = { uid, color, socketId: socket.id };
    room.players.push(player);
    console.log(`[DEBUG] Player ${uid} joined room ${code} as ${color}`);
  }
  socket.data.membership = { code, uid };
  socket.join(code);
  room.lastActive = Date.now();

  console.log(`[DEBUG] Room ${code} now has ${room.players.length} players`);

  // Emit room_joined to the joining player
  socket.emit("room_joined", {
    code: room.code,
    color: player.color.toLowerCase(), // Convert to lowercase for client
  });

  // If this is the second player, notify the first player that opponent joined
  if (room.players.length === 2 && !existing) {
    const otherPlayer = room.players.find((p) => p.uid !== uid);
    if (otherPlayer) {
      io.to(otherPlayer.socketId).emit("opponent_joined", {});
    }
  }

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
  const { from, to, promo, isCastle, isEnPassant, isDoublePawnPush } = move;
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new Error("Move coordinates must be integers");
  }
  if (from < 0 || from > 63 || to < 0 || to > 63) {
    throw new Error("Squares must be between 0 and 63");
  }
  if (from === to) {
    throw new Error("From and to squares must differ");
  }

  // Validate promotion piece if provided
  if (promo !== undefined && promo !== null) {
    if (typeof promo !== "string" || !["Q", "R", "B", "N"].includes(promo)) {
      throw new Error("Promotion piece must be Q, R, B, or N");
    }
  }

  // Validate boolean flags
  if (isCastle !== undefined && typeof isCastle !== "boolean") {
    throw new Error("isCastle must be boolean");
  }
  if (isEnPassant !== undefined && typeof isEnPassant !== "boolean") {
    throw new Error("isEnPassant must be boolean");
  }
  if (isDoublePawnPush !== undefined && typeof isDoublePawnPush !== "boolean") {
    throw new Error("isDoublePawnPush must be boolean");
  }
}

/**
 * Apply the move server side. For now this only tracks the last move and flips the turn.
 * @param {RoomState} room
 * @param {ChessMove} move
 */
export function applyMoveServer(room, move) {
  // Copy all move properties including optional ones
  room.state.lastMove = {
    from: move.from,
    to: move.to,
    promo: move.promo || null,
    isCastle: move.isCastle || false,
    isEnPassant: move.isEnPassant || false,
    isDoublePawnPush: move.isDoublePawnPush || false,
  };
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
 * @property {number} from - Source square (0-63)
 * @property {number} to - Destination square (0-63)
 * @property {'Q'|'R'|'B'|'N'|null} [promo] - Promotion piece (for pawn promotion)
 * @property {boolean} [isCastle] - True if this is a castling move
 * @property {boolean} [isEnPassant] - True if this is an en passant capture
 * @property {boolean} [isDoublePawnPush] - True if this is a double pawn push
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
