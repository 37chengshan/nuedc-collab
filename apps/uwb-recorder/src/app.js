const elementIds = [
  "address-1",
  "address-2",
  "address-3",
  "address-4",
  "address-5",
  "baud-rate",
  "calibrated-angle",
  "calibrated-distance",
  "calibrated-quality",
  "calibrated-zone",
  "calibration-error-bound",
  "calibration-anchor-coordinates",
  "calibration-anchor-count",
  "calibration-angle-heatmap",
  "calibration-bias-chart",
  "calibration-boundary-chart",
  "calibration-boundary-offset",
  "calibration-current-point",
  "calibration-distance-heatmap",
  "calibration-dynamic-error-chart",
  "calibration-export-c-button",
  "calibration-export-csv-button",
  "calibration-export-json-button",
  "calibration-export-png-button",
  "calibration-geometry-chart",
  "calibration-history-capture",
  "calibration-plan",
  "calibration-plan-summary",
  "calibration-progress",
  "calibration-quality-body",
  "calibration-recapture-button",
  "calibration-rejection-reasons",
  "calibration-start-button",
  "calibration-status",
  "calibration-train-button",
  "calibration-trajectory-chart",
  "calibration-validate-button",
  "capture-button",
  "capture-download-button",
  "capture-label",
  "capture-status",
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
  lastCaptureId: null,
  finalCalibration: null,
  position: {
    latest: null,
    smoothedDistanceM: null,
    smoothedAngleDeg: null,
  },
  calibration: {
    plan: null,
    selectedIndex: 0,
    captures: new Map(),
    model: null,
    validation: null,
    busy: false,
  },
};

const channelColors = ["#4e7d95", "#d97757", "#8a8074", "#7d6d8f", "#6f8a69"];
const CALIBRATION_DISTANCES_M = [
  0.5, 0.8, 0.95, 1, 1.05, 1.5, 1.95, 2, 2.05, 2.5, 3,
];
const CALIBRATION_ANGLES_DEG = [-45, -30, -15, 0, 15, 30, 45];
const CALIBRATION_LIMITS = {
  boundaryOffsetMm: 300,
  distanceErrorM: 0.3,
  angleErrorDeg: 10,
};
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

function renderCalibratedPosition() {
  const model = state.finalCalibration;
  const estimate = state.position.latest;
  const errorM = model?.metrics?.distanceMaxErrorM;
  elements["calibration-error-bound"].textContent = Number.isFinite(errorM)
    ? `最终 18 组标定点最大误差 ±${errorM.toFixed(3)} m`
    : "正在载入最终模型";

  if (!estimate?.valid) {
    elements["calibrated-distance"].textContent = "--";
    elements["calibrated-angle"].textContent = "--°";
    elements["calibrated-zone"].textContent = state.status?.connected
      ? "等待两路稳定数据"
      : "连接串口后开始定位";
    elements["calibrated-quality"].className =
      "position-quality waiting";
    elements["calibrated-quality"].textContent =
      estimate?.reason ?? "等待串口数据";
    return;
  }

  const distanceM =
    state.position.smoothedDistanceM ?? estimate.distanceM;
  elements["calibrated-distance"].textContent = distanceM.toFixed(2);
  if (estimate.angleValid) {
    const angleDeg = state.position.smoothedAngleDeg ?? estimate.angleDeg;
    elements["calibrated-angle"].textContent =
      `${angleDeg >= 0 ? "+" : ""}${angleDeg.toFixed(1)}°`;
  } else {
    elements["calibrated-angle"].textContent = "暂不可用";
  }

  let zone = "感应区外";
  if (distanceM <= 1) {
    zone = "开锁区 · ≤ 1.00 m";
  } else if (distanceM <= 2) {
    zone = "迎宾区 · 1.00～2.00 m";
  } else if (distanceM <= 3) {
    zone = "感应区 · 2.00～3.00 m";
  }
  elements["calibrated-zone"].textContent = zone;
  const degraded = estimate.quality !== "good";
  elements["calibrated-quality"].className =
    `position-quality ${degraded ? "warning" : "good"}`;
  elements["calibrated-quality"].textContent = degraded
    ? "距离可用 · 角度链路不稳"
    : "双路稳定 · 实时拟合中";
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

function selectedCalibrationPoint() {
  return (
    state.calibration.plan?.points?.[state.calibration.selectedIndex] ?? null
  );
}

function parseAnchorCoordinates() {
  const count = Number(elements["calibration-anchor-count"].value);
  const pairs = elements["calibration-anchor-coordinates"].value
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair, index) => {
      const [xMm, yMm] = pair.split(",").map(Number);
      if (!Number.isFinite(xMm) || !Number.isFinite(yMm)) {
        throw new Error(`第${index + 1}个基站坐标格式不正确`);
      }
      return { id: index + 1, xMm, yMm, enabled: index < count };
    });
  if (pairs.length < count) {
    throw new Error(`已选择${count}个基站，但只填写了${pairs.length}组坐标`);
  }
  return pairs.slice(0, count);
}

function setCalibrationBusy(busy) {
  state.calibration.busy = busy;
  for (const id of [
    "calibration-start-button",
    "calibration-recapture-button",
    "calibration-train-button",
    "calibration-validate-button",
    "calibration-export-c-button",
  ]) {
    elements[id].disabled = busy;
  }
  elements["calibration-anchor-count"].disabled = busy;
  elements["calibration-anchor-coordinates"].disabled = busy;
  elements["calibration-boundary-offset"].disabled = busy;
  elements["calibration-history-capture"].disabled = busy;
}

function canvasPoint(origin, scale, radiusM, angleDeg) {
  const radians = (angleDeg * Math.PI) / 180;
  return {
    x: origin.x + Math.sin(radians) * radiusM * scale,
    y: origin.y - Math.cos(radians) * radiusM * scale,
  };
}

function sectorBandPath(context, origin, scale, innerM, outerM) {
  context.beginPath();
  for (let angle = -45; angle <= 45; angle += 2) {
    const point = canvasPoint(origin, scale, outerM, angle);
    if (angle === -45) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  }
  for (let angle = 45; angle >= -45; angle -= 2) {
    const point = canvasPoint(origin, scale, innerM, angle);
    context.lineTo(point.x, point.y);
  }
  context.closePath();
}

function drawCalibrationGeometry() {
  const canvas = elements["calibration-geometry-chart"];
  const { ratio, width, height } = resizeCanvas(canvas);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  const boundaryM =
    Number(elements["calibration-boundary-offset"].value || 300) / 1000;
  const maxRadiusM = boundaryM + 3;
  const origin = { x: width / 2, y: height - 22 * ratio };
  const scale = (height - 48 * ratio) / maxRadiusM;

  const zones = [
    { inner: boundaryM, outer: boundaryM + 1, fill: "rgba(81,118,94,.16)" },
    { inner: boundaryM + 1, outer: boundaryM + 2, fill: "rgba(217,119,87,.13)" },
    { inner: boundaryM + 2, outer: boundaryM + 3, fill: "rgba(78,125,149,.11)" },
  ];
  for (const zone of zones) {
    sectorBandPath(context, origin, scale, zone.inner, zone.outer);
    context.fillStyle = zone.fill;
    context.fill();
  }

  context.strokeStyle = "rgba(55,48,41,.24)";
  context.lineWidth = ratio;
  for (const radialDistanceM of [0, 1, 2, 3]) {
    const radiusM = boundaryM + radialDistanceM;
    context.beginPath();
    for (let angle = -45; angle <= 45; angle += 2) {
      const point = canvasPoint(origin, scale, radiusM, angle);
      if (angle === -45) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    }
    context.stroke();
    const labelPoint = canvasPoint(origin, scale, radiusM, 45);
    context.fillStyle = "#69635d";
    context.font = `${11 * ratio}px "Cascadia Mono", Consolas`;
    context.fillText(
      radialDistanceM === 0 ? "圆柱边界" : `${radialDistanceM}m`,
      labelPoint.x + 5 * ratio,
      labelPoint.y,
    );
  }

  for (const angle of [-45, 0, 45]) {
    const end = canvasPoint(origin, scale, maxRadiusM, angle);
    context.beginPath();
    context.moveTo(origin.x, origin.y);
    context.lineTo(end.x, end.y);
    context.strokeStyle = angle === 0 ? "#4e7d95" : "rgba(55,48,41,.28)";
    context.setLineDash(angle === 0 ? [7 * ratio, 5 * ratio] : []);
    context.stroke();
    context.setLineDash([]);
  }

  context.beginPath();
  context.arc(origin.x, origin.y, boundaryM * scale, 0, Math.PI * 2);
  context.fillStyle = "#d8d3cb";
  context.fill();
  context.strokeStyle = "#6e6962";
  context.stroke();

  let anchors = [];
  try {
    anchors = parseAnchorCoordinates();
  } catch {
    anchors = [
      { id: 1, xMm: -125, yMm: 40 },
      { id: 2, xMm: 125, yMm: 40 },
    ];
  }
  for (const anchor of anchors) {
    const x = origin.x + (anchor.xMm / 1000) * scale;
    const y = origin.y - (anchor.yMm / 1000) * scale;
    context.fillStyle = "#292724";
    context.fillRect(x - 6 * ratio, y - 6 * ratio, 12 * ratio, 12 * ratio);
    context.fillStyle = "#292724";
    context.font = `${11 * ratio}px "Cascadia Mono", Consolas`;
    context.fillText(`A${anchor.id}`, x + 9 * ratio, y + 4 * ratio);
  }

  const point = selectedCalibrationPoint();
  for (const planPoint of state.calibration.plan?.points ?? []) {
    const position = canvasPoint(
      origin,
      scale,
      boundaryM + planPoint.distanceM,
      planPoint.angleDeg,
    );
    const capture = state.calibration.captures.get(planPoint.id);
    context.beginPath();
    context.arc(
      position.x,
      position.y,
      planPoint.id === point?.id ? 7 * ratio : 2.3 * ratio,
      0,
      Math.PI * 2,
    );
    context.fillStyle =
      planPoint.id === point?.id
        ? "#d35f39"
        : capture?.accepted
          ? "#51765e"
          : capture
            ? "#a64b4b"
            : "rgba(55,48,41,.28)";
    context.fill();
  }

  if (point) {
    const positionRadiusM = boundaryM + point.distanceM;
    const key = canvasPoint(
      origin,
      scale,
      positionRadiusM,
      point.angleDeg,
    );
    context.strokeStyle = "#d35f39";
    context.lineWidth = 2.5 * ratio;
    context.beginPath();
    context.moveTo(origin.x, origin.y);
    context.lineTo(key.x, key.y);
    context.stroke();
    context.fillStyle = "#d35f39";
    context.font = `${12 * ratio}px "Cascadia Mono", Consolas`;
    context.fillText(
      `${point.id}  边界${point.distanceM.toFixed(2)}m / 半径${positionRadiusM.toFixed(2)}m`,
      12 * ratio,
      18 * ratio,
    );
  }
}

function renderCalibrationPlan() {
  const plan = state.calibration.plan;
  if (!plan) {
    return;
  }
  const completed = [...state.calibration.captures.values()].filter(
    (capture) => capture.accepted,
  ).length;
  elements["calibration-plan-summary"].textContent =
    `${completed} / ${plan.points.length} 点可训练`;
  elements["calibration-progress"].setAttribute("aria-valuenow", String(completed));
  elements["calibration-progress"].querySelector("span").style.width =
    `${(completed / plan.points.length) * 100}%`;
  elements["calibration-plan"].innerHTML = plan.points
    .map((point, index) => {
      const capture = state.calibration.captures.get(point.id);
      const stateClass = capture
        ? capture.accepted
          ? "accepted"
          : "rejected"
        : "pending";
      const current =
        index === state.calibration.selectedIndex ? " current" : "";
      return `<button
        type="button"
        class="calibration-point ${stateClass}${current}"
        data-calibration-index="${index}"
        aria-label="第${point.index}点，边界距离${point.distanceM}米，角度${point.angleDeg}度，${capture?.accepted ? "可训练" : capture ? "需重采" : "未采集"}"
        title="${escapeHtml(point.id)} · ${escapeHtml(point.label)}"
      ><span>${String(point.index).padStart(2, "0")}</span><small>${point.distanceM}m<br>${point.angleDeg >= 0 ? "+" : ""}${point.angleDeg}°</small></button>`;
    })
    .join("");
  for (const button of elements["calibration-plan"].querySelectorAll(
    "[data-calibration-index]",
  )) {
    button.addEventListener("click", () => {
      state.calibration.selectedIndex = Number(button.dataset.calibrationIndex);
      renderCalibrationPlan();
      renderCalibrationPoint();
    });
  }
}

function humanCalibrationReason(reason, capture) {
  const anchor = capture?.perAnchor?.find(
    (item) => item.anchorId === reason.anchorId,
  );
  switch (reason.code) {
    case "ANCHOR_SAMPLE_SHORTAGE":
      return `A${reason.anchorId}仅${anchor?.synchronizedSamples ?? 0}组，至少100组；保持钥匙不动后重采。`;
    case "INSUFFICIENT_SYNCHRONIZED_SAMPLES":
      return `只有${capture?.synchronizedGroups ?? 0}组同地址同步数据，至少100组；保持钥匙不动并确认所有基站持续上报后重采。`;
    case "ADDRESS_MISMATCH":
      return "各路收到的钥匙地址不同；确认所有基站测的是同一把钥匙后重采。";
    case "ANCHOR_GEOMETRY_RESIDUAL":
      return `A${reason.anchorId}与摆放真值偏差${anchor?.residualCm?.toFixed(1) ?? "--"}cm；检查边界距离、角度和基站坐标后重采。`;
    case "ANCHOR_UNSTABLE":
      return `A${reason.anchorId}距离跳动过大；远离遮挡物，保持钥匙不动后重采。`;
    case "ANCHOR_LOW_SNR":
      return `A${reason.anchorId}信号太弱；调整天线朝向并保持无遮挡后重采。`;
    default:
      return reason.message ?? "此点不能进入训练，请检查摆放后重采。";
  }
}

function renderCalibrationQuality(capture) {
  if (!capture) {
    elements["calibration-quality-body"].innerHTML =
      '<tr class="empty-row"><td colspan="7">尚未采集当前点</td></tr>';
    elements["calibration-rejection-reasons"].innerHTML =
      "<li>按图摆放钥匙，点击“开始当前点”。</li>";
    return;
  }
  elements["calibration-quality-body"].innerHTML = (capture.perAnchor ?? [])
    .map((anchor) => {
      const failed =
        anchor.synchronizedSamples < 100 ||
        Math.abs(anchor.residualCm ?? 0) > 30 ||
        (anchor.spreadCm ?? 0) > 10 ||
        (anchor.snrDb !== null && anchor.snrDb < 3);
      return `<tr class="${failed ? "quality-fail" : "quality-pass"}">
        <td>A${anchor.anchorId}<small>${escapeHtml((anchor.addresses ?? []).join("/"))}</small></td>
        <td>${anchor.samples} 帧 / ${anchor.synchronizedSamples} 组</td>
        <td>${anchor.medianCm?.toFixed(1) ?? "--"} cm</td>
        <td>${anchor.spreadCm?.toFixed(1) ?? "--"} cm</td>
        <td>${anchor.snrDb?.toFixed(1) ?? "--"} dB</td>
        <td>${anchor.expectedDistanceCm?.toFixed(1) ?? "--"} cm</td>
        <td>${anchor.residualCm === null || anchor.residualCm === undefined ? "--" : `${anchor.residualCm >= 0 ? "+" : ""}${anchor.residualCm.toFixed(1)} cm`}</td>
      </tr>`;
    })
    .join("");
  const reasons = capture.recaptureReasons ?? [];
  elements["calibration-rejection-reasons"].innerHTML =
    reasons.length === 0
      ? "<li class=\"quality-pass-copy\">通过，可进入训练。移动到下一测点前先记住当前点号。</li>"
      : reasons
          .map(
            (reason) =>
              `<li>${escapeHtml(humanCalibrationReason(reason, capture))}</li>`,
          )
          .join("");
}

function renderCalibrationPoint() {
  const point = selectedCalibrationPoint();
  if (!point) return;
  elements["calibration-current-point"].textContent =
    `第 ${String(point.index).padStart(2, "0")} / 77 点 · 边界距离 ${point.distanceM.toFixed(2)} m · ${point.angleDeg >= 0 ? "+" : ""}${point.angleDeg}°`;
  renderCalibrationQuality(state.calibration.captures.get(point.id));
  drawCalibrationGeometry();
}

function calibrationRequestKey(action, pointId = "") {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${action}-${pointId}-${random}`;
}

async function captureCalibrationPoint() {
  const point = selectedCalibrationPoint();
  if (!point || state.calibration.busy) return;
  let anchors;
  try {
    anchors = parseAnchorCoordinates();
  } catch (error) {
    elements["calibration-status"].textContent = error.message;
    elements["calibration-status"].dataset.kind = "error";
    return;
  }
  const historyCaptureId = elements["calibration-history-capture"].value;
  setCalibrationBusy(true);
  elements["calibration-status"].dataset.kind = "recording";
  const startedAt = Date.now();
  const countdown = historyCaptureId
    ? null
    : window.setInterval(() => {
        const remaining = Math.max(
          0,
          15 - Math.floor((Date.now() - startedAt) / 1000),
        );
        elements["calibration-status"].textContent =
          `${point.id} · 还需保持不动 ${remaining}s`;
      }, 250);
  try {
    elements["calibration-status"].textContent = historyCaptureId
      ? `正在核对历史采集 ${historyCaptureId}`
      : `${point.id} · 保持钥匙不动 15s`;
    const capture = await apiRequest("/api/calibration/capture", {
      method: "POST",
      body: {
        pointId: point.id,
        distanceM: point.distanceM,
        angleDeg: point.angleDeg,
        boundaryOffsetMm: Number(
          elements["calibration-boundary-offset"].value,
        ),
        anchorCount: anchors.length,
        anchors,
        captureId: historyCaptureId || undefined,
        durationSeconds: 15,
        warmupSeconds: 2,
        minimumSynchronizedGroups: 100,
        synchronizationWindowMs: 120,
        idempotencyKey: calibrationRequestKey("capture", point.id),
      },
    });
    state.calibration.captures.set(point.id, capture);
    elements["calibration-status"].dataset.kind = capture.accepted
      ? "success"
      : "error";
    elements["calibration-status"].textContent = capture.accepted
      ? `${point.id} 通过，可移动到下一点`
      : `${point.id} 未通过，请按下方提示重采`;
    renderCalibrationPlan();
    renderCalibrationPoint();
    drawCalibrationReports();
  } catch (error) {
    elements["calibration-status"].dataset.kind = "error";
    elements["calibration-status"].textContent =
      `采集未完成：${error.message}。保持当前摆放，检查串口后重试。`;
  } finally {
    if (countdown) window.clearInterval(countdown);
    setCalibrationBusy(false);
  }
}

function drawReportFrame(canvas, title, subtitle = "等待训练结果") {
  const { ratio, width, height } = resizeCanvas(canvas);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#fbfaf7";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(55,48,41,.12)";
  context.lineWidth = ratio;
  for (let step = 1; step < 5; step += 1) {
    const y = (height * step) / 5;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  context.fillStyle = "#5e5953";
  context.font = `${12 * ratio}px "Cascadia Mono", Consolas`;
  context.fillText(title, 12 * ratio, 20 * ratio);
  context.fillStyle = "#8a847d";
  context.font = `${11 * ratio}px "Microsoft YaHei UI", sans-serif`;
  context.fillText(subtitle, 12 * ratio, height - 12 * ratio);
  return { context, ratio, width, height };
}

function drawCalibrationHeatmap(canvas, metricName) {
  const { context, ratio, width, height } = drawReportFrame(
    canvas,
    metricName,
    state.calibration.validation ? "独立验证结果" : "灰色=未采，绿=可训练，红=需重采",
  );
  const left = 26 * ratio;
  const top = 32 * ratio;
  const cellWidth = (width - left - 10 * ratio) / CALIBRATION_ANGLES_DEG.length;
  const cellHeight =
    (height - top - 28 * ratio) / CALIBRATION_DISTANCES_M.length;
  for (const [row, distanceM] of CALIBRATION_DISTANCES_M.entries()) {
    for (const [column, angleDeg] of CALIBRATION_ANGLES_DEG.entries()) {
      const point = state.calibration.plan?.points?.find(
        (item) => item.distanceM === distanceM && item.angleDeg === angleDeg,
      );
      const capture = point && state.calibration.captures.get(point.id);
      context.fillStyle = capture
        ? capture.accepted
          ? "rgba(81,118,94,.72)"
          : "rgba(166,75,75,.72)"
        : "rgba(138,128,116,.16)";
      context.fillRect(
        left + column * cellWidth + ratio,
        top + row * cellHeight + ratio,
        cellWidth - 2 * ratio,
        cellHeight - 2 * ratio,
      );
    }
  }
}

function drawBiasReport() {
  const canvas = elements["calibration-bias-chart"];
  const { context, ratio, width, height } = drawReportFrame(
    canvas,
    "各基站残差 / cm",
    "虚线为题目 ±30 cm 限值",
  );
  const captures = [...state.calibration.captures.values()];
  const anchorIds = [
    ...new Set(captures.flatMap((capture) => capture.perAnchor?.map((item) => item.anchorId) ?? [])),
  ];
  const values = anchorIds.map((anchorId) => {
    const residuals = captures
      .map((capture) =>
        capture.perAnchor?.find((item) => item.anchorId === anchorId)?.residualCm,
      )
      .filter(Number.isFinite);
    return residuals.length
      ? residuals.reduce((sum, value) => sum + value, 0) / residuals.length
      : 0;
  });
  const middle = height / 2;
  const scale = (height * 0.38) / 30;
  context.setLineDash([5 * ratio, 4 * ratio]);
  context.strokeStyle = "#a64b4b";
  for (const limit of [-30, 30]) {
    const y = middle - limit * scale;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  context.setLineDash([]);
  values.forEach((value, index) => {
    const barWidth = width / Math.max(4, values.length * 2);
    const x = ((index + 1) * width) / (values.length + 1) - barWidth / 2;
    const barHeight = Math.abs(value) * scale;
    context.fillStyle = Math.abs(value) > 30 ? "#a64b4b" : "#4e7d95";
    context.fillRect(
      x,
      value >= 0 ? middle - barHeight : middle,
      barWidth,
      barHeight,
    );
    context.fillStyle = "#292724";
    context.fillText(`A${anchorIds[index]}`, x, height - 28 * ratio);
  });
}

function drawCalibrationReports() {
  drawBiasReport();
  drawCalibrationHeatmap(
    elements["calibration-distance-heatmap"],
    "距离 P95 / 限值 ±0.30m",
  );
  drawCalibrationHeatmap(
    elements["calibration-angle-heatmap"],
    "角度 P95 / 限值 ±10°",
  );
  drawReportFrame(
    elements["calibration-trajectory-chart"],
    "真实轨迹 / 滤波轨迹",
    state.calibration.validation ? "验证轨迹已载入" : "训练后显示轨迹",
  );
  drawReportFrame(
    elements["calibration-dynamic-error-chart"],
    "距离误差 / 角度误差",
    "红线限值：±0.30m 与 ±10°",
  );
  const boundary = drawReportFrame(
    elements["calibration-boundary-chart"],
    "边界距离 / m",
    "1m 开锁边界，2m 迎宾边界",
  );
  for (const [distanceM, color] of [
    [1, "#51765e"],
    [2, "#d97757"],
  ]) {
    const y = boundary.height - (distanceM / 3) * boundary.height;
    boundary.context.strokeStyle = color;
    boundary.context.lineWidth = 2 * boundary.ratio;
    boundary.context.beginPath();
    boundary.context.moveTo(0, y);
    boundary.context.lineTo(boundary.width, y);
    boundary.context.stroke();
  }
}

async function trainCalibration() {
  if (state.calibration.busy) return;
  const accepted = [...state.calibration.captures.values()].filter(
    (capture) => capture.accepted,
  );
  if (accepted.length === 0) {
    elements["calibration-status"].dataset.kind = "error";
    elements["calibration-status"].textContent =
      "还没有可训练测点；先完成一个通过质量检查的点。";
    return;
  }
  setCalibrationBusy(true);
  try {
    elements["calibration-status"].dataset.kind = "recording";
    elements["calibration-status"].textContent =
      `正在迭代训练，已提供 ${accepted.length} 个合格点…`;
    const result = await apiRequest("/api/calibration/train", {
      method: "POST",
      body: {
        anchors: parseAnchorCoordinates(),
        boundaryOffsetMm: Number(
          elements["calibration-boundary-offset"].value,
        ),
        idempotencyKey: calibrationRequestKey("train"),
      },
    });
    state.calibration.model = result.model ?? result;
    elements["calibration-status"].dataset.kind = "success";
    elements["calibration-status"].textContent =
      "训练完成；请用独立摆放点执行验证。";
    drawCalibrationReports();
  } catch (error) {
    elements["calibration-status"].dataset.kind = "error";
    elements["calibration-status"].textContent =
      `训练未完成：${error.message}`;
  } finally {
    setCalibrationBusy(false);
  }
}

async function validateCalibration() {
  if (state.calibration.busy) return;
  setCalibrationBusy(true);
  try {
    elements["calibration-status"].dataset.kind = "recording";
    elements["calibration-status"].textContent = "正在生成独立验证报告…";
    state.calibration.validation = await apiRequest(
      "/api/calibration/validate",
      {
        method: "POST",
        body: {
          model: state.calibration.model,
          idempotencyKey: calibrationRequestKey("validate"),
        },
      },
    );
    elements["calibration-status"].dataset.kind =
      state.calibration.validation.passed === false ? "error" : "success";
    elements["calibration-status"].textContent =
      state.calibration.validation.passed === false
        ? "验证未通过；按报告中的红色测点补采。"
        : "验证完成；请核对距离、角度和 1m/2m 边界指标。";
    drawCalibrationReports();
  } catch (error) {
    elements["calibration-status"].dataset.kind = "error";
    elements["calibration-status"].textContent =
      `验证未完成：${error.message}`;
  } finally {
    setCalibrationBusy(false);
  }
}

function downloadBlob(filename, content, type) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function exportCalibrationJson() {
  downloadBlob(
    "uwb-calibration-report.json",
    `${JSON.stringify(
      {
        plan: state.calibration.plan,
        captures: [...state.calibration.captures.values()],
        model: state.calibration.model,
        validation: state.calibration.validation,
      },
      null,
      2,
    )}\n`,
    "application/json",
  );
}

function exportCalibrationCsv() {
  const rows = [
    [
      "point_id",
      "radial_distance_m",
      "angle_deg",
      "anchor",
      "raw_samples",
      "synchronized_samples",
      "median_cm",
      "spread_cm",
      "snr_db",
      "expected_cm",
      "residual_cm",
      "accepted",
    ],
  ];
  for (const capture of state.calibration.captures.values()) {
    for (const anchor of capture.perAnchor ?? []) {
      rows.push([
        capture.pointId,
        capture.distanceM,
        capture.angleDeg,
        anchor.anchorId,
        anchor.samples,
        anchor.synchronizedSamples,
        anchor.medianCm,
        anchor.spreadCm,
        anchor.snrDb,
        anchor.expectedDistanceCm,
        anchor.residualCm,
        capture.accepted,
      ]);
    }
  }
  downloadBlob(
    "uwb-calibration-report.csv",
    `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`,
    "text/csv;charset=utf-8",
  );
}

function exportCalibrationPng() {
  const sourceCanvases = [
    "calibration-bias-chart",
    "calibration-distance-heatmap",
    "calibration-angle-heatmap",
    "calibration-trajectory-chart",
    "calibration-dynamic-error-chart",
    "calibration-boundary-chart",
  ].map((id) => elements[id]);
  const report = document.createElement("canvas");
  report.width = 1200;
  report.height = 960;
  const context = report.getContext("2d");
  context.fillStyle = "#f7f6f2";
  context.fillRect(0, 0, report.width, report.height);
  sourceCanvases.forEach((canvas, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    context.drawImage(canvas, column * 600, row * 320, 600, 320);
  });
  const link = document.createElement("a");
  link.href = report.toDataURL("image/png");
  link.download = "uwb-calibration-report.png";
  link.click();
}

async function exportCalibrationC() {
  if (state.calibration.busy) return;
  setCalibrationBusy(true);
  try {
    const result = await apiRequest("/api/calibration/export", {
      method: "POST",
      body: {
        model: state.calibration.model,
        name: "calibration_model_data",
        idempotencyKey: calibrationRequestKey("export"),
      },
    });
    downloadBlob(
      result.headerFileName ?? "calibration_model_data.h",
      result.header,
      "text/x-c;charset=utf-8",
    );
    downloadBlob(
      result.sourceFileName ?? "calibration_model_data.c",
      result.source,
      "text/x-c;charset=utf-8",
    );
    elements["calibration-status"].dataset.kind = "success";
    elements["calibration-status"].textContent =
      "MSPM0 C 模型已导出（.h / .c）。";
  } catch (error) {
    elements["calibration-status"].dataset.kind = "error";
    elements["calibration-status"].textContent =
      `模型导出失败：${error.message}`;
  } finally {
    setCalibrationBusy(false);
  }
}

async function loadCalibrationHistory() {
  const captures = await apiRequest("/api/captures");
  elements["calibration-history-capture"].innerHTML = [
    '<option value="">现场采集（15 秒）</option>',
    ...captures.map(
      (capture) =>
        `<option value="${escapeHtml(capture.id)}">核对历史：${escapeHtml(capture.label)} · ${capture.frameCount ?? 0}帧</option>`,
    ),
  ].join("");
}

async function initializeCalibration() {
  state.calibration.plan = await apiRequest("/api/calibration/plan");
  renderCalibrationPlan();
  renderCalibrationPoint();
  drawCalibrationReports();
  await loadCalibrationHistory();
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

function renderCapture() {
  const connected = state.status?.connected === true;
  const capture = state.status?.capture ?? null;
  const recording = capture?.status === "recording";

  elements["capture-button"].disabled = !connected || recording;
  elements["capture-label"].disabled = recording;
  elements["capture-button"].textContent = recording
    ? `记录中 ${capture.remainingSeconds ?? 0}s`
    : "采集45秒";

  if (recording) {
    state.lastCaptureId = capture.id;
    elements["capture-download-button"].disabled = true;
    elements["capture-status"].dataset.kind = "recording";
    elements["capture-status"].textContent =
      `正在保存：${capture.label} · ${capture.frameCount ?? 0}帧`;
    return;
  }

  if (capture?.status === "completed") {
    state.lastCaptureId = capture.id;
    elements["capture-download-button"].disabled = false;
    elements["capture-status"].dataset.kind = "success";
    elements["capture-status"].textContent =
      `已保存：${capture.label} · ${capture.frameCount ?? 0}帧`;
    return;
  }

  if (capture?.status === "interrupted") {
    state.lastCaptureId = capture.id;
    elements["capture-download-button"].disabled =
      (capture.frameCount ?? 0) === 0;
    elements["capture-status"].dataset.kind = "error";
    elements["capture-status"].textContent =
      `采集中断：${capture.label} · 已保存${capture.frameCount ?? 0}帧`;
    return;
  }

  elements["capture-download-button"].disabled = !state.lastCaptureId;
  elements["capture-status"].dataset.kind = "";
  elements["capture-status"].textContent = connected
    ? "填写测点名称后开始"
    : "连接串口后可开始";
}

function render() {
  for (let device = 1; device <= 5; device += 1) {
    renderChannel(device);
  }
  renderDifference();
  renderCalibratedPosition();
  renderTable();
  renderChart();
  renderStatus();
  renderCapture();
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

async function refreshFinalCalibration() {
  state.finalCalibration = await apiRequest("/api/calibration/final");
  renderCalibratedPosition();
}

async function refreshPosition() {
  const estimate = await apiRequest("/api/position");
  state.position.latest = estimate;
  if (estimate.valid) {
    const alpha = 0.28;
    state.position.smoothedDistanceM =
      state.position.smoothedDistanceM === null
        ? estimate.distanceM
        : state.position.smoothedDistanceM * (1 - alpha) +
          estimate.distanceM * alpha;
    if (estimate.angleValid) {
      state.position.smoothedAngleDeg =
        state.position.smoothedAngleDeg === null
          ? estimate.angleDeg
          : state.position.smoothedAngleDeg * (1 - alpha) +
            estimate.angleDeg * alpha;
    }
  }
  renderCalibratedPosition();
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

async function startCapture() {
  const label = elements["capture-label"].value.trim();
  if (!label) {
    elements["capture-status"].dataset.kind = "error";
    elements["capture-status"].textContent = "请先填写测点名称";
    elements["capture-label"].focus();
    return;
  }
  try {
    const capture = await apiRequest("/api/captures", {
      method: "POST",
      body: { label, durationSeconds: 45 },
    });
    state.lastCaptureId = capture.id;
    state.status = {
      ...(state.status ?? {}),
      capture,
    };
    renderCapture();
  } catch (error) {
    elements["capture-status"].dataset.kind = "error";
    elements["capture-status"].textContent = `采集失败：${error.message}`;
  }
}

async function downloadCaptureCsv() {
  if (!state.lastCaptureId) {
    return;
  }
  try {
    const response = await apiRequest(
      `/api/captures/${encodeURIComponent(state.lastCaptureId)}/export.csv`,
      { raw: true },
    );
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    const safeLabel =
      elements["capture-label"].value.trim().replace(/[\\/:*?"<>|]+/g, "-") ||
      state.lastCaptureId;
    link.download = `uwb-${safeLabel}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) {
    elements["capture-status"].dataset.kind = "error";
    elements["capture-status"].textContent = `下载失败：${error.message}`;
  }
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
      await refreshPosition();
    } else if (state.position.latest?.valid) {
      state.position.latest = {
        valid: false,
        reason: "串口已断开",
      };
      state.position.smoothedDistanceM = null;
      state.position.smoothedAngleDeg = null;
      renderCalibratedPosition();
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
    calibration: "自动标定",
    configuration: "参数设置",
    records: "数据记录",
    console: "串口终端",
    connect: "选择串口",
  },
  en: {
    title: "Ranging workbench",
    monitor: "Live monitor",
    calibration: "Calibration",
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
  [
    copy.monitor,
    copy.calibration,
    copy.configuration,
    copy.records,
    copy.console,
  ].forEach(
    (text, index) => {
      const icon = links[index].querySelector("span")?.outerHTML ?? "";
      links[index].innerHTML = `${icon}${text}`;
    },
  );
  elements["connect-button"].textContent = copy.connect;
  elements["language-button"].textContent =
    state.language === "zh" ? "中文 / English" : "English / 中文";
}

function activatePage(pageId, { updateHash = true } = {}) {
  const sections = [...document.querySelectorAll(".page-section")];
  const requested = String(pageId ?? "").replace(/^#/, "");
  const active =
    sections.find((section) => section.id === requested) ?? sections[0];
  for (const section of sections) {
    section.classList.toggle("active-page", section === active);
    section.setAttribute("aria-hidden", String(section !== active));
  }
  for (const link of document.querySelectorAll(".nav-link")) {
    const selected = link.getAttribute("href") === `#${active.id}`;
    link.classList.toggle("active", selected);
    if (selected) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
  if (updateHash && window.location.hash !== `#${active.id}`) {
    window.history.pushState(null, "", `#${active.id}`);
  }
  window.requestAnimationFrame(() => {
    renderChart();
    drawCalibrationGeometry();
    drawCalibrationReports();
  });
}

elements["connect-button"].addEventListener("click", connectSerial);
elements["disconnect-button"].addEventListener("click", disconnectSerial);
elements["refresh-ports-button"].addEventListener("click", refreshPorts);
elements["pause-button"].addEventListener("click", togglePause);
elements["export-button"].addEventListener("click", exportCsv);
elements["capture-button"].addEventListener("click", startCapture);
elements["capture-download-button"].addEventListener(
  "click",
  downloadCaptureCsv,
);
elements["calibration-start-button"].addEventListener(
  "click",
  captureCalibrationPoint,
);
elements["calibration-recapture-button"].addEventListener(
  "click",
  captureCalibrationPoint,
);
elements["calibration-train-button"].addEventListener(
  "click",
  trainCalibration,
);
elements["calibration-validate-button"].addEventListener(
  "click",
  validateCalibration,
);
elements["calibration-export-c-button"].addEventListener(
  "click",
  exportCalibrationC,
);
elements["calibration-export-png-button"].addEventListener(
  "click",
  exportCalibrationPng,
);
elements["calibration-export-csv-button"].addEventListener(
  "click",
  exportCalibrationCsv,
);
elements["calibration-export-json-button"].addEventListener(
  "click",
  exportCalibrationJson,
);
elements["calibration-anchor-count"].addEventListener(
  "change",
  drawCalibrationGeometry,
);
elements["calibration-anchor-coordinates"].addEventListener(
  "change",
  drawCalibrationGeometry,
);
elements["calibration-boundary-offset"].addEventListener(
  "change",
  drawCalibrationGeometry,
);
elements["calibration-plan"].addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
    return;
  }
  event.preventDefault();
  const step =
    event.key === "ArrowLeft"
      ? -1
      : event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp"
          ? -7
          : 7;
  const pointCount = state.calibration.plan?.points?.length ?? 0;
  state.calibration.selectedIndex = Math.min(
    Math.max(state.calibration.selectedIndex + step, 0),
    pointCount - 1,
  );
  renderCalibrationPlan();
  renderCalibrationPoint();
  elements["calibration-plan"]
    .querySelector(`[data-calibration-index="${state.calibration.selectedIndex}"]`)
    ?.focus();
});
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
for (const link of document.querySelectorAll(".nav-link")) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    activatePage(link.getAttribute("href"));
  });
}
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
window.addEventListener("resize", () => {
  renderChart();
  drawCalibrationGeometry();
  drawCalibrationReports();
});
window.addEventListener("hashchange", () => {
  activatePage(window.location.hash, { updateHash: false });
});

async function initialize() {
  setCommandButtonsDisabled(true);
  try {
    await refreshPorts();
    await refreshStatus();
    await refreshFinalCalibration();
    await refreshSessions(state.activeSessionId ?? "");
    await initializeCalibration().catch((error) => {
      elements["calibration-status"].dataset.kind = "error";
      elements["calibration-status"].textContent =
        `标定服务未就绪：${error.message}`;
    });
    if (!state.status?.connected && elements["session-select"].value) {
      await loadSelectedSession();
    }
    activatePage(window.location.hash || "#monitor", { updateHash: false });
    render();
  } catch (error) {
    elements["connection-status"].textContent =
      `采集服务未启动：${error.message}`;
    elements["save-status"].textContent = "请双击 start.cmd 启动服务";
  }
  window.setInterval(pollRealtime, 300);
}

void initialize();
