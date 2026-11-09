import Database from "better-sqlite3";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { AccessClientInfo } from "./access-info.js";

export type Host = {
  id: string;
  name: string;
  lastSeenAt: number | null;
  dshStatus: "online" | "offline";
  online: boolean;
  createdAt: number;
};

export type AccessSession = AccessClientInfo & {
  id: string;
  startedAt: number;
  lastSeenAt: number;
  expiresAt: number;
  status: "active" | "expired" | "ended";
};

export type AdminStats = {
  generatedAt: number;
  hosts: { total: number; online: number; dshOnline: number };
  sessions: {
    active: number;
    last24h: number;
    last7d: number;
    last30d: number;
  };
  daily: Array<{ day: string; sessions: number }>;
  recentSessions: Array<{
    id: string;
    hostName: string;
    platform: string;
    startedAt: number;
    lastSeenAt: number;
    status: "active" | "expired" | "ended";
  }>;
};

const PAIR_TTL_MS = Number(process.env.PAIR_TTL_MS ?? 120_000);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashClaim(claimToken: string): string {
  const decoded = Buffer.from(claimToken, "base64url");
  if (decoded.toString("base64url") !== claimToken || decoded.length !== 32) {
    throw new Error("invalid_claim_token");
  }
  return createHash("sha256").update(decoded).digest("hex");
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("hex")}`;
}

export class Store {
  readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host_token_hash TEXT,
        last_seen_at INTEGER,
        dsh_status TEXT NOT NULL DEFAULT 'offline',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pair_sessions (
        id TEXT PRIMARY KEY,
        host_name TEXT NOT NULL,
        claim_token_hash TEXT NOT NULL,
        confirm_secret_hash TEXT NOT NULL,
        host_id TEXT,
        client_id TEXT,
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS client_tokens (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        device_label TEXT NOT NULL,
        platform TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS access_sessions (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        client_id TEXT,
        device_label TEXT NOT NULL,
        platform TEXT NOT NULL,
        os_version TEXT,
        started_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ended_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS access_sessions_host_started ON access_sessions(host_id, started_at DESC);
    `);
    this.cleanupExpired();
  }

  close() {
    this.db.close();
  }

  createPairSession(
    claimTokenHash: string,
    hostName: string,
  ): { pairId: string; confirmSecret: string; expiresAt: number } {
    if (!/^[a-f0-9]{64}$/.test(claimTokenHash)) {
      throw new Error("invalid_claim_hash");
    }
    const pairId = randomId("pair");
    const confirmSecret = randomBytes(32).toString("hex");
    const now = Date.now();
    const expiresAt = now + PAIR_TTL_MS;
    this.db
      .prepare(
        "INSERT INTO pair_sessions VALUES (?, ?, ?, ?, NULL, NULL, ?, 0, ?)",
      )
      .run(
        pairId,
        hostName || "DSH Computer",
        claimTokenHash,
        hash(confirmSecret),
        expiresAt,
        now,
      );
    return { pairId, confirmSecret, expiresAt };
  }

  claimPair(
    pairId: string,
    claimToken: string,
    info: AccessClientInfo,
  ):
    | { hostId: string; hostName: string; clientToken: string }
    | "expired"
    | "used"
    | "mismatch"
    | "invalid" {
    let claimHash: string;
    try {
      claimHash = hashClaim(claimToken);
    } catch {
      return "invalid";
    }
    const row = this.db
      .prepare("SELECT * FROM pair_sessions WHERE id = ?")
      .get(pairId) as any;
    if (!row) return "invalid";
    if (row.used || row.client_id) return "used";
    if (row.expires_at < Date.now()) return "expired";
    const expected = Buffer.from(row.claim_token_hash, "hex");
    const received = Buffer.from(claimHash, "hex");
    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    )
      return "mismatch";
    const hostId = randomId("host");
    const clientId = randomId("client");
    const clientToken = randomBytes(32).toString("hex");
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO hosts VALUES (?, ?, NULL, NULL, 'offline', ?)",
        )
        .run(hostId, row.host_name, now);
      this.db
        .prepare(
          "INSERT INTO client_tokens VALUES (?, ?, ?, ?, ?, ?, NULL)",
        )
        .run(
          clientId,
          hostId,
          hash(clientToken),
          info.deviceLabel,
          info.platform,
          now,
        );
      this.db
        .prepare(
          "UPDATE pair_sessions SET host_id = ?, client_id = ? WHERE id = ?",
        )
        .run(hostId, clientId, pairId);
    });
    tx();
    return { hostId, hostName: row.host_name, clientToken };
  }

  confirmPair(
    pairId: string,
    confirmSecret: string,
  ): { hostId: string; hostToken: string } | "pending" | "expired" | null {
    const row = this.db
      .prepare("SELECT * FROM pair_sessions WHERE id = ?")
      .get(pairId) as any;
    if (!row || hash(confirmSecret) !== row.confirm_secret_hash) return null;
    if (row.used) return null;
    if (row.expires_at < Date.now()) return "expired";
    if (!row.host_id || !row.client_id) return "pending";
    const hostToken = randomBytes(32).toString("hex");
    const tx = this.db.transaction(() => {
      this.db
        .prepare("UPDATE hosts SET host_token_hash = ? WHERE id = ?")
        .run(hash(hostToken), row.host_id);
      this.db
        .prepare("UPDATE pair_sessions SET used = 1 WHERE id = ?")
        .run(pairId);
    });
    tx();
    return { hostId: row.host_id, hostToken };
  }

  /** Look without consuming: state check for the /pair/wait long poll */
  peekPair(
    pairId: string,
    confirmSecret: string,
  ): "pending" | "claimed" | "expired" | "used" | null {
    const row = this.db
      .prepare("SELECT * FROM pair_sessions WHERE id = ?")
      .get(pairId) as any;
    if (!row || hash(confirmSecret) !== row.confirm_secret_hash) return null;
    if (row.used) return "used";
    if (row.expires_at < Date.now()) return "expired";
    return row.host_id && row.client_id ? "claimed" : "pending";
  }

  host(id: string): any {
    return this.db.prepare("SELECT * FROM hosts WHERE id = ?").get(id);
  }

  findHostByToken(id: string, token: string): any {
    const row = this.host(id);
    return row && row.host_token_hash && row.host_token_hash === hash(token)
      ? row
      : null;
  }

  findClientByToken(token: string): {
    id: string;
    hostId: string;
    deviceLabel: string;
    platform: string;
  } | null {
    const row = this.db
      .prepare(
        "SELECT id, host_id hostId, device_label deviceLabel, platform FROM client_tokens WHERE token_hash = ? AND revoked_at IS NULL",
      )
      .get(hash(token)) as any;
    return row ?? null;
  }

  revokeClientTokens(hostId: string): string[] {
    const ids = (
      this.db
        .prepare(
          "SELECT id FROM client_tokens WHERE host_id = ? AND revoked_at IS NULL",
        )
        .all(hostId) as Array<{ id: string }>
    ).map((row) => row.id);
    this.db
      .prepare(
        "UPDATE client_tokens SET revoked_at = ? WHERE host_id = ? AND revoked_at IS NULL",
      )
      .run(Date.now(), hostId);
    return ids;
  }

  updateStatus(
    id: string,
    status: "online" | "offline",
    dsh: "online" | "offline",
  ) {
    this.db
      .prepare(
        "UPDATE hosts SET last_seen_at = ?, dsh_status = ? WHERE id = ?",
      )
      .run(status === "online" ? Date.now() : null, dsh, id);
  }

  unbind(id: string, hostToken: string): boolean {
    if (!this.findHostByToken(id, hostToken)) return false;
    this.revokeClientTokens(id);
    this.db
      .prepare(
        "UPDATE access_sessions SET ended_reason = 'unbound' WHERE host_id = ? AND ended_reason IS NULL",
      )
      .run(id);
    this.db
      .prepare("UPDATE hosts SET host_token_hash = NULL WHERE id = ?")
      .run(id);
    return true;
  }

  createAccessSession(
    hostId: string,
    clientId: string | null,
    info: AccessClientInfo,
    expiresAt: number,
    id = `access_${randomUUID()}`,
  ): string {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO access_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(
        id,
        hostId,
        clientId,
        info.deviceLabel,
        info.platform,
        info.osVersion,
        now,
        now,
        expiresAt,
      );
    this.db
      .prepare("DELETE FROM access_sessions WHERE started_at < ?")
      .run(now - 30 * 86400_000);
    this.db
      .prepare(
        "DELETE FROM access_sessions WHERE host_id = ? AND id NOT IN (SELECT id FROM access_sessions WHERE host_id = ? ORDER BY started_at DESC LIMIT 500)",
      )
      .run(hostId, hostId);
    return id;
  }

  touchAccessSession(id: string, hostId: string) {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE access_sessions SET last_seen_at = ? WHERE id = ? AND host_id = ? AND ended_reason IS NULL AND expires_at > ? AND last_seen_at <= ?",
      )
      .run(now, id, hostId, now, now - 60_000);
  }

  endAccessSession(id: string, reason: string) {
    this.db
      .prepare(
        "UPDATE access_sessions SET ended_reason = ?, last_seen_at = ? WHERE id = ? AND ended_reason IS NULL",
      )
      .run(reason.slice(0, 100), Date.now(), id);
  }

  listAccessSessions(hostId: string, limit: number): AccessSession[] {
    const now = Date.now();
    const rows = this.db
      .prepare(
        "SELECT id, device_label deviceLabel, platform, os_version osVersion, started_at startedAt, last_seen_at lastSeenAt, expires_at expiresAt, ended_reason endedReason FROM access_sessions WHERE host_id = ? ORDER BY started_at DESC LIMIT ?",
      )
      .all(hostId, limit) as any[];
    return rows.map(({ endedReason, ...row }) => ({
      ...row,
      status: endedReason ? "ended" : row.expiresAt <= now ? "expired" : "active",
    }));
  }

  adminStats(now = Date.now()): AdminStats {
    const count = (sql: string, ...params: unknown[]) =>
      Number((this.db.prepare(sql).get(...params) as { value: number }).value);
    const since24h = now - 86400_000;
    const since7d = now - 7 * 86400_000;
    const since30d = now - 30 * 86400_000;
    const startDay = new Date(since30d);
    startDay.setUTCHours(0, 0, 0, 0);
    const sessionRows = this.db
      .prepare(
        "SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') day, COUNT(*) value FROM access_sessions WHERE started_at >= ? GROUP BY day",
      )
      .all(startDay.getTime()) as Array<{ day: string; value: number }>;
    const sessionsByDay = new Map(
      sessionRows.map((row) => [row.day, row.value]),
    );
    const daily: AdminStats["daily"] = [];
    for (let offset = 29; offset >= 0; offset -= 1) {
      const date = new Date(now - offset * 86400_000);
      const day = date.toISOString().slice(0, 10);
      daily.push({
        day,
        sessions: sessionsByDay.get(day) ?? 0,
      });
    }
    const recent = this.db
      .prepare(
        `SELECT s.id, h.name hostName, s.platform,
                s.started_at startedAt, s.last_seen_at lastSeenAt,
                s.expires_at expiresAt, s.ended_reason endedReason
           FROM access_sessions s
           JOIN hosts h ON h.id = s.host_id
          ORDER BY s.started_at DESC
          LIMIT 50`,
      )
      .all() as Array<{
      id: string;
      hostName: string;
      platform: string;
      startedAt: number;
      lastSeenAt: number;
      expiresAt: number;
      endedReason: string | null;
    }>;
    return {
      generatedAt: now,
      hosts: {
        total: count("SELECT COUNT(*) value FROM hosts"),
        online: count(
          "SELECT COUNT(*) value FROM hosts WHERE last_seen_at IS NOT NULL",
        ),
        dshOnline: count(
          "SELECT COUNT(*) value FROM hosts WHERE dsh_status = 'online'",
        ),
      },
      sessions: {
        active: count(
          "SELECT COUNT(*) value FROM access_sessions WHERE ended_reason IS NULL AND expires_at > ?",
          now,
        ),
        last24h: count(
          "SELECT COUNT(*) value FROM access_sessions WHERE started_at >= ?",
          since24h,
        ),
        last7d: count(
          "SELECT COUNT(*) value FROM access_sessions WHERE started_at >= ?",
          since7d,
        ),
        last30d: count(
          "SELECT COUNT(*) value FROM access_sessions WHERE started_at >= ?",
          since30d,
        ),
      },
      daily,
      recentSessions: recent.map(({ expiresAt, endedReason, ...row }) => ({
        ...row,
        status: endedReason ? "ended" : expiresAt <= now ? "expired" : "active",
      })),
    };
  }

  addEvent(hostId: string, kind: string) {
    this.db
      .prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), hostId, kind, "{}", Date.now());
    this.db
      .prepare(
        "DELETE FROM events WHERE host_id = ? AND id NOT IN (SELECT id FROM events WHERE host_id = ? ORDER BY created_at DESC LIMIT 50)",
      )
      .run(hostId, hostId);
  }

  cleanupExpired(now = Date.now()) {
    const cleanup = this.db.transaction(() => ({
      pairSessions: this.db
        .prepare(
          "DELETE FROM pair_sessions WHERE expires_at < ? OR (used = 1 AND created_at < ?)",
        )
        .run(now, now - 5 * 60_000).changes,
      accessSessions: this.db
        .prepare("DELETE FROM access_sessions WHERE started_at < ?")
        .run(now - 30 * 86400_000).changes,
      events: this.db
        .prepare("DELETE FROM events WHERE created_at < ?")
        .run(now - 30 * 86400_000).changes,
    }));
    return cleanup();
  }
}
