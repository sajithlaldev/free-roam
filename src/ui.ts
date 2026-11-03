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
    $('statusText').textContent = text;
  }

  /** Single player / Multiplayer switch on the join screen. */
  bindMode(o: { get: () => 'single' | 'multi'; set: (m: 'single' | 'multi') => void }, multiplayer = true) {
    if (!multiplayer) {
      o.set('single');
      const b = $('modeMulti') as HTMLButtonElement;
      b.disabled = true;
      b.title = 'Multiplayer needs the voice server (not part of this static site)';
    }
    const refresh = () => {
      const m = o.get();
      $('modeSingle').classList.toggle('on', m === 'single');
      $('modeMulti').classList.toggle('on', m === 'multi');
      $('roomBox').hidden = m !== 'multi';
      $('modeHint').textContent = !multiplayer
        ? 'Explore on your own — with people and traffic around town. (Multiplayer needs the voice server, which this site doesn’t have.)'
        : m === 'single' ? 'Explore on your own — with people and traffic around town.' : 'Play and talk with friends (needs the voice server). No NPCs.';
    };
    $('modeSingle').addEventListener('click', () => (o.set('single'), refresh()));
    $('modeMulti').addEventListener('click', () => (o.set('multi'), refresh()));
    refresh();
  }

  setInviteVisible(v: boolean) {
    $('inviteBtn').hidden = !v;
  }

  /** Room picker on the join screen + the in-game Invite button. */
  bindRooms(o: { get: () => string; create: () => void; lobby: () => void; share: () => Promise<string> }) {
    const refresh = () => {
      const r = o.get();
      const priv = r !== 'lobby';
      $('roomName').textContent = priv ? `Private room ${r}` : 'Public lobby';
      $('shareRoomBtn').hidden = !priv;
      $('lobbyBtn').hidden = !priv;
      $('newRoomBtn').textContent = priv ? 'New private room' : 'Create private room';
      $('roomHint').textContent = priv ? 'Send the invite link to friends — only people with the link can join.' : 'Everyone joining without a link lands here.';
    };
    const toast = async () => this.toast(await o.share());
    $('newRoomBtn').addEventListener('click', () => {
      o.create();
      refresh();
      void toast();
    });
    $('lobbyBtn').addEventListener('click', () => {
      o.lobby();
      refresh();
    });
    $('shareRoomBtn').addEventListener('click', () => void toast());
    $('inviteBtn').addEventListener('click', (e) => {
      (e.currentTarget as HTMLElement).blur();
      void toast();
    });
    refresh();
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
  drawMap(half: number, me: { x: number; z: number; yaw: number }, others: { x: number; z: number; car?: boolean; gate?: boolean }[]) {
    const c = this.mapCanvas;
    const g = c.getContext('2d')!;
    const S = c.width;
    if (this.mapBg) g.drawImage(this.mapBg, 0, 0, S, S);
    const tx = (x: number) => ((x + half) / (2 * half)) * S;
    for (const o of others) {
      if (o.gate) {
        g.strokeStyle = '#ff9f1c';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(tx(o.x), tx(o.z), 4, 0, Math.PI * 2);
        g.stroke();
        continue;
      }
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
