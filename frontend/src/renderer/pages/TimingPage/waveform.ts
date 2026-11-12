import type { TimingBounds } from './timingSelection';
import type { TimingLine, TimingSection } from '@shared/types';
import { formatClock } from '../../format';
import { timingWaveLayout, WAVE_TOP, WAVE_H, type TimingWaveLayout } from './timingWaveGeometry';
export { WAVE_TOP, WAVE_H } from './timingWaveGeometry';

const BINS_PER_SECOND = 100;
const SECTION_H = 18;
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
  selectedIds?: number[];
  selectionBounds?: TimingBounds | null;
  join?: { time: number; locked: boolean } | null;
  /** Направляющая прилипания: время цели, к которой притянута граница. */
  guide?: number | null;
  pps: number;
  time: number;
  mode: 'light' | 'dark';
  layout?: TimingWaveLayout;
}

/** Рисуем только видимое окно: длинный трек не увеличивает размер канвы. */
export function drawWaveform({
  canvas,
  container,
  lines,
  sections,
  peaks,
  selected,
  selectedIds = [],
  selectionBounds = null,
  join = null,
  guide = null,
  pps,
  time,
  mode,
  layout = timingWaveLayout(lines, pps)
}: WaveformOptions): void {
  const width = container.clientWidth;
  const { waveHeight, canvasHeight } = layout;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(canvasHeight * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(canvasHeight * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dark = mode === 'dark';
  ctx.fillStyle = dark ? '#15181d' : '#fafbfc';
  ctx.fillRect(0, 0, width, canvasHeight);
  const t0 = container.scrollLeft / pps;
  const toX = (t: number): number => (t - t0) * pps;

  // Части песни: полоса сверху.
  sections.forEach((section, index) => {
    if (!Number.isFinite(section.start) || !Number.isFinite(section.end) || section.end <= section.start) return;
    const x1 = Math.max(0, toX(section.start));
    const x2 = Math.min(width, toX(section.end));
    if (x2 <= x1 || x2 <= 0 || x1 >= width) return;
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
  const mid = WAVE_TOP + waveHeight / 2;
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
      ctx.fillRect(x, mid - hi * (waveHeight / 2), 1, Math.max(1, (hi - lo) * (waveHeight / 2)));
    }
  }

  // Выделение служит окном прослушивания, а не новой строкой документа.
  if (selectionBounds) {
    const left = Math.max(0, toX(selectionBounds.start));
    const right = Math.min(width, toX(selectionBounds.end));
    ctx.fillStyle = dark ? 'rgba(124,196,255,0.10)' : 'rgba(21,101,192,0.08)';
    if (right > left) ctx.fillRect(left, WAVE_TOP, right - left, waveHeight);
  }

  // Цвет закреплён за ID, как цвет части сценария; подтверждение обозначается знаком, а выбор — отдельной рамкой.
  const colors = dark
    ? ['124,196,255', '255,183,77', '129,199,132', '206,147,216', '77,208,225']
    : ['21,101,192', '184,74,0', '46,125,50', '123,31,162', '0,121,135'];
  for (const block of layout.blocks) {
    const { line, top, height } = block;
    const x1 = block.left - t0 * pps;
    const x2 = block.right - t0 * pps;
    if (x2 < 0 || x1 > width) continue;
    const isSelected = selectedIds.includes(line.id) || line.id === selected;
    const base = colors[(((Math.trunc(line.id) - 1) % colors.length) + colors.length) % colors.length];
    const startX = block.startX - t0 * pps;
    const endX = block.endX - t0 * pps;
    ctx.fillStyle = `rgba(${base},${isSelected ? 0.34 : 0.18})`;
    ctx.fillRect(x1, top, x2 - x1, height);
    ctx.strokeStyle = isSelected ? (dark ? '#ffffff' : '#101820') : `rgb(${base})`;
    ctx.lineWidth = isSelected ? 3 : 1;
    ctx.setLineDash(line.end <= line.start ? [4, 3] : []);
    ctx.strokeRect(x1 + 1, top + 1, Math.max(1, x2 - x1 - 2), height - 2);
    ctx.setLineDash([]);
    // У закреплённой строки нет ручек изменения границ; выбор и прослушивание остаются доступны.
    if (!line.verified) {
      ctx.fillStyle = `rgb(${base})`;
      ctx.fillRect(startX - 2, top, 4, height);
      ctx.fillRect(endX - 2, top, 4, height);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.max(0, x1 + 4), top + 3, Math.max(0, Math.min(width, x2) - Math.max(0, x1) - 8), height - 6);
    ctx.clip();
    ctx.font = isSelected ? 'bold 11px sans-serif' : '11px sans-serif';
    ctx.fillStyle = dark ? '#ffffff' : '#101820';
    const label = `${line.id}${line.verified ? ' ✓' : ''}`;
    ctx.fillText(label, Math.max(0, x1) + 5, top + 13);
    if (line.verified && x2 - Math.max(0, x1) >= 48) {
      // Векторный замок не зависит от наличия emoji-шрифта в Linux или Windows.
      const lockX = Math.min(width, x2) - 16;
      ctx.strokeStyle = dark ? '#ffffff' : '#101820';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(lockX, top + 9, 8, 7);
      ctx.beginPath();
      ctx.arc(lockX + 4, top + 9, 3, Math.PI, 0);
      ctx.stroke();
    }
    const boundaryLabel = `${formatClock(line.start)} → ${formatClock(line.end)}`;
    if (x2 - x1 > ctx.measureText(boundaryLabel).width + 12) ctx.fillText(boundaryLabel, x1 + 5, top + 28);
    ctx.restore();
  }

  // Общий стык соединяет дорожки пары; закреплённая половина блокирует всю ручку.
  if (join) {
    const x = toX(join.time);
    const blocks = layout.blocks.filter((block) => selectedIds.includes(block.line.id));
    const bottom = Math.max(WAVE_TOP, ...blocks.map((block) => block.top + block.height));
    ctx.strokeStyle = dark ? '#ffffff' : '#101820';
    ctx.fillStyle = dark ? '#ffffff' : '#101820';
    ctx.lineWidth = 3;
    ctx.setLineDash(join.locked ? [3, 3] : []);
    ctx.beginPath();
    ctx.moveTo(x, WAVE_TOP);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, WAVE_TOP - 5);
    ctx.lineTo(x + 6, WAVE_TOP + 2);
    ctx.lineTo(x, WAVE_TOP + 9);
    ctx.lineTo(x - 6, WAVE_TOP + 2);
    ctx.closePath();
    ctx.fill();
  }

  // Направляющая прилипания — пунктир поверх волны и строк.
  if (guide !== null && Number.isFinite(guide)) {
    const gx = toX(guide);
    if (gx >= 0 && gx <= width) {
      ctx.strokeStyle = dark ? '#7cc4ff' : '#1565c0';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, canvasHeight);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  // Плейхед.
  const px = toX(time);
  if (px >= 0 && px <= width) {
    ctx.fillStyle = '#e53935';
    ctx.fillRect(px - 0.5, 0, 1.5, canvasHeight);
  }
  // Сетка времени.
  ctx.fillStyle = dark ? '#8a94a0' : '#6b7684';
  ctx.font = '10px sans-serif';
  const stepSeconds = pps >= 160 ? 1 : pps >= 60 ? 5 : pps >= 25 ? 10 : 30;
  for (let t = Math.ceil(t0 / stepSeconds) * stepSeconds; t < t0 + width / pps; t += stepSeconds) {
    const x = toX(t);
    ctx.fillRect(x, WAVE_TOP + waveHeight + 2, 1, 5);
    ctx.fillText(formatClock(t).replace(/\.\d+$/, ''), x + 2, canvasHeight - 5);
  }
}
