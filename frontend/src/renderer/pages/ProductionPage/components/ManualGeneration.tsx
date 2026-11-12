import { productionTexts } from '@shared/texts/production';
import { commonTexts } from '@shared/texts/common';
/**
 * Ручная генерация: речевой план у провайдера без липсинка или попытка со способом «Вручную вне приложения». Приложение
 * без агента собирает пакет (утверждённые опоры, у речевого плана срез речи, видеопромпт), показывает его и инструкцию —
 * пошаговую провайдера из реестра для речевого плана или общую для выбранного способа, а созданное вне приложения видео
 * загружается в попытку с источником и необязательными стоимостью и примечанием. У попытки своего видео пакета нет: шаг
 * только принимает видео, если первая загрузка не состоялась. Файлы и проверки — у Go.
 */
import { Fragment, type ReactElement, type ReactNode } from 'react';
import { Button, Stack, Typography } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import { mediaProviderInfo } from '@shared/media-providers';
import type { ProductionWorkflowView } from '@shared/production-workflow';
import type { ManualGeneration as ManualGenerationRecord, ManualVideo, PackageView } from '@shared/types';
import { ActionButton } from '../../../components/ActionButton';
import { formatDateTime } from '../../../format';
import { useApp } from '../../../state';
import { BUSY_REASON } from '../constants';
import { PackageTextSection } from './PackageTextSection';
import { SpeechSlice } from './ProductionSpeechPanel';
import { ExternalLink } from '../../../components/ExternalLink';
import { ManualVideoForm } from './ManualVideoForm';

const texts = productionTexts.manualGeneration;

/** Имя файла без папок: пакет показывает файлы так, как их видит пользователь в «Открыть папку». */
const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** Шаг инструкции провайдера: {url} становится внешней ссылкой, {image} и {audio} — именами файлов пакета. */
function instructionStep(step: string, url: string, files: { image: string; audio: string }): ReactNode {
  return step.split(/(\{url\}|\{image\}|\{audio\})/).map((part, index) =>
    part === '{url}' ? (
      <ExternalLink key={index} href={url}>
        {url}
      </ExternalLink>
    ) : part === '{image}' ? (
      <Fragment key={index}>{files.image}</Fragment>
    ) : part === '{audio}' ? (
      <Fragment key={index}>{files.audio}</Fragment>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    )
  );
}

/** Строка сведений загруженного видео: источник, стоимость, время и исходное имя файла. */
export function manualGenerationLine(record: ManualGenerationRecord): string {
  const cost = record.cost ? texts.costValue(record.cost) : null;
  return texts.record({ source: record.source, cost, at: formatDateTime(record.attached_at), name: record.original_name });
}

/** Сведения загруженного видео ручной генерации на шаге результата. */
export function ManualGenerationInfo({ record }: { record: ManualGenerationRecord }): ReactElement {
  return (
    <Stack spacing={0.5}>
      <Typography variant="body2">{manualGenerationLine(record)}</Typography>
      {record.description ? (
        <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>
          {record.description}
        </Typography>
      ) : null}
    </Stack>
  );
}

export function ManualGeneration({
  pkg,
  view,
  busy,
  busyReason = BUSY_REASON,
  onBuild,
  onAttach
}: {
  pkg: PackageView;
  view: ProductionWorkflowView | null;
  busy: boolean;
  busyReason?: string;
  onBuild(): void;
  onAttach(video: ManualVideo): void;
}): ReactElement {
  const { notify, describeError } = useApp();
  const request = pkg.request?.mode === 'manual' ? pkg.request : null;
  const provider = mediaProviderInfo(view?.videoProvider ?? request?.provider, 'video');
  // Инструкция провайдера описывает липсинк по одной опоре и звуку: она относится только к речевому плану без липсинка.
  const instruction = view?.singleFrame ? (provider?.manualLipSync ?? null) : null;
  const chosen = view?.generationMethod === 'manual';

  // Попытка своего видео без пакета: если загрузка не состоялась, видео загружается здесь же.
  if (request?.ownVideo) {
    return request.attemptStatus === 'manual_pending' ? (
      <Stack spacing={1.5}>
        <Typography variant="body2" color="text.secondary">
          {texts.ownVideoPending}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {productionTexts.ownVideo.format}
        </Typography>
        <ManualVideoForm busy={busy} busyReason={busyReason} sourceHint={productionTexts.ownVideo.sourceHint} onSubmit={onAttach} />
      </Stack>
    ) : (
      <Typography variant="body2">{productionTexts.planPath.manualSummary}</Typography>
    );
  }

  if (!request) {
    const reason = busy ? busyReason : view ? (view.reasons.manual ?? null) : productionTexts.productionWorkflowPanel.loadingReason;
    return (
      <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
        <Typography variant="body2" color="text.secondary">
          {chosen ? texts.descriptionChosen : texts.description}
        </Typography>
        {pkg.speech ? <SpeechSlice speech={pkg.speech} /> : null}
        <ActionButton
          variant="contained"
          startIcon={<Inventory2OutlinedIcon />}
          title={chosen ? texts.buildHintChosen : texts.buildHint}
          disabled={busy || !view?.canBuildManual}
          disabledReason={reason}
          onClick={onBuild}
        >
          {texts.build}
        </ActionButton>
      </Stack>
    );
  }

  const images = request.inputs.filter((input) => input.slot === 'image');
  const image = images[0];
  const audio = request.inputs.find((input) => input.slot === 'audio');
  const files = { image: fileName(image?.path ?? ''), audio: fileName(audio?.path ?? '') };
  const speech = pkg.speech;
  const pending = request.attemptStatus === 'manual_pending';

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(request.promptText ?? '');
      notify(commonTexts.copied, 'success');
    } catch (error) {
      notify(describeError(error), 'error');
    }
  };

  return (
    <Stack spacing={1.5}>
      <Stack spacing={0.5}>
        <Typography variant="body2">{texts.built}</Typography>
        <Stack component="ul" spacing={0.25} sx={{ m: 0, pl: 2.5 }}>
          {images.map((input) => (
            <Typography component="li" variant="body2" key={input.path}>
              {texts.input({ role: input.role ?? '', name: fileName(input.path) })}
            </Typography>
          ))}
          {audio ? (
            <Typography component="li" variant="body2">
              {speech
                ? texts.speechInput({
                    role: audio.role ?? '',
                    name: files.audio,
                    seconds: productionTexts.productionSpeechPanel.seconds(speech.end - speech.start)
                  })
                : texts.input({ role: audio.role ?? '', name: files.audio })}
            </Typography>
          ) : null}
          <Typography component="li" variant="body2">
            {texts.promptInput}
          </Typography>
        </Stack>
      </Stack>
      {speech ? <SpeechSlice speech={speech} /> : null}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button startIcon={<FolderOpenIcon />} onClick={() => void window.api.shell.openPath(request.dir)}>
          {texts.openFolder}
        </Button>
        <Button startIcon={<ContentCopyIcon />} title={texts.copyHint} onClick={() => void copy()}>
          {texts.copy}
        </Button>
      </Stack>
      {request.promptText ? <PackageTextSection title={texts.prompt} text={request.promptText} maxHeight={220} /> : null}
      {!instruction ? (
        <Stack spacing={0.5}>
          <Typography variant="subtitle2">{texts.genericInstruction}</Typography>
          <Stack component="ol" spacing={0.25} sx={{ m: 0, pl: 2.5 }}>
            {texts.genericSteps.map((step) => (
              <Typography component="li" variant="body2" key={step}>
                {step}
              </Typography>
            ))}
          </Stack>
        </Stack>
      ) : null}
      {instruction && provider ? (
        <Stack spacing={0.5}>
          <Typography variant="subtitle2">{texts.instruction({ provider: provider.title })}</Typography>
          <Stack component="ol" spacing={0.25} sx={{ m: 0, pl: 2.5 }}>
            {instruction.steps.map((step) => (
              <Typography component="li" variant="body2" key={step}>
                {instructionStep(step, instruction.url, files)}
              </Typography>
            ))}
          </Stack>
        </Stack>
      ) : null}
      {pending ? (
        <ManualVideoForm
          busy={busy}
          busyReason={busyReason}
          sourceHint={texts.sourceHint({ example: instruction?.sourceExample ?? null })}
          onSubmit={onAttach}
        />
      ) : null}
    </Stack>
  );
}
