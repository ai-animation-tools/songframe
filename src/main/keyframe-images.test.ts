/** Файловый контракт кандидатов проверяется на временном проекте и настоящем PNG, без генераторов. */
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentJob, AgentSettings, AgentStartInput } from '@shared/agents';
import type { ProductionImagesInput } from '@shared/production-workflow';
import { imageDimensions, imageExtensionMatches, isImageFile, KeyframeImages } from './keyframe-images';
import { registerTestAgentProvider, TEST_AGENT_PROVIDER, testAgentProviderInfo } from './testing/media-provider';

let restoreProvider: () => void;
beforeAll(() => {
  restoreProvider = registerTestAgentProvider();
});
afterAll(() => restoreProvider());

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
let work: string;
let project: string;
let localDir: string;
let input: ProductionImagesInput;
let launched: { input: AgentStartInput; workDir: string; config: AgentSettings; job: AgentJob };
const SHA = 'a'.repeat(64);
const AGENT: AgentSettings = { provider: testAgentProviderInfo.executor!, model: 'image-model' };
let adapter: KeyframeImages;
let validateImage: ReturnType<typeof vi.fn<(path: string) => boolean>>;
const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-keyframes-'));
  project = join(work, 'Клип');
  localDir = join(work, 'state');
  mkdirSync(join(project, 'source'), { recursive: true });
  mkdirSync(join(project, 'plan'), { recursive: true });
  writeFileSync(join(project, 'source/reference.png'), png);
  writeFileSync(join(project, 'plan/project.json'), '{"name":"Тестовый клип"}');
  input = {
    project,
    shot: 'S01',
    packageDir: join(project, 'plan/batches/S01'),
    frames: [
      { id: 'K01', role: 'first', timeSeconds: 0, prompt: 'Первый кадр', referencePaths: ['source/reference.png'] },
      { id: 'K02', role: 'last', timeSeconds: 5, prompt: 'Последний кадр', referencePaths: ['source/reference.png'] }
    ]
  };
  validateImage = vi.fn(() => true);
  adapter = new KeyframeImages({
    localDir,
    validateImage,
    agents: {
      startImages(value, workDir, config) {
        const job: AgentJob = {
          schemaVersion: 1,
          id: randomUUID(),
          sequence: 1,
          project: value.project,
          provider: config.provider,
          task: value.task,
          permissions: 'workspace-write',
          inputHashes: { prompt: 'a'.repeat(64), context: 'b'.repeat(64) },
          status: 'completed',
          phase: 'Завершено',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          exitCode: 0,
          result: '',
          log: ''
        };
        launched = { input: value, workDir, config, job };
        return job;
      }
    }
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(work, { recursive: true, force: true });
});

function start(requestSha = SHA): AgentJob {
  return adapter.start(input, { provider: TEST_AGENT_PROVIDER, requestSha, agent: AGENT });
}
function collect(job: AgentJob, requestSha = SHA): ReturnType<KeyframeImages['collect']> {
  return adapter.collect(job, requestSha);
}
function response(
  images: unknown = [
    { id: 'K01', path: 'K01.png' },
    { id: 'K02', path: 'K02.png' }
  ]
): AgentJob {
  writeFileSync(join(launched.workDir, 'K01.png'), png);
  writeFileSync(join(launched.workDir, 'K02.png'), png);
  return { ...launched.job, result: JSON.stringify({ schemaVersion: 1, stage: 'frames', images }) };
}

describe('кандидаты опор', () => {
  it('передаёт только копии референсов, дедуплицирует их и оставляет оригиналы побайтово прежними', () => {
    const before = ['source/reference.png', 'plan/project.json'].map((path) => digest(join(project, path)));
    start();
    expect(launched.workDir).toMatch(new RegExp(`${localDir}/image-jobs/`));
    const context = JSON.parse(launched.input.context!);
    expect(context.frames.map((frame: { referencePaths: string[] }) => frame.referencePaths)).toEqual([['reference-01.png'], ['reference-01.png']]);
    expect(readdirSync(launched.workDir).filter((name) => name.startsWith('reference-'))).toEqual(['reference-01.png']);
    expect(readFileSync(join(launched.workDir, 'reference-01.png'))).toEqual(png);
    expect(statSync(join(launched.workDir, 'reference-01.png')).mode & 0o222).toBe(0);
    expect(launched.input.prompt).toContain('Не используй внешние сервисы генерации');
    // Программу и название задания даёт реестр провайдера, а не выбранный текстовый агент.
    expect(launched.config).toEqual(AGENT);
    expect(launched.input.task).toBe(`Опоры S01: ${testAgentProviderInfo.title}`);
    const candidates = collect(response());
    expect(candidates).toEqual([
      { id: 'K01', path: join(launched.workDir, 'K01.png') },
      { id: 'K02', path: join(launched.workDir, 'K02.png') }
    ]);
    expect(validateImage).toHaveBeenCalledTimes(2);
    expect(['source/reference.png', 'plan/project.json'].map((path) => digest(join(project, path)))).toEqual(before);
  });

  it.each(['не JSON', 'null', '[]', '{"schemaVersion":1,"stage":"frames","images":[],"extra":true}'])(
    'не принимает невалидный финальный ответ: %s',
    (result) => {
      start();
      expect(() => collect({ ...response(), result })).toThrow();
    }
  );

  it('сохраняет порядок опор независимо от порядка файлов в финальном ответе', () => {
    start();
    const result = collect(
      response([
        { id: 'K02', path: 'K02.png' },
        { id: 'K01', path: 'K01.png' }
      ])
    );
    expect(result.map((image) => image.id)).toEqual(['K01', 'K02']);
  });

  it('собирает фактический WebP без переименования и проверяет связь с requestSHA', () => {
    const job = start('frozen-sha');
    const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
    writeFileSync(join(launched.workDir, 'K01.webp'), webp);
    writeFileSync(join(launched.workDir, 'K02.webp'), webp);
    const result = {
      ...job,
      result: JSON.stringify({
        schemaVersion: 1,
        stage: 'frames',
        images: [
          { id: 'K01', path: 'K01.webp' },
          { id: 'K02', path: 'K02.webp' }
        ]
      })
    };
    expect(launched.input.prompt).toContain('фактический формат');
    expect(collect(result, 'frozen-sha').map((item) => item.path)).toEqual([join(launched.workDir, 'K01.webp'), join(launched.workDir, 'K02.webp')]);
    expect(() => collect(result, 'another-sha')).toThrow(/другому согласованному запросу/);
  });

  it('повреждённая запись старого задания не мешает собрать новое завершённое задание', () => {
    start();
    const previous = join(localDir, 'image-jobs', '000-old-job');
    mkdirSync(previous);
    writeFileSync(join(previous, 'job.json'), '{');
    expect(collect(response()).map((image) => image.id)).toEqual(['K01', 'K02']);
    expect(readFileSync(join(previous, 'job.json'), 'utf8')).toBe('{');
  });

  it('отклоняет отсутствующий файл и текст под расширением PNG', () => {
    start();
    expect(() =>
      collect(
        response([
          { id: 'K01', path: 'missing.png' },
          { id: 'K02', path: 'K02.png' }
        ])
      )
    ).toThrow();
    const job = response();
    writeFileSync(join(launched.workDir, 'K01.png'), 'это не изображение');
    expect(() => collect(job)).toThrow(/настоящий файл изображения/);
  });

  it('передаёт magic-valid изображение декодеру и отклоняет отказ декодирования', () => {
    start();
    const job = response();
    validateImage.mockReturnValue(false);
    expect(() => collect(job)).toThrow(/настоящий файл изображения/);
    expect(validateImage).toHaveBeenCalledExactlyOnceWith(join(launched.workDir, 'K01.png'));
  });

  it.each(['.jpg', '.jpeg', '.webp'])('отклоняет PNG с чужим расширением %s и сохраняет исходные байты', (suffix) => {
    start();
    const path = join(launched.workDir, `K01${suffix}`);
    writeFileSync(path, png);
    const before = digest(path);
    const job = response([
      { id: 'K01', path: `K01${suffix}` },
      { id: 'K02', path: 'K02.png' }
    ]);
    expect(() => collect(job)).toThrow(/расширение не соответствует фактическому формату/);
    expect(digest(path)).toBe(before);
    expect(readFileSync(path)).toEqual(png);
  });

  it.each(['../outside.png', '/tmp/absolute-fixture.png'])('отклоняет путь кандидата за рабочую папку: %s', (path) => {
    start();
    writeFileSync(join(launched.workDir, '../outside.png'), png);
    expect(() =>
      collect(
        response([
          { id: 'K01', path },
          { id: 'K02', path: 'K02.png' }
        ])
      )
    ).toThrow(/настоящий файл изображения/);
  });

  it('не принимает symlink файла и путь через symlink каталога', () => {
    start();
    const job = response([
      { id: 'K01', path: 'alias.png' },
      { id: 'K02', path: 'K02.png' }
    ]);
    symlinkSync(join(launched.workDir, 'K01.png'), join(launched.workDir, 'alias.png'));
    expect(() => collect(job)).toThrow(/настоящий файл изображения/);
    symlinkSync(join(project, 'source'), join(launched.workDir, 'linked-directory'));
    expect(() =>
      collect(
        response([
          { id: 'K01', path: 'linked-directory/reference.png' },
          { id: 'K02', path: 'K02.png' }
        ])
      )
    ).toThrow(/настоящий файл изображения/);
  });

  it('отклоняет изменившийся исходный референс', () => {
    start();
    const job = response();
    writeFileSync(join(project, 'source/reference.png'), Buffer.concat([png, Buffer.from('изменено')]));
    expect(() => collect(job)).toThrow(/Референсы изменились/);
  });

  it('отклоняет изменённую рабочую копию и не выдаёт референс за результат', () => {
    start();
    expect(() =>
      collect(
        response([
          { id: 'K01', path: 'reference-01.png' },
          { id: 'K02', path: 'K02.png' }
        ])
      )
    ).toThrow();
    chmodSync(join(launched.workDir, 'reference-01.png'), 0o644);
    writeFileSync(join(launched.workDir, 'reference-01.png'), Buffer.concat([png, Buffer.from('изменено')]));
    expect(() => collect(response())).toThrow(/Референс|копи/);
  });

  it.each([
    [{ id: 'K01', path: 'K01.png' }],
    [
      { id: 'K01', path: 'K01.png' },
      { id: 'K01', path: 'K02.png' }
    ],
    [
      { id: 'K01', path: 'K01.png' },
      { id: 'K03', path: 'K02.png' }
    ]
  ])('требует ровно все заявленные ID: %j', (...images) => {
    start();
    expect(() => collect(response(images))).toThrow(/не все согласованные опоры/);
  });

  it.each([{ status: 'failed' as const }, { status: 'running' as const }, { exitCode: 1 }])('не собирает результат неуспешного задания: %j', (patch) => {
    start();
    expect(() => collect({ ...response(), ...patch })).toThrow(/не завершено успешно/);
  });

  it('не собирает задание чужой программы-агента и неполную запись без провайдера', () => {
    start();
    expect(() => collect({ ...response(), provider: 'claude' })).toThrow(/Повреждена запись/);
    const record = join(launched.workDir, 'job.json');
    const { provider: _provider, ...rest } = JSON.parse(readFileSync(record, 'utf8'));
    writeFileSync(record, JSON.stringify(rest));
    expect(() => collect(response())).toThrow(/Повреждена запись/);
  });

  it('называет провайдера из записи в ошибке результата', () => {
    start();
    expect(() => collect({ ...response(), result: 'null' })).toThrow(`${testAgentProviderInfo.title} не вернул список файлов опор.`);
  });

  it('не копирует референс за пределами проекта', () => {
    writeFileSync(join(work, 'outside.png'), png);
    input.frames[0].referencePaths = ['../outside.png'];
    expect(() => start()).toThrow(/Недоступен референс/);
  });
});

describe('magic изображений', () => {
  it('распознаёт PNG, JPEG и WebP по содержимому, а не расширению', () => {
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
      'base64'
    );
    const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
    for (const [index, bytes] of [png, jpeg, webp].entries()) {
      const path = join(work, `image-${index}.bin`);
      writeFileSync(path, bytes);
      expect(isImageFile(path)).toBe(true);
      expect(imageDimensions(path)).toEqual({ width: 1, height: 1 });
      expect(imageExtensionMatches(path)).toBe(false);
      const correctlyNamed = join(work, `image-${index}${['.png', '.jpg', '.webp'][index]}`);
      writeFileSync(correctlyNamed, bytes);
      expect(imageExtensionMatches(correctlyNamed)).toBe(true);
    }
    const jpegAlias = join(work, 'image.jpeg');
    writeFileSync(jpegAlias, jpeg);
    expect(imageExtensionMatches(jpegAlias)).toBe(true);
    const fake = join(work, 'fake.png');
    writeFileSync(fake, 'PNG');
    expect(isImageFile(fake)).toBe(false);
    expect(isImageFile(join(work, 'нет.png'))).toBe(false);
    expect(isImageFile(project)).toBe(false);
  });
});
