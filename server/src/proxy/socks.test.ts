/**
 * ZcodeKnight — Black Knight Gateway
 * 作者 Author: YU123-ZZZ — https://github.com/YU123-ZZZ
 *
 * socks.ts tests — the two tunnel builders against in-process mock servers,
 * plus the egress classifier. These prove the handshake bytes, auth flow and
 * failure mapping WITHOUT a real proxy (the ones on the market answer with
 * whatever the operator configured; a mock lets us assert exact frames).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import net from "node:net";
import { socksConnect, httpConnect } from "./socks.js";
import { applyNetworkProxy, egressFor, resetProxyStateForTest } from "./network-proxy.js";

/** Minimal SOCKS5 server: greeting → (optional auth) → CONNECT reply → echo pipe. */
function startMockSocks(opts: { requireAuth?: boolean; rejectAuth?: boolean; refuseConnect?: boolean } = {}): Promise<{ port: number; close: () => void; lastAuthUser: string }> {
  let lastAuthUser = "";
  const server = net.createServer((client) => {
    client.once("data", (greet) => {
      // Must offer no-auth when we don't demand it, and user/pass when we do.
      if (opts.requireAuth && !greet.includes(0x02)) { client.destroy(); return; }
      if (!opts.requireAuth && greet[0] !== 0x05) { client.destroy(); return; }
      client.write(Buffer.from([0x05, opts.requireAuth ? 0x02 : 0x00]));
      if (opts.requireAuth) {
        client.once("data", (auth) => {
          const ulen = auth[1];
          lastAuthUser = auth.subarray(2, 2 + ulen).toString("utf-8");
          client.write(Buffer.from([0x01, opts.rejectAuth ? 0x01 : 0x00]));
          client.once("data", (req) => handleConnect(req));
        });
      } else {
        client.once("data", (req) => handleConnect(req));
      }
    });
    function handleConnect(req: Buffer): void {
      if (opts.refuseConnect) {
        client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.end();
        return;
      }
      // Success reply (IPv4 bound addr) then echo everything back — the test
      // dials a destination that is THIS server again, so the payload loop
      // comes straight back.
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
      client.pipe(client);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => server.close(), lastAuthUser: () => lastAuthUser });
    });
  });
}

describe("socks5 tunnel", () => {
  it("connects without auth and pipes the destination payload", async () => {
    const mock = await startMockSocks();
    const echo = net.createServer((c) => c.pipe(c));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    const echoPort = (echo.address() as { port: number }).port;

    const sock = await socksConnect(`socks5://127.0.0.1:${mock.port}`, "127.0.0.1", echoPort);
    const reply = await new Promise<Buffer>((resolve) => {
      sock.once("data", resolve);
      sock.write("ping-through-socks");
    });
    expect(reply.toString()).toContain("ping-through-socks");
    sock.destroy(); echo.close(); mock.close();
  });

  it("performs username/password auth when the proxy demands it", async () => {
    const mock = await startMockSocks({ requireAuth: true });
    const echo = net.createServer((c) => c.pipe(c));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    const echoPort = (echo.address() as { port: number }).port;

    const sock = await socksConnect(`socks5://alice:secret@127.0.0.1:${mock.port}`, "127.0.0.1", echoPort);
    sock.write("authed-ping");
    const reply = await new Promise<Buffer>((resolve) => {
      sock.once("data", resolve);
    });
    expect(reply.toString()).toContain("authed-ping");
    sock.destroy(); echo.close(); mock.close();
  });

  it("surfaces a refused CONNECT with the socks reply code", async () => {
    const mock = await startMockSocks({ refuseConnect: true });
    await expect(socksConnect(`socks5://127.0.0.1:${mock.port}`, "127.0.0.1", 1)).rejects.toThrow(/connection refused by destination|CONNECT failed/i);
    mock.close();
  });
});

describe("http CONNECT tunnel", () => {
  it("tunnels through a 200-answering proxy", async () => {
    const echo = net.createServer((c) => c.pipe(c));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    const echoPort = (echo.address() as { port: number }).port;
    const proxy = net.createServer((client) => {
      client.once("data", (head) => {
        expect(head.toString()).toContain(`CONNECT 127.0.0.1:${echoPort}`);
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
        client.pipe(client);
      });
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const proxyPort = (proxy.address() as { port: number }).port;

    const sock = await httpConnect(`http://127.0.0.1:${proxyPort}`, "127.0.0.1", echoPort);
    sock.write("via-connect");
    const reply = await new Promise<Buffer>((resolve) => { sock.once("data", resolve); });
    expect(reply.toString()).toContain("via-connect");
    sock.destroy(); proxy.close(); echo.close();
  });
});

describe("egress classification", () => {
  beforeEach(() => resetProxyStateForTest());

  it("loopback destinations are always direct", async () => {
    await applyNetworkProxy({ enabled: true, url: "socks5://10.0.0.1:1080", noProxy: "" });
    expect(egressFor("http://127.0.0.1:17800/admin")).toEqual({ kind: "direct" });
    expect(egressFor("http://localhost/x")).toEqual({ kind: "direct" });
  });

  it("a socks egress classifies as socks; noProxy hosts are direct", async () => {
    await applyNetworkProxy({ enabled: true, url: "socks5://10.0.0.1:1080", noProxy: "example.com" });
    expect(egressFor("https://zcode.z.ai/v1")).toEqual({ kind: "socks", url: "socks5://10.0.0.1:1080" });
    expect(egressFor("https://example.com/api")).toEqual({ kind: "direct" });
  });

  it("an http egress classifies as http", async () => {
    await applyNetworkProxy({ enabled: true, url: "http://10.0.0.2:7890", noProxy: "" });
    expect(egressFor("https://zcode.z.ai/v1")).toEqual({ kind: "http", url: "http://10.0.0.2:7890" });
  });

  it("disabled or absent proxy is direct", async () => {
    await applyNetworkProxy({ enabled: false, url: "http://10.0.0.2:7890", noProxy: "" });
    expect(egressFor("https://zcode.z.ai/v1")).toEqual({ kind: "direct" });
  });
});
