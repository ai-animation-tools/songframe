/** Контракт ASR проверяется без настоящего агента и без запуска распознавания. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentJob } from '@shared/agents';
import type { TimingAgentReport, TimingAgentSource } from '@shared/timing-agent';
import { timingAgentTexts as texts } from '@shared/texts/timing-agent';
import { TimingAgent, parseTimingAgentReport } from './timing-agent';

const source: TimingAgentSource = {
  audioSha256: 'audio',
  lyricsSha256: 'lyrics',
  duration: 30,
  lyrics: [
    { number: 2, text: 'Первая строка' },
    { number: 3, text: 'Вторая строка' }
  ]
};
function report(snapshot = source): TimingAgentReport {
  return {
    schemaVersion: 1,
    status: 'completed',
    audioSha256: snapshot.audioSha256,
    lyricsSha256: snapshot.lyricsSha256,
    engine: 'Тестовый ASR, модель test',
    summary: 'Найден вокал',
    segments: [{ start: 12, end: 16, text: 'Первая строка' }],
    matches: [{ sourceLine: 2, start: 12, end: 16, segmentIndexes: [0], note: '' }],
    unmatchedSourceLines: [3],
    limitations: ['Вторая строка не найдена']
  };
}
it('принимает частичное сопоставление с ASR-свидетельствами и физическими номерами', () => {
  expect(parseTimingAgentReport(JSON.stringify(report()), source)).toEqual(report());
});
it('отсутствие ASR не превращает текст песни в выдуманную разметку', () => {
  const unsupported = { ...report(), status: 'unsupported', engine: null, segments: [], matches: [], unmatchedSourceLines: [2, 3] };
  expect(parseTimingAgentReport(unsupported, source).status).toBe('unsupported');
});
it.each([
  [
    'чужой MP3',
    (r: TimingAgentReport) => {
      r.audioSha256 = 'other';
    }
  ],
  [
    'чужой текст',
    (r: TimingAgentReport) => {
      r.lyricsSha256 = 'other';
    }
  ],
  [
    'неполный список',
    (r: TimingAgentReport) => {
      r.unmatchedSourceLines = [];
    }
  ],
  [
    'повтор строки',
    (r: TimingAgentReport) => {
      r.unmatchedSourceLines = [2, 3];
    }
  ],
  [
    'чужая строка',
    (r: TimingAgentReport) => {
      r.matches[0].sourceLine = 99;
    }
  ],
  [
    'нет свидетельств',
    (r: TimingAgentReport) => {
      r.matches[0].segmentIndexes = [];
    }
  ],
  [
    'чужой сегмент',
    (r: TimingAgentReport) => {
      r.matches[0].segmentIndexes = [1];
    }
  ],
  [
    'дубли свидетельств',
    (r: TimingAgentReport) => {
      r.matches[0].segmentIndexes = [0, 0];
    }
  ],
  [
    'за пределами свидетельства',
    (r: TimingAgentReport) => {
      r.matches[0].start = 1;
    }
  ],
  [
    'за пределами трека',
    (r: TimingAgentReport) => {
      r.segments[0].end = 31;
    }
  ],
  [
    'нечисловое время',
    (r: TimingAgentReport) => {
      r.segments[0].start = NaN;
    }
  ],
  [
    'нет имени ASR',
    (r: TimingAgentReport) => {
      r.engine = '';
    }
  ],
  [
    'unsupported с результатом',
    (r: TimingAgentReport) => {
      r.status = 'unsupported';
    }
  ],
  [
    'лишние ключи',
    (r: TimingAgentReport) => {
      Object.assign(r.matches[0], { verified: true });
    }
  ]
])('отклоняет неверный ответ: %s', (_name, mutate) => {
  const value = report();
  mutate(value);
  expect(() => parseTimingAgentReport(value, source)).toThrow(texts.invalidReport);
});
it.each(['```json\n{}\n```', '{', 'x'.repeat(1024 * 1024 + 1)])('отклоняет ответ без строгого JSON и превышение лимита', (value) => {
  expect(() => parseTimingAgentReport(value, source)).toThrow(texts.invalidReport);
});

let root: string, project: string, localDir: string, job: AgentJob | null;
const startAudio = vi.fn();
const cancel = vi.fn();
let service: TimingAgent;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'songframe-asr-'));
  project = join(root, 'project');
  localDir = join(root, 'state');
  job = null;
  mkdirSync(join(project, 'source'), { recursive: true });
  writeFileSync(join(project, 'source/track.mp3'), 'Синтетические байты аудио');
  writeFileSync(join(project, 'source/text.md'), '[Куплет]\nПервая строка\nВторая строка\n');
  writeFileSync(
    join(project, 'source/manifest.json'),
    JSON.stringify({
      schema_version: 1,
      lyrics: null,
      idea: null,
      cover: null,
      references: [],
      updated_at: '2026-11-02T00:00:00Z',
      track: {
        bytes: 30,
        original_name: 'track.mp3',
        path: 'track.mp3',
        duration_seconds: 30,
        sha256: createHash('sha256')
          .update(readFileSync(join(project, 'source/track.mp3')))
          .digest('hex')
      }
    })
  );
  startAudio.mockReset();
  cancel.mockReset();
  startAudio.mockImplementation((input) => {
    job = {
      schemaVersion: 1,
      id: 'job',
      sequence: 1,
      project,
      provider: 'codex',
      task: input.task,
      permissions: 'workspace-write',
      inputHashes: { prompt: 'p', context: 'c' },
      status: 'running',
      phase: 'ASR',
      startedAt: '2026-11-02T00:00:00Z',
      finishedAt: null,
      exitCode: null,
      result: '',
      log: ''
    };
    return job;
  });
  cancel.mockImplementation(async () => {
    if (job) job.status = 'cancelled';
    return job;
  });
  service = new TimingAgent({ localDir, agents: { startAudio, get: () => job, cancel } });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('показывает запрос без запуска и копирует MP3 в отдельную рабочую папку только по start', () => {
  const view = service.view(project);
  expect(view.status).toBe('idle');
  expect(startAudio).not.toHaveBeenCalled();
  expect(JSON.parse(view.context).audio.path).toBe('track.mp3');
  expect(view.prompt).toContain('unsupported');
  const original = readFileSync(join(project, 'source/track.mp3'));
  const result = service.start(project);
  const [input, directory] = startAudio.mock.calls[0];
  expect(input.project).toBe(project);
  expect(directory.startsWith(join(localDir, 'audio-jobs'))).toBe(true);
  expect(readFileSync(join(directory, 'track.mp3'))).toEqual(original);
  expect(readFileSync(join(project, 'source/track.mp3'))).toEqual(original);
  expect(result.status).toBe('running');
  expect(() => service.start(project)).toThrow(texts.busy);
  expect(startAudio).toHaveBeenCalledTimes(1);
});
it('возвращает предложение без записи разметки; изменение исходного текста блокирует перенос', () => {
  const running = service.start(project);
  job!.status = 'completed';
  job!.result = JSON.stringify(report(running.source));
  expect(service.proposal(project, 'job')).toEqual(report(running.source));
  expect(readdirSync(project)).toEqual(['source']);
  expect(() => service.proposal(project, 'other')).toThrow(texts.noProposal);
  writeFileSync(join(project, 'source/text.md'), 'Иной текст');
  expect(service.view(project).stale).toBe(true);
  expect(() => service.proposal(project, 'job')).toThrow(texts.stale);
});
it('неверный ответ виден как ошибка и не возвращается для переноса', () => {
  service.start(project);
  job!.status = 'completed';
  job!.result = '{}';
  expect(service.view(project)).toMatchObject({ status: 'failed', error: texts.invalidReport, report: null });
  expect(() => service.proposal(project, 'job')).toThrow(texts.noProposal);
});
it('отмена останавливает единственное активное задание; повторная отмена безопасна', async () => {
  service.start(project);
  expect((await service.cancel(project)).status).toBe('cancelled');
  await service.cancel(project);
  expect(cancel).toHaveBeenCalledTimes(1);
});
it('изменённый MP3 запрещает запуск и перенос, но не мешает явной отмене', async () => {
  service.start(project);
  writeFileSync(join(project, 'source/track.mp3'), 'Иной MP3');
  expect(service.view(project)).toMatchObject({ stale: true, error: texts.trackChanged });
  expect((await service.cancel(project)).status).toBe('cancelled');
  expect(() => service.start(project)).toThrow(texts.trackChanged);
});
it('при отказе запуска удаляет только свою временную папку', () => {
  startAudio.mockImplementation(() => {
    throw new Error('CLI недоступен');
  });
  expect(() => service.start(project)).toThrow('CLI недоступен');
  expect(readdirSync(join(localDir, 'audio-jobs'))).toEqual([]);
  expect(readFileSync(join(project, 'source/track.mp3'), 'utf8')).toBe('Синтетические байты аудио');
});
