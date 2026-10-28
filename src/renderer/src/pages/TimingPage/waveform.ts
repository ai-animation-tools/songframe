import type { TimingLine, TimingSection } from '@shared/types';
import { formatClock } from '../../format';

const BINS_PER_SECOND = 100;
const SECTION_H = 18;
export const WAVE_TOP = 24;
export const WAVE_H = 110;
// Подписи времени занимают собственную полосу и не заходят на волну и нижний край канвы.
const TIME_SCALE_H = 20;
export const CANVAS_H = WAVE_TOP + WAVE_H + TIME_SCALE_H;

export interface Peaks {
  min: Float32Array;
  max: Float32Array;
  duration: number;
}

/** Готовая волна на время сеанса: повторное открытие страницы не декодирует трек заново, пока его байты те же. */
const peaksCache = new Map<string, Peaks>();
/** Сколько миллисекунд подряд считаем волну, прежде чем отдать управление окну: интерфейс остаётся отзывчивым. */
const SLICE_MS = 12;

const yieldToWindow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export async function decodePeaks(url: string): Promise<Peaks> {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  // Тот же путь с другим содержимым (заменённый трек) даёт другой ключ по размеру и первым байтам.
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096));
  let sum = 0;
  for (let i = 0; i < head.length; i += 1) sum = (sum * 31 + head[i]) >>> 0;
  const key = `${url}|${buffer.byteLength}|${sum}`;
  const cached = peaksCache.get(key);
  if (cached) return cached;
  const context = new AudioContext();
  try {
    // Декодирование идёт вне главного потока; свёртку в пики считаем частями, чтобы окно не замирало.
    const audio = await context.decodeAudioData(buffer);
    const bins = Math.ceil(audio.duration * BINS_PER_SECOND);
    const min = new Float32Array(bins).fill(0);
    const max = new Float32Array(bins).fill(0);
    const step = audio.sampleRate / BINS_PER_SECOND;
    for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
      const data = audio.getChannelData(channel);
      let started = performance.now();
      for (let bin = 0; bin < bins; bin += 1) {
        const from = Math.floor(bin * step);
        const to = Math.min(data.length, Math.floor((bin + 1) * step));
        let lo = 0;
        let hi = 0;
        for (let i = from; i < to; i += 1) {
          const v = data[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (lo < min[bin]) min[bin] = lo;
        if (hi > max[bin]) max[bin] = hi;
        if (performance.now() - started > SLICE_MS) {
          await yieldToWindow();
          started = performance.now();
        }
      }
    }
    const peaks = { min, max, duration: audio.duration };
    peaksCache.set(key, peaks);
    return peaks;
  } finally {
    void context.close();
  }
}

interface WaveformOptions {
  canvas: HTMLCanvasElement;
  container: HTMLDivElement;
  lines: TimingLine[];
  sections: TimingSection[];
  peaks: Peaks | null;
  selected: number | null;
  pps: number;
  time: number;
  mode: 'light' | 'dark';
}

/** Рисуем только видимое окно: длинный трек не увеличивает размер канвы. */
export function drawWaveform({ canvas, container, lines, sections, peaks, selected, pps, time, mode }: WaveformOptions): void {
  const width = container.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(CANVAS_H * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(CANVAS_H * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dark = mode === 'dark';
  ctx.fillStyle = dark ? '#15181d' : '#fafbfc';
  ctx.fillRect(0, 0, width, CANVAS_H);
  const t0 = container.scrollLeft / pps;
  const toX = (t: number): number => (t - t0) * pps;

  // Части песни: полоса сверху.
  sections.forEach((section, index) => {
    const x1 = Math.max(0, toX(section.start));
    const x2 = Math.min(width, toX(section.end));
    if (x2 <= 0 || x1 >= width) return;
    ctx.fillStyle = index % 2 ? (dark ? '#2a3140' : '#e3ebf5') : dark ? '#222834' : '#eef2f7';
    ctx.fillRect(x1, 0, x2 - x1, SECTION_H);
    ctx.fillStyle = dark ? '#c8d0dc' : '#3b4754';
    ctx.font = '11px sans-serif';
    ctx.save();
    ctx.beginPath();
    ctx.rect(x1, 0, x2 - x1, SECTION_H);
    ctx.clip();
    ctx.fillText(section.name, x1 + 4, 13);
    ctx.restore();
  });

  // Волна по min/max бинам.
  const mid = WAVE_TOP + WAVE_H / 2;
  ctx.strokeStyle = dark ? '#3a4552' : '#d5dbe3';
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(width, mid);
  ctx.stroke();
  if (peaks) {
    ctx.fillStyle = dark ? '#6fa8dc' : '#4f81bd';
    const binsPerPx = BINS_PER_SECOND / pps;
    for (let x = 0; x < width; x += 1) {
      const from = Math.floor((t0 * pps + x) * binsPerPx);
      const to = Math.max(from + 1, Math.floor((t0 * pps + x + 1) * binsPerPx));
      if (from >= peaks.min.length) break;
      let lo = 0;
      let hi = 0;
      for (let b = from; b < to && b < peaks.min.length; b += 1) {
        if (peaks.min[b] < lo) lo = peaks.min[b];
        if (peaks.max[b] > hi) hi = peaks.max[b];
      }
      ctx.fillRect(x, mid - hi * (WAVE_H / 2), 1, Math.max(1, (hi - lo) * (WAVE_H / 2)));
    }
  }

  // Строки песни: полупрозрачные области с границами и номером.
  for (const line of lines) {
    const x1 = toX(line.start);
    const x2 = toX(line.end);
    if (x2 < 0 || x1 > width) continue;
    const isSelected = line.id === selected;
    const base = line.verified ? (dark ? '76,175,80' : '46,125,50') : dark ? '255,183,77' : '239,108,0';
    ctx.fillStyle = `rgba(${base},${isSelected ? 0.38 : 0.2})`;
    ctx.fillRect(x1, WAVE_TOP, x2 - x1, WAVE_H);
    ctx.fillStyle = `rgba(${base},${isSelected ? 1 : 0.8})`;
    ctx.fillRect(x1 - 1, WAVE_TOP, 2, WAVE_H);
    ctx.fillRect(x2 - 1, WAVE_TOP, 2, WAVE_H);
    ctx.font = isSelected ? 'bold 11px sans-serif' : '11px sans-serif';
    ctx.fillStyle = dark ? '#f1f3f5' : '#1f2933';
    ctx.fillText(String(line.id), x1 + 4, WAVE_TOP + 12);
  }

  // Плейхед.
  const px = toX(time);
  if (px >= 0 && px <= width) {
    ctx.fillStyle = '#e53935';
    ctx.fillRect(px - 0.5, 0, 1.5, CANVAS_H);
  }
  // Сетка времени.
  ctx.fillStyle = dark ? '#8a94a0' : '#6b7684';
  ctx.font = '10px sans-serif';
  const stepSeconds = pps >= 160 ? 1 : pps >= 60 ? 5 : pps >= 25 ? 10 : 30;
  for (let t = Math.ceil(t0 / stepSeconds) * stepSeconds; t < t0 + width / pps; t += stepSeconds) {
    const x = toX(t);
    ctx.fillRect(x, WAVE_TOP + WAVE_H + 2, 1, 5);
    ctx.fillText(formatClock(t).replace(/\.\d+$/, ''), x + 2, CANVAS_H - 5);
  }
}
