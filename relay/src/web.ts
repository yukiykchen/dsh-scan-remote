import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const types: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};

const publicFiles = new Map<string, string>([
  ["/app/", "app/index.html"],
  ["/app/app.css", "app/app.css"],
  ["/app/app.js", "app/app.js"],
  ["/app/crypto.js", "app/crypto.js"],
  ["/app/key-store.js", "app/key-store.js"],
  ["/app/qr-scanner.umd.min.js", "app/qr-scanner.umd.min.js"],
  ["/app/qr-scanner-worker.min.js", "app/qr-scanner-worker.min.js"],
  ["/app/sw.js", "app/sw.js"],
  ["/admin/", "admin/index.html"],
  ["/admin/admin.css", "admin/admin.css"],
  ["/admin/admin.js", "admin/admin.js"],
  ["/remote/unavailable.html", "app/remote-unavailable.html"],
]);

function securityHeaders(pathname: string): Record<string, string> {
  const script = pathname === "/app/sw.js" ? "'self'" : "'self'";
  return {
    "cache-control": pathname.endsWith(".html") || pathname.endsWith("/")
      ? "no-store"
      : "public, max-age=300",
    "content-security-policy": [
      "default-src 'self'",
      `script-src ${script}`,
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "font-src 'self'",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join("; "),
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(self), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
  };
}

export function isWebAsset(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/app" ||
    pathname === "/admin" ||
    publicFiles.has(pathname) ||
    /^\/remote\/[^/]+\/$/.test(pathname)
  );
}

export function serveWeb(
  _req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  if (pathname === "/") {
    res.writeHead(302, { location: "/app/", "cache-control": "no-store" });
    res.end();
    return true;
  }
  if (pathname === "/app" || pathname === "/admin") {
    res.writeHead(308, { location: `${pathname}/` });
    res.end();
    return true;
  }
  const relative = publicFiles.get(pathname);
  if (!relative && /^\/remote\/[^/]+\/$/.test(pathname)) {
    res.writeHead(503, {
      ...securityHeaders("/remote/unavailable.html"),
      "content-type": "text/html; charset=utf-8",
    });
    res.end(readFileSync(join(webRoot, "app/remote-unavailable.html")));
    return true;
  }
  if (!relative) return false;
  const body = readFileSync(join(webRoot, relative));
  const headers = {
    ...securityHeaders(pathname),
    "content-type": types[extname(relative)] ?? "application/octet-stream",
    "content-length": String(body.length),
    ...(pathname === "/app/sw.js"
      ? { "service-worker-allowed": "/" }
      : {}),
  };
  res.writeHead(200, headers);
  res.end(body);
  return true;
}
