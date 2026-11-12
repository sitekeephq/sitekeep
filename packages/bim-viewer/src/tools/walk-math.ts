/**
 * Pure maths of the first-person "Yürüme" mode: key → movement mapping, movement in the
 * horizontal plane, eye height smoothing over floors and stairs, a simple forward collision
 * check and the phone joystick. Scene axes: metres, Y up; yaw 0 looks towards −Z.
 */

/** Eye height above the floor (m). */
export const EYE_HEIGHT = 1.7;
/** Floors higher than this above the feet are obstacles, not steps (m). */
export const MAX_STEP = 0.5;
/** Distance kept from walls (m). */
export const BODY_RADIUS = 0.35;
/** Walking speed slider (m/s). */
export const WALK_SPEED = { min: 0.5, max: 6, default: 1.5, step: 0.5 } as const;
/** Shift multiplies the speed. */
export const RUN_FACTOR = 2.5;

export interface MoveInput {
  /** −1 … 1: S / W */
  forward: number;
  /** −1 … 1: A / D */
  right: number;
  /** −1 … 1: Q / E */
  up: number;
  run: boolean;
}

export const NO_MOVE: MoveInput = { forward: 0, right: 0, up: 0, run: false };

const KEYS: Record<string, Partial<Record<"forward" | "right" | "up", number>>> = {
  KeyW: { forward: 1 },
  ArrowUp: { forward: 1 },
  KeyS: { forward: -1 },
  ArrowDown: { forward: -1 },
  KeyD: { right: 1 },
  ArrowRight: { right: 1 },
  KeyA: { right: -1 },
  ArrowLeft: { right: -1 },
  KeyE: { up: 1 },
  KeyQ: { up: -1 },
};
const RUN_KEYS = new Set(["ShiftLeft", "ShiftRight"]);

/** Keys (KeyboardEvent.code) the walk mode listens to. */
export function isWalkKey(code: string): boolean {
  return code in KEYS || RUN_KEYS.has(code);
}

/** Pressed keys (KeyboardEvent.code) → movement; opposite keys cancel out. */
export function keysToMovement(pressed: Iterable<string>): MoveInput {
  const out = { forward: 0, right: 0, up: 0, run: false };
  const seen = new Set<string>();
  for (const code of pressed) {
    if (RUN_KEYS.has(code)) out.run = true;
    const k = KEYS[code];
    // W and ↑ together are still one step forward.
    const axis = k && (Object.keys(k)[0] as "forward" | "right" | "up");
    if (!k || !axis || seen.has(`${axis}${k[axis]}`)) continue;
    seen.add(`${axis}${k[axis]}`);
    out[axis] += k[axis]!;
  }
  return out;
}

/** Joystick knob offset (px, y down) → forward / right in −1 … 1, with a small dead zone. */
export function joystickToMovement(dx: number, dy: number, radius: number, deadZone = 0.15): MoveInput {
  if (radius <= 0) return NO_MOVE;
  let x = dx / radius;
  let y = -dy / radius;
  const len = Math.hypot(x, y);
  if (len < deadZone) return NO_MOVE;
  if (len > 1) {
    x /= len;
    y /= len;
  }
  return { forward: y, right: x, up: 0, run: Math.min(1, len) > 0.95 };
}

/** Horizontal forward and right unit vectors for a yaw angle: [x, z]. */
export function yawAxes(yaw: number): { forward: [number, number]; right: [number, number] } {
  return { forward: [-Math.sin(yaw), -Math.cos(yaw)], right: [Math.cos(yaw), -Math.sin(yaw)] };
}

/** Look direction for yaw / pitch (radians). */
export function lookDirection(yaw: number, pitch: number): [number, number, number] {
  const c = Math.cos(pitch);
  return [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c];
}

/** Yaw / pitch of a look direction (inverse of lookDirection). */
export function yawPitchOf(dir: [number, number, number]): { yaw: number; pitch: number } {
  const [x, y, z] = dir;
  const len = Math.hypot(x, y, z) || 1;
  return { yaw: Math.atan2(-x, -z), pitch: Math.asin(Math.max(-1, Math.min(1, y / len))) };
}

const PITCH_LIMIT = (85 * Math.PI) / 180;
export function clampPitch(pitch: number): number {
  return Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
}

/**
 * Displacement for one frame: horizontal along the yaw (diagonals are not faster), vertical from
 * Q / E. Speed in m/s, dt in seconds.
 */
export function moveDelta(input: MoveInput, yaw: number, speed: number, dt: number): { dx: number; dy: number; dz: number } {
  const v = speed * (input.run ? RUN_FACTOR : 1) * dt;
  let f = input.forward;
  let r = input.right;
  const len = Math.hypot(f, r);
  if (len > 1) {
    f /= len;
    r /= len;
  }
  const { forward, right } = yawAxes(yaw);
  return {
    dx: (forward[0] * f + right[0] * r) * v,
    dy: input.up * v,
    dz: (forward[1] * f + right[1] * r) * v,
  };
}

/**
 * Next eye height: follows the floor (plus the eye height) smoothly, so stairs and slab edges do
 * not jump. Without a floor under the camera the current height stays.
 */
export function smoothEyeHeight(current: number, floorY: number | null, dt: number, opts: { eyeHeight?: number; rate?: number } = {}): number {
  if (floorY === null || !Number.isFinite(floorY)) return current;
  const target = floorY + (opts.eyeHeight ?? EYE_HEIGHT);
  const diff = target - current;
  if (Math.abs(diff) < 1e-3) return target;
  const k = 1 - Math.exp(-(opts.rate ?? 10) * Math.max(0, dt));
  return current + diff * k;
}

/**
 * Picks the floor from a downward probe started MAX_STEP above the feet: a hit higher than that is
 * an obstacle (a table), not a floor. Returns null when there is no usable floor.
 */
export function floorFromProbe(feetY: number, hitY: number | null): number | null {
  if (hitY === null || !Number.isFinite(hitY)) return null;
  return hitY > feetY + MAX_STEP + 1e-6 ? null : hitY;
}

/** A forward wall probe: horizontal direction [x, z] (unit) and the distance to the hit. */
export interface WallProbe {
  dir: [number, number];
  distance: number;
}

/** False when the move [dx, dz] heads into a wall closer than the body radius plus the step. */
export function canMove(probe: WallProbe | null, dx: number, dz: number, radius = BODY_RADIUS): boolean {
  const len = Math.hypot(dx, dz);
  if (!probe || len < 1e-9) return true;
  const dot = (dx / len) * probe.dir[0] + (dz / len) * probe.dir[1];
  if (dot < 0.5) return true;
  return probe.distance > radius + len;
}
