import { DurableObject } from "cloudflare:workers";

const DEFAULT_STATE = {
  slideIndex: 0,
  slideCount: 0,
  notes: "",
  updatedAt: 0,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/session/new") {
      return json({ session: createSessionCode() });
    }

    if (url.pathname === "/api/session/status") {
      const session = normalizeSession(url.searchParams.get("session"));
      if (!session) {
        return json({ error: "Missing or invalid session." }, { status: 400 });
      }

      const id = env.REMOTE_ROOM.idFromName(session);
      return env.REMOTE_ROOM.get(id).fetch("https://remote-room/status");
    }

    if (url.pathname === "/api/ws") {
      const session = normalizeSession(url.searchParams.get("session"));
      const role = normalizeRole(url.searchParams.get("role"));

      if (!session || !role) {
        return json({ error: "Missing or invalid session or role." }, { status: 400 });
      }

      const id = env.REMOTE_ROOM.idFromName(session);
      return env.REMOTE_ROOM.get(id).fetch(request);
    }

    if (isSessionPath(url.pathname)) {
      return env.ASSETS.fetch(new Request("https://assets.local/", request));
    }

    if (url.pathname === "/") {
      return env.ASSETS.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

export class RemoteRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.state = { ...DEFAULT_STATE };
    this.presenterId = null;

    this.ctx.blockConcurrencyWhile(async () => {
      const storedState = await this.ctx.storage.get("state");
      if (storedState) {
        this.state = { ...DEFAULT_STATE, ...storedState };
      }

      for (const ws of this.ctx.getWebSockets()) {
        const meta = ws.deserializeAttachment() || {};
        if (meta.role === "presenter") {
          this.presenterId = meta.id;
        }
      }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") !== "websocket") {
      if (url.pathname === "/status") {
        return json(this.getStatus());
      }

      return json({ error: "Expected websocket upgrade." }, { status: 426 });
    }

    const session = normalizeSession(url.searchParams.get("session"));
    const role = normalizeRole(url.searchParams.get("role"));

    if (!session || !role) {
      return json({ error: "Missing or invalid session or role." }, { status: 400 });
    }

    if (this.hasLiveRole(role)) {
      return json(
        { error: role === "remote" ? "Remote already connected." : "Presenter already connected." },
        { status: 409 },
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID();
    server.serializeAttachment({ id, role, session });
    this.ctx.acceptWebSocket(server);

    if (role === "presenter") {
      this.presenterId = id;
    }

    this.send(server, {
      type: "state",
      state: this.state,
      presenterConnected: Boolean(this.presenterId),
    });
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, rawMessage) {
    let message;

    try {
      message = JSON.parse(rawMessage);
    } catch {
      this.send(ws, { type: "error", message: "Invalid JSON payload." });
      return;
    }

    const meta = ws.deserializeAttachment() || {};

    if (message.type === "hello") {
      this.send(ws, {
        type: "state",
        state: this.state,
        presenterConnected: Boolean(this.presenterId),
      });
      return;
    }

    if (message.type === "state" && meta.role === "presenter") {
      this.state = sanitizeState(message.state);
      await this.ctx.storage.put("state", this.state);
      this.broadcast({
        type: "state",
        state: this.state,
        presenterConnected: true,
      });
      return;
    }

    if (message.type === "control" && meta.role === "remote") {
      this.forwardControl(message);
      return;
    }
  }

  webSocketClose(ws) {
    this.handleDisconnect(ws);
  }

  webSocketError(ws) {
    this.handleDisconnect(ws);
  }

  handleDisconnect(ws) {
    const meta = ws.deserializeAttachment() || {};
    if (meta.id && meta.id === this.presenterId) {
      this.presenterId = null;
    }
    this.broadcastPresence();
  }

  forwardControl(message) {
    const payload = {
      type: "control",
      action: message.action,
      index: Number.isFinite(message.index) ? message.index : null,
    };

    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() || {};
      if (meta.id === this.presenterId) {
        this.send(ws, payload);
      }
    }
  }

  broadcastPresence() {
    this.broadcast({
      type: "presence",
      presenterConnected: Boolean(this.presenterId),
      remoteConnected: this.hasLiveRole("remote"),
    });
  }

  hasLiveRole(role) {
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() || {};
      if (meta.role === role) {
        return true;
      }
    }

    return false;
  }

  getStatus() {
    return {
      presenterConnected: this.hasLiveRole("presenter"),
      remoteConnected: this.hasLiveRole("remote"),
      slideIndex: this.state.slideIndex,
      slideCount: this.state.slideCount,
      updatedAt: this.state.updatedAt,
    };
  }

  broadcast(payload) {
    const encoded = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(encoded);
      } catch {}
    }
  }

  send(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {}
  }
}

function createSessionCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let output = "";
  for (const byte of bytes) {
    output += alphabet[byte % alphabet.length];
  }
  return output;
}

function normalizeSession(value) {
  if (!value) return null;
  const session = String(value).trim().toUpperCase();
  return /^[A-Z2-9]{6}$/.test(session) ? session : null;
}

function normalizeRole(value) {
  return value === "presenter" || value === "remote" ? value : null;
}

function isSessionPath(pathname) {
  return /^\/[A-Z2-9]{6}$/i.test(pathname);
}


function sanitizeState(input) {
  const slideCount = Number.isFinite(input?.slideCount) ? Math.max(0, input.slideCount) : 0;
  const maxIndex = Math.max(0, slideCount - 1);
  const slideIndex = Number.isFinite(input?.slideIndex)
    ? Math.max(0, Math.min(maxIndex, input.slideIndex))
    : 0;

  return {
    slideIndex,
    slideCount,
    notes: typeof input?.notes === "string" ? input.notes.slice(0, 4000) : "",
    updatedAt: Date.now(),
  };
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}
