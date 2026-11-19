// A live line between the extension and the command line (scripts/lane.ts):
// the command line's "fill this step" and "switch to its tab" reach the
// extension at once, and the extension's queue reaches the command line as
// it changes. The extension holds its end open, which also keeps
// Chrome from putting its background worker to sleep, so nothing waits for a
// 30-second wake-up.
//
// The same rules as the HTTP API: a loopback host, no page origin (only the
// paired extension's, or none from the command line), and the token, sent as
// the first message since a browser socket cannot set headers.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "./store";

type Role = "extension" | "cli";
type Peer = { socket: WebSocket; role: Role; applications?: Set<string>; queueAt?: number };

const sameToken = (actual: string, expected: string) =>
  actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));

export function attachLive(server: Server, config: Config) {
  const live = new WebSocketServer({ noServer: true, maxPayload: 6 * 1024 * 1024 });
  const peers = new Set<Peer>();
  // The command a command-line client is waiting to hear back about.
  const waiting = new Map<string, Peer>();
  let latestQueue: unknown;
  // Two browsers can hold the paired extension (an applying profile and the
  // everyday one): a command goes to the one whose queue lists its
  // application, else to the one that sent its queue last. The first one
  // connected took every command, and after the applying profile's
  // extension reloaded, "No such application" came back for all of them.
  const commandTarget = (applicationId?: string) => {
    const open = [...peers].filter((other) => other.role === "extension" && other.socket.readyState === other.socket.OPEN);
    const recent = [...open].sort((a, b) => (b.applications?.size ? 1 : 0) - (a.applications?.size ? 1 : 0) || (b.queueAt ?? 0) - (a.queueAt ?? 0));
    return (applicationId && open.find((other) => other.applications?.has(applicationId))) || recent[0];
  };
  const send = (peer: Peer, message: unknown) => {
    if (peer.socket.readyState === peer.socket.OPEN) peer.socket.send(JSON.stringify(message));
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
    const origin = req.headers.origin;
    const refused =
      path !== "/v1/live" ||
      !/^127\.0\.0\.1:\d+$/.test(req.headers.host || "") ||
      (origin !== undefined && (!config.extensionId || origin !== `chrome-extension://${config.extensionId}`));
    if (refused) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    live.handleUpgrade(req, socket, head, (ws) => {
      // The extension's end comes from its origin; the command line's has none.
      const role: Role = origin ? "extension" : "cli";
      let peer: Peer | undefined;
      const unauthenticated = setTimeout(() => ws.close(4001, "Send the token first."), 5000);
      ws.on("message", (data) => {
        let message: { type?: string; [key: string]: unknown };
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        if (!peer) {
          if (message.type !== "auth" || typeof message.token !== "string" || !sameToken(message.token, config.token)) {
            ws.close(4003, "Wrong token.");
            return;
          }
          clearTimeout(unauthenticated);
          peer = { socket: ws, role };
          peers.add(peer);
          send(peer, { type: "ready", role, extension: [...peers].some((other) => other.role === "extension") });
          if (role === "cli" && latestQueue) send(peer, { type: "queue", snapshot: latestQueue });
          return;
        }
        if (message.type === "ping") return send(peer, { type: "pong" });
        if (peer.role === "extension") {
          // Its queue, for every command line watching.
          if (message.type === "queue") {
            latestQueue = message.snapshot;
            const listed = (message.snapshot as { applications?: { id?: unknown }[] } | undefined)?.applications;
            peer.applications = new Set((Array.isArray(listed) ? listed : []).flatMap((app) => (typeof app?.id === "string" ? [app.id] : [])));
            peer.queueAt = Date.now();
            for (const other of peers) if (other.role === "cli") send(other, message);
          }
          // How a command went, for the command line that sent it.
          if (message.type === "result" && typeof message.id === "string") {
            const asker = waiting.get(message.id);
            waiting.delete(message.id);
            if (asker) send(asker, message);
          }
          return;
        }
        // From the command line: a command for the extension.
        if (message.type === "command" && typeof message.id === "string" && message.id.length <= 100) {
          const extension = commandTarget(typeof message.applicationId === "string" ? message.applicationId : undefined);
          if (!extension)
            return send(peer, { type: "result", id: message.id, ok: false, error: "The extension is not connected. Open Chrome with Application Lane paired." });
          waiting.set(message.id, peer);
          send(extension, { type: "command", id: message.id, action: message.action, applicationId: message.applicationId, ...(typeof message.data === "string" && message.data.length <= 20_000 ? { data: message.data } : {}) });
        }
      });
      ws.on("close", () => {
        clearTimeout(unauthenticated);
        if (peer) peers.delete(peer);
        for (const [id, asker] of waiting) if (asker === peer) waiting.delete(id);
      });
      ws.on("error", () => {});
    });
  });
  return {
    live,
    // A command for the extension that no one waits on (links queued from
    // the command line: picked up now, not at the next minute's check). Says
    // whether an extension was there to hear it.
    tell(action: string) {
      const extensions = [...peers].filter((peer) => peer.role === "extension" && peer.socket.readyState === peer.socket.OPEN);
      for (const extension of extensions) send(extension, { type: "command", id: randomUUID(), action });
      return extensions.length > 0;
    },
  };
}
