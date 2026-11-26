const crypto = require("crypto");
const EventEmitter = require("events");

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Codifica un mensaje de texto o binario en un frame WebSocket (RFC 6455).
 */
function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

class WsClient extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;

    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._cleanup());
    socket.on("error", (err) => {
      if (this.listenerCount("error") > 0) {
        this.emit("error", err);
      }
      this._cleanup();
    });
  }

  send(text) {
    if (this.closed || this.socket.destroyed) return;
    try {
      this.socket.write(encodeFrame(text, 0x1));
    } catch (_) {
      this._cleanup();
    }
  }

  close() {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(Buffer.alloc(0), 0x8));
    } catch (_) {}
    this._cleanup();
  }

  _cleanup() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch (_) {}
    this.emit("close");
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = isMasked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + payloadLen) return;

      let maskKey = null;
      if (isMasked) {
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLen));
      this.buffer = this.buffer.subarray(offset + payloadLen);

      if (isMasked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      if (opcode === 0x8) {
        this.close();
        return;
      } else if (opcode === 0x9) {
        // Ping -> Pong
        if (!this.closed && !this.socket.destroyed) {
          this.socket.write(encodeFrame(payload, 0xA));
        }
      } else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        this.emit("message", payload.toString("utf8"));
      }
    }
  }
}

/**
 * Completa el handshake WebSocket en una petición HTTP Upgrade.
 */
function acceptWebSocket(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return null;
  }
  const acceptKey = crypto
    .createHash("sha1")
    .update(key + WS_MAGIC)
    .digest("base64");

  const headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey}`,
    "\r\n",
  ];
  socket.write(headers.join("\r\n"));
  return new WsClient(socket);
}

module.exports = { acceptWebSocket };
