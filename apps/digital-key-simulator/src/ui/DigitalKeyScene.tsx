import { useRef } from "react";

export interface ScenePoint {
  x: number;
  y: number;
}

interface DigitalKeySceneProps {
  position: ScenePoint;
  idBits: boolean[];
  status: "locked" | "welcome" | "unlocked";
  faultedAnchor?: "A1" | "A2" | "A3";
  interactive?: boolean;
  bearingValid?: boolean;
  stale?: boolean;
  showRangeLines?: boolean;
  title?: string;
  sourceLabel?: string;
  onMove(position: ScenePoint): void;
}

const VIEWBOX_WIDTH = 800;
const ORIGIN_X = 400;
const ORIGIN_Y = 566;
const PIXELS_PER_METER = 132;

const anchors = [
  {
    id: "A1",
    domId: "anchor-a1",
    x: 376.24,
    y: 536.96,
    label: "锚点 A1 · -180, 220 mm",
  },
  {
    id: "A2",
    domId: "anchor-a2",
    x: 423.76,
    y: 536.96,
    label: "锚点 A2 · 180, 220 mm",
  },
  {
    id: "A3",
    domId: "anchor-a3",
    x: 400,
    y: 595.04,
    label: "锚点 A3 · 0, -220 mm",
  },
] as const;

function clampPosition(point: ScenePoint): ScenePoint {
  const y = Math.min(3.15, Math.max(0.18, point.y));
  return {
    x: Math.min(y, Math.max(-y, point.x)),
    y,
  };
}

function sceneCoordinates(position: ScenePoint) {
  return {
    x: ORIGIN_X + position.x * PIXELS_PER_METER,
    y: ORIGIN_Y - position.y * PIXELS_PER_METER,
  };
}

export function DigitalKeyScene({
  position,
  idBits,
  status,
  faultedAnchor,
  interactive = true,
  bearingValid = true,
  stale = false,
  showRangeLines = true,
  title = "门锁前向定位场",
  sourceLabel = "三锚点定位",
  onMove,
}: DigitalKeySceneProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const key = sceneCoordinates(position);
  const distance = Math.hypot(position.x, position.y);
  const angle = (Math.atan2(position.x, position.y) * 180) / Math.PI;

  function positionFromPointer(clientX: number, clientY: number) {
    if (!interactive) {
      return;
    }
    const rectangle = svgRef.current?.getBoundingClientRect();
    if (!rectangle) {
      return;
    }
    const svgX = ((clientX - rectangle.left) / rectangle.width) * VIEWBOX_WIDTH;
    const svgY = ((clientY - rectangle.top) / rectangle.height) * 620;
    onMove(
      clampPosition({
        x: (svgX - ORIGIN_X) / PIXELS_PER_METER,
        y: (ORIGIN_Y - svgY) / PIXELS_PER_METER,
      }),
    );
  }

  function handleKeyDown(event: React.KeyboardEvent<SVGGElement>) {
    if (!interactive) {
      return;
    }
    const step = event.shiftKey ? 0.2 : 0.05;
    const movement: Record<string, ScenePoint> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: step },
      ArrowDown: { x: 0, y: -step },
    };
    const delta = movement[event.key];
    if (!delta) {
      return;
    }
    event.preventDefault();
    onMove(
      clampPosition({
        x: position.x + delta.x,
        y: position.y + delta.y,
      }),
    );
  }

  return (
    <section className="scene-panel" aria-labelledby="scene-title">
      <header className="panel-header scene-heading">
        <div>
          <span className="panel-code">SPATIAL / 01</span>
          <h2 id="scene-title">{title}</h2>
          <p className="scene-source">{sourceLabel}</p>
        </div>
        <div
          className="scene-readout"
          aria-label={bearingValid ? "钥匙实时坐标" : "钥匙距离有效，方向未锁定"}
        >
          <span>
            X <strong>{bearingValid ? position.x.toFixed(2) : "--"}</strong>
            {bearingValid ? " m" : ""}
          </span>
          <span>
            Y <strong>{bearingValid ? position.y.toFixed(2) : "--"}</strong>
            {bearingValid ? " m" : ""}
          </span>
          <span>
            θ <strong>{bearingValid ? `${angle.toFixed(1)}°` : "方向未锁定"}</strong>
          </span>
        </div>
      </header>

      <div className="scene-stage">
        <svg
          ref={svgRef}
          viewBox="0 0 800 620"
          role="img"
          aria-labelledby="scene-svg-title scene-svg-desc"
          onPointerMove={(event) => {
            if (dragging.current) {
              positionFromPointer(event.clientX, event.clientY);
            }
          }}
          onPointerUp={(event) => {
            dragging.current = false;
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
        >
          <title id="scene-svg-title">数字钥匙三锚点二维定位场</title>
          <desc id="scene-svg-desc">
            门锁位于底部原点，检测范围为正前方正负四十五度。
            {interactive
              ? "可拖动钥匙，或聚焦钥匙后使用方向键移动。"
              : "钥匙位置来自电脑端已经完成拟合的实时结果，网页不参与重新定位。"}
          </desc>
          <defs>
            <pattern
              id="micro-grid"
              width="22"
              height="22"
              patternUnits="userSpaceOnUse"
            >
              <path d="M 22 0 L 0 0 0 22" className="micro-grid-line" />
            </pattern>
            <linearGradient id="zone-fade" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0" className="zone-stop-near" />
              <stop offset="1" className="zone-stop-far" />
            </linearGradient>
            <filter id="signal-glow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <rect width="800" height="620" rx="18" className="scene-base" />
          <rect width="800" height="620" rx="18" fill="url(#micro-grid)" />

          <path d="M400 566 L92 258 A436 436 0 0 1 708 258 Z" className="field-envelope" />
          <path d="M400 566 L307 473 A132 132 0 0 1 493 473 Z" className="zone zone-unlock" />
          <path d="M307 473 A132 132 0 0 1 493 473 L586 380 A264 264 0 0 0 214 380 Z" className="zone zone-welcome" />
          <path d="M214 380 A264 264 0 0 1 586 380 L679 287 A396 396 0 0 0 121 287 Z" className="zone zone-monitor" />
          <path d="M400 566 L92 258" className="limit-line" />
          <path d="M400 566 L708 258" className="limit-line" />

          <g className="zone-label zone-label-monitor">
            <text x="400" y="300">监测区</text>
            <text x="400" y="320">2.00–3.00 m</text>
          </g>
          <g className="zone-label zone-label-welcome">
            <text x="400" y="398">迎宾区</text>
            <text x="400" y="418">1.00–2.00 m</text>
          </g>
          <g className="zone-label zone-label-unlock">
            <text x="400" y="490">解锁区</text>
            <text x="400" y="510">≤ 1.00 m</text>
          </g>
          <text x="76" y="246" className="angle-label">-45°</text>
          <text x="682" y="246" className="angle-label">+45°</text>

          {anchors.map((anchor) => {
            const isFaulted = faultedAnchor === anchor.id;
            return (
              <g
                key={anchor.id}
                id={anchor.domId}
                className={isFaulted ? "anchor anchor-fault" : "anchor"}
              >
                {showRangeLines && (
                  <line x1={anchor.x} y1={anchor.y} x2={key.x} y2={key.y} className="range-line" />
                )}
                <circle cx={anchor.x} cy={anchor.y} r="15" />
                <circle cx={anchor.x} cy={anchor.y} r="4" className="anchor-core" />
                <text x={anchor.x} y={anchor.y + 34}>{anchor.id}</text>
                <title>{anchor.label}</title>
              </g>
            );
          })}

          <g className={`door-origin door-${status}`}>
            <path d="M310 570 H490 L472 606 H328 Z" />
            <path d="M362 570 V548 H438 V570" />
            <text x="400" y="598">DOOR / ORIGIN</text>
          </g>

          {!bearingValid && (
            <g className="bearing-uncertainty" aria-label="只能确定距离，方向尚未锁定">
              <path d={`M400 566 m-${distance * PIXELS_PER_METER},0 a${distance * PIXELS_PER_METER},${distance * PIXELS_PER_METER} 0 0,1 ${distance * PIXELS_PER_METER * 2},0`} />
              <text x="400" y={Math.max(56, key.y - 58)}>方向未锁定 · 距离投影</text>
            </g>
          )}

          <g
            className={`digital-key key-${status}${bearingValid ? "" : " key-range-only"}${stale ? " key-stale" : ""}`}
            role="slider"
            tabIndex={0}
            aria-label={bearingValid ? "数字钥匙位置" : "钥匙距离投影，方向未锁定"}
            aria-disabled={!interactive}
            aria-valuemin={0}
            aria-valuemax={3.15}
            aria-valuenow={Number(distance.toFixed(2))}
            aria-valuetext={
              bearingValid
                ? `${distance.toFixed(2)} 米，方位角 ${angle.toFixed(1)} 度`
                : `${distance.toFixed(2)} 米，方向未锁定`
            }
            transform={`translate(${key.x} ${key.y})`}
            onKeyDown={handleKeyDown}
            onPointerDown={(event) => {
              if (!interactive) {
                return;
              }
              dragging.current = true;
              event.currentTarget.ownerSVGElement?.setPointerCapture(
                event.pointerId,
              );
              positionFromPointer(event.clientX, event.clientY);
            }}
          >
            <circle r="47" className="pulse-ring pulse-ring-outer" />
            <circle r="36" className="pulse-ring pulse-ring-inner" />
            <circle r="25" className="key-body" filter="url(#signal-glow)" />
            <path d="M-7 -12 H8 L16 -4 V10 L8 18 H-7 L-16 10 V-4 Z" className="key-glyph" />
            <g className="id-bits" aria-label={`四位 ID ${idBits.map(Number).join("")}`}>
              {idBits.map((bit, index) => (
                <rect
                  key={index}
                  x={-15 + index * 9}
                  y="27"
                  width="6"
                  height="4"
                  rx="2"
                  className={bit ? "bit-on" : "bit-off"}
                />
              ))}
            </g>
          </g>
        </svg>

        <div className="scene-instruction">
          {interactive ? (
            <>
              <span>拖动钥匙</span>
              <span>方向键微调 5 cm</span>
              <span>Shift + 方向键 20 cm</span>
            </>
          ) : (
            <>
              <span>位置来自电脑拟合</span>
              <span>{bearingValid ? "二维位置有效" : "当前仅距离有效"}</span>
              <span>{stale ? "数据已停止更新" : "实时数据流"}</span>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
