/** Промпты видов хранятся отдельно: правка одного изображения не меняет остальные и общий legacy-промпт. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReferenceInput, SourceManifest, SourceReference, SourcesInput } from '@shared/types';
import { readManifest, saveSources, viewSources } from './sources';

const projects: string[] = [];
afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});

function fixture(): { project: string; input: SourcesInput } {
  const project = mkdtempSync(join(tmpdir(), 'songframe-reference-prompts-'));
  projects.push(project);
  mkdirSync(join(project, 'source'));
  writeFileSync(join(project, 'source', 'track.mp3'), 'трек');
  writeFileSync(join(project, 'source', 'text.md'), 'Строка песни\n');
  writeFileSync(join(project, 'source', 'description.md'), 'Идея клипа\n');
  writeFileSync(join(project, 'front.png'), 'изображение спереди');
  writeFileSync(join(project, 'side.webp'), 'изображение сбоку');
  // Существующие обязательные исходники исключают запуск ffprobe: проверяем только локальное хранение референсов.
  const manifest: SourceManifest = {
    schema_version: 1,
    track: { path: 'track.mp3', sha256: 'track', bytes: 1, original_name: 'track.mp3', duration_seconds: null },
    lyrics: { path: 'text.md', sha256: 'lyrics', bytes: 1, lines: 1, sections: [] },
    idea: { path: 'description.md', sha256: 'idea', bytes: 1 },
    cover: null,
    references: [],
    updated_at: ''
  };
  writeFileSync(join(project, 'source', 'manifest.json'), JSON.stringify(manifest));
  return {
    project,
    input: {
      track: null,
      lyrics: null,
      idea: null,
      cover: null,
      references: [
        {
          id: 'mira',
          kind: 'character',
          name: 'Мира',
          short_name: 'Мира',
          description: 'Герой',
          prompt: 'Общий старый промпт',
          files: [
            { sourcePath: join(project, 'front.png'), view: 'front', note: 'В полный рост', prompt: 'Спереди' },
            { sourcePath: join(project, 'side.webp'), view: 'side', note: 'Профиль', prompt: 'Сбоку' }
          ]
        }
      ]
    }
  };
}

function edit(project: string, ref: SourceReference, includeFilePrompts = true): SourcesInput {
  const reference: ReferenceInput = {
    ...ref,
    prompt: ref.prompt ? text(project, ref.prompt) : '',
    files: ref.files.map((file) => ({
      existingPath: file.path,
      view: file.view,
      note: file.note,
      ...(includeFilePrompts ? { prompt: file.prompt ? text(project, file.prompt) : '' } : {})
    }))
  };
  return { track: null, lyrics: null, idea: null, cover: null, references: [reference] };
}

function text(project: string, path: string): string {
  return readFileSync(join(project, 'source', path), 'utf8');
}

describe('промпты отдельных изображений референса', () => {
  it('добавляет новый вид после удаления первого без перезаписи оставшегося изображения и его промпта', () => {
    const { project, input } = fixture();
    const ref = saveSources(project, input).references[0];
    const changed = edit(project, ref);
    changed.references[0].files.shift();
    const added = join(project, 'new-side.webp');
    writeFileSync(added, 'новое изображение другого вида');
    changed.references[0].files.push({ sourcePath: added, view: 'back', note: '', prompt: 'Сзади' });
    const saved = saveSources(project, changed).references[0];
    expect(saved.files.map((file) => file.path)).toEqual(['heroes/mira-2.webp', 'heroes/mira-3.webp']);
    expect(text(project, saved.files[0].path)).toBe('изображение сбоку');
    expect(text(project, saved.files[0].prompt!)).toBe('Сбоку\n');
    expect(text(project, saved.files[1].path)).toBe('новое изображение другого вида');
    expect(text(project, saved.files[1].prompt!)).toBe('Сзади\n');
  });

  it('сохраняет разные промпты, читает их из манифеста и меняет только выбранный', () => {
    const { project, input } = fixture();
    const ref = saveSources(project, input).references[0];
    expect(ref.files.map((file) => file.prompt)).toEqual(['heroes/mira.png.prompt.txt', 'heroes/mira-2.webp.prompt.txt']);
    expect(ref.prompt).toBe('heroes/mira.prompt.txt');
    expect(viewSources(project).manifest?.references[0]).toEqual(ref);
    writeFileSync(join(project, 'source', ref.files[1].prompt!), 'Сбоку\r\n\r\n');
    writeFileSync(join(project, 'source', ref.prompt!), 'Общий старый промпт\r\n\r\n');
    const secondImage = text(project, ref.files[1].path);
    const secondPrompt = text(project, ref.files[1].prompt!);
    const common = text(project, ref.prompt!);

    const changed = edit(project, ref);
    changed.references[0].files[0].prompt = 'Другой свет спереди';
    saveSources(project, changed);
    expect(text(project, ref.files[0].prompt!)).toBe('Другой свет спереди\n');
    expect(text(project, ref.files[1].prompt!)).toBe(secondPrompt);
    expect(text(project, ref.files[1].path)).toBe(secondImage);
    expect(text(project, ref.prompt!)).toBe(common);
  });

  it('не назначает legacy-промпт видам и сохраняет его прежний путь и точные байты', () => {
    const { project, input } = fixture();
    input.references[0].files.forEach((file) => {
      delete file.prompt;
    });
    const manifest = saveSources(project, input);
    const ref = manifest.references[0];
    const legacyPath = 'heroes/original-request.txt';
    const legacyBytes = 'Общий старый промпт\r\n\r\n';
    writeFileSync(join(project, 'source', legacyPath), legacyBytes);
    rmSync(join(project, 'source', ref.prompt!));
    ref.prompt = legacyPath;
    writeFileSync(join(project, 'source', 'manifest.json'), JSON.stringify(manifest));

    const saved = saveSources(project, edit(project, ref)).references[0];
    expect(saved.files.map((file) => file.prompt)).toEqual([null, null]);
    expect(saved.prompt).toBe(legacyPath);
    expect(text(project, legacyPath)).toBe(legacyBytes);
  });

  it('сохраняет промпты изображений при записи старым клиентом без нового поля', () => {
    const { project, input } = fixture();
    const ref = saveSources(project, input).references[0];
    const legacyInput = edit(project, ref, false);
    legacyInput.references[0].files[0].note = 'Новая заметка';
    const saved = saveSources(project, legacyInput).references[0];
    expect(saved.files.map((file) => file.prompt)).toEqual(ref.files.map((file) => file.prompt));
    expect(text(project, saved.files[0].prompt!)).toBe('Спереди\n');
    expect(text(project, saved.files[1].prompt!)).toBe('Сбоку\n');
  });

  it('разделяет прежний общий путь и новый промпт изображения при их совпадении', () => {
    const { project, input } = fixture();
    input.references[0].files.forEach((file) => {
      delete file.prompt;
    });
    const manifest = saveSources(project, input);
    const ref = manifest.references[0];
    const oldCommonPath = `${ref.files[0].path}.prompt.txt`;
    writeFileSync(join(project, 'source', oldCommonPath), 'Общий старый промпт\n');
    rmSync(join(project, 'source', ref.prompt!));
    ref.prompt = oldCommonPath;
    writeFileSync(join(project, 'source', 'manifest.json'), JSON.stringify(manifest));

    const changed = edit(project, ref);
    changed.references[0].files[0].prompt = 'Промпт только спереди';
    const saved = saveSources(project, changed).references[0];
    expect(saved.files[0].prompt).toBe(oldCommonPath);
    expect(saved.prompt).not.toBe(oldCommonPath);
    expect(text(project, saved.files[0].prompt!)).toBe('Промпт только спереди\n');
    expect(text(project, saved.prompt!)).toBe('Общий старый промпт\n');
  });

  it('удаляет только выбранный промпт, сохраняя изображение, другой вид и общий промпт', () => {
    const { project, input } = fixture();
    const ref = saveSources(project, input).references[0];
    const changed = edit(project, ref);
    changed.references[0].files[0].prompt = '';
    const saved = saveSources(project, changed).references[0];
    expect(saved.files[0].prompt).toBeNull();
    expect(existsSync(join(project, 'source', ref.files[0].prompt!))).toBe(false);
    expect(text(project, ref.files[0].path)).toBe('изображение спереди');
    expect(text(project, saved.files[1].prompt!)).toBe('Сбоку\n');
    expect(text(project, saved.prompt!)).toBe('Общий старый промпт\n');
  });

  it('удаляет промпт удалённого изображения, сохраняя оставшийся вид и общий промпт', () => {
    const { project, input } = fixture();
    const ref = saveSources(project, input).references[0];
    const changed = edit(project, ref);
    changed.references[0].files.shift();
    const saved = saveSources(project, changed).references[0];
    expect(existsSync(join(project, 'source', ref.files[0].path))).toBe(false);
    expect(existsSync(join(project, 'source', ref.files[0].prompt!))).toBe(false);
    expect(text(project, saved.files[0].path)).toBe('изображение сбоку');
    expect(text(project, saved.files[0].prompt!)).toBe('Сбоку\n');
    expect(text(project, saved.prompt!)).toBe('Общий старый промпт\n');
  });

  it('не удаляет старый путь промпта, пока на него ссылается оставшееся изображение', () => {
    const { project, input } = fixture();
    const manifest = saveSources(project, input);
    const ref = manifest.references[0];
    ref.files[1].prompt = ref.files[0].prompt;
    writeFileSync(join(project, 'source', 'manifest.json'), JSON.stringify(manifest));
    const changed = edit(project, ref, false);
    changed.references[0].files.shift();
    saveSources(project, changed);
    expect(readManifest(project)?.references[0].files[0].prompt).toBe(ref.files[0].prompt);
    expect(text(project, ref.files[0].prompt!)).toBe('Спереди\n');
  });

  it('сохраняет прежний текст второго вида при правке первого с общим путём и отсутствующим полем второго', () => {
    const { project, input } = fixture();
    const manifest = saveSources(project, input);
    const ref = manifest.references[0];
    ref.files[1].prompt = ref.files[0].prompt;
    writeFileSync(join(project, 'source', ref.files[0].prompt!), 'Спереди\r\n\r\n');
    writeFileSync(join(project, 'source', 'manifest.json'), JSON.stringify(manifest));
    const changed = edit(project, ref, false);
    changed.references[0].files[0].prompt = 'Изменённый первый вид';

    const saved = saveSources(project, changed).references[0];
    expect(saved.files[0].prompt).not.toBe(saved.files[1].prompt);
    expect(text(project, saved.files[0].prompt!)).toBe('Изменённый первый вид\n');
    expect(text(project, saved.files[1].prompt!)).toBe('Спереди\r\n\r\n');
    expect(text(project, saved.prompt!)).toBe('Общий старый промпт\n');
  });

  it('сохраняет нестандартный путь и байты неизменного промпта изображения', () => {
    const { project, input } = fixture();
    const manifest = saveSources(project, input);
    const ref = manifest.references[0];
    ref.files[0].prompt = 'heroes/front-original.txt';
    writeFileSync(join(project, 'source', ref.files[0].prompt), 'Спереди\r\n\r\n');
    writeFileSync(join(project, 'source', 'manifest.json'), JSON.stringify(manifest));

    const saved = saveSources(project, edit(project, ref)).references[0];
    expect(saved.files[0].prompt).toBe('heroes/front-original.txt');
    expect(text(project, saved.files[0].prompt!)).toBe('Спереди\r\n\r\n');
  });
});
