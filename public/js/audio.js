// Shared in-app ding: a bundled WAV played through an HTMLAudioElement, with a
// Web Audio oscillator chime as fallback. Browsers (especially iOS) will not
// let audio start until a user gesture has unlocked it, and a plain AudioContext
// often re-suspends after idle — so we prime the <audio> element on Start and
// reuse that same element when a timer ends. Notifications stay as an extra.
export const DING_SRC = new URL("../sounds/ding.wav", import.meta.url).href;
export const TONES = { stand: [523, 659, 784], walk: [784, 659, 523], sit: [440, 554, 440], decompress: [392, 330, 262], end: [660, 520, 660], done: [660, 784, 988] };

let actx = null;
let el = null;
let primed = false;
let pendingKind = null;
let listening = false;

function dingEl() {
  if (el) return el;
  el = new Audio(DING_SRC);
  el.preload = "auto";
  el.playsInline = true;
  el.setAttribute("playsinline", "");
  try { el.load(); } catch { /* ignore */ }
  return el;
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
      void playDing(k);
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
    notes.forEach((f, i) => {
      for (let r = 0; r < 2; r++) {
        const o = actx.createOscillator(), g = actx.createGain(), t = t0 + i * 0.5 + r * 0.2;
        o.type = "sine"; o.frequency.value = f; o.connect(g); g.connect(actx.destination);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.start(t); o.stop(t + 0.18);
      }
    });
    return true;
  } catch {
    return false;
  }
}

/** Call from a user gesture (Start, Test sound, or a tap). Must kick off play() synchronously. */
export function unlockAudio() {
  bindResume();
  const a = dingEl();
  let fileP;
  try {
    a.muted = true;
    a.volume = 0;
    try { a.currentTime = 0; } catch { /* not loaded yet */ }
    fileP = a.play();
  } catch {
    fileP = Promise.reject(new Error("play blocked"));
  }
  const fileDone = Promise.resolve(fileP).then(() => {
    a.pause();
    try { a.currentTime = 0; } catch { /* ignore */ }
    a.muted = false;
    a.volume = 1;
    primed = true;
  }).catch(() => {
    a.muted = false;
    a.volume = 1;
  });
  const ctxDone = ensureContext().then((ctx) => {
    if (!ctx) return;
    try {
      const b = ctx.createBuffer(1, 1, 22050), src = ctx.createBufferSource();
      src.buffer = b; src.connect(ctx.destination); src.start(0);
    } catch { /* ignore */ }
  });
  return Promise.all([fileDone, ctxDone]);
}

export const audioReady = () => primed || (!!actx && actx.state === "running");

export function playAlarm(kind = "walk") {
  return playDing(kind);
}

function playDing(kind = "walk") {
  bindResume();
  void ensureContext();
  return new Promise((resolve) => {
    let a;
    try { a = dingEl(); } catch { a = null; }
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
