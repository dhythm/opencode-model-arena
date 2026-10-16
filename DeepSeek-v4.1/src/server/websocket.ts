import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const MAX_MESSAGE_BYTES = 1 << 20;

export type WSConnection = {
  id: string;
  send: (text: string) => void;
  close: (code?: number, reason?: string) => void;
  onMessage: (handler: (text: string) => void) => void;
  onClose: (handler: () => void) => void;
};

export function computeAcceptKey(secWebSocketKey: string): string {
  return createHash("sha1").update(secWebSocketKey + WS_GUID).digest("base64");
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function createConnection(socket: Socket): WSConnection {
  const id = randomUUID();
  let buffer: Buffer = Buffer.alloc(0);
  let closed = false;
  let closeEmitted = false;
  let fragmentOpcode = OP_CONTINUATION;
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  const messageHandlers: Array<(text: string) => void> = [];
  const closeHandlers: Array<() => void> = [];

  const emitClose = (): void => {
    if (closeEmitted) return;
    closeEmitted = true;
    closed = true;
    for (const handler of closeHandlers) {
      try {
        handler();
      } catch (err) {
        console.error("[ws] close handler failed:", err);
      }
    }
  };

  const writeRaw = (frame: Buffer): void => {
    if (closed || !socket.writable) return;
    socket.write(frame);
  };

  const send = (text: string): void => {
    writeRaw(encodeFrame(OP_TEXT, Buffer.from(text, "utf8")));
  };

  const sendClose = (code: number, reason: string): void => {
    const reasonBuf = Buffer.from(reason, "utf8");
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    writeRaw(encodeFrame(OP_CLOSE, payload));
  };

  const close = (code = 1000, reason = ""): void => {
    if (closed) return;
    sendClose(code, reason);
    closed = true;
    socket.end();
  };

  const fail = (code: number, reason: string): void => {
    sendClose(code, reason);
    closed = true;
    socket.destroy();
    emitClose();
  };

  const handleFrame = (fin: boolean, opcode: number, payload: Buffer): void => {
    if (opcode === OP_CLOSE) {
      sendClose(1000, "");
      closed = true;
      socket.end();
      return;
    }
    if (opcode === OP_PING) {
      writeRaw(encodeFrame(OP_PONG, payload));
      return;
    }
    if (opcode === OP_PONG) return;

    if (opcode === OP_CONTINUATION) {
      if (fragmentOpcode === OP_CONTINUATION) {
        fail(1002, "unexpected continuation");
        return;
      }
      fragmentBytes += payload.length;
    } else if (opcode === OP_TEXT || opcode === OP_BINARY) {
      fragmentOpcode = opcode;
      fragments = [];
      fragmentBytes = payload.length;
    } else {
      fail(1002, "unsupported opcode");
      return;
    }
    if (fragmentBytes > MAX_MESSAGE_BYTES) {
      fail(1009, "message too big");
      return;
    }
    fragments.push(payload);
    if (!fin) return;

    const full = Buffer.concat(fragments, fragmentBytes);
    fragments = [];
    const wasText = fragmentOpcode === OP_TEXT;
    fragmentOpcode = OP_CONTINUATION;
    fragmentBytes = 0;
    if (!wasText) return;
    const text = full.toString("utf8");
    for (const handler of messageHandlers) {
      try {
        handler(text);
      } catch (err) {
        console.error("[ws] message handler failed:", err);
      }
    }
  };

  const parse = (): void => {
    while (buffer.length >= 2) {
      const byte0 = buffer[0]!;
      const byte1 = buffer[1]!;
      const fin = (byte0 & 0x80) !== 0;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let length = byte1 & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        const big = buffer.readBigUInt64BE(offset);
        if (big > BigInt(MAX_MESSAGE_BYTES)) {
          fail(1009, "message too big");
          return;
        }
        length = Number(big);
        offset += 8;
      }

      let maskKey: Buffer | null = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;

      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);

      if (maskKey) {
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] = payload[i]! ^ maskKey[i & 3]!;
        }
      }

      handleFrame(fin, opcode, payload);
      if (closed) return;
    }
  };

  socket.on("data", (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    parse();
  });
  socket.on("close", emitClose);
  socket.on("end", emitClose);
  socket.on("error", () => emitClose());

  return {
    id,
    send,
    close,
    onMessage: (handler) => messageHandlers.push(handler),
    onClose: (handler) => closeHandlers.push(handler),
  };
}

export function attachWebSocket(
  server: Server,
  onConnection: (connection: WSConnection, request: IncomingMessage) => void,
  path = "/ws",
): void {
  server.on("upgrade", (request, rawSocket, head) => {
    const socket = rawSocket as Socket;
    const url = request.url ?? "";
    const pathname = url.split("?")[0];
    const key = request.headers["sec-websocket-key"];
    const upgrade = String(request.headers.upgrade ?? "").toLowerCase();

    if (upgrade !== "websocket" || typeof key !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    if (pathname !== path) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    if (head.length > 0) {
      // 早期データはない想定だが、あれば破棄せず接続前に流し込めないため閉じる
      socket.destroy();
      return;
    }

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${computeAcceptKey(key)}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    socket.setTimeout(0);
    onConnection(createConnection(socket), request);
  });
}
