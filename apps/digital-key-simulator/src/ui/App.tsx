import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { agentClient } from "./agent-client";
import { createFittedPositionFrame } from "../domain/live-position.mjs";
import {
  DigitalKeyScene,
  type ScenePoint,
} from "./DigitalKeyScene";
import { CalibrationWorkbench } from "./CalibrationWorkbench";

type WorkbenchMode = "live" | "replay" | "simulation" | "calibration";
type BottomTab = "timeline" | "serial" | "configuration" | "records";
type ConsolePage = "status" | "link" | "tools" | "events";
type LockState = "locked" | "welcome" | "unlocked";
type FaultKind = "none" | "anchor" | "multipath" | "id" | "timeout";

interface TimelineItem {
  id: string;
  time: string;
  kind: "RX" | "TX" | "SYS" | "ERR";
  message: string;
}

interface AnchorMetric {
  id: "1" | "2" | "3";
  distance: number;
  snr: number;
}

interface SerialPortOption {
  path: string;
  manufacturer?: string;
}

interface LivePositionFrame {
  valid: boolean;
  positionMode: "fitted-2d" | "range-only" | "unavailable";
  distanceM: number | null;
  angleValid: boolean;
  angleDeg: number | null;
  xM: number | null;
  yM: number | null;
  plotX: number | null;
  plotY: number | null;
  confidencePercent: number;
  quality: string;
  source: string;
  sampleCount: number;
  usedAnchors: string[];
  anchors: Array<Record<string, unknown>>;
  expectedErrorM: number | null;
  calibratedRangeM: Record<string, unknown> | null;
  calibratedAngleDeg: Record<string, unknown> | null;
  keyId: number | null;
  reason: string | null;
  receivedAt: string;
}

const anchorPositions = [
  { id: "1" as const, x: -0.18, y: 0.22 },
  { id: "2" as const, x: 0.18, y: 0.22 },
  { id: "3" as const, x: 0, y: -0.22 },
];

const scenarioPresets = [
  { label: "标准进场", x: 0.08, y: 0.78, seed: 20260730 },
  { label: "左侧边界", x: -1.82, y: 1.86, seed: 20260731 },
  { label: "右侧边界", x: 1.82, y: 1.86, seed: 20260732 },
  { label: "远场靠墙", x: 0.34, y: 2.72, seed: 20260733 },
];

const faultPresets: Array<{ label: string; value: FaultKind }> = [
  { label: "无故障", value: "none" },
  { label: "锚点 B 丢失", value: "anchor" },
  { label: "墙面多径", value: "multipath" },
  { label: "ID 不匹配", value: "id" },
  { label: "数据超时", value: "timeout" },
];

function timeLabel(value = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);
}

function idFromBits(bits: boolean[]) {
  return bits.reduce((value, bit) => (value << 1) | Number(bit), 0);
}

function bitsFromId(id: number) {
  return [3, 2, 1, 0].map((shift) => Boolean((id >> shift) & 1));
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function domainData(value: unknown) {
  const outer = recordOf(value);
  return recordOf(outer?.data) ?? outer;
}

function eventList(value: unknown) {
  if (Array.isArray(value)) {
    return value;
  }
  const outer = recordOf(value);
  return Array.isArray(outer?.events) ? outer.events : [];
}

function serialPortList(value: unknown): SerialPortOption[] {
  const outer = recordOf(value);
  const source = Array.isArray(value)
    ? value
    : Array.isArray(outer?.data)
      ? outer.data
      : [];
  return source
    .map((item) => recordOf(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      path: String(item.path ?? ""),
      manufacturer:
        typeof item.manufacturer === "string" ? item.manufacturer : undefined,
    }))
    .filter((item) => item.path.length > 0);
}

export function App() {
  const [mode, setMode] = useState<WorkbenchMode>("live");
  const [tab, setTab] = useState<BottomTab>("timeline");
  const [consolePage, setConsolePage] = useState<ConsolePage>("status");
  const [position, setPosition] = useState<ScenePoint>({ x: 0.18, y: 1.42 });
  const [idBits, setIdBits] = useState(bitsFromId(0x0a));
  const [expectedId, setExpectedId] = useState(0x0a);
  const [fault, setFault] = useState<FaultKind>("none");
  const [connected, setConnected] = useState(false);
  const [lifecycle, setLifecycle] = useState("paused");
  const [busy, setBusy] = useState<string | null>(null);
  const [port, setPort] = useState("LIVE://UWB-RECORDER");
  const [baudRate, setBaudRate] = useState(115200);
  const [serialPorts, setSerialPorts] = useState<SerialPortOption[]>([]);
  const [serialPath, setSerialPath] = useState("");
  const [commandText, setCommandText] = useState("");
  const [announcement, setAnnouncement] = useState(
    "工作台已就绪，等待 Agent 服务",
  );
  const [eventCursor, setEventCursor] = useState(0);
  const [timeline, setTimeline] = useState<TimelineItem[]>([
    {
      id: "boot",
      time: timeLabel(),
      kind: "SYS",
      message: "本地仪器视图已启动，正在握手 Agent v1",
    },
  ]);
  const [records, setRecords] = useState<Array<Record<string, unknown>>>([]);
  const [liveMonitoring, setLiveMonitoring] = useState(true);
  const [liveFrame, setLiveFrame] = useState<LivePositionFrame | null>(null);
  const [recorderStatus, setRecorderStatus] =
    useState<Record<string, unknown> | null>(null);
  const [calibrationStatus, setCalibrationStatus] =
    useState<Record<string, unknown> | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  const moveTimer = useRef<number | null>(null);
  const liveRequestActive = useRef(false);

  const selectedId = idFromBits(idBits);
  const radialDistance =
    mode === "live" && liveFrame?.valid
      ? Number(liveFrame.distanceM)
      : Math.max(
          0,
          Math.hypot(position.x, position.y) - 0.3,
        );
  const bearing =
    mode === "live"
      ? liveFrame?.angleValid
        ? Number(liveFrame.angleDeg)
        : null
      : (Math.atan2(position.x, position.y) * 180) / Math.PI;
  const liveKeyId = liveFrame?.keyId;
  const idAuthorized =
    mode === "live"
      ? liveKeyId !== null &&
        liveKeyId !== undefined &&
        liveKeyId === expectedId
      : selectedId === expectedId && fault !== "id";
  const bearingInside =
    bearing !== null && Number.isFinite(bearing) && Math.abs(bearing) <= 45;

  const anchorMetrics = useMemo<AnchorMetric[]>(() => {
    if (mode === "live" && liveFrame?.anchors.length) {
      return liveFrame.anchors.slice(0, 3).map((anchor, index) => ({
        id: String(anchor.anchorId ?? `A${index + 1}`)
          .replace(/^A/i, "") as AnchorMetric["id"],
        distance:
          Number(anchor.medianMm ?? anchor.distanceMm ?? 0) / 1000,
        snr: Number(anchor.snrDb ?? -99),
      }));
    }
    return anchorPositions.map((anchor, index) => ({
        id: anchor.id,
        distance: Math.hypot(
          position.x - anchor.x,
          position.y - anchor.y,
        ),
        snr:
          fault === "anchor" && anchor.id === "2"
            ? -99
            : 16.8 - radialDistance * 2.1 - index * 0.7,
      }));
  }, [fault, liveFrame, mode, position, radialDistance]);

  const latestMeasurementAt = useMemo(() => {
    const latest = recordOf(recorderStatus?.latestByDevice);
    if (!latest) {
      return null;
    }
    const timestamps = Object.values(latest)
      .map((item) => recordOf(item)?.timestamp)
      .map((value) => Date.parse(String(value ?? "")))
      .filter(Number.isFinite);
    return timestamps.length > 0 ? Math.max(...timestamps) : null;
  }, [recorderStatus]);
  const dataAgeMs =
    latestMeasurementAt === null ? null : Math.max(0, clock - latestMeasurementAt);
  const recorderConnected = recorderStatus?.connected === true;
  const dataFresh =
    recorderConnected && dataAgeMs !== null && dataAgeMs <= 2000;
  const modelReady = calibrationStatus?.ready === true;
  const lockState: LockState =
    fault === "timeout" ||
    !idAuthorized ||
    (mode === "live" &&
      (!bearingInside || !dataFresh || liveFrame?.valid !== true))
      ? "locked"
      : radialDistance <= 1
        ? "unlocked"
        : radialDistance <= 2
          ? "welcome"
          : "locked";

  const appendTimeline = useCallback(
    (kind: TimelineItem["kind"], message: string) => {
      setTimeline((current) =>
        [
          ...current,
          {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            time: timeLabel(),
            kind,
            message,
          },
        ].slice(-80),
      );
    },
    [],
  );

  const applyState = useCallback((payload: unknown) => {
    const data = domainData(payload);
    if (!data) {
      return;
    }
    const key = recordOf(data.key);
    if (key) {
      const xMm = Number(key.xMm);
      const yMm = Number(key.yMm);
      if (Number.isFinite(xMm) && Number.isFinite(yMm)) {
        setPosition({ x: xMm / 1000, y: yMm / 1000 });
      }
      const keyAddress = Number(key.keyAddress);
      if (Number.isInteger(keyAddress)) {
        setIdBits(bitsFromId(keyAddress & 0x0f));
      }
    }
    const nextExpectedId = Number(data.expectedId);
    if (Number.isInteger(nextExpectedId)) {
      setExpectedId(nextExpectedId & 0x0f);
    }
    if (
      typeof data.faultProfile === "string" &&
      ["none", "anchor", "multipath", "id", "timeout"].includes(
        data.faultProfile,
      )
    ) {
      setFault(data.faultProfile as FaultKind);
    }
    if (typeof data.lifecycle === "string") {
      setLifecycle(data.lifecycle);
      setConnected(true);
    }
  }, []);

  const runCommand = useCallback(
    async (
      operation: string,
      argumentsValue: Record<string, unknown>,
      successText: string,
    ) => {
      setBusy(operation);
      appendTimeline("TX", `${operation} ${JSON.stringify(argumentsValue)}`);
      try {
        const result = await agentClient.execute(operation, argumentsValue);
        applyState(result);
        setConnected(true);
        setAnnouncement(successText);
        appendTimeline("SYS", successText);
        return result;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "未知 Agent 错误";
        setConnected(false);
        setAnnouncement(`操作未送达：${message}`);
        appendTimeline("ERR", `${operation} · ${message}`);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [appendTimeline, applyState],
  );

  const runQuery = useCallback(
    async (operation: string, argumentsValue: Record<string, unknown> = {}) => {
      setBusy(operation);
      appendTimeline("TX", `${operation} query`);
      try {
        const result = await agentClient.query(operation, argumentsValue);
        applyState(result);
        setConnected(true);
        setAnnouncement(`${operation} 已更新`);
        appendTimeline("RX", `${operation} 返回数据`);
        return result;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "未知 Agent 错误";
        setConnected(false);
        setAnnouncement(`查询失败：${message}`);
        appendTimeline("ERR", `${operation} · ${message}`);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [appendTimeline, applyState],
  );

  const applyLivePosition = useCallback((payload: unknown) => {
    const data = domainData(payload) ?? {};
    const frame = createFittedPositionFrame(data) as LivePositionFrame;
    setLiveFrame(frame);
    if (frame.plotX !== null && frame.plotY !== null) {
      setPosition({ x: frame.plotX, y: frame.plotY });
    }
    if (frame.keyId !== null) {
      setIdBits(bitsFromId(frame.keyId & 0x0f));
    }
    return frame;
  }, []);

  const applyRecorderStatus = useCallback((payload: unknown) => {
    const status = domainData(payload);
    if (!status) {
      return null;
    }
    setRecorderStatus(status);
    if (typeof status.port === "string" && status.port.length > 0) {
      setSerialPath(status.port);
    }
    const statusBaudRate = Number(status.baudRate);
    if (Number.isFinite(statusBaudRate)) {
      setBaudRate(statusBaudRate);
    }
    return status;
  }, []);

  const loadSerialPorts = useCallback(async () => {
    setBusy("device.ports.list");
    try {
      const result = await agentClient.query("device.ports.list", {});
      const ports = serialPortList(result);
      setSerialPorts(ports);
      if (ports.length > 0) {
        setSerialPath((current) =>
          ports.some((item) => item.path === current)
            ? current
            : ports[0].path,
        );
      }
      setAnnouncement(
        ports.length > 0 ? `发现 ${ports.length} 个串口` : "没有发现可用串口",
      );
      return ports;
    } catch (error) {
      const message = error instanceof Error ? error.message : "串口扫描失败";
      setAnnouncement(message);
      appendTimeline("ERR", `device.ports.list · ${message}`);
      return [];
    } finally {
      setBusy(null);
    }
  }, [appendTimeline]);

  const connectSerial = useCallback(async () => {
    if (!serialPath) {
      setAnnouncement("请先扫描并选择串口");
      return;
    }
    setBusy("device.serial.connect");
    try {
      const result = await agentClient.execute("device.serial.connect", {
        path: serialPath,
        baudRate,
      });
      applyRecorderStatus(result);
      setAnnouncement(`${serialPath} 已连接`);
      appendTimeline("SYS", `${serialPath} @ ${baudRate} 已连接`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "串口连接失败";
      setAnnouncement(message);
      appendTimeline("ERR", `device.serial.connect · ${message}`);
    } finally {
      setBusy(null);
    }
  }, [
    appendTimeline,
    applyRecorderStatus,
    baudRate,
    serialPath,
  ]);

  const disconnectSerial = useCallback(async () => {
    setBusy("device.serial.disconnect");
    try {
      const result = await agentClient.execute("device.serial.disconnect", {});
      applyRecorderStatus(result);
      setLiveFrame(null);
      setAnnouncement("串口已断开");
      appendTimeline("SYS", "串口已断开");
    } catch (error) {
      const message = error instanceof Error ? error.message : "串口断开失败";
      setAnnouncement(message);
      appendTimeline("ERR", `device.serial.disconnect · ${message}`);
    } finally {
      setBusy(null);
    }
  }, [appendTimeline, applyRecorderStatus]);

  const refreshLivePosition = useCallback(
    async ({
      silent = false,
      includeCalibration = false,
    }: {
      silent?: boolean;
      includeCalibration?: boolean;
    } = {}) => {
      if (liveRequestActive.current) {
        return;
      }
      liveRequestActive.current = true;
      if (!silent) {
        setBusy("recorder.position.get");
      }
      try {
        const requests = [
          agentClient.query("recorder.position.get", {}),
          agentClient.query("recorder.status.get", {}),
          ...(includeCalibration
            ? [agentClient.query("recorder.calibration.get", {})]
            : []),
        ];
        const [positionResult, statusResult, calibrationResult] =
          await Promise.allSettled(requests);

        if (statusResult.status === "fulfilled") {
          applyRecorderStatus(statusResult.value);
        }
        if (calibrationResult?.status === "fulfilled") {
          const calibration = domainData(calibrationResult.value);
          if (calibration) {
            setCalibrationStatus(calibration);
          }
        }
        if (positionResult.status === "rejected") {
          throw positionResult.reason;
        }

        const frame = applyLivePosition(positionResult.value);
        setConnected(true);
        setLiveError(null);
        if (!silent) {
          const message = frame.valid
            ? frame.angleValid
              ? "已读取电脑拟合后的二维位置"
              : "已读取拟合距离，当前方向数据无效"
            : frame.reason ?? "尚未得到有效拟合位置";
          setAnnouncement(message);
          appendTimeline(frame.valid ? "RX" : "ERR", message);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "无法读取最终位置";
        setLiveFrame(null);
        setConnected(false);
        setLiveError(message);
        if (!silent) {
          setAnnouncement(`实机数据读取失败：${message}`);
          appendTimeline("ERR", `recorder.position.get · ${message}`);
        }
      } finally {
        liveRequestActive.current = false;
        if (!silent) {
          setBusy(null);
        }
      }
    },
    [appendTimeline, applyLivePosition, applyRecorderStatus],
  );

  useEffect(() => {
    let cancelled = false;
    void agentClient.registry().then(() => {
      if (cancelled) {
        return;
      }
      setConnected(true);
      setAnnouncement("Agent v1 已连接，正在读取电脑拟合结果");
      appendTimeline("SYS", "Agent v1 已连接，实机监看通道就绪");
      void loadSerialPorts();
      void refreshLivePosition({ includeCalibration: true });
    }).catch(() => {
      if (!cancelled) {
        setConnected(false);
        setAnnouncement("Agent 服务未连接，实机数据暂不可用");
        appendTimeline("ERR", "Agent v1 暂不可用");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [appendTimeline, loadSerialPorts, refreshLivePosition]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (mode !== "live" || !liveMonitoring) {
      return;
    }
    void refreshLivePosition({ silent: true, includeCalibration: true });
    const positionTimer = window.setInterval(() => {
      void refreshLivePosition({ silent: true });
    }, 500);
    const calibrationTimer = window.setInterval(() => {
      void refreshLivePosition({ silent: true, includeCalibration: true });
    }, 5000);
    return () => {
      window.clearInterval(positionTimer);
      window.clearInterval(calibrationTimer);
    };
  }, [liveMonitoring, mode, refreshLivePosition]);

  useEffect(() => {
    let disposed = false;
    const timer = window.setInterval(() => {
      void agentClient
        .events(eventCursor, 100)
        .then((payload) => {
          if (disposed) {
            return;
          }
          const events = eventList(payload);
          if (events.length === 0) {
            return;
          }
          for (const event of events) {
            const item = recordOf(event);
            if (!item) {
              continue;
            }
            const sequence = Number(item.sequence ?? item.seq);
            if (Number.isFinite(sequence)) {
              setEventCursor((current) => Math.max(current, sequence));
            }
            const type = String(item.type ?? "event");
            const eventPayload = recordOf(item.payload);
            appendTimeline(
              type.includes("failed") ? "ERR" : "RX",
              `${type}${eventPayload ? ` · ${JSON.stringify(eventPayload)}` : ""}`,
            );
          }
        })
        .catch(() => {
          // 首次握手已经提供可见错误；轮询失败不重复刷屏。
        });
    }, 1200);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [appendTimeline, eventCursor]);

  function setWorkbenchMode(nextMode: WorkbenchMode) {
    setMode(nextMode);
    setConsolePage("status");
    if (nextMode === "live") {
      setPort("LIVE://UWB-RECORDER");
      setLifecycle("monitoring");
      setLiveMonitoring(true);
      setTab("timeline");
      setAnnouncement("实机监看已启动，读取电脑拟合后的最终位置");
      void refreshLivePosition({ includeCalibration: true });
      return;
    }
    setLiveMonitoring(false);
    if (nextMode === "calibration") {
      setPort("CAL://FIELD-AGENT");
      setLifecycle("paused");
      setTab("timeline");
      setAnnouncement("现场标定模式已打开，请先核对基站坐标和钥匙真值");
      return;
    }
    if (nextMode === "replay") {
      setPort("REPLAY://LOCAL");
      setLifecycle("paused");
      setTab("records");
      void loadRecords();
      setAnnouncement("回放模式已打开，请在记录页选择本机会话");
      return;
    }
    setPort("SIM://KEYFIELD");
    setLifecycle("paused");
    void runCommand(
      "simulation.lifecycle.set",
      { state: "paused" },
      "仿真模式已启用，可拖动钥匙或运行固定场景",
    );
  }

  function moveKey(nextPosition: ScenePoint) {
    setPosition(nextPosition);
    if (moveTimer.current) {
      window.clearTimeout(moveTimer.current);
    }
    moveTimer.current = window.setTimeout(() => {
      void runCommand(
        "simulation.key.setPose",
        {
          xMm: Math.round(nextPosition.x * 1000),
          yMm: Math.round(nextPosition.y * 1000),
          active: true,
          keyAddress: 0x1110 | selectedId,
        },
        `钥匙位置已更新为 ${nextPosition.x.toFixed(2)}, ${nextPosition.y.toFixed(2)} 米`,
      );
    }, 180);
  }

  function toggleIdBit(index: number) {
    const nextBits = idBits.map((bit, bitIndex) =>
      bitIndex === index ? !bit : bit,
    );
    setIdBits(nextBits);
    const nextId = idFromBits(nextBits);
    void runCommand(
      "simulation.key.setPose",
      {
        xMm: Math.round(position.x * 1000),
        yMm: Math.round(position.y * 1000),
        active: true,
        keyAddress: 0x1110 | nextId,
      },
      `钥匙 ID 已切换为 ${nextBits.map(Number).join("")}`,
    );
  }

  function applyScenario(preset: (typeof scenarioPresets)[number]) {
    setPosition({ x: preset.x, y: preset.y });
    void runCommand(
      "simulation.key.setPose",
      {
        xMm: Math.round(preset.x * 1000),
        yMm: Math.round(preset.y * 1000),
        active: true,
        keyAddress: 0x1110 | selectedId,
      },
      `已布置场景：${preset.label}`,
    );
  }

  function applyFault(nextFault: FaultKind, label: string) {
    void runCommand(
      "simulation.faults.set",
      { profile: nextFault },
      nextFault === "none" ? "故障注入已清除" : `诊断已启动：${label}`,
    ).then((result) => {
      if (result) {
        setFault(nextFault);
      }
    });
  }

  function updateExpectedId() {
    void runCommand(
      "simulation.lock.setExpectedId",
      { expectedId },
      `门锁期望 ID 已设为 ${expectedId.toString(2).padStart(4, "0")}`,
    );
  }

  async function loadRecords() {
    const result = await runQuery("recorder.sessions.list");
    const data = domainData(result);
    const sessions = Array.isArray(data)
      ? data
      : Array.isArray(data?.sessions)
        ? data.sessions
        : [];
    setRecords(
      sessions.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object"),
      ),
    );
  }

  const quality =
    mode === "live"
      ? liveFrame?.confidencePercent ?? 0
      : fault === "none"
        ? Math.max(72, Math.round(99 - radialDistance * 5))
        : fault === "multipath"
          ? 61
          : 38;

  return (
    <div className="workbench-shell">
      <header className="top-console">
        <div className="identity-block">
          <div className="brand-sigil" aria-hidden="true">
            <span>K</span>
          </div>
          <div>
            <h1>数字钥匙工作台</h1>
          </div>
        </div>

        <div className="mode-switch" aria-label="工作模式">
          {[
            ["live", "实机监看"],
            ["calibration", "现场标定"],
            ["replay", "历史回放"],
            ["simulation", "仿真调试"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={mode === value ? "is-active" : ""}
              aria-pressed={mode === value}
              disabled={busy !== null}
              onClick={() => setWorkbenchMode(value as WorkbenchMode)}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "calibration" ? (
          <div className="connection-controls calibration-connection-controls">
            <label>
              <span>通道</span>
              <select value="CAL://FIELD-AGENT" disabled>
                <option>现场</option>
              </select>
            </label>
            <button
              type="button"
              className={connected ? "status-button online" : "status-button"}
              disabled={busy !== null}
              onClick={() => void runQuery("calibration.candidate.get")}
            >
              <span className="status-lamp" />
              刷新标定状态
            </button>
          </div>
        ) : (
          <div className={connected ? "top-agent-state online" : "top-agent-state"}>
            <span className="status-lamp" />
            <div>
              <strong>{connected ? "Agent 在线" : "Agent 离线"}</strong>
              <small>
                {mode === "live"
                  ? "实机模式"
                  : mode === "replay"
                    ? "回放模式"
                    : "仿真模式"}
              </small>
            </div>
          </div>
        )}
      </header>

      {mode === "calibration" ? (
        <CalibrationWorkbench
          serialPorts={serialPorts}
          serialPath={serialPath}
          baudRate={baudRate}
          recorderConnected={recorderConnected}
          serialBusy={busy?.startsWith("device.") === true}
          onSerialPathChange={setSerialPath}
          onBaudRateChange={setBaudRate}
          onScanPorts={() => void loadSerialPorts()}
          onConnectSerial={() => void connectSerial()}
          onDisconnectSerial={() => void disconnectSerial()}
        />
      ) : (
        <main className="operator-layout">
          <DigitalKeyScene
            position={position}
            idBits={idBits}
            status={lockState}
            faultedAnchor={fault === "anchor" ? "A2" : undefined}
            interactive={mode === "simulation"}
            bearingValid={mode !== "live" || Boolean(liveFrame?.angleValid)}
            stale={mode === "live" && !dataFresh}
            showRangeLines={mode === "simulation"}
            title="钥匙位置"
            sourceLabel={
              mode === "live"
                ? "电脑拟合结果"
                : mode === "replay"
                  ? "历史记录"
                  : "仿真定位"
            }
            onMove={moveKey}
          />

          <aside className="operator-console" aria-label="实时控制台">
            <header className="console-shell-header">
              <div className="console-heading">
                <div>
                  <h2>控制台</h2>
                  <span>
                    {mode === "live"
                      ? "实机监看"
                      : mode === "replay"
                        ? "历史回放"
                        : "仿真调试"}
                  </span>
                </div>
                <strong data-state={lockState}>
                  {lockState === "unlocked"
                    ? "已解锁"
                    : lockState === "welcome"
                      ? "迎宾"
                      : "锁定"}
                </strong>
              </div>
              <nav className="console-page-tabs" aria-label="控制台分页">
                {[
                  ["status", "状态"],
                  ["link", "链路"],
                  ["tools", "操作"],
                  ["events", "事件"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={consolePage === value ? "is-active" : ""}
                    aria-pressed={consolePage === value}
                    onClick={() => {
                      const nextPage = value as ConsolePage;
                      setConsolePage(nextPage);
                      if (nextPage === "tools" && mode !== "simulation") {
                        void loadRecords();
                      }
                    }}
                  >
                    {label}
                  </button>
                ))}
              </nav>
            </header>

            {consolePage === "status" && (
            <section className="console-overview">
              <div className="console-connection">
                {mode === "live" ? (
                  <>
                    <label>
                      <span>串口</span>
                      <select
                        value={serialPath}
                        onChange={(event) => setSerialPath(event.target.value)}
                        aria-label="串口端口"
                      >
                        {serialPorts.length === 0 && (
                          <option value="">未发现端口</option>
                        )}
                        {serialPorts.map((item) => (
                          <option key={item.path} value={item.path}>
                            {item.path}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>速率</span>
                      <select
                        value={baudRate}
                        onChange={(event) =>
                          setBaudRate(Number(event.target.value))
                        }
                      >
                        <option value={115200}>115200</option>
                        <option value={460800}>460800</option>
                        <option value={921600}>921600</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void loadSerialPorts()}
                    >
                      扫描
                    </button>
                    <button
                      type="button"
                      className={
                        recorderConnected
                          ? "status-button online"
                          : "status-button"
                      }
                      disabled={
                        busy !== null || (!recorderConnected && !serialPath)
                      }
                      onClick={() =>
                        recorderConnected
                          ? void disconnectSerial()
                          : void connectSerial()
                      }
                    >
                      <span className="status-lamp" />
                      {recorderConnected ? "断开" : "连接串口"}
                    </button>
                  </>
                ) : (
                  <>
                <label>
                  <span>数据源</span>
                  <select
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                  >
                    <option>SIM://KEYFIELD</option>
                    <option>LIVE://UWB-RECORDER</option>
                    <option>REPLAY://LOCAL</option>
                  </select>
                </label>
                <label>
                  <span>速率</span>
                  <select
                    value={baudRate}
                    onChange={(event) => setBaudRate(Number(event.target.value))}
                  >
                    <option value={115200}>115200</option>
                    <option value={460800}>460800</option>
                    <option value={921600}>921600</option>
                  </select>
                </label>
                <button
                  type="button"
                  className={connected ? "status-button online" : "status-button"}
                  disabled={busy !== null}
                  onClick={() => {
                    if (port.startsWith("LIVE")) {
                      void refreshLivePosition({ includeCalibration: true });
                    } else {
                      void runQuery("simulation.state.get");
                    }
                  }}
                >
                  <span className="status-lamp" />
                  {connected ? "已连接" : "连接"}
                </button>
                  </>
                )}
              </div>

              <div className="console-status-grid" aria-label="关键状态">
                <div>
                  <span>钥匙 ID</span>
                  <strong>
                    {mode === "live" && liveFrame?.keyId === null
                      ? "----"
                      : idBits.map(Number).join("")}
                  </strong>
                </div>
                <div>
                  <span>距离</span>
                  <strong>{radialDistance.toFixed(3)} m</strong>
                </div>
                <div>
                  <span>方向</span>
                  <strong>
                    {bearing === null
                      ? "未锁定"
                      : `${bearing >= 0 ? "+" : ""}${bearing.toFixed(2)}°`}
                  </strong>
                </div>
                <div>
                  <span>置信度</span>
                  <strong>{quality}%</strong>
                </div>
              </div>

              <div className="console-link-grid" aria-label="链路状态">
                {[
                  ["基站", recorderConnected],
                  ["拟合", modelReady],
                  ["位置", dataFresh && Boolean(liveFrame?.valid)],
                  ["监看", mode === "live" && liveMonitoring],
                ].map(([label, active]) => (
                  <span key={String(label)} className={active ? "is-active" : ""}>
                    <i />
                    {String(label)}
                  </span>
                ))}
              </div>
            </section>
            )}

            {consolePage !== "events" && (
            <div className="debug-panel">
              <div className="debug-content">
                {consolePage === "status" && mode === "live" && (
                  <>
                    <section className="debug-section fitted-result">
                      <header>
                        <h2>最终位置</h2>
                      </header>
                      <div className="position-hero">
                        <div>
                          <span>径向距离</span>
                          <strong>
                            {liveFrame?.valid
                              ? `${liveFrame.distanceM?.toFixed(3)} m`
                              : "--"}
                          </strong>
                        </div>
                        <div>
                          <span>方位角</span>
                          <strong>
                            {liveFrame?.angleValid
                              ? `${Number(liveFrame.angleDeg).toFixed(2)}°`
                              : "未锁定"}
                          </strong>
                        </div>
                      </div>
                      <div className="coordinate-grid">
                        <span>
                          X
                          <strong>
                            {liveFrame?.xM === null || liveFrame?.xM === undefined
                              ? "--"
                              : `${liveFrame.xM.toFixed(3)} m`}
                          </strong>
                        </span>
                        <span>
                          Y
                          <strong>
                            {liveFrame?.yM === null || liveFrame?.yM === undefined
                              ? "--"
                              : `${liveFrame.yM.toFixed(3)} m`}
                          </strong>
                        </span>
                        <span>
                          置信度
                          <strong>{liveFrame?.confidencePercent ?? 0}%</strong>
                        </span>
                      </div>
                      <p className={liveFrame?.angleValid ? "result-note good" : "result-note"}>
                        {liveFrame?.valid
                          ? liveFrame.angleValid
                            ? "二维位置有效"
                            : "仅距离有效"
                          : liveFrame?.reason ?? "等待有效位置"}
                      </p>
                    </section>

                    <section className="debug-section data-health">
                      <header>
                        <h2>数据健康</h2>
                      </header>
                      <dl>
                        <div>
                          <dt>串口</dt>
                          <dd>{recorderConnected ? "已连接" : "未连接"}</dd>
                        </div>
                        <div>
                          <dt>拟合模型</dt>
                          <dd>{modelReady ? "已就绪" : "未就绪"}</dd>
                        </div>
                        <div>
                          <dt>数据时效</dt>
                          <dd>
                            {dataAgeMs === null
                              ? "--"
                              : dataAgeMs < 1000
                                ? `${Math.round(dataAgeMs)} ms`
                                : `${(dataAgeMs / 1000).toFixed(1)} s`}
                          </dd>
                        </div>
                        <div>
                          <dt>结果质量</dt>
                          <dd>{liveFrame?.quality ?? "--"}</dd>
                        </div>
                        <div>
                          <dt>样本数</dt>
                          <dd>{liveFrame?.sampleCount ?? 0}</dd>
                        </div>
                        <div>
                          <dt>最大误差</dt>
                          <dd>
                            {liveFrame?.expectedErrorM === null ||
                            liveFrame?.expectedErrorM === undefined
                              ? "--"
                              : `±${liveFrame.expectedErrorM.toFixed(3)} m`}
                          </dd>
                        </div>
                      </dl>
                      {liveError && <p className="inline-error">{liveError}</p>}
                    </section>
                  </>
                )}

                {consolePage === "tools" && mode === "simulation" && (
                  <section className="debug-section">
                    <header>
                      <span className="panel-code">IDENTITY / 4 BIT</span>
                      <h2>ID 脉冲环</h2>
                    </header>
                    <div className="id-pulse-control">
                      <div className="pulse-orbit" aria-hidden="true">
                        <i />
                        <i />
                        <strong>{selectedId.toString(16).toUpperCase()}</strong>
                      </div>
                      <div className="bit-switches" aria-label="四位钥匙 ID">
                        {idBits.map((bit, index) => (
                          <button
                            key={index}
                            type="button"
                            className={bit ? "bit-active" : ""}
                            aria-pressed={bit}
                            disabled={busy !== null}
                            onClick={() => toggleIdBit(index)}
                          >
                            <span>B{3 - index}</span>
                            <strong>{Number(bit)}</strong>
                          </button>
                        ))}
                      </div>
                    </div>
                    <p className={idAuthorized ? "auth-line valid" : "auth-line"}>
                      <span />
                      {idAuthorized
                        ? `ID ${selectedId} 与门锁拨码一致`
                        : `ID ${selectedId} 与期望 ${expectedId} 不一致`}
                    </p>
                  </section>
                )}

                {consolePage === "link" && (
                  <section className="debug-section">
                    <header>
                      <span className="panel-code">ANCHORS / TWR</span>
                      <h2>{mode === "live" ? "拟合输入摘要" : "三路测距"}</h2>
                    </header>
                    <div className="anchor-table">
                      {anchorMetrics.map((anchor) => (
                        <div
                          key={anchor.id}
                          className={
                            fault === "anchor" && anchor.id === "2"
                              ? "anchor-row is-fault"
                              : "anchor-row"
                          }
                        >
                          <span className="anchor-name">A{anchor.id}</span>
                          <strong>{anchor.distance.toFixed(3)} m</strong>
                          <span>
                            {anchor.snr <= -90
                              ? "LOST"
                              : `${anchor.snr.toFixed(1)} dB`}
                          </span>
                          <i
                            style={
                              {
                                "--level": `${Math.max(4, anchor.snr * 4)}%`,
                              } as React.CSSProperties
                            }
                          />
                        </div>
                      ))}
                    </div>
                  </section>
                )}

            {consolePage === "tools" && mode === "simulation" && (
            <section className="debug-section compact">
              <header>
                <span className="panel-code">INJECTION</span>
                <h2>场景注入</h2>
              </header>
              <div className="scenario-grid">
                {scenarioPresets.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    disabled={busy !== null}
                    onClick={() => applyScenario(preset)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </section>
            )}

            {consolePage === "tools" && mode === "simulation" && (
            <section className="debug-section compact">
              <header>
                <span className="panel-code">FAULT MATRIX</span>
                <h2>故障注入</h2>
              </header>
              <div className="fault-grid">
                {faultPresets.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    className={fault === preset.value ? "is-selected" : ""}
                    aria-pressed={fault === preset.value}
                    disabled={busy !== null}
                    onClick={() => applyFault(preset.value, preset.label)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </section>
            )}

            {consolePage === "tools" && mode === "replay" && (
              <section className="debug-section replay-guide">
                <header>
                  <span className="panel-code">REPLAY / LOCAL</span>
                  <h2>历史位置回放</h2>
                </header>
                <p>
                  从下方“记录”页选择本机会话。回放只使用记录中的真实数据，
                  不用仿真结果冒充实机位置。
                </p>
                <button type="button" onClick={() => {
                  setTab("records");
                  void loadRecords();
                }}>
                  打开记录
                </button>
              </section>
            )}

            {consolePage === "tools" && mode === "live" && (
              <section className="debug-section live-operations">
                <header>
                  <h2>实时监看</h2>
                </header>
                <div className="console-actions">
                  <button
                    type="button"
                    className={liveMonitoring ? "monitor-toggle is-running" : "monitor-toggle"}
                    aria-pressed={liveMonitoring}
                    onClick={() => {
                      const next = !liveMonitoring;
                      setLiveMonitoring(next);
                      setLifecycle(next ? "monitoring" : "paused");
                      setAnnouncement(next ? "实时监看已启动" : "实时监看已暂停");
                    }}
                  >
                    {liveMonitoring ? "暂停监看" : "实时监看"}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void refreshLivePosition({ includeCalibration: true })
                    }
                  >
                    立即刷新
                  </button>
                </div>
                <p className="read-only-note">
                  网页只读取拟合结果，不直接打开串口或强制控制门锁。
                </p>
              </section>
            )}
          </div>
        </div>
            )}

            {consolePage !== "status" && (
            <section className="bottom-deck" aria-labelledby="timeline-title">
        {consolePage === "events" && (
          <div className="timeline-view">
            <header className="deck-heading">
              <div>
                <span className="panel-code">EVENT BUS / LIVE</span>
                <h2 id="timeline-title">事件时间轴</h2>
              </div>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  void runQuery("lock.snapshot.get").then(() => {
                    setTimeline([]);
                  });
                }}
              >
                清屏并读取锁态
              </button>
            </header>
            <div className="timeline-track">
              {timeline.length === 0 ? (
                <p className="empty-state">时间轴已清空，等待下一条事件。</p>
              ) : (
                timeline.slice(-12).map((item) => (
                  <article key={item.id} data-kind={item.kind}>
                    <time>{item.time}</time>
                    <span>{item.kind}</span>
                    <p>{item.message}</p>
                  </article>
                ))
              )}
            </div>
          </div>
        )}

        {consolePage === "link" && (
          <div className="utility-view">
            <div>
              <span className="panel-code">LIVE PROXY / READ ONLY</span>
              <h2>串口链路</h2>
              <p>实机模式只读取 UWB Recorder 状态，不从浏览器直接访问串口。</p>
            </div>
            <div className="serial-form">
              <input
                value={commandText}
                onChange={(event) => setCommandText(event.target.value)}
                placeholder="输入查询备注，例如：检查三路更新时间"
                aria-label="串口查询备注"
              />
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  appendTimeline("TX", `串口检查备注：${commandText || "无"}`);
                  void runQuery("recorder.status.get");
                }}
              >
                读取串口状态
              </button>
            </div>
          </div>
        )}

        {consolePage === "tools" && mode === "simulation" && (
          <div className="utility-view">
            <div>
              <span className="panel-code">LOCK / DIP SWITCH</span>
              <h2>配置</h2>
              <p>设置门锁端期望的四位 ID；钥匙 ID 在右侧脉冲环中调整。</p>
            </div>
            <div className="config-form">
              <label>
                <span>期望 ID</span>
                <input
                  type="number"
                  min="0"
                  max="15"
                  value={expectedId}
                  onChange={(event) =>
                    setExpectedId(
                      Math.min(15, Math.max(0, Number(event.target.value))),
                    )
                  }
                />
              </label>
              <output>{expectedId.toString(2).padStart(4, "0")}</output>
              <button
                type="button"
                disabled={busy !== null}
                onClick={updateExpectedId}
              >
                应用到仿真门锁
              </button>
            </div>
          </div>
        )}

        {consolePage === "tools" && mode !== "simulation" && (
          <div className="records-view">
            <header className="deck-heading">
              <div>
                <span className="panel-code">RECORDER / SESSIONS</span>
                <h2>记录</h2>
              </div>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void loadRecords()}
              >
                刷新记录
              </button>
            </header>
            {records.length === 0 ? (
              <p className="empty-state">
                尚未读取到实机会话；切换到 LIVE 通道后刷新。
              </p>
            ) : (
              <div className="record-grid">
                {records.slice(0, 8).map((record, index) => (
                  <article key={String(record.id ?? index)}>
                    <strong>{String(record.id ?? `SESSION-${index + 1}`)}</strong>
                    <span>{String(record.port ?? "--")}</span>
                    <span>{String(record.frameCount ?? 0)} 帧</span>
                  </article>
                ))}
              </div>
            )}
          </div>
        )}
            </section>
            )}
          </aside>
        </main>
      )}

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
