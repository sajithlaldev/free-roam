import type { PAHint } from './announce';

export interface PlayerRow {
  name: string;
  distance: number;
  speaking: boolean;
  audible: boolean;
  /** currently talking on the PA */
  onPA: boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const HINTS: Record<PAHint, string> = {
  '': '',
  hold: 'Hold E to use the PA',
  unmute: 'Unmute (M) to use the PA',
  busy: 'Someone else is on the PA',
  live: '🔴 LIVE on the PA',
};

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
  private lockHint = $('lockHint');

  constructor() {
    const saved = localStorage.getItem('vw-name');
    if (saved) $<HTMLInputElement>('name').value = saved;
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
      this.mic.blur(); // so Space doesn't re-trigger the button
    });
  }

  setMic(state: 'on' | 'muted' | 'unavailable', speaking = false) {
    this.mic.classList.toggle('muted', state !== 'on');
    this.mic.classList.toggle('speaking', state === 'on' && speaking);
    this.mic.disabled = state === 'unavailable';
    this.mic.textContent =
      state === 'on' ? 'Mic on (M)' : state === 'muted' ? 'Muted (M)' : 'No microphone (listen-only)';
  }

  setStatus(text: string) {
    this.status.textContent = text;
  }

  setHint(h: PAHint) {
    this.hint.textContent = HINTS[h];
    this.hint.classList.toggle('live', h === 'live');
  }

  setLockHintVisible(v: boolean) {
    this.lockHint.hidden = !v;
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
        name.textContent = (r.onPA ? '📣 ' : '') + r.name;
        const dist = document.createElement('span');
        dist.className = 'dist';
        dist.textContent = `${r.distance.toFixed(0)} m`;
        li.append(dot, name, dist);
        return li;
      }),
    );
  }
}
