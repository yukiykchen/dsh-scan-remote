import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DEVELOPMENT_JWT_SECRET = "local-development-secret-change-me";
const MINIMUM_PRODUCTION_SECRET_BYTES = 32;
const KNOWN_INSECURE_SECRETS = new Set([
  DEVELOPMENT_JWT_SECRET,
  "replace-this-in-production",
]);

function b64(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return b64(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

export function resolveJwtSecret(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.JWT_SECRET;
  if (environment.NODE_ENV !== "production")
    return configured || DEVELOPMENT_JWT_SECRET;

  if (!configured?.trim())
    throw new Error("JWT_SECRET is required when NODE_ENV=production");
  if (KNOWN_INSECURE_SECRETS.has(configured.trim().toLowerCase()))
    throw new Error("JWT_SECRET must not use a known insecure default");
  if (Buffer.byteLength(configured, "utf8") < MINIMUM_PRODUCTION_SECRET_BYTES)
    throw new Error("JWT_SECRET must contain at least 32 bytes in production");
  return configured;
}

export function signToken(
  payload: Record<string, unknown>,
  secret: string,
  ttlMs: number,
) {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  return `${body}.${b64(createHmac("sha256", secret).update(body).digest())}`;
}
export function verifyToken(
  token: string | undefined,
  secret: string,
): Record<string, any> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;
  const actual = decodeBase64Url(signature);
  const expected = createHmac("sha256", secret).update(body).digest();
  if (
    !actual ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  )
    return null;
  try {
    const decodedBody = decodeBase64Url(body);
    if (!decodedBody) return null;
    const data = JSON.parse(decodedBody.toString("utf8"));
    return data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      typeof data.exp === "number" &&
      Number.isFinite(data.exp) &&
      data.exp > Date.now()
      ? data
      : null;
  } catch {
    return null;
  }
}
export function randomToken() {
  return randomBytes(32).toString("hex");
}
