/** Управляемая модель кастинга: черновик и сохранённый снимок живут отдельно, IPC и генератор не вызываются. */
import { useRef, useState, type ReactElement } from 'react';
import { Alert, Box, Chip, Stack, Typography } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import type { CastEntity, CastFile, SourceKind } from '@shared/types';
import { DEFAULT_SOURCE_KINDS } from '@shared/types';
import { castTexts } from '@shared/texts/cast';
import { commonTexts } from '@shared/texts/common';
import { ActionButton } from '../components/ActionButton';
import { CastEntityCard } from '../pages/CastPage/components/CastEntityCard';
import { CastPropertiesEditor } from '../pages/CastPage/components/CastPropertiesEditor';
import { cleanProperties, dictionaryProblem } from '../pages/CastPage/properties';
import type { CastImageOption } from '../pages/CastPage/types';
import { storyAccess } from './commonStories';
import { createStoryApi, STORY_IMAGE_PATH, type StoryOptions } from './storybook';

export const castStoryKinds: SourceKind[] = [...DEFAULT_SOURCE_KINDS, { id: 'world', label: 'Мир сцены', dir: '' }];
const FRONT = 'references/Олег — анфас.png';
const SIDE = 'references/Олег — профиль.png';
const SHARED = 'references/Вечерний свет.png';
const BROKEN = 'references/Нет изображения.png';
const imageOptions: CastImageOption[] = [
  { path: FRONT, label: 'Олег — анфас' },
  { path: SIDE, label: 'Олег — профиль' },
  { path: SHARED, label: 'Общий референс — вечерний свет' }
];
const imagePaths = { [FRONT]: `${STORY_IMAGE_PATH}?view=front`, [SIDE]: `${STORY_IMAGE_PATH}?view=side`, [SHARED]: `${STORY_IMAGE_PATH}?view=shared` };

/** Общий доступ даёт кнопке рабочее состояние, но API содержит только безопасное преобразование URL. */
export function castStoryOptions(): StoryOptions {
  return { app: { aiAccess: storyAccess, online: true }, route: '/cast', createApi: () => createStoryApi() };
}

/** Один общий референс может принадлежать нескольким сущностям; удаление снимает только выбранную привязку. */
export function makeCastStory(): CastFile {
  return {
    schema_version: 1,
    entities: [
      {
        id: 'oleg',
        kind: 'character',
        name: 'Олег',
        short_name: 'Олег',
        role: 'Главный герой',
        appearance: 'Короткие тёмные волосы, синяя рабочая куртка. Сохранять лицо и пропорции между сценами.',
        images: [FRONT, SIDE, SHARED],
        initial_state: { clothes: 'Синяя куртка', mood: 'Сосредоточен', custom_detail: 'Ссадина на левой щеке' }
      },
      {
        id: 'pasha',
        kind: 'character',
        name: 'Дядя Паша',
        short_name: 'Паша',
        role: 'Сосед у ворот',
        appearance: 'Седые усы, светлая рубашка.',
        images: [SHARED],
        initial_state: { clothes: 'Светлая рубашка' }
      },
      {
        id: 'world',
        kind: 'world',
        name: 'Мир сцены',
        short_name: 'Мир',
        role: 'Общие условия для всех планов',
        appearance: 'Дачная улица ранней осенью. Мягкий объёмный свет, округлые формы и подробные материалы.',
        images: [SHARED],
        initial_state: { weather: 'Ясно', time: 'Вечер' }
      }
    ],
    properties: {
      character: [
        { key: 'clothes', label: 'Одежда', hint: 'Одежда в начале клипа', values: ['Синяя куртка', 'Светлая рубашка'], checklist: 'Одежда персонажа: {value}' },
        { key: 'mood', label: 'Настроение', hint: 'Эмоция перед первым планом', values: ['Сосредоточен', 'Радуется'], checklist: 'Сохранить выражение лица' }
      ],
      vehicle: [],
      world: [
        { key: 'weather', label: 'Погода', values: ['Ясно', 'Дождь'] },
        { key: 'time', label: 'Время суток', values: ['Утро', 'Вечер'] }
      ]
    }
  };
}

export type CastStoryVariant = 'regular' | 'no-images' | 'broken-image' | 'long' | 'world' | 'no-dictionary' | 'no-kinds' | 'invalid';

/** Отдельные варианты меняют только демонстрационные данные, сохраняя контракт рабочего cast.json. */
export function castStoryFixture(variant: CastStoryVariant = 'regular'): CastFile {
  const cast = makeCastStory();
  if (variant === 'no-images') cast.entities[0].images = [];
  if (variant === 'broken-image') cast.entities[0].images = [BROKEN];
  if (variant === 'long') {
    cast.entities[0].name = 'Олег Александрович — председатель садового товарищества с очень длинным названием';
    cast.entities[0].id = 'oleg_predsedatel_sadovogo_tovarishchestva';
    cast.entities[0].role = 'Главный герой, сосед, водитель и неизменный участник всех приключений возле дачных ворот';
    cast.entities[0].appearance = 'Сохранять синюю куртку, рабочие перчатки, направление вечернего света и следы предыдущей сцены. '.repeat(5);
    cast.properties.character[0].label = 'Одежда и отличительные детали внешности для непрерывности между соседними сценами';
    cast.properties.character[0].hint = 'Подробно опишите одежду, повреждения и аксессуары, которые должны сохраняться во всех последующих планах.';
  }
  if (variant === 'no-dictionary') cast.properties = {};
  if (variant === 'no-kinds') {
    cast.entities = [];
    cast.properties = {};
  }
  if (variant === 'invalid') {
    cast.properties.character[0].label = '   ';
    cast.properties.character.push({ key: 'mood', label: 'Повторяющийся код' });
  }
  return cast;
}

export interface CastStoryProps {
  variant?: CastStoryVariant;
  mode?: 'entities' | 'properties';
  collapsed?: boolean;
  failSaveOnce?: boolean;
}

/** Сохранение нормализует словарь как страница; ошибка оставляет черновик, сброс восстанавливает исходный снимок. */
export function CastStory({ variant = 'regular', mode = 'entities', collapsed = false, failSaveOnce = false }: CastStoryProps): ReactElement {
  const [saved, setSaved] = useState(() => castStoryFixture(variant === 'invalid' ? 'regular' : variant));
  const [draft, setDraft] = useState(() => castStoryFixture(variant));
  const [expanded, setExpanded] = useState<string | null>(() =>
    collapsed ? null : variant === 'world' ? 'world' : (castStoryFixture(variant).entities[0]?.id ?? null)
  );
  const [notice, setNotice] = useState<{ error?: boolean; text: string } | null>(null);
  const [epoch, setEpoch] = useState(0);
  const failed = useRef(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const kinds = variant === 'no-kinds' ? [] : castStoryKinds;
  const problem = dictionaryProblem(draft.properties, (kind) => kinds.find((item) => item.id === kind)?.label ?? kind);
  const update = (id: string, patch: Partial<CastEntity>): void => {
    setDraft((current) => ({ ...current, entities: current.entities.map((entity) => (entity.id === id ? { ...entity, ...patch } : entity)) }));
    setNotice(null);
  };
  return (
    <Stack spacing={2} sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">
        Локальная модель кастинга. Измените сведения, привязки или словарь и сохраните черновик. Реальные файлы и сервисы не используются.
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
        <Chip variant="outlined" color={dirty ? 'warning' : 'success'} label={dirty ? commonTexts.unsavedChanges : 'Изменения сохранены'} />
        <ActionButton
          variant="contained"
          startIcon={<SaveIcon />}
          disabled={!dirty || Boolean(problem)}
          disabledReason={!dirty ? commonTexts.noChangesToSave : problem}
          onClick={() => {
            if (!dirty || problem) return;
            if (failSaveOnce && !failed.current) {
              failed.current = true;
              setNotice({ error: true, text: 'Не удалось сохранить кастинг. Черновик сохранён в форме; повторите сохранение.' });
              return;
            }
            // Сохранение обрезает поля как страница с главным процессом, сохраняя свободные свойства состояния.
            const next: CastFile = {
              ...structuredClone(draft),
              entities: draft.entities.map((entity) => ({
                ...entity,
                id: entity.id.trim(),
                kind: entity.kind.trim(),
                name: entity.name.trim(),
                short_name: entity.short_name.trim() || entity.name.trim(),
                role: entity.role.trim(),
                appearance: entity.appearance.trim(),
                initial_state: Object.fromEntries(
                  Object.entries(entity.initial_state)
                    .filter(([, value]) => value.trim())
                    .map(([key, value]) => [key, value.trim()])
                )
              })),
              properties: cleanProperties(draft.properties)
            };
            const invalid = next.entities.find((entity) => !/^[a-z][a-z0-9_]*$/.test(entity.id) || !entity.name);
            if (invalid) {
              setNotice({
                error: true,
                text: !invalid.name ? castTexts.main.entityNameMissing({ id: invalid.id }) : castTexts.main.entityCodeInvalid({ label: invalid.name })
              });
              return;
            }
            setSaved(structuredClone(next));
            setDraft(next);
            setNotice({ text: 'Кастинг сохранён в локальную модель.' });
          }}
        >
          {commonTexts.save}
        </ActionButton>
        <ActionButton
          onClick={() => {
            const initial = castStoryFixture(variant);
            setSaved(castStoryFixture(variant === 'invalid' ? 'regular' : variant));
            setDraft(initial);
            setExpanded(collapsed ? null : variant === 'world' ? 'world' : (initial.entities[0]?.id ?? null));
            setNotice(null);
            failed.current = false;
            // Перемонтирование очищает раскрытые строки, новую форму, подтверждения и внутренние поля состояния.
            setEpoch((current) => current + 1);
          }}
        >
          Сбросить модель
        </ActionButton>
      </Stack>
      {notice && <Alert severity={notice.error ? 'error' : 'success'}>{notice.text}</Alert>}
      {mode === 'properties' ? (
        <>
          <CastPropertiesEditor
            key={epoch}
            kinds={kinds}
            entities={draft.entities}
            properties={draft.properties}
            savedProperties={saved.properties}
            problem={problem}
            onChange={(properties) => {
              setDraft((current) => ({ ...current, properties }));
              setNotice(null);
            }}
          />
          <Alert severity="info">Удаление свойства из словаря сохраняет уже записанные значения сущностей.</Alert>
          <Stack role="region" aria-label="Начальные состояния сущностей" spacing={1}>
            {draft.entities.map((entity) => (
              <Typography key={entity.id} variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {entity.name}:{' '}
                {Object.entries(entity.initial_state)
                  .map(([key, value]) => `${key} = ${value}`)
                  .join('; ')}
              </Typography>
            ))}
          </Stack>
        </>
      ) : (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 1 }}>
          {draft.entities.map((entity) => (
            <CastEntityCard
              key={`${epoch}:${entity.id}`}
              entity={entity}
              entities={draft.entities}
              kinds={kinds}
              properties={draft.properties[entity.kind] ?? []}
              imagePaths={imagePaths}
              imageOptions={imageOptions}
              expanded={expanded === entity.id}
              onExpandedChange={(open) => setExpanded(open ? entity.id : null)}
              onUpdate={(patch) => update(entity.id, patch)}
              onRename={(id) => {
                if (draft.entities.some((other) => other !== entity && other.id === id)) {
                  setNotice({ error: true, text: castTexts.entityCodeTaken });
                  return;
                }
                update(entity.id, { id });
                setExpanded(id);
              }}
              onRemove={() => {
                setDraft((current) => ({ ...current, entities: current.entities.filter((item) => item.id !== entity.id) }));
                setNotice(null);
              }}
              generationDisabledReason={dirty ? castTexts.imageGenerationSaveFirst : null}
              onGenerate={() => {
                // Доступность повторно проверяется обработчиком; сохранение и открытие генерации остаются разными шагами.
                if (dirty) return;
                setNotice({ text: `Запрошено открытие диалога для «${entity.name || entity.id}». Генерация не запускалась.` });
              }}
            />
          ))}
        </Box>
      )}
    </Stack>
  );
}
