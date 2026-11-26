const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { acceptWebSocket } = require("./ws-helper");

const HTTP_PORT = Number(process.env.PORT || 3000);
const MC_WS_PORT = Number(process.env.MC_WS_PORT || 3001);

const PUBLIC_DIR = path.join(__dirname, "public");
const MCADDON_PATH = path.join(__dirname, "MinecraftProximityVoice.mcaddon");

// Estado de clientes de voz (navegador)
const voicePeers = new Map(); // peerId -> { ws, peerId, gamertag, speaking, simPos }
// Estado de posiciones reales desde Minecraft Bedrock
const mcPositions = new Map(); // gamertagLower -> { gamertag, x, y, z, yaw, dimension, updatedAt }
// Conexiones activas de Minecraft (/connect localhost:3001)
const mcSockets = new Set();
// Mapa de requestId -> gamertag para respuestas de querytarget
const pendingMcRequests = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".mcaddon": "application/octet-stream",
};

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function broadcastVoice(payload, excludePeerId = null) {
  const msg = JSON.stringify(payload);
  for (const [id, peer] of voicePeers.entries()) {
    if (id !== excludePeerId) {
      peer.ws.send(msg);
    }
  }
}

function getWorldStatePayload() {
  const players = {};
  const now = Date.now();

  for (const peer of voicePeers.values()) {
    const key = peer.gamertag.toLowerCase();
    const mc = mcPositions.get(key);
    const mcFresh = mc && now - mc.updatedAt < 4000;

    if (mcFresh) {
      players[peer.peerId] = {
        peerId: peer.peerId,
        gamertag: peer.gamertag,
        x: mc.x,
        y: mc.y,
        z: mc.z,
        yaw: mc.yaw,
        dimension: mc.dimension,
        speaking: peer.speaking,
        source: "minecraft",
      };
    } else {
      players[peer.peerId] = {
        peerId: peer.peerId,
        gamertag: peer.gamertag,
        x: peer.simPos.x,
        y: peer.simPos.y,
        z: peer.simPos.z,
        yaw: peer.simPos.yaw,
        dimension: "overworld",
        speaking: peer.speaking,
        source: "sim",
      };
    }
  }

  return {
    type: "world-state",
    mcConnected: mcSockets.size > 0,
    players,
  };
}

// --- Servidor HTTP + WebSocket de Voz (Puerto 3000) ---
const httpServer = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (req.method === "POST" && urlPath === "/api/positions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const list = JSON.parse(body);
        if (Array.isArray(list)) {
          const now = Date.now();
          for (const p of list) {
            if (!p || !p.name) continue;
            mcPositions.set(String(p.name).toLowerCase(), {
              gamertag: p.name,
              x: Number(p.x) || 0,
              y: Number(p.y) || 64,
              z: Number(p.z) || 0,
              yaw: Number(p.yaw) || 0,
              dimension: String(p.dimension || "overworld"),
              updatedAt: now,
            });
          }
        }
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 400, { error: "Invalid JSON" });
      }
    });
    return;
  }

  if (urlPath === "/api/status") {
    sendJson(res, 200, {
      mcConnected: mcSockets.size > 0,
      voicePeers: voicePeers.size,
      hasAddon: fs.existsSync(MCADDON_PATH),
    });
    return;
  }

  if (urlPath === "/download/MinecraftProximityVoice.mcaddon") {
    if (!fs.existsSync(MCADDON_PATH)) {
      res.writeHead(404);
      res.end("Mod .mcaddon no encontrado. Ejecuta el empaquetado primero.");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="MinecraftProximityVoice.mcaddon"',
    });
    fs.createReadStream(MCADDON_PATH).pipe(res);
    return;
  }

  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const fullPath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
});

httpServer.on("upgrade", (req, socket) => {
  const urlPath = (req.url || "/").split("?")[0];
  if (urlPath === "/mc") {
    const ws = acceptWebSocket(req, socket);
    if (ws) attachMinecraftBridge(ws);
    return;
  }
  if (urlPath !== "/ws") {
    socket.destroy();
    return;
  }

  const ws = acceptWebSocket(req, socket);
  if (!ws) return;

  let currentPeerId = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "join") {
      currentPeerId = msg.peerId || crypto.randomUUID();
      const gamertag = String(msg.gamertag || "Jugador").trim().slice(0, 24);
      const indexOffset = voicePeers.size * 5;

      const peerInfo = {
        ws,
        peerId: currentPeerId,
        gamertag,
        speaking: false,
        simPos: { x: indexOffset, y: 64, z: 0, yaw: 0 },
      };

      const existingPeers = Array.from(voicePeers.values()).map((p) => ({
        peerId: p.peerId,
        gamertag: p.gamertag,
      }));

      voicePeers.set(currentPeerId, peerInfo);

      ws.send(
        JSON.stringify({
          type: "joined",
          peerId: currentPeerId,
          gamertag,
          peers: existingPeers,
        })
      );

      broadcastVoice(
        {
          type: "peer-joined",
          peerId: currentPeerId,
          gamertag,
        },
        currentPeerId
      );
      return;
    }

    if (!currentPeerId || !voicePeers.has(currentPeerId)) return;
    const sender = voicePeers.get(currentPeerId);

    if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice") {
      const target = voicePeers.get(msg.to);
      if (target) {
        target.ws.send(
          JSON.stringify({
            type: msg.type,
            from: currentPeerId,
            sdp: msg.sdp,
            candidate: msg.candidate,
          })
        );
      }
    } else if (msg.type === "speaking") {
      sender.speaking = Boolean(msg.speaking);
    } else if (msg.type === "sim-move") {
      sender.simPos = {
        x: Number(msg.x) || 0,
        y: Number(msg.y) || 64,
        z: Number(msg.z) || 0,
        yaw: Number(msg.yaw) || 0,
      };
    }
  });

  ws.on("close", () => {
    if (currentPeerId && voicePeers.has(currentPeerId)) {
      voicePeers.delete(currentPeerId);
      broadcastVoice({ type: "peer-left", peerId: currentPeerId });
    }
  });
});

// --- Puente WebSocket de Minecraft Bedrock (Puerto 3001) ---
function sendMcCommand(ws, commandLine, tag = null) {
  const requestId = crypto.randomUUID();
  if (tag) {
    pendingMcRequests.set(requestId, { tag, time: Date.now() });
  }
  ws.send(
    JSON.stringify({
      header: {
        version: 1,
        requestId,
        messagePurpose: "commandRequest",
        messageType: "commandRequest",
      },
      body: {
        version: 1,
        commandLine,
        origin: { type: "player" },
      },
    })
  );
}

function normalizeDimension(dim) {
  if (dim === 0 || dim === "0" || dim === "overworld") return "overworld";
  if (dim === 1 || dim === "1" || dim === "nether") return "nether";
  if (dim === 2 || dim === "2" || dim === "the_end") return "the_end";
  return String(dim || "overworld");
}

function attachMinecraftBridge(ws) {
  mcSockets.add(ws);
  console.log("[MC Bridge] Minecraft Bedrock conectado!");

  sendMcCommand(
    ws,
    'tellraw @a {"rawtext":[{"text":"§8[§b🎙 VoiceChat§8] §a¡Conectado al servidor de voz por proximidad!"}]}'
  );

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    const header = data.header || {};
    const body = data.body || {};

    if (header.messagePurpose === "commandResponse" && header.requestId) {
      const reqMeta = pendingMcRequests.get(header.requestId);
      pendingMcRequests.delete(header.requestId);

      if (reqMeta && body.details) {
        try {
          const parsed = JSON.parse(body.details);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const target = parsed[0];
            if (target && target.position) {
              mcPositions.set(reqMeta.tag.toLowerCase(), {
                gamertag: reqMeta.tag,
                x: Number(target.position.x) || 0,
                y: Number(target.position.y) || 64,
                z: Number(target.position.z) || 0,
                yaw: Number(target.yRot) || 0,
                dimension: normalizeDimension(target.dimension),
                updatedAt: Date.now(),
              });
            }
          }
        } catch (_) {}
      }
    }
  });

  ws.on("close", () => {
    mcSockets.delete(ws);
    console.log("[MC Bridge] Minecraft Bedrock desconectado.");
  });
}

const mcBridgeServer = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Minecraft Bedrock Voice Bridge WebSocket");
});

mcBridgeServer.on("upgrade", (req, socket) => {
  const ws = acceptWebSocket(req, socket);
  if (ws) attachMinecraftBridge(ws);
});

// Bucle de sondeo de coordenadas en Minecraft y broadcast a clientes de voz (cada 150ms)
setInterval(() => {
  const now = Date.now();
  for (const [reqId, meta] of pendingMcRequests.entries()) {
    if (now - meta.time > 3000) pendingMcRequests.delete(reqId);
  }

  if (mcSockets.size > 0 && voicePeers.size > 0) {
    const firstMc = mcSockets.values().next().value;
    const queriedTags = new Set();
    for (const peer of voicePeers.values()) {
      const tag = peer.gamertag;
      if (tag && !queriedTags.has(tag.toLowerCase())) {
        queriedTags.add(tag.toLowerCase());
        const safeTag = tag.replace(/"/g, "");
        sendMcCommand(firstMc, `querytarget "${safeTag}"`, tag);
      }
    }
  }

  if (voicePeers.size > 0) {
    broadcastVoice(getWorldStatePayload());
  }
}, 150);

httpServer.listen(HTTP_PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🎙️  Minecraft Bedrock Proximity Voice Chat`);
  console.log(`🌐 App Web (Micrófono): http://localhost:${HTTP_PORT}`);
  console.log(`🎮 Puente Minecraft:    /connect localhost:${MC_WS_PORT}`);
  console.log(`📦 Mod .mcaddon:        http://localhost:${HTTP_PORT}/download/MinecraftProximityVoice.mcaddon`);
  console.log(`==================================================\n`);
});

mcBridgeServer.on("error", () => {});
if (!process.env.RENDER && !process.env.RAILWAY_ENVIRONMENT) {
  mcBridgeServer.listen(MC_WS_PORT);
}
