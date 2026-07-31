import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CSSProperties,
  KeyboardEvent,
  PointerEvent,
} from "react";

import { agentClient } from "./agent-client";

const MIN_ANCHORS = 2;
const MAX_ANCHORS = 4;
const STABILITY_DURATION_MS = 2_000;
const CAPTURE_DURATION_MS = 15_000;
const MIN_SYNC_GROUPS = 100;

const MAP_WIDTH = 760;
const MAP_HEIGHT = 560;
const MAP_ORIGIN_X = 380;
const MAP_ORIGIN_Y = 486;
const MAP_PIXELS_PER_METER = 112;
const MAP_MIN_X_MM = -3_000;
const MAP_MAX_X_MM = 3_000;
const MAP_MIN_Y_MM = -500;
const MAP_MAX_Y_MM = 4_000;

type CapturePhase =
  | "idle"
  | "stabilizing"
  | "capturing"
  | "qualified"
  | "rejected";
type CalibrationPanel = "capture" | "anchors" | "analysis" | "models";

interface Point3D {
  xMm: number;
  yMm: number;
  zMm: number;
}

interface AnchorPoint extends Point3D {
  id: string;
}

interface PositionResult extends Point3D {
  radialM: number | null;
  angleDeg: number | null;
  version?: string;
}

interface HeatCell {
  xMm: number;
  yMm: number;
  errorM: number | null;
  samples: number;
}

interface Recommendation extends Point3D {
  reason: string;
}

interface CaptureSnapshot {
  phase: CapturePhase;
  stabilityRemainingMs: number | null;
  captureElapsedMs: number | null;
  synchronizedGroups: number;
  rejectReasons: string[];
}

interface CalibrationWorkbenchProps {
  serialPorts: Array<{ path: string; manufacturer?: string }>;
  serialPath: string;
  baudRate: number;
  recorderConnected: boolean;
  serialBusy: boolean;
  onSerialPathChange: (path: string) => void;
  onBaudRateChange: (baudRate: number) => void;
  onScanPorts: () => void;
  onConnectSerial: () => void;
  onDisconnectSerial: () => void;
}

const DEFAULT_ANCHORS: AnchorPoint[] = [
  { id: "A1", xMm: -125, yMm: 40, zMm: 850 },
  { id: "A2", xMm: 125, yMm: 40, zMm: 850 },
];

const ANCHOR_PRESETS: AnchorPoint[] = [
  ...DEFAULT_ANCHORS,
  { id: "A3", xMm: 0, yMm: -220, zMm: 850 },
  { id: "A4", xMm: 0, yMm: 220, zMm: 850 },
];

const EMPTY_HEATMAP: HeatCell[] = Array.from({ length: 63 }, (_, index) => {
  const column = index % 9;
  const row = Math.floor(index / 9);
  return {
    xMm: -2_000 + column * 500,
    yMm: 500 + row * 500,
    errorM: null,
    samples: 0,
  };
});

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function domainData(value: unknown) {
  const outer = recordOf(value);
  return recordOf(outer?.data) ?? outer;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function metricOf(point: Point3D) {
  const radialM = Math.hypot(point.xMm, point.yMm) / 1000;
  const angleDeg = (Math.atan2(point.xMm, point.yMm) * 180) / Math.PI;
  return { radialM, angleDeg };
}

function mapPoint(point: Point3D) {
  return {
    x: MAP_ORIGIN_X + (point.xMm / 1000) * MAP_PIXELS_PER_METER,
    y: MAP_ORIGIN_Y - (point.yMm / 1000) * MAP_PIXELS_PER_METER,
  };
}

function parsePosition(value: unknown): PositionResult | null {
  const record = recordOf(value);
  if (!record) {
    return null;
  }
  const xMm = finiteNumber(record.xMm);
  const yMm = finiteNumber(record.yMm);
  const zMm = finiteNumber(record.zMm);
  if (xMm === null || yMm === null || zMm === null) {
    return null;
  }
  const metrics = metricOf({ xMm, yMm, zMm });
  return {
    xMm,
    yMm,
    zMm,
    radialM: finiteNumber(record.radialM) ?? metrics.radialM,
    angleDeg: finiteNumber(record.angleDeg) ?? metrics.angleDeg,
    version:
      typeof record.version === "string" ? record.version : undefined,
  };
}

function phaseOf(value: unknown): CapturePhase | null {
  return ["idle", "stabilizing", "capturing", "qualified", "rejected"].includes(
    String(value),
  )
    ? (String(value) as CapturePhase)
    : null;
}

function operationRecordOf(value: unknown) {
  const data = domainData(value);
  return (
    recordOf(data?.operationRecord) ??
    recordOf(data?.operation) ??
    data
  );
}

function operationIdOf(value: unknown) {
  const operationRecord = operationRecordOf(value);
  const id = operationRecord?.id ?? operationRecord?.operationId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function setupRevisionOf(value: unknown) {
  const data = domainData(value);
  const result =
    recordOf(data?.result) ??
    recordOf(data?.output) ??
    data;
  const setup = recordOf(result?.setup);
  const revision =
    result?.setupRevision ??
    result?.setupKey ??
    setup?.setupRevision ??
    setup?.setupKey;
  if (typeof revision === "string" && revision.length > 0) {
    return revision;
  }
  if (
    typeof setup?.id === "string" &&
    Number.isInteger(Number(setup.revision))
  ) {
    return `${setup.id}@${Number(setup.revision)}`;
  }
  return null;
}

function formatMillimeters(value: number) {
  return `${Math.round(value)} mm`;
}

function formatPosition(value: PositionResult | null, axis: keyof Point3D) {
  return value ? formatMillimeters(value[axis]) : "--";
}

function phaseLabel(phase: CapturePhase) {
  const labels: Record<CapturePhase, string> = {
    idle: "等待开始",
    stabilizing: "保持稳定",
    capturing: "同步采集中",
    qualified: "质量通过",
    rejected: "质量拒绝",
  };
  return labels[phase];
}

export function CalibrationWorkbench({
  serialPorts,
  serialPath,
  baudRate,
  recorderConnected,
  serialBusy,
  onSerialPathChange,
  onBaudRateChange,
  onScanPorts,
  onConnectSerial,
  onDisconnectSerial,
}: CalibrationWorkbenchProps) {
  const mapRef = useRef<SVGSVGElement>(null);
  const [panel, setPanel] = useState<CalibrationPanel>("capture");
  const [anchors, setAnchors] = useState<AnchorPoint[]>(DEFAULT_ANCHORS);
  const [truth, setTruth] = useState<Point3D>({
    xMm: 0,
    yMm: 1_000,
    zMm: 850,
  });
  const [snapshot, setSnapshot] = useState<CaptureSnapshot>({
    phase: "idle",
    stabilityRemainingMs: null,
    captureElapsedMs: null,
    synchronizedGroups: 0,
    rejectReasons: [],
  });
  const [candidate, setCandidate] = useState<PositionResult | null>(null);
  const [formal, setFormal] = useState<PositionResult | null>(null);
  const [heatmap, setHeatmap] = useState<HeatCell[]>(EMPTY_HEATMAP);
  const [recommendation, setRecommendation] =
    useState<Recommendation | null>(null);
  const [modelVersion, setModelVersion] = useState("未载入");
  const [candidateVersion, setCandidateVersion] = useState("无候选");
  const [autoActivate, setAutoActivate] = useState(false);
  const [setupRevision, setSetupRevision] = useState<string | null>(null);
  const [setupDirty, setSetupDirty] = useState(true);
  const [captureOperationId, setCaptureOperationId] =
    useState<string | null>(null);
  const [captureStartedAt, setCaptureStartedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("同步中…");
  const [lastError, setLastError] = useState<string | null>(null);
  const [targetDistanceM, setTargetDistanceM] = useState(1);
  const [targetAngleDeg, setTargetAngleDeg] = useState(0);

  const truthMetrics = useMemo(() => metricOf(truth), [truth]);
  const truthMapPoint = useMemo(() => mapPoint(truth), [truth]);
  const recommendationMapPoint = recommendation
    ? mapPoint(recommendation)
    : null;
  const hasHeatmapData = heatmap.some((cell) => cell.errorM !== null);
  const localElapsedMs =
    captureStartedAt === null ? 0 : Math.max(0, clock - captureStartedAt);
  const stabilityRemainingMs =
    snapshot.stabilityRemainingMs ??
    (captureStartedAt === null
      ? STABILITY_DURATION_MS
      : Math.max(0, STABILITY_DURATION_MS - localElapsedMs));
  const captureElapsedMs =
    snapshot.captureElapsedMs ??
    (captureStartedAt === null
      ? 0
      : clamp(
          localElapsedMs - STABILITY_DURATION_MS,
          0,
          CAPTURE_DURATION_MS,
        ));
  const captureProgress = Math.round(
    (captureElapsedMs / CAPTURE_DURATION_MS) * 100,
  );
  const syncProgress = Math.round(
    clamp(snapshot.synchronizedGroups / MIN_SYNC_GROUPS, 0, 1) * 100,
  );

  function setPolarTruth(distanceM: number, angleDeg: number) {
    const safeDistance = clamp(distanceM, 0, 4);
    const safeAngle = clamp(angleDeg, -180, 180);
    const radians = (safeAngle * Math.PI) / 180;
    setTargetDistanceM(safeDistance);
    setTargetAngleDeg(safeAngle);
    setTruth((current) => ({
      xMm: Math.round(safeDistance * 1000 * Math.sin(radians)),
      yMm: Math.round(safeDistance * 1000 * Math.cos(radians)),
      zMm: current.zMm,
    }));
  }

  function setCartesianTruth(next: Point3D) {
    const metrics = metricOf(next);
    setTruth(next);
    setTargetDistanceM(Number(metrics.radialM.toFixed(3)));
    setTargetAngleDeg(Number(metrics.angleDeg.toFixed(2)));
  }

  const applyCalibrationStatus = useCallback((payload: unknown) => {
    const data = domainData(payload);
    if (!data) {
      return;
    }
    const capture = recordOf(data.capture) ?? data;
    const model = recordOf(data.model);
    const setup = recordOf(data.setup);
    const active = recordOf(data.active);
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    const latestCandidate =
      recordOf(data.candidate) ??
      recordOf(candidates[0]);
    const nextPhase = phaseOf(capture.phase);
    const admission = recordOf(latestCandidate?.admission);
    const rejectReasons = Array.isArray(capture.rejectReasons)
      ? capture.rejectReasons.map(String)
      : Array.isArray(admission?.reasons)
        ? admission.reasons.map(String)
        : [];

    const revision = setupRevisionOf(data);
    if (revision) {
      setSetupRevision(revision);
      setSetupDirty(false);
    }
    if (setup) {
      if (typeof setup.autoActivate === "boolean") {
        setAutoActivate(setup.autoActivate);
      }
      if (Array.isArray(setup.anchors)) {
        const nextAnchors = setup.anchors
          .map((item) => {
            const record = recordOf(item);
            const xMm = finiteNumber(record?.xMm);
            const yMm = finiteNumber(record?.yMm);
            const zMm = finiteNumber(record?.zMm);
            if (
              typeof record?.id !== "string" ||
              xMm === null ||
              yMm === null ||
              zMm === null
            ) {
              return null;
            }
            return { id: record.id, xMm, yMm, zMm };
          })
          .filter((item): item is AnchorPoint => item !== null)
          .slice(0, MAX_ANCHORS);
        if (nextAnchors.length >= MIN_ANCHORS) {
          setAnchors(nextAnchors);
        }
      }
    }

    setSnapshot((current) => ({
      phase: nextPhase ?? current.phase,
      stabilityRemainingMs:
        finiteNumber(capture.stabilityRemainingMs) ??
        current.stabilityRemainingMs,
      captureElapsedMs:
        finiteNumber(capture.captureElapsedMs) ?? current.captureElapsedMs,
      synchronizedGroups:
        finiteNumber(capture.synchronizedGroups) ??
        current.synchronizedGroups,
      rejectReasons,
    }));

    const nextCandidate = parsePosition(data.candidatePosition);
    const nextFormal = parsePosition(data.formalPosition);
    if (nextCandidate) {
      setCandidate(nextCandidate);
    }
    if (nextFormal) {
      setFormal(nextFormal);
    }

    if (Array.isArray(data.heatmap)) {
      const nextHeatmap = data.heatmap
        .map((item) => {
          const record = recordOf(item);
          const xMm = finiteNumber(record?.xMm);
          const yMm = finiteNumber(record?.yMm);
          if (xMm === null || yMm === null) {
            return null;
          }
          return {
            xMm,
            yMm,
            errorM: finiteNumber(record?.errorM),
            samples: Math.max(0, Math.round(finiteNumber(record?.samples) ?? 0)),
          };
        })
        .filter((item): item is HeatCell => item !== null);
      if (nextHeatmap.length > 0) {
        setHeatmap(nextHeatmap);
      }
    }

    const nextRecommendation = recordOf(data.recommendation);
    const recommendationX = finiteNumber(nextRecommendation?.xMm);
    const recommendationY = finiteNumber(nextRecommendation?.yMm);
    const recommendationZ = finiteNumber(nextRecommendation?.zMm);
    if (
      recommendationX !== null &&
      recommendationY !== null &&
      recommendationZ !== null
    ) {
      setRecommendation({
        xMm: recommendationX,
        yMm: recommendationY,
        zMm: recommendationZ,
        reason: String(
          nextRecommendation?.reason ?? "覆盖最薄弱区域",
        ),
      });
    }

    if (model) {
      if (typeof model.version === "string") {
        setModelVersion(model.version);
      }
      if (typeof model.candidateVersion === "string") {
        setCandidateVersion(model.candidateVersion);
      }
    }
    if (typeof active?.versionId === "string") {
      setModelVersion(active.versionId);
    }
    if (typeof latestCandidate?.id === "string") {
      setCandidateVersion(latestCandidate.id);
    }
  }, []);

  const refreshCalibrationStatus = useCallback(
    async (silent = false) => {
      if (!silent) {
        setBusy("calibration.candidate.get");
      }
      try {
        const result = await agentClient.query("calibration.candidate.get", {});
        applyCalibrationStatus(result);
        setLastError(null);
        setNotice("已同步");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "现场标定状态读取失败";
        setLastError(message);
        if (!silent) {
          setNotice("服务未就绪");
        }
      } finally {
        if (!silent) {
          setBusy(null);
        }
      }
    },
    [applyCalibrationStatus],
  );

  useEffect(() => {
    void refreshCalibrationStatus();
  }, [refreshCalibrationStatus]);

  useEffect(() => {
    if (captureStartedAt === null) {
      return;
    }
    const timer = window.setInterval(() => setClock(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [captureStartedAt]);

  const applyOperationRecord = useCallback(
    (payload: unknown) => {
      const operationRecord = operationRecordOf(payload);
      if (!operationRecord) {
        return "unknown";
      }
      const operationState = String(
        operationRecord.status ?? operationRecord.state ?? "unknown",
      );
      const progress = recordOf(operationRecord.progress);
      const synchronizedGroups =
        finiteNumber(progress?.synchronizedGroups) ??
        finiteNumber(operationRecord.synchronizedGroups);
      const elapsedMs =
        finiteNumber(progress?.elapsedMs) ??
        finiteNumber(operationRecord.elapsedMs);
      const message =
        typeof progress?.message === "string"
          ? progress.message
          : typeof operationRecord.message === "string"
            ? operationRecord.message
            : null;

      setSnapshot((current) => ({
        ...current,
        phase:
          operationState === "succeeded"
            ? "qualified"
            : operationState === "failed" ||
                operationState === "cancelled"
              ? "rejected"
              : elapsedMs !== null && elapsedMs >= STABILITY_DURATION_MS
                ? "capturing"
                : "stabilizing",
        captureElapsedMs:
          elapsedMs === null
            ? current.captureElapsedMs
            : clamp(
                elapsedMs - STABILITY_DURATION_MS,
                0,
                CAPTURE_DURATION_MS,
              ),
        synchronizedGroups:
          synchronizedGroups ?? current.synchronizedGroups,
        rejectReasons:
          operationState === "failed" || operationState === "cancelled"
            ? [
                message ??
                  (operationState === "cancelled"
                    ? "采集已取消"
                    : "采集操作失败"),
              ]
            : current.rejectReasons,
      }));

      if (message) {
        setNotice(message);
      }
      const result =
        operationRecord.result ??
        operationRecord.output ??
        operationRecord.data;
      if (result) {
        applyCalibrationStatus(result);
      }
      if (
        operationState === "succeeded" ||
        operationState === "failed" ||
        operationState === "cancelled"
      ) {
        setCaptureStartedAt(null);
        setCaptureOperationId(null);
      }
      return operationState;
    },
    [applyCalibrationStatus],
  );

  useEffect(() => {
    if (!captureOperationId) {
      return;
    }
    let disposed = false;
    const poll = async () => {
      try {
        const result = await agentClient.operation(captureOperationId);
        if (disposed) {
          return;
        }
        const state = applyOperationRecord(result);
        setLastError(null);
        if (["succeeded", "failed", "cancelled"].includes(state)) {
          void refreshCalibrationStatus(true);
        }
      } catch (error) {
        if (!disposed) {
          setLastError(
            error instanceof Error ? error.message : "采集进度轮询失败",
          );
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [
    applyOperationRecord,
    captureOperationId,
    refreshCalibrationStatus,
  ]);

  function updateAnchor(
    index: number,
    axis: keyof Point3D,
    value: number,
  ) {
    setSetupDirty(true);
    setAnchors((current) =>
      current.map((anchor, anchorIndex) =>
        anchorIndex === index ? { ...anchor, [axis]: value } : anchor,
      ),
    );
  }

  function addAnchor() {
    if (anchors.length >= MAX_ANCHORS) {
      return;
    }
    setSetupDirty(true);
    setAnchors((current) => [...current, ANCHOR_PRESETS[current.length]]);
  }

  function removeAnchor() {
    if (anchors.length <= MIN_ANCHORS) {
      return;
    }
    setSetupDirty(true);
    setAnchors((current) => current.slice(0, -1));
  }

  function setTruthFromPointer(event: PointerEvent<SVGSVGElement>) {
    const rectangle = mapRef.current?.getBoundingClientRect();
    if (!rectangle) {
      return;
    }
    const mapX =
      ((event.clientX - rectangle.left) / rectangle.width) * MAP_WIDTH;
    const mapY =
      ((event.clientY - rectangle.top) / rectangle.height) * MAP_HEIGHT;
    setCartesianTruth({
      ...truth,
      xMm: Math.round(
        clamp(
          ((mapX - MAP_ORIGIN_X) / MAP_PIXELS_PER_METER) * 1000,
          MAP_MIN_X_MM,
          MAP_MAX_X_MM,
        ),
      ),
      yMm: Math.round(
        clamp(
          ((MAP_ORIGIN_Y - mapY) / MAP_PIXELS_PER_METER) * 1000,
          MAP_MIN_Y_MM,
          MAP_MAX_Y_MM,
        ),
      ),
    });
  }

  function handleMapKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    const step = event.shiftKey ? 200 : 50;
    const movement: Record<string, { xMm: number; yMm: number }> = {
      ArrowLeft: { xMm: -step, yMm: 0 },
      ArrowRight: { xMm: step, yMm: 0 },
      ArrowUp: { xMm: 0, yMm: step },
      ArrowDown: { xMm: 0, yMm: -step },
    };
    const delta = movement[event.key];
    if (!delta) {
      return;
    }
    event.preventDefault();
    setCartesianTruth({
      ...truth,
      xMm: clamp(
        truth.xMm + delta.xMm,
        MAP_MIN_X_MM,
        MAP_MAX_X_MM,
      ),
      yMm: clamp(
        truth.yMm + delta.yMm,
        MAP_MIN_Y_MM,
        MAP_MAX_Y_MM,
      ),
    });
  }

  async function saveSetup() {
    setBusy("calibration.setup.configure");
    const result = await agentClient.execute("calibration.setup.configure", {
      lock: { xMm: 0, yMm: 0, zMm: 0 },
      anchors,
      autoActivate,
    });
    const revision = setupRevisionOf(result);
    if (!revision) {
      const refreshed = await agentClient.query("calibration.candidate.get", {});
      applyCalibrationStatus(refreshed);
      const refreshedRevision = setupRevisionOf(refreshed);
      if (!refreshedRevision) {
        throw new Error("场地配置已提交，但 Agent 未返回 setupRevision");
      }
      setSetupRevision(refreshedRevision);
      setSetupDirty(false);
      setNotice(`已保存 ${refreshedRevision}`);
      return refreshedRevision;
    }
    setSetupRevision(revision);
    setSetupDirty(false);
    setNotice(`已保存 ${revision}`);
    return revision;
  }

  async function ensureSetupSaved() {
    if (!setupDirty && setupRevision) {
      return setupRevision;
    }
    return saveSetup();
  }

  async function startCapture() {
    setLastError(null);
    setCaptureStartedAt(Date.now());
    setClock(Date.now());
    setSnapshot({
      phase: "stabilizing",
      stabilityRemainingMs: null,
      captureElapsedMs: null,
      synchronizedGroups: 0,
      rejectReasons: [],
    });
    setNotice("保持静止");
    try {
      const currentSetupRevision = await ensureSetupSaved();
      setBusy("calibration.point.capture");
      const operationRecord = await agentClient.execute(
        "calibration.point.capture",
        {
          setupRevision: currentSetupRevision,
          xMm: truth.xMm,
          yMm: truth.yMm,
          zMm: truth.zMm,
          durationSeconds: 15,
          warmupSeconds: 2,
          minimumSynchronizedGroups: MIN_SYNC_GROUPS,
        },
      );
      const operationId = operationIdOf(operationRecord);
      if (!operationId) {
        throw new Error("Agent 未返回采集 operationRecord.id");
      }
      setCaptureOperationId(operationId);
      applyOperationRecord(operationRecord);
      setNotice("采集中");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "无法启动现场采集";
      setCaptureStartedAt(null);
      setCaptureOperationId(null);
      setLastError(message);
      setSnapshot((current) => ({
        ...current,
        phase: "rejected",
        rejectReasons: [`Agent 未接受采集：${message}`],
      }));
      setNotice("采集未启动");
    } finally {
      setBusy(null);
    }
  }

  async function cancelCapture() {
    if (!captureOperationId) {
      return;
    }
    setBusy(`operation.cancel:${captureOperationId}`);
    try {
      const operationRecord = await agentClient.cancel(captureOperationId);
      applyOperationRecord(operationRecord);
      setCaptureStartedAt(null);
      setCaptureOperationId(null);
      setSnapshot((current) => ({
        ...current,
        phase: "rejected",
        rejectReasons: ["采集已由现场人员取消"],
      }));
      setNotice("已取消");
    } catch (error) {
      setLastError(
        error instanceof Error ? error.message : "无法取消现场采集",
      );
    } finally {
      setBusy(null);
    }
  }

  async function runModelAction(
    operation:
      | "calibration.model.activate"
      | "calibration.model.rollback",
    successText: string,
  ) {
    setBusy(operation);
    try {
      const currentSetupRevision = await ensureSetupSaved();
      const argumentsValue =
        operation === "calibration.model.activate"
          ? {
              setupRevision: currentSetupRevision,
              candidateVersion,
            }
          : { setupRevision: currentSetupRevision };
      const result = await agentClient.execute(operation, argumentsValue);
      applyCalibrationStatus(result);
      await refreshCalibrationStatus(true);
      setLastError(null);
      setNotice(successText);
    } catch (error) {
      setLastError(
        error instanceof Error ? error.message : `${successText}失败`,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="calibration-workbench" aria-labelledby="calibration-title">
      <header className="calibration-hero">
        <div>
          <h2 id="calibration-title">现场标定</h2>
        </div>
        <div className="calibration-hero-status" data-phase={snapshot.phase}>
          <strong>{phaseLabel(snapshot.phase)}</strong>
          <small>{notice}</small>
        </div>
      </header>

      <section className="calibration-primary-grid">
        <section className="calibration-map-panel">
          <header className="panel-header">
            <div>
              <h2>真值地图</h2>
            </div>
            <div className="calibration-map-readout">
              <span>
                径向距离 <strong>{truthMetrics.radialM.toFixed(3)} m</strong>
              </span>
              <span>
                方位角{" "}
                <strong>
                  {truthMetrics.angleDeg >= 0 ? "+" : ""}
                  {truthMetrics.angleDeg.toFixed(2)}°
                </strong>
              </span>
            </div>
          </header>

          <div className="calibration-map">
            <svg
              ref={mapRef}
              viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
              role="application"
              tabIndex={0}
              aria-label={`现场标定地图，钥匙真值 X ${truth.xMm} 毫米，Y ${truth.yMm} 毫米`}
              onKeyDown={handleMapKeyDown}
              onPointerDown={setTruthFromPointer}
            >
              <defs>
                <pattern
                  id="calibration-minor-grid"
                  width={MAP_PIXELS_PER_METER / 2}
                  height={MAP_PIXELS_PER_METER / 2}
                  patternUnits="userSpaceOnUse"
                >
                  <path
                    d={`M ${MAP_PIXELS_PER_METER / 2} 0 L 0 0 0 ${MAP_PIXELS_PER_METER / 2}`}
                    className="calibration-grid-minor"
                  />
                </pattern>
                <filter
                  id="calibration-key-glow"
                  x="-100%"
                  y="-100%"
                  width="300%"
                  height="300%"
                >
                  <feGaussianBlur stdDeviation="5" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              <rect
                width={MAP_WIDTH}
                height={MAP_HEIGHT}
                rx="18"
                className="calibration-map-base"
              />
              <rect
                width={MAP_WIDTH}
                height={MAP_HEIGHT}
                rx="18"
                fill="url(#calibration-minor-grid)"
              />

              {[1, 2, 3].map((radius) => (
                <circle
                  key={radius}
                  cx={MAP_ORIGIN_X}
                  cy={MAP_ORIGIN_Y}
                  r={radius * MAP_PIXELS_PER_METER}
                  className="calibration-radius"
                />
              ))}
              <line
                x1="0"
                y1={MAP_ORIGIN_Y}
                x2={MAP_WIDTH}
                y2={MAP_ORIGIN_Y}
                className="calibration-axis"
              />
              <line
                x1={MAP_ORIGIN_X}
                y1="0"
                x2={MAP_ORIGIN_X}
                y2={MAP_HEIGHT}
                className="calibration-axis"
              />

              {anchors.map((anchor) => {
                const point = mapPoint(anchor);
                return (
                  <g
                    key={anchor.id}
                    className="calibration-anchor"
                    transform={`translate(${point.x} ${point.y})`}
                  >
                    <path d="M0 -16 L14 10 H-14 Z" />
                    <circle r="4" />
                    <text y="-24">{anchor.id}</text>
                    <title>
                      {anchor.id}：X {anchor.xMm}，Y {anchor.yMm}，Z{" "}
                      {anchor.zMm} 毫米
                    </title>
                  </g>
                );
              })}

              <g
                className="calibration-door-origin"
                transform={`translate(${MAP_ORIGIN_X} ${MAP_ORIGIN_Y})`}
              >
                <circle r="25" />
                <path d="M-18 4 H18 M0 -18 V18" />
                <text y="45">门锁中心 O</text>
              </g>

              {recommendationMapPoint && (
                <g
                  className="calibration-recommendation"
                  transform={`translate(${recommendationMapPoint.x} ${recommendationMapPoint.y})`}
                >
                  <circle r="18" />
                  <path d="M-8 0 H8 M0 -8 V8" />
                  <text y="-27">NEXT</text>
                </g>
              )}

              <g
                className="calibration-truth-key"
                transform={`translate(${truthMapPoint.x} ${truthMapPoint.y})`}
                filter="url(#calibration-key-glow)"
              >
                <circle r="21" />
                <path d="M-8 -11 H7 L14 -4 V9 L7 16 H-8 L-15 9 V-4 Z" />
                <text y="-31">钥匙真值</text>
              </g>
            </svg>

            <div className="calibration-map-instruction">
              <span>方向键 50 mm · 加速 200 mm</span>
            </div>
          </div>

          <div className="truth-coordinate-strip truth-derived-strip">
            <span>X <strong>{truth.xMm} mm</strong></span>
            <span>Y <strong>{truth.yMm} mm</strong></span>
            <span>Z <strong>{truth.zMm} mm</strong></span>
          </div>
        </section>

        <aside className="calibration-console">
          <nav className="calibration-page-tabs" aria-label="现场标定分页">
            {[
              ["capture", "采集"],
              ["anchors", "基站"],
              ["analysis", "分析"],
              ["models", "模型"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={panel === value ? "is-active" : ""}
                aria-pressed={panel === value}
                onClick={() => setPanel(value as CalibrationPanel)}
              >
                {label}
              </button>
            ))}
          </nav>

        <section
          className="calibration-capture-panel"
          hidden={panel !== "capture"}
        >
          <header>
            <h2>采集</h2>
          </header>

          <div className="calibration-serial-control">
            <label>
              <span>串口</span>
              <select
                value={serialPath}
                onChange={(event) => onSerialPathChange(event.target.value)}
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
                  onBaudRateChange(Number(event.target.value))
                }
              >
                <option value={115200}>115200</option>
                <option value={460800}>460800</option>
                <option value={921600}>921600</option>
              </select>
            </label>
            <button type="button" disabled={serialBusy} onClick={onScanPorts}>
              扫描
            </button>
            <button
              type="button"
              className={recorderConnected ? "serial-connected" : ""}
              disabled={serialBusy || (!recorderConnected && !serialPath)}
              onClick={
                recorderConnected ? onDisconnectSerial : onConnectSerial
              }
            >
              {recorderConnected ? "断开串口" : "连接串口"}
            </button>
          </div>

          <div className="capture-target-form">
            <label>
              <span>标定距离 / m</span>
              <input
                type="number"
                min="0"
                max="4"
                step="0.05"
                value={targetDistanceM}
                onChange={(event) =>
                  setPolarTruth(Number(event.target.value), targetAngleDeg)
                }
              />
            </label>
            <label>
              <span>标定角度 / °</span>
              <input
                type="number"
                min="-180"
                max="180"
                step="1"
                value={targetAngleDeg}
                onChange={(event) =>
                  setPolarTruth(targetDistanceM, Number(event.target.value))
                }
              />
            </label>
          </div>

          <div className="capture-dial-grid">
            <div className="capture-dial">
              <span>稳定倒计时</span>
              <strong>{(stabilityRemainingMs / 1000).toFixed(1)} s</strong>
            </div>
            <div className="capture-dial">
              <span>采集进度</span>
              <strong>{(captureElapsedMs / 1000).toFixed(1)} / 15 s</strong>
              <progress
                max="100"
                value={captureProgress}
                aria-label="15秒采集进度"
              />
            </div>
            <div className="capture-dial">
              <span>同步组门槛</span>
              <strong>
                {snapshot.synchronizedGroups} / {MIN_SYNC_GROUPS}
              </strong>
              <progress
                max="100"
                value={syncProgress}
                aria-label="100同步组门槛"
              />
            </div>
          </div>

          <div className="capture-actions">
            <button
              type="button"
              className="calibration-primary-action"
              disabled={
                busy !== null ||
                !recorderConnected ||
                snapshot.phase === "stabilizing" ||
                snapshot.phase === "capturing"
              }
              onClick={() => void startCapture()}
            >
              开始现场采集
            </button>
            <button
              type="button"
              disabled={busy !== null || captureOperationId === null}
              onClick={() => void cancelCapture()}
            >
              取消采集
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void refreshCalibrationStatus()}
            >
              刷新状态
            </button>
          </div>
          <div className="capture-operation-meta">
            <span>
              <strong>
                {setupRevision ? `场地 ${setupRevision}` : "场地未保存"}
              </strong>
            </span>
            {captureOperationId && (
              <span>
                <strong>作业 {captureOperationId}</strong>
              </span>
            )}
          </div>

          <div className="next-point-card">
            <strong>下一点</strong>
            {recommendation ? (
              <>
                <p>
                  X {recommendation.xMm} · Y {recommendation.yMm} · Z{" "}
                  {recommendation.zMm} mm
                </p>
                <small>{recommendation.reason}</small>
                <button
                  type="button"
                  onClick={() =>
                    setCartesianTruth({
                      xMm: recommendation.xMm,
                      yMm: recommendation.yMm,
                      zMm: recommendation.zMm,
                    })
                  }
                >
                  设为真值
                </button>
              </>
            ) : (
              <p>暂无推荐</p>
            )}
          </div>

          <section className="quality-rejection" aria-labelledby="reject-title">
            <div>
              <h3 id="reject-title">质量</h3>
            </div>
            {snapshot.rejectReasons.length > 0 ? (
              <ul>
                {snapshot.rejectReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : (
              <p>
                {snapshot.phase === "qualified"
                  ? "通过"
                  : "无异常"}
              </p>
            )}
          </section>

          {lastError && (
            <p className="calibration-agent-error" role="alert">
              {lastError}
            </p>
          )}
        </section>

      <section
        className="calibration-secondary-grid"
        hidden={panel === "capture"}
      >
        <details
          className="calibration-mobile-fold anchor-coordinate-panel"
          hidden={panel !== "anchors"}
          open
        >
          <summary>
            <span>基站坐标</span>
            <small>{anchors.length} / 2–4 基站</small>
          </summary>
          <div className="anchor-coordinate-body">
            <div className="anchor-coordinate-table">
              {anchors.map((anchor, index) => (
                <div className="anchor-coordinate-row" key={anchor.id}>
                  <strong>{anchor.id}</strong>
                  {(["xMm", "yMm", "zMm"] as const).map((axis) => (
                    <label key={axis}>
                      <span>{axis.slice(0, 1).toUpperCase()}</span>
                      <input
                        type="number"
                        value={anchor[axis]}
                        onChange={(event) =>
                          updateAnchor(index, axis, Number(event.target.value))
                        }
                      />
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <div className="anchor-coordinate-actions">
              <button
                type="button"
                disabled={anchors.length >= MAX_ANCHORS}
                onClick={addAnchor}
              >
                增加基站
              </button>
              <button
                type="button"
                disabled={anchors.length <= MIN_ANCHORS}
                onClick={removeAnchor}
              >
                移除末位基站
              </button>
              <button
                type="button"
                aria-pressed={autoActivate}
                onClick={() => {
                  setAutoActivate((current) => !current);
                  setSetupDirty(true);
                }}
              >
                {autoActivate ? "自动切换：开" : "自动切换：关"}
              </button>
              <button
                type="button"
                disabled={busy !== null || !setupDirty}
                onClick={() =>
                  void saveSetup().catch((error) => {
                    setLastError(
                      error instanceof Error
                        ? error.message
                        : "场地配置保存失败",
                    );
                    setBusy(null);
                  })
                }
              >
                {setupDirty ? "保存场地配置" : `已保存 ${setupRevision ?? ""}`}
              </button>
            </div>
          </div>
        </details>

        <details
          className="calibration-mobile-fold position-compare-panel"
          hidden={panel !== "analysis"}
          open
        >
          <summary>
            <span>位置对比</span>
          </summary>
          <div className="position-comparison">
            {[
              { label: "钥匙真值", value: { ...truth, ...truthMetrics } },
              { label: "候选位置", value: candidate },
              { label: "正式位置", value: formal },
            ].map((item) => (
              <article key={item.label}>
                <span>{item.label}</span>
                <strong>
                  X {formatPosition(item.value, "xMm")} · Y{" "}
                  {formatPosition(item.value, "yMm")}
                </strong>
                <small>
                  Z {formatPosition(item.value, "zMm")} · r{" "}
                  {item.value?.radialM === null ||
                  item.value?.radialM === undefined
                    ? "--"
                    : `${item.value.radialM.toFixed(3)} m`}
                  {" · "}θ{" "}
                  {item.value?.angleDeg === null ||
                  item.value?.angleDeg === undefined
                    ? "--"
                    : `${item.value.angleDeg.toFixed(2)}°`}
                </small>
              </article>
            ))}
          </div>
        </details>

        <details
          className="calibration-mobile-fold heatmap-panel"
          hidden={panel !== "analysis"}
          open
        >
          <summary>
            <span>误差热力图</span>
          </summary>
          {hasHeatmapData ? (
            <div className="error-heatmap" aria-label="标定误差热力图">
              {heatmap.map((cell) => {
                const intensity =
                  cell.errorM === null ? 0 : clamp(cell.errorM / 0.3, 0, 1);
                return (
                  <span
                    key={`${cell.xMm}-${cell.yMm}`}
                    className={cell.errorM === null ? "is-empty" : ""}
                    style={
                      {
                        "--heat-intensity": intensity,
                      } as CSSProperties
                    }
                    title={
                      cell.errorM === null
                        ? `X ${cell.xMm} / Y ${cell.yMm}：无样本`
                        : `X ${cell.xMm} / Y ${cell.yMm}：误差 ${cell.errorM.toFixed(3)} m，${cell.samples} 组`
                    }
                  >
                    {cell.errorM === null ? "·" : cell.errorM.toFixed(2)}
                  </span>
                );
              })}
            </div>
          ) : (
            <div className="heatmap-empty" role="status">
              暂无误差
            </div>
          )}
        </details>

        <details
          className={`calibration-mobile-fold model-control-panel${
            modelVersion === "未载入" && candidateVersion === "无候选"
              ? " is-empty"
              : ""
          }`}
          hidden={panel !== "models"}
          open
        >
          <summary>
            <span>模型版本</span>
          </summary>
          <dl className="model-version-list">
            <div>
              <dt>正式模型</dt>
              <dd>{modelVersion}</dd>
            </div>
            <div>
              <dt>候选模型</dt>
              <dd>{candidateVersion}</dd>
            </div>
            <div>
              <dt>自动切换</dt>
              <dd>{autoActivate ? "候选通过后启用" : "仅手动激活"}</dd>
            </div>
          </dl>
          <div className="model-control-actions">
            <button
              type="button"
              disabled={busy !== null || candidateVersion === "无候选"}
              onClick={() =>
                void runModelAction(
                  "calibration.model.activate",
                  "候选模型已提升为正式模型",
                )
              }
            >
              提升为正式模型
            </button>
            <button
              type="button"
              className="calibration-danger-action"
              disabled={busy !== null}
              onClick={() =>
                void runModelAction(
                  "calibration.model.rollback",
                  "模型已回退到上一稳定版本",
                )
              }
            >
              回退模型
            </button>
          </div>
        </details>
      </section>
        </aside>
      </section>
    </main>
  );
}
