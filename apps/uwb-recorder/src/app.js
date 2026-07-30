const elementIds = [
  "address-1",
  "address-2",
  "address-3",
  "address-4",
  "address-5",
  "baud-rate",
  "clear-button",
  "clear-console-button",
  "clear-dialog",
  "clear-live-button",
  "command-input",
  "command-progress",
  "connect-button",
  "connection-status",
  "data-table-body",
  "disconnect-button",
  "distance-1",
  "distance-2",
  "distance-3",
  "distance-4",
  "distance-5",
  "distance-chart",
  "distance-difference",
  "empty-chart",
  "export-button",
  "frame-count",
  "language-button",
  "median-1",
  "median-2",
  "median-3",
  "median-4",
  "median-5",
  "mode-status",
  "module-version",
  "pause-button",
  "port-select",
  "quality-1",
  "quality-2",
  "quality-3",
  "quality-4",
  "quality-5",
  "range-1",
  "range-2",
  "range-3",
  "range-4",
  "range-5",
  "raw-console",
  "refresh-ports-button",
  "reset-view-button",
  "restore-dialog",
  "save-status",
  "send-button",
  "session-select",
  "snr-1",
  "snr-2",
  "snr-3",
  "snr-4",
  "snr-5",
  "status-dot",
  "sync-status",
];

const elements = Object.fromEntries(
  elementIds.map((id) => [id, document.getElementById(id)]),
);

const state = {
  status: null,
  records: [],
  eventCursor: 0,
  activeSessionId: null,
  paused: false,
  polling: false,
  consoleLines: [],
  viewStartedAt: 0,
  language: "zh",
  lastStatusPoll: 0,
};

const channelColors = ["#4e7d95", "#d97757", "#8a8074", "#7d6d8f", "#6f8a69"];
const MAX_MEMORY_RECORDS = 10000;
const MAX_CHART_RECORDS = 300;
const MAX_TABLE_ROWS = 40;
const MAX_CONSOLE_LINES = 240;

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (options.raw) {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response;
  }
  const envelope = await response.json();
  if (!response.ok || !envelope.ok) {
    const error = new Error(
      envelope.error?.message ?? `请求失败：HTTP ${response.status}`,
    );
    error.code = envelope.error?.code;
    error.details = envelope.error?.details;
    throw error;
  }
  return envelope.data;
}

function formatLocalTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  }).format(new Date(timestamp));
}

function sessionLabel(session) {
  const time = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(session.startedAt));
  return `${time} · ${session.port ?? "--"} · ${session.frameCount ?? 0}帧`;
}

function appendConsole(raw, direction = "RX", timestamp = new Date().toISOString()) {
  state.consoleLines.push(`[${formatLocalTime(timestamp)}] ${direction} ${raw}`);
  if (state.consoleLines.length > MAX_CONSOLE_LINES) {
    state.consoleLines.splice(0, state.consoleLines.length - MAX_CONSOLE_LINES);
  }
  elements["raw-console"].textContent = state.consoleLines.join("\n");
  elements["raw-console"].scrollTop = elements["raw-console"].scrollHeight;
}

function setCommandProgress(text, kind = "neutral") {
  elements["command-progress"].textContent = text;
  elements["command-progress"].dataset.kind = kind;
}

function setCommandButtonsDisabled(disabled) {
  for (const button of document.querySelectorAll("[data-command-action]")) {
    button.disabled = disabled;
  }
}

function addRecord(record) {
  state.records.push(record);
  if (state.records.length > MAX_MEMORY_RECORDS) {
    state.records.splice(0, state.records.length - MAX_MEMORY_RECORDS);
  }
}

function handleEvents(events) {
  let receivedFrame = false;
  for (const event of events) {
    state.eventCursor = Math.max(state.eventCursor, event.seq ?? 0);
    if (event.type === "frame") {
      addRecord(event);
      appendConsole(event.raw, "RX", event.timestamp);
      receivedFrame = true;
    } else if (event.type === "serial") {
      appendConsole(event.raw, event.direction ?? "RX", event.timestamp);
    } else if (event.type === "error") {
      appendConsole(`${event.code}: ${event.message}`, "ERR", event.timestamp);
    } else if (event.type === "status") {
      appendConsole(
        `${event.state} ${event.path ?? ""} ${event.baudRate ?? ""}`.trim(),
        "SYS",
        event.timestamp,
      );
    }
  }
  if (!state.paused && (events.length > 0 || receivedFrame)) {
    render();
  } else if (state.status?.session) {
    elements["frame-count"].textContent =
      `${state.status.session.frameCount ?? state.records.length} 帧`;
  }
}

function recordsForDevice(device, limit = 20) {
  return state.records.filter((record) => record.device === device).slice(-limit);
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function channelMetrics(device) {
  const records = recordsForDevice(device, 20);
  if (records.length === 0) {
    return null;
  }
  const distances = records.map((record) => record.distanceCm);
  return {
    latest: records.at(-1),
    median: median(distances),
    range: Math.max(...distances) - Math.min(...distances),
  };
}

function qualityFor(metrics) {
  if (!metrics) {
    return { className: "waiting", label: "等待" };
  }
  if (metrics.latest.snrDb !== null && metrics.latest.snrDb < 3) {
    return { className: "bad", label: "信号很差" };
  }
  if (metrics.range > 20) {
    return { className: "bad", label: "距离跳变" };
  }
  if (
    (metrics.latest.snrDb !== null && metrics.latest.snrDb < 8) ||
    metrics.range > 8
  ) {
    return { className: "warning", label: "不稳定" };
  }
  return { className: "", label: "稳定" };
}

function renderChannel(device) {
  const metrics = channelMetrics(device);
  const quality = qualityFor(metrics);
  elements[`quality-${device}`].className =
    `quality-tag ${quality.className}`.trim();
  elements[`quality-${device}`].textContent = quality.label;

  if (!metrics) {
    elements[`distance-${device}`].textContent = "--";
    elements[`snr-${device}`].textContent = "-- dB";
    elements[`range-${device}`].textContent = "-- cm";
    elements[`median-${device}`].textContent = "-- cm";
    elements[`address-${device}`].textContent = "----";
    return;
  }

  elements[`distance-${device}`].textContent = metrics.latest.distanceCm
    .toFixed(1)
    .replace(".0", "");
  elements[`snr-${device}`].textContent =
    metrics.latest.snrDb === null
      ? "-- dB"
      : `${metrics.latest.snrDb.toFixed(1)} dB`;
  elements[`range-${device}`].textContent = `${metrics.range.toFixed(1)} cm`;
  elements[`median-${device}`].textContent = `${metrics.median.toFixed(1)} cm`;
  elements[`address-${device}`].textContent = metrics.latest.address;
}

function renderDifference() {
  const first = channelMetrics(1);
  const second = channelMetrics(2);
  if (!first || !second) {
    elements["distance-difference"].textContent = "-- cm";
    elements["sync-status"].textContent = "等待两路同步数据";
    return;
  }
  const difference = first.latest.distanceCm - second.latest.distanceCm;
  const timeDifference = Math.abs(
    new Date(first.latest.timestamp).getTime() -
      new Date(second.latest.timestamp).getTime(),
  );
  elements["distance-difference"].textContent =
    `${difference >= 0 ? "+" : ""}${difference.toFixed(1)} cm`;
  elements["sync-status"].textContent =
    timeDifference <= 200
      ? `时间差 ${timeDifference} ms`
      : `不同步：${timeDifference} ms`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderTable() {
  const records = state.records.slice(-MAX_TABLE_ROWS).reverse();
  if (records.length === 0) {
    elements["data-table-body"].innerHTML =
      '<tr class="empty-row"><td colspan="6">尚未收到数据</td></tr>';
    return;
  }
  elements["data-table-body"].innerHTML = records
    .map(
      (record) => `
        <tr>
          <td>${formatLocalTime(record.timestamp)}</td>
          <td>D${record.device ?? "-"}</td>
          <td>${record.address}</td>
          <td>${record.distanceCm} cm</td>
          <td>${record.snrDb === null ? "--" : `${record.snrDb} dB`}</td>
          <td>${escapeHtml(record.raw)}</td>
        </tr>`,
    )
    .join("");
}

function resizeCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const rectangle = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rectangle.width * ratio));
  const height = Math.max(1, Math.round(rectangle.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { ratio, width, height };
}

function renderChart() {
  const canvas = elements["distance-chart"];
  const { ratio, width, height } = resizeCanvas(canvas);
  const context = canvas.getContext("2d");
  const records = state.records
    .filter(
      (record) =>
        record.device >= 1 &&
        record.device <= 5 &&
        new Date(record.timestamp).getTime() >= state.viewStartedAt,
    )
    .slice(-MAX_CHART_RECORDS);
  context.clearRect(0, 0, width, height);
  elements["empty-chart"].hidden = records.length > 0;
  if (records.length === 0) {
    return;
  }

  const padding = {
    top: 20 * ratio,
    right: 18 * ratio,
    bottom: 30 * ratio,
    left: 56 * ratio,
  };
  const distances = records.map((record) => record.distanceCm);
  let minimum = Math.floor((Math.min(...distances) - 5) / 10) * 10;
  let maximum = Math.ceil((Math.max(...distances) + 5) / 10) * 10;
  if (maximum - minimum < 20) {
    const middle = (maximum + minimum) / 2;
    minimum = middle - 10;
    maximum = middle + 10;
  }
  const xStart = padding.left;
  const xEnd = width - padding.right;
  const yStart = padding.top;
  const yEnd = height - padding.bottom;
  const plotWidth = xEnd - xStart;
  const plotHeight = yEnd - yStart;

  context.font = `${11 * ratio}px Consolas`;
  context.strokeStyle = "rgba(70, 65, 60, 0.15)";
  context.fillStyle = "#77736d";
  context.lineWidth = ratio;
  for (let step = 0; step <= 5; step += 1) {
    const y = yStart + (plotHeight * step) / 5;
    const value = maximum - ((maximum - minimum) * step) / 5;
    context.beginPath();
    context.moveTo(xStart, y);
    context.lineTo(xEnd, y);
    context.stroke();
    context.fillText(value.toFixed(0), 8 * ratio, y + 4 * ratio);
  }

  for (let device = 1; device <= 5; device += 1) {
    const series = records.filter((record) => record.device === device);
    if (series.length === 0) {
      continue;
    }
    context.beginPath();
    context.strokeStyle = channelColors[device - 1];
    context.lineWidth = (device <= 2 ? 2.2 : 1.5) * ratio;
    context.lineJoin = "round";
    context.lineCap = "round";
    for (const [index, record] of series.entries()) {
      const recordPosition = records.indexOf(record);
      const x =
        xStart +
        (plotWidth * recordPosition) / Math.max(1, records.length - 1);
      const y =
        yEnd -
        (plotHeight * (record.distanceCm - minimum)) / (maximum - minimum);
      if (index === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }
    context.stroke();
  }
}

function fillParameterForm(parameters) {
  const mapping = {
    interval: "param-interval",
    role: "param-role",
    channel: "param-channel",
    baudCode: "param-baud",
    power: "param-power",
    responders: "param-responders",
    source: "param-source",
  };
  for (const [key, id] of Object.entries(mapping)) {
    if (parameters?.[key] !== null && parameters?.[key] !== undefined) {
      document.getElementById(id).value = String(parameters[key]);
    }
  }
  if (Array.isArray(parameters?.destinations)) {
    parameters.destinations.forEach((address, index) => {
      document.getElementById(`param-dst-${index + 1}`).value = address;
    });
  }
  elements["module-version"].textContent =
    `版本：${parameters?.version ?? "--"}`;
}

function renderStatus() {
  const status = state.status;
  const connected = status?.connected === true;
  elements["connection-status"].textContent = connected
    ? `${status.port} · ${status.baudRate}`
    : "等待连接";
  elements["status-dot"].classList.toggle("connected", connected);
  elements["mode-status"].textContent = status?.atMode
    ? "配置模式"
    : "数据模式";
  elements["save-status"].textContent = connected
    ? "服务端正在自动保存 JSONL"
    : "历史数据保存在本地服务";
  elements["frame-count"].textContent =
    `${status?.session?.frameCount ?? state.records.length} 帧`;
  elements["connect-button"].disabled = connected;
  elements["disconnect-button"].disabled = !connected;
  elements["refresh-ports-button"].disabled = connected;
  elements["port-select"].disabled = connected;
  elements["baud-rate"].disabled = connected;
  elements["send-button"].disabled = !connected;
  elements["pause-button"].disabled = !connected;
  elements["session-select"].disabled = connected;
  setCommandButtonsDisabled(!connected);
  fillParameterForm(status?.parameters);
}

function render() {
  for (let device = 1; device <= 5; device += 1) {
    renderChannel(device);
  }
  renderDifference();
  renderTable();
  renderChart();
  renderStatus();
  elements["export-button"].disabled =
    !state.activeSessionId || state.records.length === 0;
  elements["clear-button"].disabled = !state.activeSessionId;
}

async function refreshPorts() {
  try {
    const ports = await apiRequest("/api/ports");
    if (ports.length === 0) {
      elements["port-select"].innerHTML =
        '<option value="">未发现串口</option>';
      return;
    }
    const previous = elements["port-select"].value;
    elements["port-select"].innerHTML = ports
      .map((port) => {
        const description = [port.path, port.manufacturer]
          .filter(Boolean)
          .join(" · ");
        return `<option value="${escapeHtml(port.path)}">${escapeHtml(description)}</option>`;
      })
      .join("");
    if (ports.some((port) => port.path === previous)) {
      elements["port-select"].value = previous;
    }
  } catch (error) {
    elements["port-select"].innerHTML =
      '<option value="">采集服务未启动</option>';
    elements["connection-status"].textContent = error.message;
  }
}

async function refreshStatus({ loadMeasurements = true } = {}) {
  const status = await apiRequest("/api/status");
  const nextSessionId = status.session?.id ?? null;
  const sessionChanged = nextSessionId !== state.activeSessionId;
  state.status = status;
  if (sessionChanged) {
    state.activeSessionId = nextSessionId;
    state.records = [];
    state.eventCursor = status.eventSequence ?? 0;
    if (loadMeasurements && nextSessionId) {
      state.records = await apiRequest(
        `/api/measurements?session_id=${encodeURIComponent(nextSessionId)}&limit=${MAX_MEMORY_RECORDS}`,
      );
    }
    await refreshSessions(nextSessionId);
  }
  render();
}

async function refreshSessions(selectedId = "") {
  const sessions = await apiRequest("/api/sessions");
  if (sessions.length === 0) {
    elements["session-select"].innerHTML =
      '<option value="">暂无历史记录</option>';
    return;
  }
  elements["session-select"].innerHTML = sessions
    .map(
      (session) =>
        `<option value="${escapeHtml(session.id)}">${escapeHtml(sessionLabel(session))}</option>`,
    )
    .join("");
  elements["session-select"].value = selectedId || sessions[0].id;
}

async function loadSelectedSession() {
  if (state.status?.connected) {
    return;
  }
  const sessionId = elements["session-select"].value;
  if (!sessionId) {
    return;
  }
  state.activeSessionId = sessionId;
  state.records = await apiRequest(
    `/api/sessions/${encodeURIComponent(sessionId)}/measurements?limit=${MAX_MEMORY_RECORDS}`,
  );
  state.viewStartedAt = 0;
  render();
}

async function connectSerial() {
  const path = elements["port-select"].value;
  if (!path) {
    setCommandProgress("请选择串口", "error");
    return;
  }
  try {
    setCommandProgress("正在连接…");
    await apiRequest("/api/connect", {
      method: "POST",
      body: {
        path,
        baudRate: Number(elements["baud-rate"].value),
      },
    });
    state.consoleLines = [];
    state.viewStartedAt = 0;
    await refreshStatus();
    setCommandProgress("串口已连接", "success");
  } catch (error) {
    setCommandProgress(`连接失败：${error.message}`, "error");
  }
}

async function disconnectSerial() {
  try {
    await apiRequest("/api/disconnect", { method: "POST", body: {} });
    await refreshStatus({ loadMeasurements: false });
    await refreshPorts();
    setCommandProgress("串口已断开", "success");
  } catch (error) {
    setCommandProgress(`断开失败：${error.message}`, "error");
  }
}

function collectParameters() {
  return {
    interval: Number(document.getElementById("param-interval").value),
    role: Number(document.getElementById("param-role").value),
    channel: Number(document.getElementById("param-channel").value),
    baudCode: Number(document.getElementById("param-baud").value),
    power: Number(document.getElementById("param-power").value),
    responders: Number(document.getElementById("param-responders").value),
    source: document.getElementById("param-source").value,
    destinations: Array.from({ length: 5 }, (_, index) =>
      document.getElementById(`param-dst-${index + 1}`).value,
    ),
  };
}

async function callAction(action, body = {}) {
  try {
    setCommandProgress(`正在执行 ${action}…`);
    const result = await apiRequest(`/api/actions/${action}`, {
      method: "POST",
      body,
    });
    setCommandProgress(
      action === "write"
        ? "参数已发送，请复位模块使其生效"
        : "指令执行完成",
      "success",
    );
    window.setTimeout(() => {
      void refreshStatus({ loadMeasurements: false });
    }, 1200);
    return result;
  } catch (error) {
    setCommandProgress(`${error.code ?? "操作失败"}：${error.message}`, "error");
    return null;
  }
}

async function handleCommandAction(action) {
  if (action === "restore") {
    elements["restore-dialog"].showModal();
    return;
  }
  if (action === "write") {
    await callAction("write", { parameters: collectParameters() });
    return;
  }
  await callAction(action);
}

async function sendCommand() {
  const text = elements["command-input"].value.trim();
  if (!text) {
    return;
  }
  try {
    await apiRequest("/api/command", {
      method: "POST",
      body: { text, lineEnding: text !== "+++" },
    });
    elements["command-input"].value = "";
  } catch (error) {
    setCommandProgress(`发送失败：${error.message}`, "error");
  }
}

async function exportCsv() {
  if (!state.activeSessionId) {
    return;
  }
  const response = await apiRequest(
    `/api/sessions/${encodeURIComponent(state.activeSessionId)}/export.csv`,
    { raw: true },
  );
  const blob = await response.blob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `uwb-${state.activeSessionId}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function clearCurrentSession() {
  if (!state.activeSessionId) {
    return;
  }
  try {
    await apiRequest(
      `/api/sessions/${encodeURIComponent(state.activeSessionId)}?confirm=true`,
      { method: "DELETE" },
    );
    state.activeSessionId = null;
    state.records = [];
    await refreshSessions();
    await loadSelectedSession();
    render();
  } catch (error) {
    setCommandProgress(`删除失败：${error.message}`, "error");
  }
}

function togglePause() {
  state.paused = !state.paused;
  elements["pause-button"].textContent = state.paused
    ? "继续显示"
    : "暂停显示";
  elements["save-status"].textContent = state.paused
    ? "画面已暂停，服务端仍在保存全部数据"
    : "服务端正在自动保存 JSONL";
  if (!state.paused) {
    render();
  }
}

async function pollRealtime() {
  if (state.polling) {
    return;
  }
  state.polling = true;
  try {
    const now = Date.now();
    if (now - state.lastStatusPoll >= 1000) {
      await refreshStatus({ loadMeasurements: false });
      state.lastStatusPoll = now;
    }
    if (state.status?.connected) {
      const events = await apiRequest(
        `/api/events?after=${state.eventCursor}&limit=1000`,
      );
      handleEvents(events);
    }
  } catch (error) {
    elements["connection-status"].textContent = error.message;
  } finally {
    state.polling = false;
  }
}

const languageCopies = {
  zh: {
    title: "测距实验台",
    monitor: "实时监控",
    configuration: "参数设置",
    records: "数据记录",
    console: "串口终端",
    connect: "选择串口",
  },
  en: {
    title: "Ranging workbench",
    monitor: "Live monitor",
    configuration: "Configuration",
    records: "Data records",
    console: "Serial console",
    connect: "Connect",
  },
};

function toggleLanguage() {
  state.language = state.language === "zh" ? "en" : "zh";
  const copy = languageCopies[state.language];
  document.documentElement.lang = state.language === "zh" ? "zh-CN" : "en";
  document.querySelector("h1").textContent = copy.title;
  const links = document.querySelectorAll(".nav-link");
  [copy.monitor, copy.configuration, copy.records, copy.console].forEach(
    (text, index) => {
      const icon = links[index].querySelector("span")?.outerHTML ?? "";
      links[index].innerHTML = `${icon}${text}`;
    },
  );
  elements["connect-button"].textContent = copy.connect;
  elements["language-button"].textContent =
    state.language === "zh" ? "中文 / English" : "English / 中文";
}

function updateActiveNavigation() {
  const sections = [...document.querySelectorAll(".page-section")];
  const active =
    sections
      .filter((section) => section.getBoundingClientRect().top <= 180)
      .at(-1) ?? sections[0];
  for (const link of document.querySelectorAll(".nav-link")) {
    link.classList.toggle(
      "active",
      link.getAttribute("href") === `#${active.id}`,
    );
  }
}

elements["connect-button"].addEventListener("click", connectSerial);
elements["disconnect-button"].addEventListener("click", disconnectSerial);
elements["refresh-ports-button"].addEventListener("click", refreshPorts);
elements["pause-button"].addEventListener("click", togglePause);
elements["export-button"].addEventListener("click", exportCsv);
elements["send-button"].addEventListener("click", sendCommand);
elements["command-input"].addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    void sendCommand();
  }
});
elements["session-select"].addEventListener("change", loadSelectedSession);
elements["clear-button"].addEventListener("click", () => {
  elements["clear-dialog"].showModal();
});
elements["clear-console-button"].addEventListener("click", () => {
  state.consoleLines = [];
  elements["raw-console"].textContent =
    "显示已清空，服务端保存的数据不受影响。";
});
elements["clear-live-button"].addEventListener("click", () => {
  state.viewStartedAt = Date.now();
  renderChart();
});
elements["reset-view-button"].addEventListener("click", () => {
  state.viewStartedAt = 0;
  renderChart();
});
elements["language-button"].addEventListener("click", toggleLanguage);
for (const button of document.querySelectorAll("[data-command-action]")) {
  button.addEventListener("click", () => {
    void handleCommandAction(button.dataset.commandAction);
  });
}
elements["clear-dialog"].addEventListener("close", () => {
  if (elements["clear-dialog"].returnValue === "confirm") {
    void clearCurrentSession();
  }
});
elements["restore-dialog"].addEventListener("close", () => {
  if (elements["restore-dialog"].returnValue === "confirm") {
    void callAction("restore", { confirm: true });
  }
});
window.addEventListener("resize", renderChart);
window.addEventListener("scroll", updateActiveNavigation, { passive: true });

async function initialize() {
  setCommandButtonsDisabled(true);
  try {
    await refreshPorts();
    await refreshStatus();
    await refreshSessions(state.activeSessionId ?? "");
    if (!state.status?.connected && elements["session-select"].value) {
      await loadSelectedSession();
    }
    updateActiveNavigation();
    render();
  } catch (error) {
    elements["connection-status"].textContent =
      `采集服务未启动：${error.message}`;
    elements["save-status"].textContent = "请双击 start.cmd 启动服务";
  }
  window.setInterval(pollRealtime, 300);
}

void initialize();
