// Runtime Web Audio synthesis.  No samples are loaded.
export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.noiseBuf = null;
  }
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.32;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 0.5;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let s = 0x1234567;
    for (let i = 0; i < len; i++) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      d[i] = ((s & 0xffff) / 32768) - 1;
    }
    this.noiseBuf = buf;
  }
  resume() {
    this.init();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  }
  _gain(t, a, d, peak) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    g.connect(this.master);
    return g;
  }
  _tone(freq, dur, type = "square", vol = 0.2, slide = 0) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    const g = this._gain(t, 0.005, dur, vol);
    o.connect(g);
    o.start(t); o.stop(t + dur + 0.05);
  }
  _noise(dur, vol = 0.2, filterHz = 1200, type = "lowpass") {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(filterHz, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(80, filterHz * 0.25), t + dur);
    const g = this._gain(t, 0.004, dur, vol);
    src.connect(f); f.connect(g);
    src.start(t); src.stop(t + dur + 0.05);
  }
  _toneAt(freq, dur, type, vol, delay) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    const g = this._gain(t, 0.005, dur, vol);
    o.connect(g);
    o.start(t); o.stop(t + dur + 0.05);
  }
  shootRivet() { this._tone(280, 0.09, "square", 0.22, -180); this._noise(0.08, 0.14, 2400); }
  shootScatter() { this._noise(0.18, 0.3, 900); this._tone(110, 0.15, "sawtooth", 0.18, -60); }
  shootArc() { this._tone(160, 0.22, "sine", 0.22, 260); this._noise(0.15, 0.12, 700); }
  impact() { this._noise(0.09, 0.18, 3000, "highpass"); }
  explosion() { this._noise(0.45, 0.4, 600); this._tone(70, 0.35, "sawtooth", 0.25, -40); }
  door() { this._tone(90, 0.5, "sawtooth", 0.16, 40); this._noise(0.5, 0.12, 500); }
  lift() { this._tone(60, 0.6, "square", 0.14, 20); }
  switchOn() { this._tone(520, 0.08, "square", 0.16, -120); this._tone(220, 0.12, "triangle", 0.12, -80); }
  alert(kind) { this._tone(kind === "sentinel" ? 70 : 180, 0.18, "sawtooth", 0.18, 120); }
  pain(kind) { this._tone(kind === "sentinel" ? 90 : 300, 0.16, "square", 0.16, -100); }
  death(kind) { this._noise(0.4, 0.25, 800); this._tone(kind === "sentinel" ? 55 : 140, 0.4, "sawtooth", 0.2, -90); }
  pickup() { this._tone(660, 0.06, "square", 0.12, 220); this._tone(990, 0.09, "square", 0.1, 180); }
  key() { this._tone(520, 0.08, "triangle", 0.16, 260); this._tone(1040, 0.16, "sine", 0.12, 200); }
  playerHurt() { this._noise(0.2, 0.28, 700); this._tone(90, 0.2, "sawtooth", 0.18, -30); }
  playerDie() { this._tone(160, 0.8, "sawtooth", 0.22, -130); this._noise(0.6, 0.2, 500); }
  empty() { this._tone(120, 0.05, "square", 0.07, -40); }
  secret() { [523, 659, 784, 1047].forEach((f, i) => this._toneAt(f, 0.16, "triangle", 0.13, i * 0.09)); }
  exit() { [392, 523, 659, 784, 1047].forEach((f, i) => this._toneAt(f, 0.22, "triangle", 0.14, i * 0.11)); }
}
