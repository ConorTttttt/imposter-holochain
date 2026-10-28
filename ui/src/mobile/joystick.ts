// Touch movement is deliberately an input adapter. The game loop remains the
// single authority for collision, walls, speed, and role-specific restrictions.
export type Direction = Readonly<{ x: number; y: number }>;

const STILL: Direction = Object.freeze({ x: 0, y: 0 });
const DEAD_ZONE = 0.15;

/** A clamped analog direction, with a small centre dead zone (no drift). */
export function joystickVector(dx: number, dy: number, radius: number): Direction {
  if (![dx, dy, radius].every(Number.isFinite) || radius <= 0) return STILL;
  const distance = Math.hypot(dx, dy);
  if (distance <= radius * DEAD_ZONE) return STILL;
  const strength = Math.min(1, (distance / radius - DEAD_ZONE) / (1 - DEAD_ZONE));
  return { x: (dx / distance) * strength, y: (dy / distance) * strength };
}

/** Pointer capture keeps control when a finger slides beyond the circular pad. */
export class TouchJoystick {
  private pointerId: number | null = null;
  private value: Direction = STILL;
  private readonly thumb: HTMLElement;

  constructor(private readonly pad: HTMLElement) {
    const thumb = pad.querySelector<HTMLElement>(".mobile-stick");
    if (!thumb) throw new Error("Missing mobile joystick thumb");
    this.thumb = thumb;
    pad.addEventListener("pointerdown", this.down);
    pad.addEventListener("pointermove", this.move);
    pad.addEventListener("pointerup", this.up);
    pad.addEventListener("pointercancel", this.up);
    pad.addEventListener("lostpointercapture", this.up);
    window.addEventListener("blur", () => this.reset());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.reset();
    });
  }

  get direction(): Direction {
    return this.value;
  }

  reset(): void {
    this.pointerId = null;
    this.value = STILL;
    this.thumb.style.transform = "translate(-50%, -50%)";
  }

  private readonly down = (event: PointerEvent): void => {
    if (this.pointerId !== null || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    this.pointerId = event.pointerId;
    this.pad.setPointerCapture(event.pointerId);
    this.update(event);
  };

  private readonly move = (event: PointerEvent): void => {
    if (this.pointerId === event.pointerId) this.update(event);
  };

  private readonly up = (event: PointerEvent): void => {
    if (this.pointerId === event.pointerId) this.reset();
  };

  private update(event: PointerEvent): void {
    const rect = this.pad.getBoundingClientRect();
    const radius = Math.max(1, (Math.min(rect.width, rect.height) - this.thumb.offsetWidth) / 2);
    this.value = joystickVector(
      event.clientX - (rect.left + rect.width / 2),
      event.clientY - (rect.top + rect.height / 2),
      radius,
    );
    const x = Math.round(this.value.x * radius);
    const y = Math.round(this.value.y * radius);
    this.thumb.style.transform =
      "translate(calc(-50% + " + x + "px), calc(-50% + " + y + "px))";
  }
}
