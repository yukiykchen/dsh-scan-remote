"use strict";

const byId = (id) => document.getElementById(id);
const views = ["login-view", "disabled-view", "dashboard-view"];
let lastStats = null;

function show(name) {
  for (const view of views) byId(view).classList.toggle("hidden", view !== name);
  const authenticated = name === "dashboard-view";
  byId("logout").classList.toggle("hidden", !authenticated);
  byId("refresh").classList.toggle("hidden", !authenticated);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "request_failed");
  return data;
}

function number(value) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function date(value) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function setText(id, value) {
  byId(id).textContent = value;
}

function renderChart(daily) {
  const canvas = byId("activity-chart");
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const width = Math.max(canvas.clientWidth, 320);
  const height = 240;
  canvas.width = Math.floor(width * ratio);
  canvas.height = height * ratio;
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  const style = getComputedStyle(document.documentElement);
  const line = style.getPropertyValue("--line").trim();
  const muted = style.getPropertyValue("--muted").trim();
  const colors = [style.getPropertyValue("--accent").trim(), style.getPropertyValue("--second").trim()];
  const padding = { top: 20, right: 18, bottom: 30, left: 38 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maximum = Math.max(1, ...daily.flatMap((entry) => [entry.users, entry.sessions]));
  context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.fillStyle = muted;
  context.strokeStyle = line;
  context.lineWidth = 1;
  for (let index = 0; index <= 4; index += 1) {
    const y = padding.top + (chartHeight * index) / 4;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    const label = Math.round(maximum * (1 - index / 4));
    context.fillText(String(label), 8, y + 4);
  }
  for (const [seriesIndex, field] of ["users", "sessions"].entries()) {
    context.beginPath();
    context.strokeStyle = colors[seriesIndex];
    context.lineWidth = 2;
    daily.forEach((entry, index) => {
      const x = padding.left + (chartWidth * index) / Math.max(1, daily.length - 1);
      const y = padding.top + chartHeight * (1 - entry[field] / maximum);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  }
  for (const index of [0, 9, 19, 29]) {
    if (!daily[index]) continue;
    const x = padding.left + (chartWidth * index) / Math.max(1, daily.length - 1);
    context.fillStyle = muted;
    context.fillText(daily[index].day.slice(5), Math.min(x, width - 48), height - 9);
  }
}

function renderSessions(sessions) {
  const body = byId("session-rows");
  body.replaceChildren();
  byId("sessions-empty").classList.toggle("hidden", sessions.length !== 0);
  const labels = { active: "进行中", expired: "已过期", ended: "已结束" };
  for (const session of sessions) {
    const row = document.createElement("tr");
    for (const value of [
      session.email,
      session.deviceName,
      session.platform,
      date(session.startedAt),
      date(session.lastSeenAt),
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const status = document.createElement("td");
    status.className = `status ${session.status}`;
    status.textContent = labels[session.status] || session.status;
    row.append(status);
    body.append(row);
  }
}

async function loadStats() {
  const stats = await api("/admin/api/stats");
  lastStats = stats;
  setText("users-total", number(stats.users.total));
  setText("users-new", `近 7 天新增 ${number(stats.users.new7d)}`);
  setText("active-users", number(stats.sessions.activeUsers30d));
  setText("users-24h", `近 24 小时新增 ${number(stats.users.new24h)}`);
  setText("devices-paired", number(stats.devices.paired));
  setText("devices-online", `在线 ${number(stats.devices.online)}，DSH 可用 ${number(stats.devices.dshOnline)}`);
  setText("sessions-active", number(stats.sessions.active));
  setText("sessions-24h", `近 24 小时 ${number(stats.sessions.last24h)}`);
  setText("updated-at", `更新于 ${date(stats.generatedAt)}`);
  renderChart(stats.daily);
  renderSessions(stats.recentSessions);
}

byId("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setText("login-error", "");
  try {
    await api("/admin/api/login", {
      method: "POST",
      body: JSON.stringify({ username: byId("username").value, password: byId("password").value }),
    });
    show("dashboard-view");
    await loadStats();
  } catch {
    setText("login-error", "账号或密码不正确。");
  }
});

byId("refresh").addEventListener("click", () => loadStats());
byId("logout").addEventListener("click", async () => {
  await api("/admin/api/logout", { method: "POST", body: "{}" });
  show("login-view");
});
new ResizeObserver(() => { if (lastStats) renderChart(lastStats.daily); }).observe(byId("activity-chart"));

(async function start() {
  try {
    const session = await api("/admin/api/session");
    if (!session.enabled) return show("disabled-view");
    if (!session.authenticated) return show("login-view");
    show("dashboard-view");
    await loadStats();
  } catch {
    show("login-view");
  }
})();
