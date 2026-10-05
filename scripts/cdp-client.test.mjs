// Tests for cli/src/cdpClient.ts against a mock CDP WebSocket server.
// Run on Node 18/20 the client uses its own RFC 6455 framing; the test also
// forces that path on newer Node by hiding the global WebSocket.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

delete globalThis.WebSocket;
const { CdpConnection, CdpTab } = await import("../dist/cdpClient.js");

function frame(opcode, payload, fin = true) {
  const len = payload.length;
  const head =
    len < 126
      ? Buffer.from([(fin ? 0x80 : 0) | opcode, len])
      : len < 65536
        ? Buffer.from([(fin ? 0x80 : 0) | opcode, 126, len >> 8, len & 0xff])
        : (() => {
            const h = Buffer.alloc(10);
            h[0] = (fin ? 0x80 : 0) | opcode;
            h[1] = 127;
            h.writeBigUInt64BE(BigInt(len), 2);
            return h;
          })();
  return Buffer.concat([head, payload]);
}

function startMock(handler) {
  const server = createServer((req, res) => {
    if (req.url === "/json/version") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/x` }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        assert.ok(buf[1] & 0x80, "client frames must be masked");
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const data = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i % 4]);
        buf = buf.subarray(off + 4 + len);
        if (opcode === 0x1) handler(JSON.parse(Buffer.from(data).toString("utf8")), socket);
        if (opcode === 0xa) socket.emit("pong-received");
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const reply = (socket, msg) => socket.write(frame(0x1, Buffer.from(JSON.stringify(msg))));
let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

await test("request/response, events ignored, large (64-bit length) reply", async () => {
  const big = "y".repeat(70_000);
  const server = await startMock((msg, socket) => {
    reply(socket, { method: "Target.targetCreated", params: {} });
    reply(socket, { id: msg.id, result: { echo: msg.method, big: msg.method === "Big" ? big : undefined } });
  });
  const conn = await CdpConnection.connect(server.address().port);
  assert.equal((await conn.send("Ping")).echo, "Ping");
  assert.equal((await conn.send("Big")).big.length, 70_000);
  conn.close();
  server.close();
});

await test("fragmented messages and server pings", async () => {
  let pongs = 0;
  const server = await startMock((msg, socket) => {
    socket.once("pong-received", () => pongs++);
    socket.write(frame(0x9, Buffer.from("hi")));
    const text = Buffer.from(JSON.stringify({ id: msg.id, result: { ok: true } }));
    socket.write(frame(0x1, text.subarray(0, 5), false));
    socket.write(frame(0x0, text.subarray(5), true));
  });
  const conn = await CdpConnection.connect(server.address().port);
  assert.equal((await conn.send("Frag")).ok, true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pongs, 1, "a ping is answered with a pong");
  conn.close();
  server.close();
});

await test("CDP errors reject; a dropped socket rejects pending calls", async () => {
  const server = await startMock((msg, socket) => {
    if (msg.method === "Fail") reply(socket, { id: msg.id, error: { message: "No target" } });
    if (msg.method === "Hang") socket.destroy();
  });
  const conn = await CdpConnection.connect(server.address().port);
  await assert.rejects(conn.send("Fail"), /No target/);
  await assert.rejects(conn.send("Hang"), /connection lost/);
  await assert.rejects(conn.send("After"), /connection lost/);
  server.close();
});

await test("calls time out instead of hanging", async () => {
  const server = await startMock(() => {});
  const conn = await CdpConnection.connect(server.address().port);
  await assert.rejects(conn.send("Silent", {}, undefined, 200), /timed out/);
  conn.close();
  server.close();
});

await test("tabs open in the background, evaluate, and retry across a navigation", async () => {
  const calls = [];
  let evals = 0;
  const server = await startMock((msg, socket) => {
    calls.push(msg);
    if (msg.method === "Target.createTarget") return reply(socket, { id: msg.id, result: { targetId: "T1" } });
    if (msg.method === "Target.attachToTarget") return reply(socket, { id: msg.id, result: { sessionId: "S1" } });
    if (msg.method === "Runtime.evaluate") {
      evals++;
      if (evals === 1) return reply(socket, { id: msg.id, error: { message: "Execution context was destroyed." } });
      return reply(socket, { id: msg.id, result: { result: { value: 42 } } });
    }
    if (msg.method === "Target.closeTarget") return reply(socket, { id: msg.id, result: { success: true } });
  });
  const conn = await CdpConnection.connect(server.address().port);
  const tab = await CdpTab.openBackground(conn, "https://example.com");
  assert.equal(await tab.evaluate("6*7"), 42);
  await tab.close();
  const created = calls.find((c) => c.method === "Target.createTarget");
  assert.equal(created.params.background, true, "never activates the tab");
  assert.equal(calls.find((c) => c.method === "Runtime.evaluate").sessionId, "S1", "evaluates only in its own tab");
  conn.close();
  server.close();
});

await test("a stalled handshake times out and closes its socket", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/x` }));
  });
  let upgradeClosed = false;
  // Accept the upgrade, never answer it.
  server.on("upgrade", (_req, socket) => socket.on("end", () => { upgradeClosed = true; }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await assert.rejects(CdpConnection.connect(server.address().port, 300), /timed out/);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(upgradeClosed, "the timed-out handshake must not leave its socket open");
  server.close();
});

console.log(`${passed} passing`);
// Mock servers keep idle sockets open; the result is in, so leave.
process.exit(0);
