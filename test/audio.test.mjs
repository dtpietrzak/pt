import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wavPath = join(root, "public/sounds/ding.wav");

test("ding.wav is a short mono PCM chime", () => {
  assert.equal(existsSync(wavPath), true);
  const buf = readFileSync(wavPath);
  assert.ok(buf.length > 1000 && buf.length < 200_000, `unexpected size ${buf.length}`);
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE");
  assert.equal(buf.toString("ascii", 12, 16), "fmt ");
  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  assert.equal(channels, 1);
  assert.equal(bits, 16);
  assert.ok(rate === 22050 || rate === 44100, `rate ${rate}`);
  const dataSize = buf.readUInt32LE(40);
  const seconds = dataSize / (rate * channels * (bits / 8));
  assert.ok(seconds >= 0.3 && seconds <= 2, `duration ${seconds}`);
});

test("the service worker generator precaches sounds/", () => {
  const src = readFileSync(join(root, "scripts/gen-sw.mjs"), "utf8");
  assert.match(src, /startsWith\("sounds\/"\)/);
});

test("Settings has a Test sound button next to Alarm sound", () => {
  const src = readFileSync(join(root, "public/js/ui/settings.js"), "utf8");
  assert.match(src, /id="test-sound"/);
  assert.match(src, /Test sound/);
  assert.match(src, /class="sound-row"/);
  assert.match(src, /unlockAudio\(\)/);
  assert.match(src, /playAlarm\(/);
});

test("unlockAudio primes the shared element and playAlarm replays it", async () => {
  const plays = [];
  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.muted = false;
      this.volume = 1;
      this.currentTime = 0;
      this.paused = true;
      this.readyState = 2;
      this.playsInline = false;
    }
    load() {}
    setAttribute() {}
    play() {
      plays.push({ muted: this.muted, volume: this.volume, currentTime: this.currentTime, src: this.src });
      this.paused = false;
      return Promise.resolve();
    }
    pause() { this.paused = true; }
  }
  class FakeCtx {
    constructor() { this.state = "suspended"; this.currentTime = 0; }
    resume() { this.state = "running"; return Promise.resolve(); }
    createBuffer() { return {}; }
    createBufferSource() { return { connect() {}, start() {}, buffer: null }; }
    get destination() { return {}; }
    createOscillator() { return { type: "", frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
    createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
  }
  globalThis.addEventListener = () => {};
  globalThis.window = globalThis;
  globalThis.Audio = FakeAudio;
  globalThis.AudioContext = FakeCtx;
  globalThis.webkitAudioContext = FakeCtx;
  globalThis.document = { visibilityState: "visible", addEventListener() {} };

  const audio = await import("../public/js/audio.js");
  assert.ok(String(audio.DING_SRC).endsWith("sounds/ding.wav"));
  assert.ok(audio.TONES.done && audio.TONES.walk);
  assert.equal(audio.audioReady(), false);

  await audio.unlockAudio();
  assert.equal(audio.audioReady(), true);
  assert.ok(plays.length >= 1, "unlock should play a muted prime clip");
  assert.equal(plays[0].muted, true);
  assert.equal(plays[0].volume, 0);

  const ok = await audio.playAlarm("done");
  assert.equal(ok, true);
  const audible = plays.filter((p) => p.muted === false && p.volume === 1);
  assert.ok(audible.length >= 1, "playAlarm should play the same element unmuted");
  assert.ok(String(audible[0].src).endsWith("sounds/ding.wav"));

  assert.ok(String(audio.TICK_SRC).endsWith("sounds/tick.wav"));
  assert.ok(String(audio.GO_SRC).endsWith("sounds/go.wav"));
  const nBefore = plays.length;
  await audio.playTick();
  await audio.playGo();
  const after = plays.slice(nBefore).filter((p) => p.muted === false);
  assert.ok(after.some((p) => String(p.src).endsWith("sounds/tick.wav")));
  assert.ok(after.some((p) => String(p.src).endsWith("sounds/go.wav")));
});
