/** Локальная разметка использует штатный Jobs/PythonLauncher, отменяется только своим предметным API. */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import definition from '../../tools/song_timing/models.json';
import type { JobInfo, TimingGenerateOptions } from '@shared/types';
import type { SongModelSetup } from '@shared/song-models';
import { SONG_MODEL_ID } from '@shared/song-models';
import { analyzeLyrics } from '@shared/lyrics';
import { songTimingTexts as texts } from '@shared/texts/song-timing';
import { VocalPreparation, modelFilesInstalled, songModelsDirectory } from './vocal-preparation';
import { whisperSetup } from './whisper-setup';
import { viewTiming } from './timing';
import type { Jobs } from './jobs';

export class TimingLocal {
  private running = new Map<string, { jobId: string; controller: AbortController }>();
  readonly vocals: VocalPreparation;
  constructor(private readonly getJobs: () => Jobs) {
    this.vocals = new VocalPreparation(getJobs);
  }
  private get jobs(): Jobs {
    return this.getJobs();
  }
  setup(): SongModelSetup {
    const directory = songModelsDirectory(this.jobs);
    const installed = modelFilesInstalled(directory, 'alignment');
    return { directory, installed, totalBytes: definition.files.filter((item) => item.component === 'alignment').reduce((sum, item) => sum + item.bytes, 0) };
  }
  download(): JobInfo {
    const active = this.jobs.list().find((job) => job.modelDownload?.model === SONG_MODEL_ID && job.status === 'running');
    if (active) return active;
    const controller = new AbortController();
    const job = this.jobs.start(
      'model_download',
      texts.download,
      null,
      [{ tool: 'download_song_models', args: ['--component', 'alignment', '--output', this.setup().directory] }],
      controller.signal
    );
    job.modelDownload = { model: SONG_MODEL_ID, directory: this.setup().directory };
    this.running.set(job.id, { jobId: job.id, controller });
    return job;
  }
  async start(project: string, options: TimingGenerateOptions): Promise<JobInfo> {
    const view = viewTiming(project);
    if (!view.trackPath || !view.lyrics.some((line) => !line.header && line.text)) throw new Error(texts.sourceRequired);
    // Ошибку исходного текста показываем до диагностики Python и создания фонового задания.
    const problems = analyzeLyrics(readFileSync(join(project, 'source/text.md'), 'utf8')).problems;
    if (problems.length) throw new Error(problems.join(' '));
    let model = options.model?.trim();
    if (!model) {
      const setup = await whisperSetup(this.jobs.launcher);
      model = setup.directories[setup.recommended];
    }
    // После асинхронной диагностики повторяем проверку, чтобы двойной клик не создавал второе задание.
    const existing = this.jobs
      .list()
      .find((job) => job.status === 'running' && job.project === project && job.steps.some((step) => ['align_lyrics', 'separate_vocals'].includes(step.tool)));
    if (existing) throw new Error(texts.busy);
    const args = ['--json', '--model', model, '--device', options.device === 'cpu' ? 'cpu' : 'auto'];
    if (options.vocals) {
      const setup = this.setup();
      if (!setup.installed) throw new Error(texts.missing);
      args.push('--song-models', setup.directory);
    }
    const controller = new AbortController();
    const launch = (vocalResult?: string): JobInfo => {
      const launchArgs = [...args, ...(vocalResult ? ['--vocal-result', vocalResult] : []), ...(options.reset ? ['--reset'] : [])];
      return this.jobs.start(
        'tool',
        texts.jobTitle,
        project,
        [{ tool: 'align_lyrics', label: options.vocals ? texts.vocals : texts.basic, args: launchArgs, timeoutMs: 90 * 60 * 1000 }],
        controller.signal
      );
    };
    const job = options.vocals ? this.vocals.startWithSelected(project, launch) : launch();
    this.running.set(job.id, { jobId: job.id, controller });
    return job;
  }
  cancel(id: string): JobInfo {
    const entry = this.running.get(id);
    const job = this.jobs.get(id);
    if (!entry || !job) {
      const preparation = this.vocals.cancel(id);
      if (preparation) return preparation;
      throw new Error(texts.noJob);
    }
    if (job.status === 'running') entry.controller.abort(texts.cancelled);
    return job;
  }
  shutdown(): void {
    this.vocals.shutdown();
    for (const entry of this.running.values()) entry.controller.abort(texts.cancelled);
  }
}
