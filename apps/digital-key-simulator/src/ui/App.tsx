import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { agentClient } from "./agent-client";
import {
  DigitalKeyScene,
  type ScenePoint,
} from "./DigitalKeyScene";

type WorkbenchMode = "live" | "replay" | "simulation";
type BottomTab = "timeline" | "serial" | "configuration" | "records";
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

export function App() {
  const [mode, setMode] = useState<WorkbenchMode>("simulation");
  const [tab, setTab] = useState<BottomTab>("timeline");
  const [position, setPosition] = useState<ScenePoint>({ x: 0.18, y: 1.42 });
  const [idBits, setIdBits] = useState(bitsFromId(0x0a));
  const [expectedId, setExpectedId] = useState(0x0a);
  const [fault, setFault] = useState<FaultKind>("none");
  const [connected, setConnected] = useState(false);
  const [lifecycle, setLifecycle] = useState("paused");
  const [busy, setBusy] = useState<string | null>(null);
  const [port, setPort] = useState("SIM://KEYFIELD");
  const [baudRate, setBaudRate] = useState(115200);
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
  const moveTimer = useRef<number | null>(null);

  const selectedId = idFromBits(idBits);
  const radialDistance = Math.max(
    0,
    Math.hypot(position.x, position.y) - 0.3,
  );
  const bearing = (Math.atan2(position.x, position.y) * 180) / Math.PI;
  const idAuthorized = selectedId === expectedId && fault !== "id";
  const lockState: LockState =
    fault === "timeout" || !idAuthorized
      ? "locked"
      : radialDistance <= 1
        ? "unlocked"
        : radialDistance <= 2
          ? "welcome"
          : "locked";

  const anchorMetrics = useMemo<AnchorMetric[]>(
    () =>
      anchorPositions.map((anchor, index) => ({
        id: anchor.id,
        distance: Math.hypot(
          position.x - anchor.x,
          position.y - anchor.y,
        ),
        snr:
          fault === "anchor" && anchor.id === "2"
            ? -99
            : 16.8 - radialDistance * 2.1 - index * 0.7,
      })),
    [fault, position, radialDistance],
  );

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

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      agentClient.registry(),
      agentClient.query("simulation.state.get", {}),
    ]).then((results) => {
      if (cancelled) {
        return;
      }
      const stateResult = results[1];
      if (stateResult.status === "fulfilled") {
        applyState(stateResult.value);
        setConnected(true);
        setAnnouncement("Agent v1 已连接，仿真状态同步完成");
        appendTimeline("RX", "simulation.state.get 初始快照");
      } else {
        setConnected(false);
        setAnnouncement("Agent 服务未连接，当前显示本地演示状态");
        appendTimeline("ERR", "Agent v1 暂不可用，本地交互仍可预览");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [appendTimeline, applyState]);

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
    if (nextMode === "live") {
      setPort("LIVE://UWB-RECORDER");
      setLifecycle("paused");
      void runQuery("recorder.status.get").then((result) => {
        if (result) {
          setAnnouncement("实机模式已连接，只读接收 UWB Lab 数据");
        }
      });
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
    fault === "none"
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
            <p className="instrument-kicker">NUEDC / C · KEYFIELD 3A</p>
            <h1>数字钥匙工作台</h1>
          </div>
        </div>

        <div className="mode-switch" aria-label="工作模式">
          {[
            ["live", "实机模式"],
            ["replay", "回放模式"],
            ["simulation", "仿真模式"],
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

        <div className="connection-controls">
          <label>
            <span>数据通道</span>
            <select value={port} onChange={(event) => setPort(event.target.value)}>
              <option>SIM://KEYFIELD</option>
              <option>LIVE://UWB-RECORDER</option>
              <option>REPLAY://LOCAL</option>
            </select>
          </label>
          <label>
            <span>串口速率</span>
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
                void runQuery("recorder.status.get");
              } else {
                void runQuery("simulation.state.get");
              }
            }}
          >
            <span className="status-lamp" />
            {connected ? "链路在线" : "连接 Agent"}
          </button>
        </div>
      </header>

      <div className="telemetry-strip" aria-label="关键状态">
        <div>
          <span>LOCK STATE</span>
          <strong data-state={lockState}>
            {lockState === "unlocked"
              ? "已解锁"
              : lockState === "welcome"
                ? "迎宾"
                : "锁定"}
          </strong>
        </div>
        <div>
          <span>KEY ID</span>
          <strong>{idBits.map(Number).join("")}</strong>
        </div>
        <div>
          <span>RADIAL</span>
          <strong>{radialDistance.toFixed(3)} m</strong>
        </div>
        <div>
          <span>BEARING</span>
          <strong>{bearing >= 0 ? "+" : ""}{bearing.toFixed(2)}°</strong>
        </div>
        <div>
          <span>CONFIDENCE</span>
          <strong>{quality}%</strong>
        </div>
        <div>
          <span>LIFECYCLE</span>
          <strong>{lifecycle.toUpperCase()}</strong>
        </div>
      </div>

      <main className="main-instrument">
        <DigitalKeyScene
          position={position}
          idBits={idBits}
          status={lockState}
          faultedAnchor={fault === "anchor" ? "A2" : undefined}
          onMove={moveKey}
        />

        <details className="mobile-fold debug-panel" open>
          <summary>
            <span>链路调试台</span>
            <small>LINK / DIAGNOSTICS</small>
          </summary>
          <div className="debug-content">
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

            <section className="debug-section">
              <header>
                <span className="panel-code">ANCHORS / TWR</span>
                <h2>三路测距</h2>
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
                      {anchor.snr <= -90 ? "LOST" : `${anchor.snr.toFixed(1)} dB`}
                    </span>
                    <i style={{ "--level": `${Math.max(4, anchor.snr * 4)}%` } as React.CSSProperties} />
                  </div>
                ))}
              </div>
            </section>

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
          </div>
        </details>
      </main>

      <section className="bottom-deck" aria-labelledby="timeline-title">
        <nav className="deck-tabs" aria-label="底部工作区">
          {[
            ["timeline", "事件时间轴"],
            ["serial", "串口"],
            ["configuration", "配置"],
            ["records", "记录"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={tab === value ? "is-active" : ""}
              aria-selected={tab === value}
              onClick={() => {
                setTab(value as BottomTab);
                if (value === "records") {
                  void loadRecords();
                }
              }}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === "timeline" && (
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

        {tab === "serial" && (
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

        {tab === "configuration" && (
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
                写入门锁拨码
              </button>
            </div>
          </div>
        )}

        {tab === "records" && (
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

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
