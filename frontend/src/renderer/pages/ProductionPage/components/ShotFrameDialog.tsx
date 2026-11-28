import { productionTexts } from '@shared/texts/production';
import { commonTexts } from '@shared/texts/common';
/**
 * «Взять кадр» у опоры: окно выбора кадра принятого плана клипа — план из списка принятых, превью кадра, номер
 * кадра и быстрые «Первый» и «Последний». «Сохранить» вырезает кадр из принятого участка без эффектов
 * (production.takeFrame, PNG полного размера в папке загрузок под именем проекта, как «Взять текущий кадр») и
 * отдаёт путь владельцу: тот ставит файл кандидатом опоры тем же путём, что «Свой файл». Номер кадра — в сетке
 * принятого участка (video.mp4 комплекта): первый кадр следующего плана совпадает с последним кадром монтажа.
 */
import { useEffect, useState, type ReactElement } from 'react';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography } from '@mui/material';
import type { ShotProduction } from '@shared/types';
import { useApp } from '../../../state';
import { ActionButton } from '../../../components/ActionButton';
import { NumberField } from '../../../components/NumberField';

const texts = productionTexts.shotFrame;

/** Откуда брать кадры: проект, его принятые планы с видео и план, выбранный в окне по умолчанию. */
export interface ShotFrameSource {
  project: string;
  /** Принятые планы с видео и сведениями участка (asset.video и asset.edit), кроме текущего. */
  shots: ShotProduction[];
  /** Предшественник текущего плана среди принятых; null — первый из списка. */
  defaultShot: string | null;
}

/** Принятые планы клипа, из которых можно взять кадр, и предшественник плана shot в порядке клипа. */
export function shotFrameSource(project: string, shots: readonly ShotProduction[], shot: string): ShotFrameSource {
  const accepted = shots.filter((item) => item.id !== shot && item.asset?.video && item.asset.edit && item.asset.edit.frames > 0);
  const index = shots.findIndex((item) => item.id === shot);
  const before = index < 0 ? [] : shots.slice(0, index).filter((item) => accepted.includes(item));
  return { project, shots: accepted, defaultShot: before.at(-1)?.id ?? null };
}

/**
 * Кнопка «Взять кадр» с окном. onPicked получает путь сохранённого кадра; false — кадр не поставлен, окно
 * остаётся открытым. Без принятых планов кнопка недоступна с причиной.
 */
export function ShotFrameButton({
  frame,
  source,
  disabled,
  disabledReason,
  onPicked
}: {
  frame: string;
  source: ShotFrameSource;
  disabled: boolean;
  disabledReason: string | null;
  onPicked(path: string): Promise<boolean | void>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const empty = source.shots.length === 0;
  return (
    <>
      <ActionButton
        size="small"
        startIcon={<PhotoCameraIcon />}
        sx={{ mt: 0.5 }}
        title={texts.openHint({ id: frame })}
        disabled={disabled || empty}
        disabledReason={disabled ? disabledReason : texts.noShots}
        onClick={() => setOpen(true)}
      >
        {texts.open}
      </ActionButton>
      {open ? <ShotFrameDialog frame={frame} source={source} onPicked={onPicked} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function ShotFrameDialog({
  frame,
  source,
  onPicked,
  onClose
}: {
  frame: string;
  source: ShotFrameSource;
  onPicked(path: string): Promise<boolean | void>;
  onClose(): void;
}): ReactElement {
  const { describeError } = useApp();
  const [shotId, setShotId] = useState(source.defaultShot ?? source.shots[0]?.id ?? '');
  const shot = source.shots.find((item) => item.id === shotId) ?? null;
  const edit = shot?.asset?.edit ?? null;
  const last = edit ? edit.frames - 1 : 0;
  // По умолчанию — последний кадр: непрерывный стык продолжает конец принятого участка.
  const [number, setNumber] = useState(last);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const fps = edit?.fps ?? 0;

  // Превью — середина интервала кадра: на границе WebView может показать соседний кадр.
  useEffect(() => {
    if (!video || !fps) return;
    const seek = (): void => {
      video.currentTime = (number + 0.5) / fps;
    };
    if (video.readyState >= 1) seek();
    video.addEventListener('loadedmetadata', seek);
    return () => video.removeEventListener('loadedmetadata', seek);
  }, [video, number, fps, shotId]);

  const chooseShot = (id: string): void => {
    const next = source.shots.find((item) => item.id === id);
    setShotId(id);
    setNumber(next?.asset?.edit ? next.asset.edit.frames - 1 : 0);
    setError(null);
  };
  const save = async (): Promise<void> => {
    if (!shot) return;
    setSaving(true);
    setError(null);
    try {
      const taken = await window.api.production.takeFrame(source.project, shot.id, number);
      if ((await onPicked(taken.path)) !== false) onClose();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setSaving(false);
    }
  };
  const titleId = `shot-frame-${frame}`;
  const seconds = fps ? (number / fps).toFixed(2).replace('.', ',') : '0';
  // Выбор плана и кадра — черновик: Escape и клик по фону окно не закрывают, только «Отмена».
  return (
    <Dialog open fullWidth maxWidth="md" aria-labelledby={titleId}>
      <DialogTitle id={titleId}>{texts.title({ id: frame })}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            {texts.intro({ id: frame })}
          </Typography>
          <TextField select label={texts.shot} value={shotId} disabled={saving} onChange={(event) => chooseShot(event.target.value)} sx={{ maxWidth: 420 }}>
            {source.shots.map((item) => (
              <MenuItem key={item.id} value={item.id}>
                {texts.shotOption({ id: item.id, title: item.title })}
              </MenuItem>
            ))}
          </TextField>
          {shot?.asset?.video ? (
            <Box sx={{ maxWidth: 640 }}>
              <video
                key={shot.id}
                ref={setVideo}
                src={window.api.shell.fileUrl(shot.asset.video)}
                muted
                playsInline
                preload="auto"
                aria-label={texts.preview({ shot: shot.id })}
                style={{ width: '100%', display: 'block', borderRadius: 8, background: '#000' }}
              />
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                {texts.position({ frame: number, seconds })}
              </Typography>
            </Box>
          ) : null}
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <NumberField
              label={texts.frame}
              value={number}
              min={0}
              max={last}
              step={1}
              disabled={saving || !edit}
              helperText={texts.frameRange({ last })}
              onChange={(value) => value !== undefined && Number.isInteger(value) && setNumber(value)}
              sx={{ width: 180 }}
            />
            <Button size="small" disabled={saving || !edit} onClick={() => setNumber(0)}>
              {texts.first}
            </Button>
            <Button size="small" disabled={saving || !edit} onClick={() => setNumber(last)}>
              {texts.last}
            </Button>
          </Stack>
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button startIcon={<CancelOutlinedIcon />} disabled={saving} onClick={onClose}>
          {commonTexts.cancel}
        </Button>
        <ActionButton variant="contained" disabled={saving || !shot} disabledReason={saving ? texts.saving : null} onClick={() => void save()}>
          {commonTexts.save}
        </ActionButton>
      </DialogActions>
    </Dialog>
  );
}
