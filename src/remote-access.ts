import { Config, saveConfig } from "./config.js";
import { qrSvg } from "./qr.js";
import { pairingLink, publicRelayOrigin } from "./pair-link.js";
import { RelayClient } from "./relay-client.js";
import { deriveClaimToken, generateMasterKey, hashClaimToken } from "./e2ee.js";
import { dshCompatibility } from "./dsh-compat.js";

type PairSession = {
  pairId: string;
  confirmSecret: string;
  expiresAt: number;
  masterKey: string;
};

export type PairingView = {
  expiresAt: number;
  qrPayload: string;
  qrSvg: string;
};

export type RemoteAccessState = {
  phase: "unpaired" | "pairing" | "paired";
  hostId: string | null;
  hostName: string;
  relay: string;
  dsh: "online" | "offline";
  relayConnection: "connected" | "connecting" | "offline";
  pairing: PairingView | null;
  dshVersion: string | null;
  dshCompatible: boolean;
  compatibilityMessage: string | null;
};

export type AccessSession = {
  id: string;
  deviceLabel: string;
  platform: "ios" | "android" | "other";
  osVersion: string | null;
  startedAt: number;
  lastSeenAt: number;
  expiresAt: number;
  status: "active" | "expired" | "ended";
};

type RelayConnection = {
  start(): Promise<void>;
  stop(): void;
  status(): { connected: boolean; dsh: boolean };
};

type Dependencies = {
  request: (url: string, data: unknown) => Promise<{ status: number; data: any }>;
  save: typeof saveConfig;
  createClient: (config: Config) => RelayConnection;
  probeDsh: (port: number) => Promise<boolean>;
  pollIntervalMs: number;
  requestAccessSessions: (config: Config) => Promise<AccessSession[]>;
  requestUnbind: (config: Config) => Promise<{ status: number; data: any }>;
};

async function post(url: string, data: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  return { status: response.status, data: (await response.json()) as any };
}

async function probeDsh(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function requestAccessSessions(config: Config) {
  if (!config.hostId || !config.hostToken) return [];
  const response = await fetch(
    `${config.relay}/host-management/${encodeURIComponent(config.hostId)}/access-sessions?limit=50`,
    {
      headers: { authorization: `Host ${config.hostToken}` },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) {
    throw new Error(`Relay rejected access log request (${response.status})`);
  }
  const body = (await response.json()) as { sessions?: AccessSession[] };
  return Array.isArray(body.sessions) ? body.sessions : [];
}

async function requestUnbind(config: Config) {
  const response = await fetch(
    `${config.relay}/host-management/${encodeURIComponent(config.hostId!)}/unbind`,
    {
      method: "POST",
      headers: { authorization: `Host ${config.hostToken}` },
      signal: AbortSignal.timeout(5000),
    },
  );
  return { status: response.status, data: (await response.json()) as any };
}

const defaults: Dependencies = {
  request: post,
  save: saveConfig,
  createClient: (config) => new RelayClient(config),
  probeDsh,
  pollIntervalMs: 2000,
  requestAccessSessions,
  requestUnbind,
};

export class RemoteAccessManager {
  private config: Config;
  private pairing?: PairSession;
  private client?: RelayConnection;
  private pollTimer?: NodeJS.Timeout;
  private disposed = false;
  private deps: Dependencies;

  constructor(config: Config, dependencies: Partial<Dependencies> = {}) {
    this.config = config;
    this.deps = { ...defaults, ...dependencies };
  }

  async initialize() {
    if (this.disposed) return;
    if (this.config.hostToken) await this.connect();
  }

  async state(): Promise<RemoteAccessState> {
    const clientStatus = this.client?.status();
    const dsh = clientStatus?.dsh ?? (await this.deps.probeDsh(this.config.dshPort));
    const compatibility = dshCompatibility();
    return {
      phase: this.pairing
        ? "pairing"
        : this.config.hostToken
          ? "paired"
          : "unpaired",
      hostId: this.config.hostId ?? null,
      hostName: this.config.hostName,
      relay: this.config.relay,
      dsh: dsh ? "online" : "offline",
      relayConnection: clientStatus?.connected
        ? "connected"
        : this.client
          ? "connecting"
          : "offline",
      pairing: this.pairing ? this.pairingView(this.pairing) : null,
      dshVersion: compatibility.detectedVersion,
      dshCompatible: compatibility.compatible,
      compatibilityMessage: compatibility.message,
    };
  }

  async startPairing(): Promise<RemoteAccessState> {
    const compatibility = dshCompatibility();
    if (compatibility.message && !compatibility.compatible) {
      throw new Error(compatibility.message);
    }
    if (!this.pairing) {
      const masterKey = generateMasterKey();
      const created = await this.deps.request(`${this.config.relay}/pair/session`, {
        claimTokenHash: hashClaimToken(deriveClaimToken(masterKey)),
        hostName: this.config.hostName,
      });
      if (created.status !== 201) {
        throw new Error(`Relay rejected pairing session (${created.status})`);
      }
      this.pairing = {
        pairId: created.data.pairId,
        confirmSecret: created.data.confirmSecret,
        expiresAt: created.data.expiresAt,
        masterKey,
      };
      this.schedulePoll(this.deps.pollIntervalMs);
    }
    return this.state();
  }

  async accessSessions(): Promise<AccessSession[]> {
    if (!this.config.hostToken || !this.config.hostId) return [];
    return this.deps.requestAccessSessions(this.config);
  }

  cancelPairing() {
    this.pairing = undefined;
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  async removePairing(): Promise<RemoteAccessState> {
    if (this.pairing) {
      this.cancelPairing();
      return this.state();
    }
    if (!this.config.hostId || !this.config.hostToken) return this.state();
    const unbound = await this.deps.requestUnbind(this.config);
    if (unbound.status !== 200) {
      throw new Error(`Relay rejected unbind request (${unbound.status})`);
    }
    this.client?.stop();
    this.client = undefined;
    this.config = {
      hostName: this.config.hostName,
      relay: this.config.relay,
      publicRelayUrl: this.config.publicRelayUrl,
      dshPort: this.config.dshPort,
    };
    await this.deps.save(this.config);
    return this.state();
  }

  dispose() {
    this.disposed = true;
    this.cancelPairing();
    this.client?.stop();
    this.client = undefined;
  }

  private pairingView(session: PairSession): PairingView {
    const origin = publicRelayOrigin(this.config.relay, this.config.publicRelayUrl);
    const qrPayload = pairingLink(origin, session.pairId, session.masterKey);
    return {
      expiresAt: session.expiresAt,
      qrPayload,
      qrSvg: qrSvg(qrPayload),
    };
  }

  private schedulePoll(delay: number) {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.pollPairing(), delay);
  }

  private async pollPairing() {
    const session = this.pairing;
    if (!session || this.disposed) return;
    if (Date.now() >= session.expiresAt) {
      this.cancelPairing();
      return;
    }
    try {
      const confirmed = await this.deps.request(`${this.config.relay}/pair/confirm`, {
        pairId: session.pairId,
        confirmSecret: session.confirmSecret,
      });
      if (this.pairing !== session || this.disposed) return;
      if (confirmed.status === 200) {
        const previous = this.config;
        this.config = {
          ...this.config,
          hostId: confirmed.data.hostId,
          hostToken: confirmed.data.hostToken,
          e2eeMasterKey: session.masterKey,
        };
        this.cancelPairing();
        if (
          previous.hostId &&
          previous.hostToken &&
          previous.hostId !== this.config.hostId
        ) {
          await this.deps.requestUnbind(previous).catch(() => undefined);
        }
        await this.deps.save(this.config);
        await this.connect();
        return;
      }
      if (confirmed.status !== 202) {
        this.cancelPairing();
        return;
      }
    } catch {
      // Transient Relay failures must not drop a still-valid QR.
    }
    if (this.pairing === session) this.schedulePoll(this.deps.pollIntervalMs);
  }

  private async connect() {
    if (this.disposed) return;
    this.client?.stop();
    this.client = this.deps.createClient(this.config);
    if (this.disposed) {
      this.client.stop();
      this.client = undefined;
      return;
    }
    await this.client.start();
    if (this.disposed) {
      this.client.stop();
      this.client = undefined;
    }
  }
}
