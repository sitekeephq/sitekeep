/**
 * First-person walking ("Yürüme"): WASD / arrows move, the mouse looks around (pointer lock on
 * click, Esc releases it), Shift runs, Q / E go down / up. The eye stays 1.7 m above the floor
 * found by a downward raycast and follows stairs smoothly; a short forward raycast stops the walk
 * at walls. Raycasts run one at a time and at most ~25 per second each, so the Fragments worker is
 * never flooded. Phones use the joystick (setJoystick) and touch-drag to look.
 */
import * as THREE from "three";
import type { ViewerEngine } from "../core/ViewerEngine.js";
import {
  EYE_HEIGHT,
  MAX_STEP,
  NO_MOVE,
  WALK_SPEED,
  canMove,
  clampPitch,
  floorFromProbe,
  isWalkKey,
  keysToMovement,
  lookDirection,
  moveDelta,
  smoothEyeHeight,
  yawPitchOf,
  type MoveInput,
  type WallProbe,
} from "./walk-math.js";
import { isTypingTarget } from "./shortcuts.js";

const LOOK_SPEED = 0.0025; // rad per pixel (pointer lock)
const TOUCH_LOOK_SPEED = 0.005;
/** At most one floor and one wall probe per this many ms (≈ 25 per second; the height is smoothed anyway). */
const PROBE_MS = 40;

export class WalkController {
  active = false;
  speed: number = WALK_SPEED.default;
  pointerLocked = false;
  onChange: () => void = () => undefined;

  private yaw = 0;
  private pitch = 0;
  /** Q / E offset on top of the eye height. */
  private extra = 0;
  private readonly pos = new THREE.Vector3();
  private readonly keys = new Set<string>();
  private joystick: MoveInput = NO_MOVE;
  private floorY: number | null = null;
  private wall: WallProbe | null = null;
  private moveDir: [number, number] = [0, -1];
  private raf = 0;
  private last = 0;
  private floorBusy = false;
  private wallBusy = false;
  private floorAt = 0;
  private wallAt = 0;
  private dirty = true;
  private touchLook: { id: number; x: number; y: number } | null = null; // drag-to-look pointer
  private readonly probeCam = new THREE.PerspectiveCamera(2, 1, 0.02, 500);
  /** IFC doors may be modelled closed; cache which picked elements walking may pass through. */
  private readonly passable = new Map<string, boolean>();

  constructor(private readonly engine: ViewerEngine) {}

  private get canvas(): HTMLCanvasElement {
    return this.engine.world.renderer!.three.domElement;
  }

  /** Starts walking from the camera (or at a dropped-in eye point). */
  async start(at?: THREE.Vector3) {
    const controls = this.engine.world.camera.controls;
    const p = controls.getPosition(new THREE.Vector3());
    const t = controls.getTarget(new THREE.Vector3());
    const look = yawPitchOf([t.x - p.x, t.y - p.y, t.z - p.z]);
    this.yaw = look.yaw;
    this.pitch = at ? 0 : clampPitch(look.pitch * 0.5);
    this.pos.copy(at ?? p);
    this.extra = 0;
    this.floorY = at ? at.y - EYE_HEIGHT : null;
    this.wall = null;
    this.dirty = true;
    if (at) {
      this.applyCamera();
    }
    if (this.active) return;
    this.active = true;
    controls.enabled = false;
    const c = this.canvas;
    // camera-controls clears touch-action when disabled; touch-drag looks around, it must not scroll.
    c.style.touchAction = "none";
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    c.addEventListener("click", this.onClick);
    c.addEventListener("pointerdown", this.onPointerDown);
    c.addEventListener("pointermove", this.onPointerMove);
    c.addEventListener("pointerup", this.onPointerUp);
    c.addEventListener("pointercancel", this.onPointerUp);
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("pointerlockchange", this.onLockChange);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    this.onChange();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    cancelAnimationFrame(this.raf);
    const c = this.canvas;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    c.removeEventListener("click", this.onClick);
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointercancel", this.onPointerUp);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("pointerlockchange", this.onLockChange);
    if (document.pointerLockElement === c) document.exitPointerLock();
    this.pointerLocked = false;
    this.keys.clear();
    this.joystick = NO_MOVE;
    this.touchLook = null;
    const controls = this.engine.world.camera.controls;
    controls.enabled = true;
    // Orbit around a point a few metres ahead instead of the eye itself.
    const [dx, dy, dz] = lookDirection(this.yaw, this.pitch);
    void controls.setLookAt(this.pos.x, this.pos.y, this.pos.z, this.pos.x + dx * 5, this.pos.y + dy * 5, this.pos.z + dz * 5, false);
    this.engine.fragments.core.update(true);
    this.onChange();
  }

  setSpeed(speed: number) {
    this.speed = Math.max(WALK_SPEED.min, Math.min(WALK_SPEED.max, speed));
    this.onChange();
  }

  /** Phone joystick: forward / right in −1 … 1. */
  setJoystick(input: MoveInput) {
    this.joystick = input;
  }

  dispose() {
    this.stop();
  }

  // ------------------------------------------------------------------ frame

  private frame = (now: number) => {
    if (!this.active) return;
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const keys = keysToMovement(this.keys);
    const input: MoveInput = {
      forward: keys.forward + this.joystick.forward,
      right: keys.right + this.joystick.right,
      up: keys.up,
      run: keys.run || this.joystick.run,
    };
    const { dx, dy, dz } = moveDelta(input, this.yaw, this.speed, dt);
    const moving = Math.hypot(dx, dz) > 1e-6;
    if (moving) {
      const len = Math.hypot(dx, dz);
      this.moveDir = [dx / len, dz / len];
      if (canMove(this.wall, dx, dz)) {
        this.pos.x += dx;
        this.pos.z += dz;
        this.dirty = true;
      }
    }
    if (dy) {
      if (this.floorY === null) this.pos.y += dy;
      else this.extra = Math.max(-(EYE_HEIGHT - 0.3), this.extra + dy);
      this.dirty = true;
    }
    const y = smoothEyeHeight(this.pos.y, this.floorY === null ? null : this.floorY + this.extra, dt);
    if (Math.abs(y - this.pos.y) > 1e-5) {
      this.pos.y = y;
      this.dirty = true;
    }
    if (this.dirty) {
      this.dirty = false;
      this.applyCamera();
    }
    if (!this.floorBusy && now - this.floorAt >= PROBE_MS) {
      this.floorAt = now;
      void this.probeFloor();
    }
    if (moving && !this.wallBusy && now - this.wallAt >= PROBE_MS) {
      this.wallAt = now;
      void this.probeWall();
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  /** CameraControls is disabled while walking; update the Three.js camera directly. */
  private applyCamera() {
    const [dx, dy, dz] = lookDirection(this.yaw, this.pitch);
    const camera = this.engine.world.camera.three;
    camera.position.copy(this.pos);
    camera.lookAt(this.pos.x + dx, this.pos.y + dy, this.pos.z + dz);
    camera.updateMatrixWorld(true);
    this.engine.fragments.core.update(true);
  }

  /** Raycast from `origin` along `dir` (unit) through a narrow helper camera; distance to the hit or null. */
  private async cast(origin: THREE.Vector3, dir: THREE.Vector3, classify = false): Promise<{ point: THREE.Vector3; distance: number; passable: boolean } | null> {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const cam = this.probeCam;
    cam.aspect = rect.width / rect.height;
    cam.position.copy(origin);
    cam.up.set(0, 1, 0);
    if (Math.abs(dir.y) > 0.99) cam.up.set(0, 0, -1);
    cam.lookAt(origin.clone().add(dir));
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    try {
      const hit = await this.engine.fragments.raycast({
        camera: cam,
        mouse: new THREE.Vector2(rect.left + rect.width / 2, rect.top + rect.height / 2),
        dom: canvas,
      });
      if (!hit) return null;
      const distance = hit.point.clone().sub(origin).dot(dir);
      if (distance <= 0) return null;
      let passable = false;
      if (classify && hit.fragments && hit.localId !== undefined) {
        const key = `${hit.fragments.modelId}:${hit.localId}`;
        const cached = this.passable.get(key);
        if (cached !== undefined) passable = cached;
        else {
          const [data] = await hit.fragments.getItemsData([hit.localId], { attributesDefault: true });
          const raw = data?._category;
          const category = raw && typeof raw === "object" && "value" in raw ? String(raw.value) : String(raw ?? "");
          passable = /^IFC(?:DOOR|OPENINGELEMENT)$/i.test(category);
          this.passable.set(key, passable);
        }
      }
      return { point: hit.point, distance, passable };
    } catch {
      return null;
    }
  }

  private async probeFloor() {
    this.floorBusy = true;
    const feet = this.floorY === null ? this.pos.y - EYE_HEIGHT : this.pos.y - EYE_HEIGHT - this.extra;
    const origin = new THREE.Vector3(this.pos.x, feet + MAX_STEP, this.pos.z);
    const hit = await this.cast(origin, new THREE.Vector3(0, -1, 0));
    if (this.active) {
      const floor = floorFromProbe(feet, hit ? hit.point.y : null);
      // No floor (outside the building, over a shaft): keep the current height.
      if (floor !== null) this.floorY = floor;
      else if (!hit) this.floorY = null;
    }
    this.floorBusy = false;
  }

  private async probeWall() {
    this.wallBusy = true;
    const [x, z] = this.moveDir;
    const feet = this.pos.y - EYE_HEIGHT - this.extra;
    // Knee height: low enough for walls, above stair steps.
    const origin = new THREE.Vector3(this.pos.x, feet + MAX_STEP + 0.2, this.pos.z);
    const hit = await this.cast(origin, new THREE.Vector3(x, 0, z), true);
    if (this.active) this.wall = hit && !hit.passable ? { dir: [x, z], distance: hit.distance } : { dir: [x, z], distance: Infinity };
    this.wallBusy = false;
  }

  // ------------------------------------------------------------------ input

  private onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!isWalkKey(e.code)) return;
    this.keys.add(e.code);
    if (e.code.startsWith("Arrow")) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private onBlur = () => this.keys.clear();

  private onClick = (e: MouseEvent) => {
    if ((e as PointerEvent).pointerType === "touch") return;
    if (document.pointerLockElement === this.canvas) return;
    try {
      // Returns a promise in current browsers; a refusal (iframe policy) leaves drag-to-look.
      const req = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      req?.catch?.(() => undefined);
    } catch {
      // Older browsers throw instead.
    }
  };

  private onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== this.canvas) return;
    this.look(e.movementX * LOOK_SPEED, e.movementY * LOOK_SPEED);
  };

  /** Drag to look (touch, or a mouse when pointer lock is not available). */
  private onPointerDown = (e: PointerEvent) => {
    if (this.touchLook || document.pointerLockElement === this.canvas) return;
    this.touchLook = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.touchLook || e.pointerId !== this.touchLook.id) return;
    this.look((e.clientX - this.touchLook.x) * TOUCH_LOOK_SPEED, (e.clientY - this.touchLook.y) * TOUCH_LOOK_SPEED);
    this.touchLook.x = e.clientX;
    this.touchLook.y = e.clientY;
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.touchLook?.id === e.pointerId) this.touchLook = null;
  };

  private onLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    this.onChange();
  };

  private look(dx: number, dy: number) {
    this.yaw -= dx;
    this.pitch = clampPitch(this.pitch - dy);
    this.dirty = true;
  }
}
