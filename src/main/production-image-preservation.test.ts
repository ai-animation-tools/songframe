/** Платные image attempts переживают Apply/откат без копирования поверх оригиналов. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyProductionPackage, productionPackagePaid, productionPackageVideoPaid, recoverInterruptedProductionApplies } from './production-workflow-apply';
import { registerTestMediaProvider, TEST_PROVIDER } from './testing/media-provider';

let restoreProvider: () => void;
beforeAll(() => {
  restoreProvider = registerTestMediaProvider();
});
afterAll(() => restoreProvider());

// Подменяем только точку сбоя копирования; все остальные операции остаются настоящими.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, cpSync: vi.fn(actual.cpSync) };
});

const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const write = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
let base: string;
let project: string;
let local: string;
let pkg: string;
let image: string;
let original: string;
function readWorkflow(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pkg, 'workflow.json'), 'utf8'));
}
function snapshot(directory: string): Record<string, Buffer> {
  return Object.fromEntries(
    readdirSync(directory)
      .filter((name) => statSync(join(directory, name)).isFile())
      .map((name) => [name, readFileSync(join(directory, name))])
  );
}
function assertImageUnchanged(before: Record<string, Buffer>, inode: number): void {
  expect(snapshot(image)).toEqual(before);
  expect(statSync(original).ino).toBe(inode);
  expect(statSync(original).mtimeMs).toBe(1234567890000);
}
function interrupt(): string {
  // Незавершившийся callback моделирует остановку процесса: остаётся настоящий журнал Apply.
  void applyProductionPackage(local, project, pkg, async () => {
    writeFileSync(join(pkg, 'video-prompt.txt'), 'Прерванная запись');
    writeFileSync(join(pkg, 'new.txt'), 'Частичный результат');
    await new Promise<void>(() => {});
  });
  const directory = join(local, 'production-apply', hash(`${project}\0${pkg}`));
  expect(existsSync(join(directory, 'pending.json'))).toBe(true);
  return directory;
}

describe('сохранность платных изображений при изменении рабочего пакета', () => {
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'production-images-'));
    project = join(base, 'project');
    local = join(base, 'local');
    pkg = join(project, 'plan/batches/M01-attempt-01');
    image = join(pkg, 'images/request-01');
    original = join(image, 'original.png');
    write(join(project, 'plan/project.json'), { schema_version: 1 });
    write(join(image, 'request.json'), { schema_version: 1, kind: 'image', provider: TEST_PROVIDER, command: 'text_to_image', inputs: [], outputs: 1 });
    const requestSha = hash(readFileSync(join(image, 'request.json')));
    writeFileSync(original, 'Сохранённые платные байты изображения');
    utimesSync(original, 1234567890, 1234567890);
    mkdirSync(join(image, 'inputs'));
    write(join(image, 'attempt.json'), {
      request_sha256: requestSha,
      status: 'downloaded',
      generation_id: 'image-id',
      downloads: [{ path: 'original.png', bytes: statSync(original).size }]
    });
    write(join(pkg, 'workflow.json'), {
      schema_version: 1,
      shot: 'M01',
      stage: 'prompt_review',
      request_dir: null,
      image_request_dir: 'images/request-01',
      image_frame_id: 'K01',
      image_requests: [{ frame_id: 'K01', request_dir: 'images/request-01', request_sha256: requestSha, provider: TEST_PROVIDER }]
    });
    writeFileSync(join(pkg, 'video-prompt.txt'), 'Исходный видеопромпт');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('разрешает новый видеопромпт/request, сохраняя все image bytes и inode оригинала', async () => {
    const before = snapshot(image);
    const inode = statSync(original).ino;
    expect(productionPackagePaid(pkg)).toBe(true);
    expect(productionPackageVideoPaid(pkg)).toBe(false);
    await applyProductionPackage(local, project, pkg, async () => {
      writeFileSync(join(pkg, 'video-prompt.txt'), 'Новый согласуемый видеопромпт');
      write(join(pkg, 'request-01/request.json'), { kind: 'video', provider: TEST_PROVIDER });
      write(join(pkg, 'request-01/attempt.json'), { status: 'prepared' });
      write(join(pkg, 'workflow.json'), { ...readWorkflow(), stage: 'request_choice', request_dir: 'request-01' });
    });
    assertImageUnchanged(before, inode);
    expect(readWorkflow().request_dir).toBe('request-01');
    expect(readFileSync(join(pkg, 'video-prompt.txt'), 'utf8')).toBe('Новый согласуемый видеопромпт');
  });

  it('откатывает только mutable files после ошибки, не заменяя image directory', async () => {
    const before = snapshot(image);
    const inode = statSync(original).ino;
    const folderInode = statSync(image).ino;
    await expect(
      applyProductionPackage(local, project, pkg, async () => {
        writeFileSync(join(pkg, 'video-prompt.txt'), 'Ошибка посредине применения');
        writeFileSync(join(pkg, 'images/new.txt'), 'Новый сосед image attempt');
        throw new Error('Прерван Apply');
      })
    ).rejects.toThrow('Прерван Apply');
    expect(readFileSync(join(pkg, 'video-prompt.txt'), 'utf8')).toBe('Исходный видеопромпт');
    expect(existsSync(join(pkg, 'images/new.txt'))).toBe(false);
    expect(statSync(image).ino).toBe(folderInode);
    assertImageUnchanged(before, inode);
  });

  it('восстанавливает прерванный Apply из v2 журнала без image originals в backup', () => {
    const before = snapshot(image);
    const inode = statSync(original).ino;
    const directory = interrupt();
    const pending = JSON.parse(readFileSync(join(directory, 'pending.json'), 'utf8'));
    expect(pending.schemaVersion).toBe(2);
    expect(existsSync(join(directory, 'package/images/request-01'))).toBe(false);
    expect(pending.protectedImages[0].files.inputs).toBeNull();
    recoverInterruptedProductionApplies(local);
    expect(readFileSync(join(pkg, 'video-prompt.txt'), 'utf8')).toBe('Исходный видеопромпт');
    expect(existsSync(join(pkg, 'new.txt'))).toBe(false);
    assertImageUnchanged(before, inode);
    expect(existsSync(directory)).toBe(false);
  });

  it('повторяет восстановление после обрыва между удалением workflow и копированием mutable backup', async () => {
    const before = snapshot(image);
    const inode = statSync(original).ino;
    const directory = interrupt();
    const copy = (await vi.importActual<typeof fs>('node:fs')).cpSync;
    const interruption = vi.mocked(fs.cpSync).mockImplementation((source, target, options) => {
      if (source === join(directory, 'package') && target === pkg) {
        expect(existsSync(join(pkg, 'workflow.json'))).toBe(false);
        throw new Error('Обрыв перед копированием mutable backup');
      }
      return copy(source, target, options);
    });
    try {
      expect(() => recoverInterruptedProductionApplies(local)).toThrow('Обрыв перед копированием');
    } finally {
      interruption.mockImplementation(copy);
    }
    expect(existsSync(join(pkg, 'workflow.json'))).toBe(false);
    expect(existsSync(join(directory, 'pending.json'))).toBe(true);
    assertImageUnchanged(before, inode);
    recoverInterruptedProductionApplies(local);
    expect(readWorkflow().stage).toBe('prompt_review');
    expect(readFileSync(join(pkg, 'video-prompt.txt'), 'utf8')).toBe('Исходный видеопромпт');
    assertImageUnchanged(before, inode);
    expect(existsSync(directory)).toBe(false);
    expect(() => recoverInterruptedProductionApplies(local)).not.toThrow();
  });

  it('не подменяет существующую чужую history резервом и не скрывает новую оплату без workflow', () => {
    const directory = interrupt();
    const data = readWorkflow();
    write(join(pkg, 'workflow.json'), { ...data, image_requests: [] });
    expect(() => recoverInterruptedProductionApplies(local)).toThrow('История');
    expect(readWorkflow().image_requests).toEqual([]);
    expect(existsSync(join(directory, 'pending.json'))).toBe(true);
    rmSync(join(pkg, 'workflow.json'));
    const backupWorkflow = join(directory, 'package/workflow.json');
    const backupBytes = readFileSync(backupWorkflow);
    const foreignBackup = JSON.parse(backupBytes.toString('utf8'));
    foreignBackup.image_requests[0].frame_id = 'K02';
    write(backupWorkflow, foreignBackup);
    expect(() => recoverInterruptedProductionApplies(local)).toThrow('Защищённая image-попытка');
    expect(existsSync(join(pkg, 'workflow.json'))).toBe(false);
    writeFileSync(backupWorkflow, backupBytes);
    write(join(pkg, 'new-video/attempt.json'), { status: 'submission_unknown' });
    expect(() => recoverInterruptedProductionApplies(local)).toThrow('платную попытку');
    expect(existsSync(join(pkg, 'workflow.json'))).toBe(false);
    expect(existsSync(join(directory, 'pending.json'))).toBe(true);
  });

  it('останавливает восстановление при подмене защищённого оригинала, сохраняя журнал', () => {
    const directory = interrupt();
    writeFileSync(original, 'Подменённый оригинал');
    expect(() => recoverInterruptedProductionApplies(local)).toThrow('оригиналы изменились');
    expect(readFileSync(original, 'utf8')).toBe('Подменённый оригинал');
    rmSync(join(pkg, 'workflow.json'));
    expect(() => recoverInterruptedProductionApplies(local)).toThrow('оригиналы изменились');
    expect(existsSync(join(pkg, 'workflow.json'))).toBe(false);
    expect(readFileSync(join(pkg, 'video-prompt.txt'), 'utf8')).toBe('Прерванная запись');
    expect(existsSync(join(directory, 'pending.json'))).toBe(true);
  });

  it('не восстанавливает поверх неизвестной оплаты или нового video submit', () => {
    const directory = interrupt();
    write(join(pkg, 'unknown/attempt.json'), { status: 'submission_unknown' });
    expect(() => recoverInterruptedProductionApplies(local)).toThrow('платную попытку');
    expect(existsSync(join(directory, 'pending.json'))).toBe(true);
    expect(readFileSync(join(pkg, 'video-prompt.txt'), 'utf8')).toBe('Прерванная запись');
  });

  it('не доверяет незарегистрированному paid image, неизвестному attempt и неверному request SHA', async () => {
    const action = vi.fn(async () => {});
    const data = readWorkflow();
    write(join(pkg, 'workflow.json'), { ...data, image_requests: [], image_request_dir: null });
    expect(productionPackageVideoPaid(pkg)).toBe(true);
    await expect(applyProductionPackage(local, project, pkg, action)).rejects.toThrow('платной отправки');
    write(join(pkg, 'workflow.json'), data);
    write(join(pkg, 'images/request-01/request.json'), { kind: 'image', provider: TEST_PROVIDER, command: 'text_to_image', changed: true });
    await expect(applyProductionPackage(local, project, pkg, action)).rejects.toThrow('платной отправки');
    expect(action).not.toHaveBeenCalled();
  });

  it('сохраняет запрет для video stages и legacy попыток с неизвестным исходом', async () => {
    const action = vi.fn(async () => {});
    const data = readWorkflow();
    for (const stage of ['submitted', 'downloaded', 'edit_review', 'accepted']) {
      write(join(pkg, 'workflow.json'), { ...data, stage });
      expect(productionPackageVideoPaid(pkg)).toBe(true);
      await expect(applyProductionPackage(local, project, pkg, action)).rejects.toThrow('платной отправки');
    }
    write(join(pkg, 'workflow.json'), data);
    write(join(pkg, 'legacy/attempt.json'), {});
    expect(productionPackageVideoPaid(pkg)).toBe(true);
    expect(action).not.toHaveBeenCalled();
  });

  it('считает отдельный video request платным независимо от текущего workflow stage', async () => {
    write(join(pkg, 'video-request/request.json'), { kind: 'video', provider: TEST_PROVIDER });
    write(join(pkg, 'video-request/attempt.json'), { status: 'prepared' });
    write(join(pkg, 'workflow.json'), { ...readWorkflow(), request_dir: 'video-request' });
    expect(productionPackageVideoPaid(pkg)).toBe(false);
    write(join(pkg, 'video-request/attempt.json'), { status: 'submitted', generation_id: 'video-id' });
    const action = vi.fn(async () => {});
    expect(productionPackageVideoPaid(pkg)).toBe(true);
    await expect(applyProductionPackage(local, project, pkg, action)).rejects.toThrow('платной отправки');
    expect(action).not.toHaveBeenCalled();
  });

  it('не разрешает Apply до выбора image-кандидата и не игнорирует вложенный video attempt', async () => {
    const action = vi.fn(async () => {});
    const data = readWorkflow();
    for (const stage of ['image_request_choice', 'image_submitted', 'image_downloaded']) {
      write(join(pkg, 'workflow.json'), { ...data, stage });
      await expect(applyProductionPackage(local, project, pkg, action)).rejects.toThrow('выберите опору');
    }
    write(join(pkg, 'workflow.json'), data);
    write(join(image, 'nested-video/attempt.json'), { status: 'submitted', generation_id: 'video-id' });
    expect(productionPackageVideoPaid(pkg)).toBe(true);
    expect(action).not.toHaveBeenCalled();
  });
});
