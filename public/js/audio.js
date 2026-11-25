// Shared Web Audio helpers: unlock after a user tap, then play the in-app chime.
// Used by the work timer and by timed-exercise countdowns. No DOM besides window.
let actx = null;
export function unlockAudio() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    const b = actx.createBuffer(1, 1, 22050), src = actx.createBufferSource(); // silent blip: marks the context as user-activated
    src.buffer = b; src.connect(actx.destination); src.start(0);
  } catch { /* no audio available */ }
}
export const audioReady = () => !!actx && actx.state === "running";
const TONES = { stand: [523, 659, 784], walk: [784, 659, 523], sit: [440, 554, 440], decompress: [392, 330, 262], end: [660, 520, 660], done: [660, 784, 988] };
export function playAlarm(kind = "walk") {
  if (!audioReady()) return false;
  const notes = TONES[kind] || TONES.walk, t0 = actx.currentTime + 0.02;
  notes.forEach((f, i) => {
    for (let r = 0; r < 2; r++) {
      const o = actx.createOscillator(), g = actx.createGain(), t = t0 + i * 0.5 + r * 0.2;
      o.type = "sine"; o.frequency.value = f; o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.start(t); o.stop(t + 0.18);
    }
  });
  return true;
}
export const fmtClock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
export function buzz(pattern = [300, 150, 300]) {
  try { if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(pattern); } catch { /* ignore */ }
}
export async function dingNotify(title, body, tag = "pt-ex-timer") {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const opts = { body, tag, renotify: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png", vibrate: [200, 100, 200] };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg?.showNotification) return await reg.showNotification(title, opts);
    new Notification(title, opts);
  } catch { try { new Notification(title, opts); } catch { /* ignore */ } }
}
