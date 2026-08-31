import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { PetStatus } from "../types";

type PetState = "idle" | "running" | "waiting" | "review" | "failed" | "waving";

type Props = {
  status: PetStatus;
  running: boolean;
  waiting: boolean;
  reviewing: boolean;
  failed: boolean;
  onOpen: () => void;
};

const animations: Record<PetState, { row: number; frames: number; duration: number }> = {
  idle: { row: 0, frames: 6, duration: 720 },
  running: { row: 7, frames: 6, duration: 120 },
  waiting: { row: 6, frames: 6, duration: 150 },
  review: { row: 8, frames: 6, duration: 150 },
  failed: { row: 5, frames: 8, duration: 180 },
  waving: { row: 3, frames: 4, duration: 180 },
};

type Position = { x: number; y: number };

function maximumY(height: number) {
  const composerClearance = window.innerWidth <= 560 ? 110 : 12;
  return Math.max(58, window.innerHeight - height - composerClearance);
}

function initialPosition() {
  try {
    const saved = JSON.parse(localStorage.getItem("codex-fnos-pet-position") || "null") as Position | null;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved;
  } catch { /* Ignore corrupt per-device placement. */ }
  return {
    x: Math.max(12, window.innerWidth - 142),
    y: window.innerWidth <= 560 ? maximumY(104) : Math.max(80, window.innerHeight - 268),
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function PetCompanion({ status, running, waiting, reviewing, failed, onOpen }: Props) {
  const pet = status.pets.find((item) => item.id === status.settings.activePetId) ?? null;
  const [frame, setFrame] = useState(0);
  const [look, setLook] = useState<number | null>(null);
  const [celebrating, setCelebrating] = useState(false);
  const [position, setPosition] = useState<Position>(initialPosition);
  const root = useRef<HTMLButtonElement>(null);
  const previousRunning = useRef(false);
  const drag = useRef<{ id: number; x: number; y: number; originX: number; originY: number; currentX: number; currentY: number; moved: boolean } | null>(null);
  const prefersReduced = useMemo(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, []);
  const reduced = prefersReduced || status.settings.motion === "reduced";

  useEffect(() => {
    if (previousRunning.current && !running && !waiting && !failed) {
      setCelebrating(true);
      const timer = window.setTimeout(() => setCelebrating(false), 2_400);
      previousRunning.current = running;
      return () => window.clearTimeout(timer);
    }
    previousRunning.current = running;
  }, [failed, running, waiting]);

  const state: PetState = waiting ? "waiting" : running ? "running" : failed ? "failed" : reviewing ? "review" : celebrating ? "waving" : "idle";
  const animation = animations[state];

  useEffect(() => {
    setFrame(0);
    if (reduced) return;
    const timer = window.setInterval(() => setFrame((value) => (value + 1) % animation.frames), animation.duration);
    return () => window.clearInterval(timer);
  }, [animation.duration, animation.frames, reduced, state]);

  useEffect(() => {
    if (!pet || pet.spriteVersionNumber !== 2 || state !== "idle" || reduced) {
      setLook(null);
      return;
    }
    let pending = false;
    let pointer: { x: number; y: number } | null = null;
    const update = () => {
      pending = false;
      const rect = root.current?.getBoundingClientRect();
      if (!rect || !pointer) return;
      const dx = pointer.x - (rect.left + rect.width / 2);
      const dy = pointer.y - (rect.top + rect.height / 2);
      if (Math.hypot(dx, dy) < 34) return setLook(null);
      const degrees = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
      setLook(Math.round(degrees / 22.5) % 16);
    };
    const move = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (!pending) { pending = true; window.requestAnimationFrame(update); }
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, [pet?.id, pet?.spriteVersionNumber, reduced, state]);

  useEffect(() => {
    const width = Math.round(96 * status.settings.scale);
    const height = Math.round(104 * status.settings.scale);
    const resize = () => setPosition((current) => ({
      x: clamp(current.x, 8, Math.max(8, window.innerWidth - width - 8)),
      y: clamp(current.y, 58, maximumY(height)),
    }));
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [status.settings.scale]);

  if (!pet || !status.settings.visible) return null;
  const scale = status.settings.scale;
  const width = Math.round(96 * scale);
  const height = Math.round(104 * scale);
  const row = look === null ? animation.row : look < 8 ? 9 : 10;
  const column = look === null ? frame : look % 8;
  const rows = pet.spriteVersionNumber === 2 ? 11 : 9;
  const style = {
    left: position.x,
    top: position.y,
    width,
    height,
    backgroundImage: `url(/api/pets/${encodeURIComponent(pet.id)}/spritesheet)`,
    backgroundSize: `${width * 8}px ${height * rows}px`,
    backgroundPosition: `${-column * width}px ${-row * height}px`,
  } satisfies CSSProperties;

  function pointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: position.x, originY: position.y, currentX: position.x, currentY: position.y, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    const dx = event.clientX - drag.current.x;
    const dy = event.clientY - drag.current.y;
    if (Math.hypot(dx, dy) > 4) drag.current.moved = true;
    const next = {
      x: clamp(drag.current.originX + dx, 8, Math.max(8, window.innerWidth - width - 8)),
      y: clamp(drag.current.originY + dy, 58, maximumY(height)),
    };
    drag.current.currentX = next.x;
    drag.current.currentY = next.y;
    setPosition(next);
  }

  function pointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag.current || drag.current.id !== event.pointerId) return;
    const { moved, currentX, currentY } = drag.current;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    localStorage.setItem("codex-fnos-pet-position", JSON.stringify({ x: currentX, y: currentY }));
    if (!moved) onOpen();
  }

  function pointerCancel(event: ReactPointerEvent<HTMLButtonElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return <button
    ref={root}
    className={`pet-companion pet-state-${state} ${reduced ? "reduced" : ""}`}
    style={style}
    title={`${pet.displayName} · ${state === "running" ? "Codex 正在工作" : state === "waiting" ? "等待你的操作" : "点击打开宠物中心，拖动可改变位置"}`}
    aria-label={`${pet.displayName}，点击打开宠物中心`}
    onPointerDown={pointerDown}
    onPointerMove={pointerMove}
    onPointerUp={pointerUp}
    onPointerCancel={pointerCancel}
  />;
}
