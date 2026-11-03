export interface PlayerRow {
  name: string;
  distance: number;
  speaking: boolean;
  audible: boolean;
  where: string; // "📣", "🚙", "🪑", "" …
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class UI {
  private join = $('join');
  private form = $<HTMLFormElement>('joinForm');
  private joinBtn = $<HTMLButtonElement>('joinBtn');
  private err = $('joinErr');
  private hud = $('hud');
  private status = $('status');
  private list = $('playerList');
  private empty = $('empty');
  private mic = $<HTMLButtonElement>('micBtn');
  private hint = $('hint');
  private help = $('help');
  private dash = $('dash');
  private mapCanvas = $<HTMLCanvasElement>('minimap');
  private mapBg: HTMLCanvasElement | null = null;

  constructor() {
    const saved = localStorage.getItem('vw-name');
    if (saved) $<HTMLInputElement>('name').value = saved;
  }

  setCredit(text: string) {
    $('credit').textContent = text;
  }

  ready() {
    this.joinBtn.disabled = false;
    this.joinBtn.textContent = 'Join';
  }

  onJoin(cb: (name: string) => Promise<void>) {
    this.form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $<HTMLInputElement>('name').value.trim();
      if (!name) return;
      localStorage.setItem('vw-name', name);
      this.joinBtn.disabled = true;
      this.joinBtn.textContent = 'Joining…';
      this.err.textContent = '';
      try {
        await cb(name);
      } catch (ex) {
        this.err.textContent = ex instanceof Error ? ex.message : String(ex);
        this.joinBtn.disabled = false;
        this.joinBtn.textContent = 'Join';
      }
    });
  }

  showHud() {
    this.join.hidden = true;
    this.hud.hidden = false;
  }

  onMicToggle(cb: () => void) {
    this.mic.addEventListener('click', () => {
      cb();
      this.mic.blur();
    });
  }

  setMic(state: 'on' | 'muted' | 'unavailable', speaking = false) {
    this.mic.classList.toggle('muted', state !== 'on');
    this.mic.classList.toggle('speaking', state === 'on' && speaking);
    this.mic.disabled = state === 'unavailable';
    this.mic.textContent = state === 'on' ? 'Mic on (M)' : state === 'muted' ? 'Muted (M)' : 'No microphone (listen-only)';
  }

  setStatus(text: string) {
    this.status.textContent = text;
  }

  setHint(text: string, live = false) {
    if (this.hint.textContent !== text) this.hint.textContent = text;
    this.hint.classList.toggle('live', live);
  }

  private toastTimer = 0;
  toast(text: string) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (t.hidden = true), 1600);
  }

  setHelpVisible(v: boolean) {
    this.help.hidden = !v;
  }

  setDash(d: { kmh: number; gear: string; range: string; rpm: number; esp: boolean } | null) {
    this.dash.hidden = !d;
    if (!d) return;
    this.dash.innerHTML = `<b>${d.kmh}</b><span>km/h</span><i>${d.gear}</i><i>${d.range}</i><i class="rpm"><em style="width:${Math.min(100, d.rpm / 62)}%"></em></i>${d.esp ? '<i class="esp">ESP</i>' : ''}`;
  }

  setMapBackground(c: HTMLCanvasElement) {
    this.mapBg = c;
  }

  /** dots: world xz in [-half, half]. */
  drawMap(half: number, me: { x: number; z: number; yaw: number }, others: { x: number; z: number; car?: boolean }[]) {
    const c = this.mapCanvas;
    const g = c.getContext('2d')!;
    const S = c.width;
    if (this.mapBg) g.drawImage(this.mapBg, 0, 0, S, S);
    const tx = (x: number) => ((x + half) / (2 * half)) * S;
    for (const o of others) {
      g.fillStyle = o.car ? '#ffd84a' : '#4ade80';
      g.fillRect(tx(o.x) - 2, tx(o.z) - 2, o.car ? 5 : 4, o.car ? 5 : 4);
    }
    g.save();
    g.translate(tx(me.x), tx(me.z));
    g.rotate(-me.yaw + Math.PI);
    g.fillStyle = '#fff';
    g.strokeStyle = '#000';
    g.beginPath();
    g.moveTo(0, -7);
    g.lineTo(5, 5);
    g.lineTo(-5, 5);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }

  setPlayers(rows: PlayerRow[]) {
    this.empty.hidden = rows.length > 0;
    this.list.replaceChildren(
      ...rows.map((r) => {
        const li = document.createElement('li');
        li.className = (r.speaking ? 'speaking ' : '') + (r.audible ? '' : 'far');
        const dot = document.createElement('span');
        dot.className = 'dot';
        const name = document.createElement('span');
        name.textContent = (r.where ? r.where + ' ' : '') + r.name;
        const dist = document.createElement('span');
        dist.className = 'dist';
        dist.textContent = `${r.distance.toFixed(0)} m`;
        li.append(dot, name, dist);
        return li;
      }),
    );
  }
}
