const PREFIX = "/dsh-scan-remote";
function json(res, status, body) {
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
}
export function isRemoteRequest(req) {
    return req.headers["x-dsh-scan-remote"] === "1";
}
export function createManagementHandler(manager) {
    return async (req, res) => {
        const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        try {
            if (req.method === "GET" && path === `${PREFIX}/api/state`) {
                return json(res, 200, {
                    ...(await manager.state()),
                    localActionsAllowed: !isRemoteRequest(req),
                });
            }
            if (req.method === "GET" && path === `${PREFIX}/api/access-sessions`) {
                return json(res, 200, { sessions: await manager.accessSessions() });
            }
            if (isRemoteRequest(req) && (req.method === "POST" || req.method === "DELETE")) {
                return json(res, 403, { reason: "local_management_required" });
            }
            if (req.method === "POST" && path === `${PREFIX}/api/pairing`) {
                return json(res, 200, await manager.startPairing());
            }
            if (req.method === "DELETE" && path === `${PREFIX}/api/pairing`) {
                return json(res, 200, await manager.removePairing());
            }
            return json(res, 404, { reason: "not_found" });
        }
        catch (error) {
            return json(res, 502, {
                reason: "relay_unavailable",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    };
}
export function registerManagementRoutes(webServer, manager) {
    return webServer.register({
        kind: "prefix",
        path: PREFIX,
        handler: createManagementHandler(manager),
    });
}
