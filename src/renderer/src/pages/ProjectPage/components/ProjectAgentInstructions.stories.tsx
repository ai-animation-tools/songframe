/** Управляемая форма повторяет ключ и сброс редактора из ProjectSettingsCard, сохраняя данные только в памяти. */
import { useEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Alert, Box, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import type { AgentProvider } from '@shared/agent-providers';
import { projectTexts } from '@shared/texts/project';
import { commonTexts } from '@shared/texts/common';
import { INSTRUCTION_STORY_LONG_TEXT, INSTRUCTION_STORY_TEXT } from '../../../testing/imageStories';
import { ActionButton } from '../../../components/ActionButton';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { ProjectAgentInstructions } from './ProjectAgentInstructions';

interface InstructionStoryProps {
  initialAgent?: AgentProvider | null;
  longText?: boolean;
  saveDelay?: number;
}

function InstructionStory({ initialAgent = 'codex', longText = false, saveDelay = 700 }: InstructionStoryProps) {
  const initialText = longText ? INSTRUCTION_STORY_LONG_TEXT : INSTRUCTION_STORY_TEXT;
  const [project, setProject] = useState('Клип у старых ворот');
  const [agentProvider, setAgentProvider] = useState<AgentProvider | null>(initialAgent);
  const [saved, setSaved] = useState(initialText);
  const [value, setValue] = useState(initialText);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedProjects = useRef(new Map([[project, initialText]]));
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const dirty = value !== saved;
  const reason = busy ? projectTexts.settings.waitSaving : !dirty ? commonTexts.noChangesToSave : null;
  const save = (): void => {
    if (busy || !dirty) return;
    setBusy(true);
    setNotice(false);
    timer.current = setTimeout(() => {
      savedProjects.current.set(project, value);
      setSaved(value);
      setRevision((current) => current + 1);
      setBusy(false);
      setNotice(true);
    }, saveDelay);
  };
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">{project}</Typography>
        <TextField
          select
          label="Текстовый агент"
          value={agentProvider ?? ''}
          disabled={busy}
          onChange={(event) => {
            const provider = event.target.value;
            setAgentProvider(provider === 'codex' || provider === 'claude' ? provider : null);
          }}
          sx={{ maxWidth: 320 }}
        >
          <MenuItem value="">Не выбран</MenuItem>
          <MenuItem value="codex">Codex</MenuItem>
          <MenuItem value="claude">Claude Code</MenuItem>
        </TextField>
        {/* Тот же состав ключа закрывает разрешение редактировать после сохранения, сброса или смены контекста. */}
        <ProjectAgentInstructions
          key={`instructions:${project}:${agentProvider}:${revision}`}
          value={value}
          agentProvider={agentProvider}
          busy={busy}
          onChange={(next) => {
            setValue(next);
            setNotice(false);
          }}
        />
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          <ActionButton variant="contained" startIcon={<SaveIcon />} disabled={!!reason} disabledReason={reason} onClick={save}>
            {commonTexts.save}
          </ActionButton>
          <DestructiveButton
            startIcon={<RestartAltIcon />}
            label={projectTexts.settings.resetTitle}
            description={projectTexts.settings.resetDescription}
            confirmLabel={commonTexts.resetChanges}
            disabled={busy || !dirty}
            disabledReason={busy ? projectTexts.settings.waitSaving : projectTexts.settings.noUnsavedChanges}
            onConfirm={() => {
              setValue(saved);
              setRevision((current) => current + 1);
              setNotice(false);
            }}
          >
            {commonTexts.resetChanges}
          </DestructiveButton>
          <ActionButton
            startIcon={<SwapHorizIcon />}
            disabled={busy}
            disabledReason={projectTexts.settings.waitSaving}
            onClick={() => {
              const nextProject = project === 'Клип у старых ворот' ? 'Другой клип' : 'Клип у старых ворот';
              const nextValue = savedProjects.current.get(nextProject) ?? 'Следуй музыкальному ритму другого проекта.\nСохраняй его собственных персонажей.';
              setProject(nextProject);
              setSaved(nextValue);
              setValue(nextValue);
              setNotice(false);
            }}
          >
            Сменить проект
          </ActionButton>
        </Box>
        {busy && (
          <Alert severity="info" role="status">
            Сохраняем настройки в локальную модель истории…
          </Alert>
        )}
        {notice && <Alert severity="success">Настройки сохранены в памяти истории. Редактор снова заблокирован.</Alert>}
      </Stack>
    </Paper>
  );
}

const meta = {
  title: 'Страницы/Проект/Постоянные инструкции агенту',
  component: InstructionStory,
  // Взаимодействия с фокусом проверяются в отдельном Canvas без массового play в Docs.
  tags: ['!autodocs'],
  args: { initialAgent: 'codex', longText: false, saveDelay: 700 },
  render: (args) => <InstructionStory key={`${args.initialAgent}:${args.longText}:${args.saveDelay}`} {...args} />
} satisfies Meta<typeof InstructionStory>;
export default meta;
type Story = StoryObj<typeof meta>;
type PlayContext = Parameters<NonNullable<Story['play']>>[0];

async function requestUnlock({ canvasElement }: PlayContext): Promise<void> {
  await userEvent.click(within(canvasElement).getByRole('button', { name: projectTexts.agentInstructions.unlock }));
  const screen = within(canvasElement.ownerDocument.body);
  const warning = await screen.findByText('Изменяйте содержимое этого поля только если точно понимаете что делаете.');
  // В Docs iframe может быть скрыт вне прокрутки; видимость проверяется отдельно от точного текста.
  await expect(warning).toBeInTheDocument();
}

async function unlock(context: PlayContext): Promise<void> {
  await requestUnlock(context);
  const screen = within(context.canvasElement.ownerDocument.body);
  const dialog = screen.getByRole('dialog', { name: projectTexts.agentInstructions.unlockTitle });
  await userEvent.click(within(dialog).getByRole('button', { name: projectTexts.agentInstructions.unlock }));
  // Пока подтверждение закрывается, MUI ещё скрывает форму от accessibility tree.
  await within(context.canvasElement).findByRole('textbox', { name: projectTexts.agentInstructions.title });
}

export const NoAgent: Story = { name: 'Без выбранного агента', args: { initialAgent: null } };
export const Locked: Story = { name: 'Выбранный агент — изначальная блокировка' };
export const LockedFocused: Story = {
  name: 'Заблокированное поле в фокусе · чтение без изменения',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('textbox', { name: projectTexts.agentInstructions.title });
    await userEvent.click(input);
    await userEvent.type(input, 'Этот текст не должен добавиться.');
    await expect(input).toHaveFocus();
    await expect(input).toHaveAttribute('readonly');
    // DOM textarea нормализует CRLF; это не меняет сохранённый текст проекта.
    await expect(input).toHaveValue(INSTRUCTION_STORY_TEXT.replace(/\r\n?/g, '\n'));
    await expect(canvas.getByText('Поле заблокировано. Для редактирования нажмите «Разблокировать».')).toBeInTheDocument();
  }
};
export const ExactWarning: Story = { name: 'Точное предупреждение — отмена в фокусе', play: requestUnlock };
export const CancelUnlock: Story = {
  tags: ['ci'],
  name: 'Отмена оставляет поле заблокированным',
  play: async (context) => {
    await requestUnlock(context);
    const screen = within(context.canvasElement.ownerDocument.body);
    const dialog = screen.getByRole('dialog', { name: projectTexts.agentInstructions.unlockTitle });
    await userEvent.click(within(dialog).getByRole('button', { name: commonTexts.cancel }));
    await expect(await within(context.canvasElement).findByRole('textbox', { name: projectTexts.agentInstructions.title })).toHaveAttribute('readonly');
  }
};
export const Editing: Story = {
  tags: ['ci'],
  name: 'Подтверждение — правка, сохранение и сброс',
  play: async (context) => {
    await unlock(context);
    const input = within(context.canvasElement).getByRole('textbox', { name: projectTexts.agentInstructions.title });
    await userEvent.type(input, '\nНе меняй утверждённую одежду героя.');
    await expect(input).not.toHaveAttribute('readonly');
  }
};
export const LongInstructions: Story = { name: 'Длинные инструкции с переносами', args: { longText: true }, play: unlock };
export const Saving: Story = {
  name: 'Запись — поле и действия ждут завершения',
  args: { saveDelay: 15000 },
  play: async (context) => {
    await unlock(context);
    const canvas = within(context.canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: projectTexts.agentInstructions.title }), '\nСохраняй настроение сцены.');
    await userEvent.click(canvas.getByRole('button', { name: commonTexts.save }));
    await expect(canvas.getByRole('status')).toBeInTheDocument();
    await expect(canvas.getByRole('textbox', { name: projectTexts.agentInstructions.title })).toHaveAttribute('readonly');
  }
};
