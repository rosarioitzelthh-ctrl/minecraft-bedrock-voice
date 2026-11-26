import { world, system } from "@minecraft/server";

const hudDisabled = new Set();
const MAX_VOICE_DISTANCE = 32;

function distance3D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function getVoiceUrl() {
  try {
    const val = world.getDynamicProperty("voiceUrl");
    return typeof val === "string" && val.length > 0 ? val : null;
  } catch (_) {
    return null;
  }
}

// Mensaje de bienvenida al entrar al mundo
world.afterEvents.playerSpawn.subscribe((event) => {
  if (!event.initialSpawn) return;
  const player = event.player;
  system.runTimeout(() => {
    try {
      const savedUrl = getVoiceUrl();
      player.sendMessage(
        "§8[§b🎙 VoiceChat§8] §f¡Chat de Voz por Proximidad 3D activo en este mundo!"
      );
      if (savedUrl) {
        player.sendMessage(
          `§8[§b🎙 VoiceChat§8] §aAbre este link en tu navegador o celular: §b${savedUrl}`
        );
        player.sendMessage(
          "§8[§b🎙 VoiceChat§8] §7Escribe tu Gamertag exacto y permite el micrófono."
        );
      } else {
        player.sendMessage(
          "§8[§b🎙 VoiceChat§8] §7Anfitrión: ejecuta §e/connect localhost:3001 §7y luego §e!voz link <URL> §7para compartir el link con tus amigos."
        );
      }
      player.sendMessage(
        "§8[§b🎙 VoiceChat§8] §7Usa §e!voz §7para ocultar/mostrar el radar en pantalla."
      );
    } catch (_) {}
  }, 40);
});

// Comandos en chat: !voz / !vc / !voz link <url>
world.beforeEvents.chatSend.subscribe((event) => {
  const raw = event.message.trim();
  const lower = raw.toLowerCase();
  if (!lower.startsWith("!voz") && !lower.startsWith("!vc")) return;

  event.cancel = true;
  const player = event.sender;
  const parts = raw.split(/\s+/);

  system.run(() => {
    if (parts.length >= 3 && parts[1].toLowerCase() === "link") {
      const newUrl = parts.slice(2).join(" ");
      try {
        world.setDynamicProperty("voiceUrl", newUrl);
        world.sendMessage(
          `§8[§b🎙 VoiceChat§8] §aLink de voz actualizado para todos: §b${newUrl}`
        );
      } catch (e) {
        player.sendMessage("§8[§b🎙 VoiceChat§8] §cNo se pudo guardar el link.");
      }
      return;
    }

    if (hudDisabled.has(player.id)) {
      hudDisabled.delete(player.id);
      player.sendMessage("§8[§b🎙 VoiceChat§8] §aRadar de proximidad activado.");
    } else {
      hudDisabled.add(player.id);
      player.sendMessage("§8[§b🎙 VoiceChat§8] §cRadar de proximidad desactivado.");
    }
  });
});

// Actualiza el HUD de proximidad cada segundo (20 ticks)
system.runInterval(() => {
  const players = world.getAllPlayers();
  if (players.length < 2) return;

  for (const player of players) {
    if (hudDisabled.has(player.id)) continue;

    let nearest = null;
    let nearestDist = Infinity;
    let nearbyCount = 0;

    for (const other of players) {
      if (other.id === player.id) continue;
      if (other.dimension.id !== player.dimension.id) continue;

      const d = distance3D(player.location, other.location);
      if (d <= MAX_VOICE_DISTANCE) {
        nearbyCount++;
      }
      if (d < nearestDist) {
        nearestDist = d;
        nearest = other;
      }
    }

    if (nearest && nearestDist <= MAX_VOICE_DISTANCE) {
      const distStr = nearestDist.toFixed(1);
      const color = nearestDist < 10 ? "§a" : nearestDist < 22 ? "§e" : "§6";
      player.onScreenDisplay.setActionBar(
        `§b🎙 Voz Cercana: ${color}${nearest.name} §7(${distStr}m) §8| §f${nearbyCount} en rango`
      );
    }
  }
}, 20);
