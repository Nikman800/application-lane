// The command line's live line to the extension, through the backend
// (src/server/live.ts): commands out, the extension's queue in.
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { QueueSnapshot } from "../src/shared/model";

// The live line to the extension, through the backend (src/server/live.ts).
// Kept (the full-screen view): a line the backend dropped, restarted or not
// yet back, is opened again every two seconds. The view showed the queue of
// the moment the backend restarted, and nothing after.
export async function liveLine(
  url: string,
  token: () => Promise<string>,
  base: string,
  onQueue?: (queue: QueueSnapshot) => void,
  keep?: { onDown: () => void; onUp: () => void },
  retryMs = 2000,
) {
  const results = new Map<string, (result: { ok: boolean; error?: string; detail?: string }) => void>();
  let socket!: WebSocket;
  let closing = false;
  const open = async () => {
    const credential = await token();
    return new Promise<void>((resolve, reject) => {
      const next = new WebSocket(url, { handshakeTimeout: 4000 });
      const timer = setTimeout(() => {
        next.terminate();
        reject(new Error("The backend did not authenticate the connection."));
      }, 5000);
      next.once("error", () => {
        clearTimeout(timer);
        reject(new Error(`The backend is not running at ${base}. Start it with npm start in the project folder (or application-lane if installed), and keep that window open.`));
      });
      next.once("open", () => next.send(JSON.stringify({ type: "auth", token: credential })));
      next.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.type === "ready") {
          clearTimeout(timer);
          socket = next;
          resolve();
        }
        if (message.type === "queue" && onQueue) onQueue(message.snapshot);
        if (message.type === "result") results.get(message.id)?.(message);
      });
      next.once("close", () => {
        clearTimeout(timer);
        if (socket !== next) {
          reject(new Error("The backend closed the connection before authenticating it."));
          return;
        }
        for (const result of results.values()) result({ ok: false, error: "The backend disconnected before the command finished." });
        if (closing || !keep) return;
        keep.onDown();
        const retry = () => setTimeout(() => {
          if (!closing) void open().then(keep.onUp, retry);
        }, retryMs);
        retry();
      });
    });
  };
  await open();
  const send = (action: string, applicationId?: string, data?: string) =>
    new Promise<{ ok: boolean; error?: string; detail?: string }>((resolve) => {
      if (socket.readyState !== socket.OPEN) return resolve({ ok: false, error: "The backend is not answering. Reconnecting…" });
      const id = randomUUID();
      const timer = setTimeout(() => {
        results.delete(id);
        resolve({ ok: false, error: "The extension did not answer. Is Chrome open with Application Lane?" });
      }, 15_000);
      results.set(id, (result) => {
        clearTimeout(timer);
        results.delete(id);
        resolve(result);
      });
      socket.send(JSON.stringify({ type: "command", id, action, applicationId, ...(data ? { data } : {}) }), (error) => {
        if (error) results.get(id)?.({ ok: false, error: error.message });
      });
    });
  return {
    get socket() {
      return socket;
    },
    send,
    close() {
      closing = true;
      socket.close();
    },
  };
}
