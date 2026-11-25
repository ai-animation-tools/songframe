/**
 * Локальная модель страницы «Эффекты»: effects.view/preview/render/remove и jobs.get без Wails и
 * FFmpeg. Превью — SVG data: URL с перечнем эффектов кадра, чтобы «до» и «после» различались.
 * Рендер — задание вида tool с шагом shot_effects: первый опрос видит его выполняющимся,
 * следующий — завершённым, и план получает свежий эффект с полными значениями параметров.
 */
import type { EffectParamSpec, JobInfo } from '@shared/types';
import type { AppliedEffectStep, EffectKind, EffectShot, EffectStep, EffectsView } from '@shared/effects';
import { STORY_IMAGE_PATH, STORY_VIDEO_PATH, type StoryOptions } from './storybook';

export const EFFECTS_PAGE_PROJECT = '/mock/Клип у старых ворот';

const spec = (name: string, title: string, min: number, max: number, value: number, step: number, hint: string): EffectParamSpec => ({
  name,
  title,
  min,
  max,
  default: value,
  step,
  hint
});

/** Эффекты витрины: те же виды и подписи, что у реестра Go, с частью параметров. */
export const EFFECT_KINDS: EffectKind[] = [
  {
    id: 'reverse',
    title: 'Реверс',
    hint: 'Ролик плана идёт задом наперёд: последний кадр становится первым. Применяйте, когда план снят прямым ходом, а на экране нужен обратный — капли взлетают из лужи, свет уходит назад: модели видео обратную физику по описанию не делают. Остальные эффекты ложатся уже на развёрнутое видео: дождь в нём падает вниз, как обычно. Параметров нет. Сравнение «До» показывает кадр с тем же номером в исходном видео.',
    windAngle: '',
    planTime: [],
    beam: null,
    params: []
  },
  {
    id: 'light',
    hint: 'Свет от источника за кадром или у его края: фары подъезжающей машины, фонарь, луч из окна. Применяйте, когда по сюжету на место или героя падает свет, которого нет в принятом видео. Эффект подсветит освещённые предметы, обведёт их края со стороны источника и даст лёгкую дымку луча; свет может разгораться по ходу плана.',
    title: 'Свет',
    windAngle: '',
    planTime: ['start', 'end', 'fade_start', 'fade_end'],
    beam: { x: 'source_x', y: 'source_y', radius: 'radius', direction: 'direction', cone: 'cone' },
    params: [
      spec(
        'source_x',
        'Источник по горизонтали, доля кадра',
        -0.5,
        1.5,
        0.1,
        0.01,
        'Где источник по горизонтали: 0 — левый край кадра, 1 — правый. Меньше 0 или больше 1 — источник за кадром и светит сбоку.'
      ),
      spec(
        'source_y',
        'Источник по вертикали, доля кадра',
        -0.5,
        1.5,
        0.9,
        0.01,
        'Где источник по вертикали: 0 — верх кадра, 1 — низ. Больше 1 — источник ниже кадра, например фары у земли.'
      ),
      spec('radius', 'Дальность, доля диагонали', 0.1, 3, 1.1, 0.01, 'Как далеко достаёт свет.'),
      spec('intensity', 'Сила', 0, 20, 4, 0.1, 'Яркость света в полную силу. Кадр пересвечен — уменьшите, свет едва заметен — увеличьте.'),
      spec('start', 'Начало нарастания', 0, 1, 0.45, 0.01, 'Когда свет начинает появляться: 0 — горит с первого кадра.'),
      spec('end', 'Полная сила', 0, 1, 1, 0.01, 'Когда свет набирает полную силу.'),
      spec('fade_start', 'Начало затухания', 0, 1, 1, 0.01, 'Когда свет начинает гаснуть. Конец плана — свет не гаснет.'),
      spec('fade_end', 'Свет погас', 0, 1, 1, 0.01, 'Когда свет гаснет совсем.'),
      spec('flicker', 'Дрожание', 0, 0.5, 0.06, 0.01, 'Лёгкое мерцание от кадра к кадру: живой огонь, свет сквозь дождь или листву. 0 — ровный свет.'),
      spec(
        'direction',
        'Направление луча, градусы: 0 — вправо, 90 — вверх',
        0,
        360,
        45,
        1,
        'Куда светит луч на экране: 0 — вправо, 90 — вверх, 180 — влево, 270 — вниз. Важен только для узкого луча.'
      ),
      spec(
        'cone',
        'Ширина луча, градусы: 360 — во все стороны',
        10,
        360,
        360,
        1,
        'Ширина луча. 360 — свет во все стороны, как от лампы; 30–60 — узкий луч фары или прожектора.'
      )
    ]
  },
  {
    id: 'rain',
    planTime: [],
    beam: null,
    hint: 'Дождь поверх принятого плана. Применяйте, когда по сценарию идёт дождь, а в видео его нет или он слабый и неровный от кадра к кадру. Капли падают слоями — мелкие вдали, крупные у камеры, — подсвечиваются светом кадра, а сам кадр становится темнее и контрастнее, как мокрый. Чтобы дождь соседних планов совпадал, берите параметры с уже настроенного плана.',
    title: 'Дождь',
    windAngle: 'angle',
    params: [
      spec('density', 'Плотность, капель на мегапиксель', 0, 5000, 900, 10, 'Сколько капель: 300–600 — морось, около 900 — обычный дождь, от 2000 — ливень.'),
      spec('angle', 'Наклон, градусы от вертикали', -60, 60, 0, 0.5, 'Наклон струй: 0 — дождь падает отвесно, плюс — капли летят вправо, минус — влево.'),
      spec('speed', 'Скорость, пиксели за кадр', 5, 200, 55, 0.5, 'Как быстро падают капли. Медленно — лёгкий дождь, быстро — сильный ливень.'),
      spec(
        'shutter',
        'Длина капли, доля пути за кадр',
        0.05,
        3,
        0.5,
        0.01,
        'Длина следа капли, как от выдержки камеры. Меньше — короткие чёрточки, больше — длинные сплошные струи.'
      ),
      spec(
        'thickness',
        'Размер капли (толщина), пиксели',
        0.3,
        6,
        1.1,
        0.1,
        'Толщина капли в полном кадре. Тонкие — мелкий дальний дождь, толстые — крупные капли у камеры.'
      ),
      spec('opacity', 'Непрозрачность', 0, 1, 0.35, 0.01, 'Насколько капли заметны. Меньше — едва видный дождь на фоне, больше — плотные яркие струи.')
    ]
  },
  {
    id: 'grain',
    title: 'Зерно',
    planTime: [],
    beam: null,
    hint: 'Плёночное зерно: лёгкий шум, свой на каждом кадре. Применяйте, чтобы видео выглядело снятым камерой, а планы разных генераций — одним клипом. Зерно заметнее в светлых местах; на уменьшенном превью его почти не видно — смотрите кадр на весь экран.',
    windAngle: '',
    params: [spec('amount', 'Сила зерна', 0, 0.2, 0.025, 0.001, 'Сила зерна: 0,01–0,03 — едва заметная плёнка, от 0,05 — грубое зерно старой плёнки.')]
  }
];

/** Полные значения шага, как их пишет Go: заданное или по умолчанию; наклон из ветра — условный. */
function applied(step: EffectStep): AppliedEffectStep {
  const kind = EFFECT_KINDS.find((item) => item.id === step.effect);
  if (!kind) throw new Error(`Неизвестный эффект «${step.effect}».`);
  const params = Object.fromEntries(kind.params.map((item) => [item.name, step.given[item.name] ?? item.default]));
  if (step.wind && kind.windAngle && step.given[kind.windAngle] === undefined)
    params[kind.windAngle] = Math.round((Math.atan(step.wind.strength * Math.cos((step.wind.direction * Math.PI) / 180)) * 1800) / Math.PI) / 10;
  return { ...structuredClone(step), version: 1, params };
}

const RAIN_WITH_WIND: EffectStep = { effect: 'rain', given: { density: 1400, shutter: 1.2 }, wind: { direction: 20, strength: 0.5 } };

function shot(id: string, title: string, start: number, extra: Partial<EffectShot>): EffectShot {
  return {
    shot: id,
    title,
    start,
    end: start + 3,
    fps: 24,
    frames: 72,
    source: STORY_VIDEO_PATH,
    applied: false,
    steps: [],
    output: '',
    version: '',
    stale: '',
    problem: '',
    lipsync: false,
    camera: true,
    heading: 90,
    jobId: '',
    frame: STORY_IMAGE_PATH,
    lines: [
      { text: 'Капли стучат по крышам', start: -0.4, end: 1.2 },
      { text: 'Город ждёт рассвета', start: 1.5, end: 2.9 }
    ],
    lyricProblem: null,
    ...extra
  };
}

/** Устаревший эффект — фраза Go-сервиса о смене принятого видео. */
export const EFFECTS_STALE_REASON = 'Принятое видео плана изменилось после применения эффекта: примените эффект заново.';
export const EFFECTS_KIT_PROBLEM = 'Комплект плана M04 повреждён: нет принятого монтажа accepted_edit с видео, частотой и числом кадров.';

function initialShots(): EffectShot[] {
  return [
    shot('M01', 'Вступление: город под дождём', 0, {
      applied: true,
      steps: [applied(RAIN_WITH_WIND), applied({ effect: 'grain', given: {} })],
      output: STORY_VIDEO_PATH,
      version: 'a'.repeat(64)
    }),
    shot('M02', 'Мост над рекой на рассвете', 3, { camera: false, heading: 0, lipsync: true }),
    shot('M03', 'Фонарь у старого причала', 6, {
      applied: true,
      steps: [applied({ effect: 'light', given: { intensity: 7 } })],
      output: STORY_VIDEO_PATH,
      version: 'b'.repeat(64),
      stale: EFFECTS_STALE_REASON
    }),
    shot('M04', 'Пустая площадь', 9, { problem: EFFECTS_KIT_PROBLEM, frame: '' })
  ];
}

/** SVG-кадр превью: план, номер кадра и эффекты, чтобы «до» и «после» различались на глаз. */
function previewImage(shotId: string, steps: EffectStep[], frame: number): string {
  const label = steps.length ? steps.map((step) => EFFECT_KINDS.find((kind) => kind.id === step.effect)?.title ?? step.effect).join(' + ') : 'без эффекта';
  const rain = steps.some((step) => step.effect === 'rain')
    ? Array.from(
        { length: 40 },
        (_, index) =>
          `<line x1="${(index * 37) % 960}" y1="${(index * 53) % 540}" x2="${((index * 37) % 960) + 12}" y2="${((index * 53) % 540) + 40}" stroke="#cfe" stroke-opacity="0.7"/>`
      ).join('')
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#3a5a40"/>${rain}<text x="40" y="80" font-size="40" fill="#fff">${shotId} · кадр ${frame}</text><text x="40" y="140" font-size="32" fill="#fff">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export interface EffectsPageInspection {
  previews: { shot: string; steps: EffectStep[]; frame: number; width: number }[];
  renders: { shot: string; steps: EffectStep[] }[];
  removed: string[];
}

let activeInspection: () => EffectsPageInspection = () => ({ previews: [], renders: [], removed: [] });
/** Вызовы модели последней открытой истории. */
export function effectsPageInspection(): EffectsPageInspection {
  return activeInspection();
}

export type EffectsPageState = 'shots' | 'empty';

export function effectsPageOptions({ state = 'shots', shot }: { state?: EffectsPageState; shot?: string } = {}): StoryOptions {
  return {
    shell: 'page',
    route: shot ? `/project/effects?shot=${shot}` : '/project/effects',
    app: {
      state: { packaged: false, problems: [], localDir: '/mock/state', current: EFFECTS_PAGE_PROJECT, history: [], platform: 'linux' }
    },
    createApi: () => {
      const inspection: EffectsPageInspection = { previews: [], renders: [], removed: [] };
      activeInspection = () => inspection;
      let shots = state === 'empty' ? [] : initialShots();
      const jobs = new Map<string, { info: JobInfo; shot: string; steps: EffectStep[]; polls: number }>();
      const view = (): EffectsView => structuredClone({ kinds: EFFECT_KINDS, shots });
      const find = (id: string): EffectShot => {
        const found = shots.find((item) => item.shot === id);
        if (!found) throw new Error(`План ${id} не найден в сценарии.`);
        return found;
      };
      return {
        effects: {
          view: async (project) => {
            if (project !== EFFECTS_PAGE_PROJECT) throw new Error('Модель знает только проект истории.');
            return view();
          },
          preview: async (_project, id, steps, frame, width) => {
            find(id);
            inspection.previews.push({ shot: id, steps: structuredClone(steps), frame, width });
            steps.forEach(applied);
            return previewImage(id, steps, frame);
          },
          render: async (_project, id, steps) => {
            find(id);
            if (!steps.length) throw new Error('Не выбран ни один эффект.');
            steps.forEach(applied);
            inspection.renders.push({ shot: id, steps: structuredClone(steps) });
            const info: JobInfo = {
              id: `effects-${jobs.size + 1}`,
              project: EFFECTS_PAGE_PROJECT,
              kind: 'tool',
              title: `Эффект ${id}`,
              status: 'running',
              startedAt: '2026-11-22T12:00:00.000Z',
              finishedAt: null,
              log: '',
              code: null,
              steps: [{ label: `Эффект ${id}`, tool: 'shot_effects', status: 'running', code: null }]
            };
            jobs.set(info.id, { info, shot: id, steps: structuredClone(steps), polls: 0 });
            shots = shots.map((item) => (item.shot === id ? { ...item, jobId: info.id } : item));
            return structuredClone(info);
          },
          remove: async (_project, id) => {
            find(id);
            inspection.removed.push(id);
            shots = shots.map((item) => (item.shot === id ? { ...item, applied: false, steps: [], output: '', version: '', stale: '' } : item));
            return view();
          }
        },
        jobs: {
          get: async (id) => {
            const job = jobs.get(id);
            if (!job) return null;
            job.polls += 1;
            if (job.info.status === 'running' && job.polls > 1) {
              job.info = {
                ...job.info,
                status: 'done',
                code: 0,
                finishedAt: '2026-11-22T12:00:10.000Z',
                steps: job.info.steps.map((step) => ({ ...step, status: 'done', code: 0 }))
              };
              shots = shots.map((item) =>
                item.shot === job.shot
                  ? {
                      ...item,
                      jobId: '',
                      applied: true,
                      stale: '',
                      steps: job.steps.map(applied),
                      output: STORY_VIDEO_PATH,
                      version: `${job.info.id}`.padEnd(64, '0')
                    }
                  : item
              );
            }
            return structuredClone(job.info);
          }
        }
      };
    }
  };
}
