/**
 * Engine sound as an AudioWorklet: a little combustion simulation rather than oscillators.
 *
 * The crank turns at rpm; on a four-stroke each cylinder fires once every two revolutions,
 * evenly spaced. Every firing launches an exhaust pressure pulse (t·e^(−t/τ)) whose size
 * follows engine load and varies a little shot to shot. The pulse train goes through two
 * exhaust resonances and a load-dependent low-pass — that's the growl — plus intake roar and
 * mechanical noise. Diesels add injector/combustion clatter on each firing and, with boost,
 * a turbo whistle.
 */
export const ENGINE_WORKLET = /* js */ `
class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  set(type, f, q, sr) {
    const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q);
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    else { b0 = a; b1 = 0; b2 = -a; } // band-pass (0 dB peak)
    const a0 = 1 + a;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = (-2 * c) / a0; this.a2 = (1 - a) / a0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 800, minValue: 0, maxValue: 9000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'gain', defaultValue: 0, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
    ];
  }
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.cyl = o.cylinders || 4;
    this.diesel = !!o.diesel;
    this.theta = Math.random();
    this.amp = new Float32Array(this.cyl).fill(1);
    this.last = new Float32Array(this.cyl).fill(1); // previous local phase (to catch each firing)
    this.tFire = new Float32Array(this.cyl).fill(1); // seconds since this cylinder fired
    this.knock = new Float32Array(this.cyl);
    this.seed = (Math.random() * 1e9) | 0;
    this.f1 = new Biquad(); this.f2 = new Biquad(); this.lp = new Biquad(); this.hp = new Biquad();
    this.intake = new Biquad(); this.clat = new Biquad(); this.dc = 0; this.boost = 0; this.turboPh = 0;
    this.smRpm = 800; this.smLoad = 0;
  }
  rand() { this.seed = (this.seed * 1664525 + 1013904223) | 0; return ((this.seed >>> 0) / 4294967296); }
  process(_in, outputs, p) {
    const out = outputs[0][0];
    if (!out) return true;
    const sr = sampleRate;
    this.smRpm += (p.rpm[0] - this.smRpm) * 0.35;
    this.smLoad += (p.load[0] - this.smLoad) * 0.25;
    const rpm = Math.max(300, this.smRpm), load = this.smLoad, gain = p.gain[0];
    const D = this.diesel;
    const cycle = rpm / 60 / 2; // four-stroke cycles per second
    const fire = cycle * this.cyl;
    // Exhaust resonances (fixed pipe modes) + a brightness that opens with load and rpm.
    this.f1.set('bp', D ? 95 : 120, 1.1, sr);
    this.f2.set('bp', D ? 260 : 380, 1.8, sr);
    this.lp.set('lp', (D ? 650 : 900) + load * (D ? 1400 : 2600) + rpm * 0.25, 0.7, sr);
    this.hp.set('hp', 28, 0.7, sr);
    this.intake.set('bp', 500 + rpm * 0.35, 0.9, sr);
    this.clat.set('hp', 2600, 0.8, sr);
    const tau = (D ? 0.0007 : 0.0011) * (1 + 1200 / rpm * 0.25);
    const boostT = D ? Math.min(1, Math.max(0, (rpm - 1300) / 2200)) * load : 0;
    this.boost += (boostT - this.boost) * 0.02;
    for (let i = 0; i < out.length; i++) {
      this.theta += cycle / sr;
      if (this.theta >= 1) this.theta -= 1;
      let pulse = 0;
      let clatter = 0;
      for (let c = 0; c < this.cyl; c++) {
        let local = this.theta - c / this.cyl;
        if (local < 0) local += 1;
        if (local < this.last[c]) {
          // This cylinder just fired: a new pulse with a little cycle-to-cycle variation.
          this.tFire[c] = 0;
          this.amp[c] = (0.3 + 0.7 * load) * (0.88 + 0.24 * this.rand());
          this.knock[c] = D ? (0.5 + 0.5 * this.rand()) * (0.55 + 0.45 * (1 - load * 0.5)) : 0;
        }
        this.last[c] = local;
        const t = this.tFire[c];
        this.tFire[c] = t + 1 / sr;
        if (t < 0.02) {
          pulse += this.amp[c] * (t / tau) * Math.exp(1 - t / tau);
          if (D && t < 0.004) clatter += this.knock[c] * Math.exp(-t / 0.0006) * (this.rand() * 2 - 1);
        }
      }
      const noise = this.rand() * 2 - 1;
      let x = this.hp.run(pulse);
      let body = this.f1.run(x) * 2.2 + this.f2.run(x) * 1.3 + x * 0.35;
      body = this.lp.run(body);
      const roar = this.intake.run(noise) * (0.04 + 0.22 * load) * Math.min(1, rpm / 3000);
      const clat = D ? this.clat.run(clatter) * 0.5 : 0;
      this.turboPh += (1800 + 2600 * this.boost) / sr;
      const whistle = D ? Math.sin(2 * Math.PI * this.turboPh) * 0.012 * this.boost : 0;
      const mech = Math.sin(2 * Math.PI * this.theta * this.cyl * 6) * 0.004 * Math.min(1, rpm / 2000);
      let y = body + roar + clat + whistle + mech;
      this.dc += (y - this.dc) * 0.0005;
      y -= this.dc;
      out[i] = Math.tanh(y * 0.9) * gain;
    }
    for (let ch = 1; ch < outputs[0].length; ch++) outputs[0][ch].set(out);
    return true;
  }
}
registerProcessor('engine-sim', EngineProcessor);
`;
