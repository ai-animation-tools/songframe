/** Публикует только выбранные тестовые медиа; пользовательские клипы и весь проект-образец в витрину не попадают. */
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, 'build/storybook-assets');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const [source, target] of [
  ['assets/shots/M01/video.mp4', 'story-video.mp4'],
  ['source/heroes/mira.png', 'story-image.png'],
  ['source/track.mp3', 'story-track.mp3']
])
  cpSync(resolve(root, 'tools/testdata/sample-project', source), resolve(output, target));

// Кадровые примеры подготовлены заранее: запуск и CI витрины только копируют их, без FFmpeg.
for (const name of ['story-derived-source-150.mp4', 'story-derived-preview-92.mp4', 'story-derived-preview-62.mp4', 'story-derived-still-92.mp4'])
  cpSync(resolve(root, '.storybook/assets', name), resolve(output, name));
