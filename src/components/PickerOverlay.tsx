import { useEffect, useState } from "react";
import { native, type PickerHover } from "../lib/native";
import { Ico } from "./icons";

type Params = {
  mode: "display" | "window" | "area";
  displayId: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hz: number;
};

function readParams(): Params {
  const q = new URLSearchParams(window.location.search);
  const num = (k: string) => Number(q.get(k) ?? "0");
  return {
    mode: (q.get("picker") as Params["mode"]) || "display",
    displayId: num("displayId"),
    name: q.get("name") || "Display",
    x: num("x"),
    y: num("y"),
    w: num("w"),
    h: num("h"),
    hz: num("hz"),
  };
}

export function PickerOverlay() {
  const [params] = useState<Params>(() => readParams());
  const [hover, setHover] = useState<PickerHover | null>(null);

  useEffect(() => {
    const off = native.onPickerHover(setHover);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void native.closePickerOverlays();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      void off.then((f) => f());
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (params.mode === "area") {
    return <AreaPicker params={params} />;
  }
  if (params.mode === "window") {
    return <WindowPicker params={params} hover={hover} />;
  }
  return <DisplayPicker params={params} hover={hover} />;
}

type Rect = { x: number; y: number; w: number; h: number };

function PickerActions({
  onStart,
  startDisabled,
  showChevron,
}: {
  onStart: () => void;
  startDisabled?: boolean;
  showChevron?: boolean;
}) {
  const openDev = () => {
    void native.openDevEditor().catch((e) => console.error(e));
  };

  return (
    <div className="picker-actions">
      <button className="picker-record" onClick={onStart} disabled={startDisabled}>
        <span className="picker-record-dot" aria-hidden />
        <span>Start recording</span>
        {showChevron && <Ico.chevDown size={11} style={{ opacity: 0.85 }} />}
      </button>
      {import.meta.env.DEV && (
        <button type="button" className="picker-dev" onClick={openDev}>
          Dev Mode
        </button>
      )}
    </div>
  );
}

function AreaPicker({ params }: { params: Params }) {
  const [drag, setDrag] = useState<{ startX: number; startY: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setRect(null);
    setDrag({ startX: e.clientX, startY: e.clientY });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!drag) return;
    const x = Math.min(drag.startX, e.clientX);
    const y = Math.min(drag.startY, e.clientY);
    const w = Math.abs(e.clientX - drag.startX);
    const h = Math.abs(e.clientY - drag.startY);
    setRect({ x, y, w, h });
  };
  const onMouseUp = () => {
    setDrag(null);
    if (rect && (rect.w < 10 || rect.h < 10)) setRect(null);
  };

  const start = () => {
    if (!rect) return;
    void native.pickerSelectArea({
      displayId: params.displayId,
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
    });
  };

  // Position the action pill below the rect; flip above if it would clip.
  const pillTop = rect ? (rect.y + rect.h + 12 > params.h - 56 ? rect.y - 56 : rect.y + rect.h + 12) : 0;
  const pillLeft = rect ? rect.x + rect.w / 2 : 0;

  return (
    <div
      className="picker-root picker-area-root"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {/* Dim everything, then "punch out" the selection via four masks. */}
      <div className="picker-area-dim picker-area-dim-top" style={{ height: rect ? `${rect.y}px` : "100%" }} />
      {rect && (
        <>
          <div
            className="picker-area-dim"
            style={{ top: `${rect.y}px`, left: 0, width: `${rect.x}px`, height: `${rect.h}px` }}
          />
          <div
            className="picker-area-dim"
            style={{ top: `${rect.y}px`, left: `${rect.x + rect.w}px`, right: 0, height: `${rect.h}px` }}
          />
          <div
            className="picker-area-dim"
            style={{ top: `${rect.y + rect.h}px`, left: 0, right: 0, bottom: 0 }}
          />
          <div
            className="picker-area-rect"
            style={{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` }}
          >
            <div className="picker-area-dims">
              {Math.round(rect.w)}×{Math.round(rect.h)}
            </div>
          </div>
          {!drag && (
            <div
              className="picker-area-pill"
              style={{ left: `${pillLeft}px`, top: `${pillTop}px` }}
              onMouseDown={(e) => e.stopPropagation()}
              onMouseMove={(e) => e.stopPropagation()}
              onMouseUp={(e) => e.stopPropagation()}
            >
              <PickerActions onStart={start} />
            </div>
          )}
        </>
      )}
      {!rect && (
        <div className="picker-area-hint">Click and drag to select an area · Esc to cancel</div>
      )}
    </div>
  );
}

function DisplayPicker({ params, hover }: { params: Params; hover: PickerHover | null }) {
  const isHovered =
    hover != null && hover.mode === "display" && hover.displayId === params.displayId;
  const start = () => void native.pickerSelectDisplay(params.displayId);
  return (
    <div className={`picker-root ${isHovered ? "is-hovered" : ""}`}>
      <div className="picker-tint" />
      <div className="picker-center">
        <div className="picker-title">{params.name}</div>
        <div className="picker-meta">
          {params.w}×{params.h} · {params.hz}FPS
        </div>
        <PickerActions onStart={start} showChevron />
      </div>
    </div>
  );
}

function WindowPicker({ params, hover }: { params: Params; hover: PickerHover | null }) {
  const onThisDisplay =
    hover != null && hover.mode === "window" && hover.displayId === params.displayId;
  const winId = onThisDisplay ? hover.windowId : null;
  const rect = onThisDisplay ? hover.rect : null;
  const owner = onThisDisplay ? hover.owner : null;
  const title = onThisDisplay ? hover.title : null;

  const start = () => {
    if (winId != null) void native.pickerSelectWindow(winId);
  };

  // Window rect from CG global coords → display-local CSS pixels.
  const localRect = rect
    ? { left: rect.x - params.x, top: rect.y - params.y, width: rect.w, height: rect.h }
    : null;

  return (
    <div className="picker-root picker-window-root">
      {localRect && (
        <div
          className="picker-window-highlight"
          style={{
            left: `${localRect.left}px`,
            top: `${localRect.top}px`,
            width: `${localRect.width}px`,
            height: `${localRect.height}px`,
          }}
        />
      )}
      {localRect && (
        <div
          className="picker-window-label"
          style={{
            left: `${localRect.left + localRect.width / 2}px`,
            top: `${localRect.top + localRect.height / 2}px`,
          }}
        >
          <div className="picker-title picker-title-sm">
            {(owner || "Window") + (title ? " — " + title : "")}
          </div>
          <div className="picker-meta">
            {Math.round(localRect.width)}×{Math.round(localRect.height)}
          </div>
          <PickerActions onStart={start} showChevron />
        </div>
      )}
    </div>
  );
}
