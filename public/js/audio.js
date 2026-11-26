// Shared in-app cues: bundled WAVs played through primed HTMLAudioElements, with a
// Web Audio oscillator chime as fallback. Browsers (especially iOS) will not
// let audio start until a user gesture has unlocked it, and a plain AudioContext
// often re-suspends after idle — so we prime each clip on Start and reuse those
// same elements when a timer ends. Notifications stay as an extra.
export const DING_SRC = new URL("../sounds/ding.wav", import.meta.url).href;
export const TICK_SRC = new URL("../sounds/tick.wav", import.meta.url).href;
export const GO_SRC = new URL("../sounds/go.wav", import.meta.url).href;
export const TONES = { stand: [523, 659, 784], walk: [784, 659, 523], sit: [440, 554, 440], decompress: [392, 330, 262], end: [660, 520, 660], done: [660, 784, 988], tick: [1397], go: [392, 494] };

const CLIPS = { ding: DING_SRC, tick: TICK_SRC, go: GO_SRC };
const els = {};
let actx = null;
let primed = false;
let pendingKind = null;
let listening = false;

function clipEl(name) {
  const src = CLIPS[name] || CLIPS.ding;
  const key = CLIPS[name] ? name : "ding";
  if (els[key]) return els[key];
  const a = new Audio(src);
  a.preload = "auto";
  a.playsInline = true;
  a.setAttribute("playsinline", "");
  try { a.load(); } catch { /* ignore */ }
  els[key] = a;
  return a;
}

function bindResume() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  const flush = () => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (actx?.state === "suspended") void actx.resume().catch(() => {});
    if (pendingKind != null) {
      const k = pendingKind;
      pendingKind = null;
      void playClip(k);
    }
  };
  document.addEventListener("visibilitychange", flush);
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("focus", flush);
    window.addEventListener("pageshow", flush);
  }
}

async function ensureContext() {
  try {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    actx = actx || new AC();
    if (actx.state === "suspended") await actx.resume();
    return actx;
  } catch {
    return null;
  }
}

function synthBell(kind) {
  if (!actx || actx.state !== "running") return false;
  try {
    const notes = TONES[kind] || TONES.walk;
    const t0 = actx.currentTime + 0.02;
    const hold = kind === "go" ? 0.42 : kind === "tick" ? 0.1 : 0.16;
    notes.forEach((f, i) => {
      const reps = (kind === "tick" || kind === "go") ? 1 : 2;
      for (let r = 0; r < reps; r++) {
        const o = actx.createOscillator(), g = actx.createGain();
        const t = t0 + i * (kind === "go" ? 0.08 : 0.5) + r * 0.2;
        o.type = "sine"; o.frequency.value = f; o.connect(g); g.connect(actx.destination);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(kind === "tick" ? 0.28 : 0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + hold);
        o.start(t); o.stop(t + hold + 0.02);
      }
    });
    return true;
  } catch {
    return false;
  }
}

function mutePlay(a) {
  try {
    a.muted = true;
    a.volume = 0;
    try { a.currentTime = 0; } catch { /* not loaded yet */ }
    return a.play();
  } catch {
    return Promise.reject(new Error("play blocked"));
  }
}

/** Call from a user gesture (Start, Test sound, or a tap). Must kick off play() synchronously. */
export function unlockAudio() {
  bindResume();
  const plays = ["ding", "tick", "go"].map((name) => {
    const a = clipEl(name);
    return Promise.resolve(mutePlay(a)).then(() => {
      a.pause();
      try { a.currentTime = 0; } catch { /* ignore */ }
      a.muted = false;
      a.volume = 1;
      primed = true;
    }).catch(() => {
      a.muted = false;
      a.volume = 1;
    });
  });
  const ctxDone = ensureContext().then((ctx) => {
    if (!ctx) return;
    try {
      const b = ctx.createBuffer(1, 1, 22050), src = ctx.createBufferSource();
      src.buffer = b; src.connect(ctx.destination); src.start(0);
    } catch { /* ignore */ }
  });
  return Promise.all([...plays, ctxDone]);
}

export const audioReady = () => primed || (!!actx && actx.state === "running");

function playClip(kind = "ding") {
  bindResume();
  void ensureContext();
  const name = CLIPS[kind] ? kind : "ding";
  return new Promise((resolve) => {
    let a;
    try { a = clipEl(name); } catch { a = null; }
    const fail = () => {
      const ok = synthBell(kind);
      if (!ok) pendingKind = kind;
      resolve(ok);
    };
    if (!a) return fail();
    try {
      a.muted = false;
      a.volume = 1;
      try { if (a.readyState >= 1) a.currentTime = 0; } catch { /* ignore */ }
      const p = a.play();
      Promise.resolve(p).then(() => {
        pendingKind = null;
        primed = true;
        resolve(true);
      }).catch(fail);
    } catch {
      fail();
    }
  });
}

export function playAlarm(kind = "walk") {
  return playClip("ding");
}
export function playTick() { return playClip("tick"); }
export function playGo() { return playClip("go"); }
export function playCue(kind) {
  if (kind === "tick") return playTick();
  if (kind === "go") return playGo();
  return playAlarm(kind);
}

export const fmtClock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

export function buzz(pattern = [300, 150, 300]) {
  try { if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(pattern); } catch { /* ignore */ }
}

export async function dingNotify(title, body, tag = "pt-ex-timer") {
  if (!("Notification" in globalThis) || Notification.permission !== "granted") return;
  const opts = { body, tag, renotify: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png", vibrate: [200, 100, 200] };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg?.showNotification) return await reg.showNotification(title, opts);
    new Notification(title, opts);
  } catch { try { new Notification(title, opts); } catch { /* ignore */ } }
}
