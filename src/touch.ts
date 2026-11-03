/**
 * On-screen controls for phones and tablets: a floating analog stick on the left (move /
 * drive), drag anywhere on the right to look, and context buttons. Buttons feed the same
 * key codes the keyboard does, so every game system works unchanged.
 */
export interface TouchTarget {
  virtualKey(code: string, down: boolean): void;
  analog: { x: number; y: number };
  look(dx: number, dy: number): void;
}

type Mode = 'foot' | 'drive' | 'ride' | 'seated';

interface Btn {
  el: HTMLButtonElement;
  code: string;
  modes: Mode[];
}

export class TouchControls {
  private root: HTMLDivElement;
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private buttons: Btn[] = [];
  private mode: Mode | null = null;
  private actLabel: HTMLButtonElement | null = null;

  constructor(private target: TouchTarget) {
    const root = (this.root = document.createElement('div'));
    root.id = 'touch';
    root.innerHTML = `
      <div class="t-zone t-left"></div>
      <div class="t-zone t-right"></div>
      <div class="t-stick"><div class="t-knob"></div></div>
      <div class="t-buttons"></div>
      <div class="t-top"></div>
      <div class="t-rotate">Rotate your phone to landscape for the best view ↻</div>`;
    document.body.appendChild(root);
    this.stickBase = root.querySelector('.t-stick')!;
    this.stickKnob = root.querySelector('.t-knob')!;
    const left = root.querySelector('.t-left') as HTMLDivElement;
    const right = root.querySelector('.t-right') as HTMLDivElement;

    // Floating stick: appears where the thumb lands.
    left.addEventListener('pointerdown', (e) => {
      if (this.stickId !== null) return;
      this.stickId = e.pointerId;
      left.setPointerCapture(e.pointerId);
      this.stickOrigin = { x: e.clientX, y: e.clientY };
      this.stickBase.style.left = `${e.clientX}px`;
      this.stickBase.style.top = `${e.clientY}px`;
      this.stickBase.classList.add('on');
      this.moveStick(e.clientX, e.clientY);
    });
    left.addEventListener('pointermove', (e) => e.pointerId === this.stickId && this.moveStick(e.clientX, e.clientY));
    const endStick = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.stickBase.classList.remove('on');
      this.target.analog.x = this.target.analog.y = 0;
      this.stickKnob.style.transform = 'translate(-50%, -50%)';
    };
    left.addEventListener('pointerup', endStick);
    left.addEventListener('pointercancel', endStick);

    // Look: drag on the right half.
    right.addEventListener('pointerdown', (e) => {
      if (this.lookId !== null) return;
      this.lookId = e.pointerId;
      right.setPointerCapture(e.pointerId);
      this.lookLast = { x: e.clientX, y: e.clientY };
    });
    right.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return;
      this.target.look((e.clientX - this.lookLast.x) * 1.6, (e.clientY - this.lookLast.y) * 1.6);
      this.lookLast = { x: e.clientX, y: e.clientY };
    });
    const endLook = (e: PointerEvent) => e.pointerId === this.lookId && (this.lookId = null);
    right.addEventListener('pointerup', endLook);
    right.addEventListener('pointercancel', endLook);

    const bar = root.querySelector('.t-buttons') as HTMLDivElement;
    const top = root.querySelector('.t-top') as HTMLDivElement;
    const add = (parent: HTMLElement, label: string, code: string, modes: Mode[], cls = '') => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `t-btn ${cls}`;
      el.textContent = label;
      const down = (e: PointerEvent) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add('down');
        this.target.virtualKey(code, true);
      };
      const up = () => {
        el.classList.remove('down');
        this.target.virtualKey(code, false);
      };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      parent.appendChild(el);
      this.buttons.push({ el, code, modes });
      return el;
    };
    // On foot
    add(bar, 'Jump', 'Space', ['foot'], 'big');
    this.actLabel = add(bar, 'E', 'KeyE', ['foot', 'drive', 'ride', 'seated'], 'act');
    add(bar, 'Crouch', 'KeyC', ['foot']);
    add(bar, 'Lie', 'KeyZ', ['foot']);
    // Driving
    add(bar, 'Brake', 'Space', ['drive'], 'big');
    add(bar, 'Horn', 'KeyH', ['drive']);
    add(bar, '4L', 'KeyL', ['drive']);
    add(bar, 'Reset', 'KeyR', ['drive']);
    // Always
    add(top, '🎥', 'KeyV', ['foot', 'drive', 'ride', 'seated']);
    add(top, '🎤', 'KeyM', ['foot', 'drive', 'ride', 'seated']);
    this.setMode('foot', '');
  }

  private moveStick(x: number, y: number) {
    const R = 56;
    let dx = x - this.stickOrigin.x;
    let dy = y - this.stickOrigin.y;
    const len = Math.hypot(dx, dy);
    if (len > R) {
      dx = (dx / len) * R;
      dy = (dy / len) * R;
    }
    this.stickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    this.target.analog.x = dx / R;
    this.target.analog.y = -dy / R;
  }

  /** Which buttons show, and what the interact button says (from the HUD hint). */
  setMode(mode: Mode, hint: string) {
    if (mode !== this.mode) {
      this.mode = mode;
      for (const b of this.buttons) b.el.hidden = !b.modes.includes(mode);
    }
    if (this.actLabel) {
      const label = hint.startsWith('Hold E') ? 'Talk' : /get out|stand up/i.test(hint) ? (mode === 'seated' ? 'Stand' : 'Exit') : /drive|ride/i.test(hint) ? 'Enter' : /sit/i.test(hint) ? 'Sit' : 'E';
      if (this.actLabel.textContent !== label) this.actLabel.textContent = label;
      this.actLabel.classList.toggle('glow', hint !== '' && mode === 'foot');
    }
  }

  dispose() {
    this.root.remove();
  }
}
