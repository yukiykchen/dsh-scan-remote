import type { IncomingMessage } from "node:http";

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
  }
}

export function envInteger(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function readBody(
  req: IncomingMessage,
  limit: number,
): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit)
    throw new BodyTooLargeError(limit);

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      req.resume();
      throw new BodyTooLargeError(limit);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

export async function readJsonBody(
  req: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

type RateWindow = { count: number; resetAt: number };

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, RateWindow>();

  take(key: string, maximum: number, windowMs: number, now = Date.now()): number {
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return 0;
    }
    if (current.count >= maximum)
      return Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    current.count += 1;
    return 0;
  }

  sweep(now = Date.now()) {
    for (const [key, window] of this.windows)
      if (window.resetAt <= now) this.windows.delete(key);
  }
}

export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?.split(",")[0]
      .trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}
