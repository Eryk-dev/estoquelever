// Audio feedback for warehouse scanning operations
// Uses Web Audio API OscillatorNode — no audio files needed

let audioCtx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (audioCtx) return audioCtx;
  try {
    audioCtx = new AudioContext();
    return audioCtx;
  } catch {
    return null;
  }
}

function playTone(frequency: number, duration: number, startTime?: number): void {
  const ctx = getContext();
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.frequency.value = frequency;
  gain.gain.value = 0.3;

  const start = startTime ?? ctx.currentTime;
  osc.start(start);
  osc.stop(start + duration / 1000);
}

/** Short high-pitched beep — item scanned successfully */
export function playSuccess(): void {
  playTone(880, 100);
}

/** Low double beep — scan not found */
export function playError(): void {
  const ctx = getContext();
  if (!ctx) return;
  playTone(220, 200, ctx.currentTime);
  playTone(220, 200, ctx.currentTime + 0.3);
}

/** Ascending melody — order fully scanned */
export function playComplete(): void {
  const ctx = getContext();
  if (!ctx) return;
  playTone(440, 150, ctx.currentTime);
  playTone(880, 150, ctx.currentTime + 0.15);
  playTone(1320, 150, ctx.currentTime + 0.3);
}

/** Single medium beep — item already scanned */
export function playAlreadyDone(): void {
  playTone(440, 200);
}
