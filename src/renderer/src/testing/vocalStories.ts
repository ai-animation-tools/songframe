/** Синтетические сигналы витрины: одна шкала времени и разные частоты без реальных исходников. */
import type { VocalModelId, VocalPreparationView } from '@shared/vocals';
import { VOCAL_MODELS, KNOWN_VOCAL_MODELS } from '@shared/vocals';

export function syntheticVocalAudio(vocal: boolean): string {
  const rate = 8000,
    samples = rate * 8;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const data = new DataView(buffer);
  const text = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index++) data.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, 'RIFF');
  data.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, rate, true);
  data.setUint32(28, rate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  text(36, 'data');
  data.setUint32(40, samples * 2, true);
  for (let sample = 0; sample < samples; sample++) {
    const time = sample / rate;
    const value = Math.sin(time * 2 * Math.PI * 440) * 0.1 + (vocal ? 0 : Math.sin(time * 2 * Math.PI * 110) * 0.1);
    data.setInt16(44 + sample * 2, value * 32767, true);
  }
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

export function makeVocalStoryView(installed: boolean, cached = false): VocalPreparationView {
  const view: VocalPreparationView = {
    sourcePath: '/mock/vocal-original.wav',
    sourceSha256: 'story-original-sha',
    models: VOCAL_MODELS.map((model) => ({ ...model, installed, totalBytes: 66000000 })),
    results: [],
    selectedId: null,
    problems: []
  };
  if (cached) {
    addVocalStoryResult(view, 'voc-ft');
    addVocalStoryResult(view, 'kim-vocal-1');
    view.selectedId = view.results[0].id;
  }
  return view;
}

export function addVocalStoryResult(view: VocalPreparationView, modelId: VocalModelId): void {
  const next = Math.max(0, ...view.results.map((result) => Number(result.id.split('-').at(-1)) || 0)) + 1;
  const id = `vocal-result-${next}`;
  view.results.push({
    id,
    modelId,
    modelLabel: KNOWN_VOCAL_MODELS.find((model) => model.id === modelId)!.label,
    path: `/mock/${id}.wav`,
    sha256: id,
    createdAt: '2026-11-02T11:20:30Z',
    duration: 8
  });
}
