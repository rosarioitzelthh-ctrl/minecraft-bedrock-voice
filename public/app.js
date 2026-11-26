const gamertagInput = document.getElementById("gamertagInput");
const btnJoin = document.getElementById("btnJoin");
const btnLeave = document.getElementById("btnLeave");
const btnMute = document.getElementById("btnMute");
const btnDeafen = document.getElementById("btnDeafen");
const joinCard = document.getElementById("joinCard");
const controlsCard = document.getElementById("controlsCard");
const joinError = document.getElementById("joinError");
const mcBadge = document.getElementById("mcBadge");
const micBadge = document.getElementById("micBadge");
const micLevelFill = document.getElementById("micLevelFill");
const maxDistSlider = document.getElementById("maxDistSlider");
const maxDistLabel = document.getElementById("maxDistLabel");
const playersList = document.getElementById("playersList");
const peerCount = document.getElementById("peerCount");
const posReadout = document.getElementById("posReadout");
const radarCanvas = document.getElementById("radarCanvas");
const audioContainer = document.getElementById("audioContainer");
const cmdCopy = document.getElementById("cmdCopy");

const ctx = radarCanvas.getContext("2d");

let localStream = null;
let audioCtx = null;
let analyser = null;
let ws = null;
let myPeerId = null;
let myGamertag = "";
let isMuted = false;
let isDeafened = false;
let maxDistance = 32;
let mcConnected = false;

// peerId -> { pc, audioEl, sourceNode, gainNode, pannerNode }
const peers = new Map();
// peerId -> { peerId, gamertag, x, y, z, yaw, dimension, speaking, source }
let worldPlayers = {};

// Posición local para modo simulación/prueba
let simPos = { x: 0, y: 64, z: 0, yaw: 0 };
let isDragging = false;

const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
  ],
};

const shareUrlBox = document.getElementById("shareUrlBox");
if (shareUrlBox) {
  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  shareUrlBox.textContent = isLocal
    ? "Ejecuta Iniciar_Online_Con_Amigos.bat para obtener tu link https:// público"
    : location.origin;
  shareUrlBox.addEventListener("click", () => {
    if (!isLocal) {
      navigator.clipboard?.writeText(location.origin).catch(() => {});
      const prev = shareUrlBox.textContent;
      shareUrlBox.textContent = "¡Link copiado! " + location.origin;
      setTimeout(() => (shareUrlBox.textContent = prev), 1600);
    }
  });
}

const isLocalHost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const mcConnectCmd = isLocalHost
  ? "/connect localhost:3001"
  : `/connect wss://${location.host}/mc`;

cmdCopy.textContent = mcConnectCmd;
cmdCopy.addEventListener("click", () => {
  navigator.clipboard?.writeText(mcConnectCmd).catch(() => {});
  cmdCopy.textContent = "¡Copiado! " + mcConnectCmd;
  setTimeout(() => (cmdCopy.textContent = mcConnectCmd), 1600);
});

try {
  const savedTag = localStorage.getItem("mc_voice_gamertag");
  if (savedTag) gamertagInput.value = savedTag;
} catch (_) {}

maxDistSlider.addEventListener("input", () => {
  maxDistance = Number(maxDistSlider.value);
  maxDistLabel.textContent = String(maxDistance);
  updateAllSpatialAudio();
});

async function requestMicrophone() {
  joinError.textContent = "";
  try {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
    }
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    micBadge.textContent = "Micrófono: Permitido";
    micBadge.className = "badge badge-ok";
    setupLocalMicMeter();
    return true;
  } catch (err) {
    micBadge.textContent = "Micrófono: Denegado";
    micBadge.className = "badge badge-warn";
    joinError.textContent =
      "No se pudo acceder al micrófono. Permite el acceso en tu navegador e inténtalo de nuevo.";
    return false;
  }
}

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Mantiene el AudioContext activo en segundo plano en móviles
    try {
      const osc = audioCtx.createOscillator();
      const silentGain = audioCtx.createGain();
      silentGain.gain.value = 0.0001;
      osc.connect(silentGain);
      silentGain.connect(audioCtx.destination);
      osc.start();
    } catch (_) {}
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
}

function setupLocalMicMeter() {
  ensureAudioContext();
  const src = audioCtx.createMediaStreamSource(localStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);

  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Chat de Voz Minecraft",
        artist: myGamertag || "En llamada de proximidad",
      });
      navigator.mediaSession.playbackState = "playing";
    } catch (_) {}
  }

  const data = new Uint8Array(analyser.frequencyBinCount);
  let lastSpeaking = false;

  function tick() {
    if (!analyser) return;
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const avg = sum / data.length;
    const pct = Math.min(100, Math.round((avg / 65) * 100));
    micLevelFill.style.width = isMuted ? "0%" : `${pct}%`;

    const speaking = !isMuted && pct > 12;
    if (speaking !== lastSpeaking && ws && ws.readyState === WebSocket.OPEN) {
      lastSpeaking = speaking;
      ws.send(JSON.stringify({ type: "speaking", speaking }));
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

btnJoin.addEventListener("click", async () => {
  const tag = gamertagInput.value.trim();
  if (!tag) {
    joinError.textContent = "Escribe tu Gamertag de Minecraft Bedrock primero.";
    return;
  }
  try {
    localStorage.setItem("mc_voice_gamertag", tag);
  } catch (_) {}

  // Iniciar AudioContext dentro del gesto del usuario (clave en móviles/iOS/Android)
  ensureAudioContext();

  btnJoin.disabled = true;
  btnJoin.textContent = "Conectando micrófono...";
  if (!localStream) {
    const ok = await requestMicrophone();
    if (!ok) {
      btnJoin.disabled = false;
      btnJoin.textContent = "🎙️ Entrar al Chat de Voz";
      return;
    }
  }
  ensureAudioContext();
  try {
    await navigator.wakeLock?.request("screen");
  } catch (_) {}

  myGamertag = tag;
  connectWebSocket();
  btnJoin.disabled = false;
  btnJoin.textContent = "🎙️ Entrar al Chat de Voz";
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
});

btnLeave.addEventListener("click", () => {
  if (ws) ws.close();
  cleanupAllPeers();
  joinCard.classList.remove("hidden");
  controlsCard.classList.add("hidden");
});

btnMute.addEventListener("click", () => {
  isMuted = !isMuted;
  if (localStream) {
    localStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
  }
  btnMute.textContent = isMuted ? "🔇 Mic: Silenciado" : "🎙️ Mic: Activo";
  micBadge.textContent = isMuted ? "Micrófono: Silenciado" : "Micrófono: Activo";
  micBadge.className = isMuted ? "badge badge-warn" : "badge badge-ok";
});

btnDeafen.addEventListener("click", () => {
  isDeafened = !isDeafened;
  btnDeafen.textContent = isDeafened ? "🔇 Audio: Ensordecido" : "🔊 Audio: Activo";
  updateAllSpatialAudio();
});

function connectWebSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "join", gamertag: myGamertag }));
  };

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === "joined") {
      myPeerId = msg.peerId;
      joinCard.classList.add("hidden");
      controlsCard.classList.remove("hidden");
      for (const p of msg.peers) {
        await createPeerConnection(p.peerId, true);
      }
    } else if (msg.type === "peer-joined") {
      await createPeerConnection(msg.peerId, false);
    } else if (msg.type === "peer-left") {
      removePeer(msg.peerId);
    } else if (msg.type === "offer") {
      await handleOffer(msg.from, msg.sdp);
    } else if (msg.type === "answer") {
      const peer = peers.get(msg.from);
      if (peer) await peer.pc.setRemoteDescription(msg.sdp);
    } else if (msg.type === "ice") {
      const peer = peers.get(msg.from);
      if (peer && msg.candidate) {
        await peer.pc.addIceCandidate(msg.candidate).catch(() => {});
      }
    } else if (msg.type === "world-state") {
      mcConnected = Boolean(msg.mcConnected);
      mcBadge.textContent = mcConnected
        ? "Minecraft: Conectado"
        : "Minecraft: Esperando /connect";
      mcBadge.className = mcConnected ? "badge badge-ok" : "badge badge-warn";

      worldPlayers = msg.players || {};
      updateAllSpatialAudio();
      renderPlayersList();
    }
  };

  ws.onclose = () => {
    cleanupAllPeers();
  };
}

async function createPeerConnection(remotePeerId, isInitiator) {
  if (peers.has(remotePeerId)) return peers.get(remotePeerId);

  const pc = new RTCPeerConnection(RTC_CONFIG);
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  const peerEntry = {
    pc,
    audioEl: null,
    sourceNode: null,
    gainNode: null,
    pannerNode: null,
  };
  peers.set(remotePeerId, peerEntry);

  pc.onicecandidate = (e) => {
    if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "ice",
          to: remotePeerId,
          candidate: e.candidate,
        })
      );
    }
  };

  pc.ontrack = (e) => {
    const remoteStream = e.streams[0];
    if (!remoteStream) return;

    // Elemento <audio> silenciado para asegurar reproducción WebRTC en Chromium
    const audioEl = document.createElement("audio");
    audioEl.srcObject = remoteStream;
    audioEl.autoplay = true;
    audioEl.muted = true;
    audioContainer.appendChild(audioEl);
    audioEl.play().catch(() => {});

    // Grafo Web Audio 3D: Source -> Gain -> Panner (HRTF) -> Destination
    const sourceNode = audioCtx.createMediaStreamSource(remoteStream);
    const gainNode = audioCtx.createGain();
    const pannerNode = audioCtx.createPanner();
    pannerNode.panningModel = "HRTF";
    pannerNode.distanceModel = "linear";
    pannerNode.refDistance = 2;
    pannerNode.maxDistance = maxDistance;
    pannerNode.rolloffFactor = 1;

    sourceNode.connect(gainNode);
    gainNode.connect(pannerNode);
    pannerNode.connect(audioCtx.destination);

    peerEntry.audioEl = audioEl;
    peerEntry.sourceNode = sourceNode;
    peerEntry.gainNode = gainNode;
    peerEntry.pannerNode = pannerNode;

    updateAllSpatialAudio();
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(
      JSON.stringify({
        type: "offer",
        to: remotePeerId,
        sdp: pc.localDescription,
      })
    );
  }

  return peerEntry;
}

async function handleOffer(remotePeerId, sdp) {
  const peerEntry = await createPeerConnection(remotePeerId, false);
  await peerEntry.pc.setRemoteDescription(sdp);
  const answer = await peerEntry.pc.createAnswer();
  await peerEntry.pc.setLocalDescription(answer);
  ws.send(
    JSON.stringify({
      type: "answer",
      to: remotePeerId,
      sdp: peerEntry.pc.localDescription,
    })
  );
}

function removePeer(remotePeerId) {
  const peer = peers.get(remotePeerId);
  if (!peer) return;
  try {
    peer.pc.close();
  } catch (_) {}
  if (peer.audioEl) peer.audioEl.remove();
  if (peer.sourceNode) peer.sourceNode.disconnect();
  if (peer.gainNode) peer.gainNode.disconnect();
  if (peer.pannerNode) peer.pannerNode.disconnect();
  peers.delete(remotePeerId);
}

function cleanupAllPeers() {
  for (const id of Array.from(peers.keys())) {
    removePeer(id);
  }
}

function dist3D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function updateAllSpatialAudio() {
  if (!audioCtx || !myPeerId) return;
  const me = worldPlayers[myPeerId];
  if (!me) return;

  posReadout.textContent = `Pos: (${me.x.toFixed(1)}, ${me.y.toFixed(1)}, ${me.z.toFixed(1)}) | Yaw: ${Math.round(me.yaw)}°`;

  // Orientación del oyente según yaw de Minecraft
  const rad = (me.yaw * Math.PI) / 180;
  const fx = -Math.sin(rad);
  const fz = Math.cos(rad);
  const listener = audioCtx.listener;

  if (listener.positionX) {
    listener.positionX.value = me.x;
    listener.positionY.value = me.y;
    listener.positionZ.value = me.z;
    listener.forwardX.value = fx;
    listener.forwardY.value = 0;
    listener.forwardZ.value = fz;
    listener.upX.value = 0;
    listener.upY.value = 1;
    listener.upZ.value = 0;
  }

  for (const [remoteId, peer] of peers.entries()) {
    if (!peer.pannerNode || !peer.gainNode) continue;
    const other = worldPlayers[remoteId];
    if (!other || isDeafened) {
      peer.gainNode.gain.value = 0;
      continue;
    }

    if (other.dimension !== me.dimension) {
      peer.gainNode.gain.value = 0;
      continue;
    }

    peer.pannerNode.maxDistance = maxDistance;
    if (peer.pannerNode.positionX) {
      peer.pannerNode.positionX.value = other.x;
      peer.pannerNode.positionY.value = other.y;
      peer.pannerNode.positionZ.value = other.z;
    }

    const d = dist3D(me, other);
    if (d >= maxDistance) {
      peer.gainNode.gain.value = 0;
    } else {
      const vol = Math.max(0, 1 - d / maxDistance);
      peer.gainNode.gain.value = vol;
    }
  }
}

function renderPlayersList() {
  const list = Object.values(worldPlayers);
  peerCount.textContent = String(list.length);
  if (list.length === 0) {
    playersList.innerHTML = `<li class="empty-msg">Aún no hay jugadores en la sala de voz.</li>`;
    return;
  }

  const me = worldPlayers[myPeerId];
  playersList.innerHTML = list
    .map((p) => {
      const isMe = p.peerId === myPeerId;
      let distBadge = "Tú";
      if (!isMe && me) {
        if (p.dimension !== me.dimension) {
          distBadge = `Otra dimensión (${p.dimension})`;
        } else {
          const d = dist3D(me, p);
          const pct = d >= maxDistance ? 0 : Math.round((1 - d / maxDistance) * 100);
          distBadge = `${d.toFixed(1)}m · Vol ${pct}%`;
        }
      }
      const srcTag = p.source === "minecraft" ? "🎮 MC" : "🧪 Sim";
      return `
        <li class="player-item ${p.speaking ? "speaking" : ""}">
          <div>
            <strong>${escapeHtml(p.gamertag)}</strong>
            <span class="mono"> (${srcTag})</span>
          </div>
          <span class="mono">${distBadge}</span>
        </li>
      `;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- Radar 2D + Arrastre en modo simulación ---
radarCanvas.addEventListener("pointerdown", (e) => {
  const me = worldPlayers[myPeerId];
  if (!me || me.source === "minecraft") return;
  isDragging = true;
  moveSimFromEvent(e);
});

window.addEventListener("pointermove", (e) => {
  if (!isDragging) return;
  moveSimFromEvent(e);
});

window.addEventListener("pointerup", () => {
  isDragging = false;
});

function moveSimFromEvent(e) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const rect = radarCanvas.getBoundingClientRect();
  const cx = radarCanvas.width / 2;
  const cy = radarCanvas.height / 2;
  const px = ((e.clientX - rect.left) / rect.width) * radarCanvas.width;
  const py = ((e.clientY - rect.top) / rect.height) * radarCanvas.height;
  const scale = (radarCanvas.width * 0.44) / Math.max(maxDistance, 20);

  simPos.x = (px - cx) / scale;
  simPos.z = (py - cy) / scale;
  ws.send(JSON.stringify({ type: "sim-move", ...simPos }));
}

function drawRadar() {
  const w = radarCanvas.width;
  const h = radarCanvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const radiusPx = w * 0.44;
  const scale = radiusPx / Math.max(maxDistance, 20);

  ctx.clearRect(0, 0, w, h);

  // Anillos de distancia
  ctx.strokeStyle = "#1e293b";
  ctx.lineWidth = 1;
  [0.33, 0.66, 1].forEach((f) => {
    ctx.beginPath();
    ctx.arc(cx, cy, radiusPx * f, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = "#64748b";
    ctx.font = "11px monospace";
    ctx.fillText(`${Math.round(maxDistance * f)}m`, cx + 4, cy - radiusPx * f + 13);
  });

  // Ejes
  ctx.beginPath();
  ctx.moveTo(cx - radiusPx, cy);
  ctx.lineTo(cx + radiusPx, cy);
  ctx.moveTo(cx, cy - radiusPx);
  ctx.lineTo(cx, cy + radiusPx);
  ctx.stroke();

  const me = worldPlayers[myPeerId];
  const originX = me && me.source === "minecraft" ? me.x : 0;
  const originZ = me && me.source === "minecraft" ? me.z : 0;

  for (const p of Object.values(worldPlayers)) {
    const dx = p.x - originX;
    const dz = p.z - originZ;
    const px = cx + dx * scale;
    const py = cy + dz * scale;

    const isMe = p.peerId === myPeerId;
    ctx.beginPath();
    ctx.arc(px, py, isMe ? 9 : 7, 0, Math.PI * 2);
    ctx.fillStyle = p.speaking ? "#2ecc71" : isMe ? "#38bdf8" : "#94a3b8";
    ctx.fill();

    if (p.speaking) {
      ctx.beginPath();
      ctx.arc(px, py, 14, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(46, 204, 113, 0.55)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.fillStyle = "#e2e8f0";
    ctx.font = "12px sans-serif";
    ctx.fillText(p.gamertag, px + 11, py + 4);
  }

  requestAnimationFrame(drawRadar);
}

requestAnimationFrame(drawRadar);
