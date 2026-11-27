/**
 * Окно сохранённого образа референса: создать образ из сохранённых снимков, привязать готовый образ аккаунта,
 * отвязать или удалить из аккаунта (только после отдельного подтверждения). Все действия бесплатные; их
 * итог — новое состояние, которое окно сразу показывает. Закрывается только кнопкой: Escape и щелчок по фону
 * потеряли бы набранное описание.
 */
import { useMemo, useState, type ReactElement } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormLabel,
  LinearProgress,
  MenuItem,
  Radio,
  RadioGroup,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography
} from '@mui/material';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import AddPhotoAlternateOutlinedIcon from '@mui/icons-material/AddPhotoAlternateOutlined';
import LinkIcon from '@mui/icons-material/Link';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import DeleteForeverOutlinedIcon from '@mui/icons-material/DeleteForeverOutlined';
import { REFERENCE_VIEW_LABELS, type SourceReference } from '@shared/types';
import {
  defaultSavedLookKind,
  defaultSavedLookName,
  savedLookNameLength,
  type SavedLook,
  type SavedLookInput,
  type SavedLookRules,
  type SavedLookState
} from '@shared/saved-looks';
import { commonTexts } from '@shared/texts/common';
import { savedLooksTexts } from '@shared/texts/saved-looks';
import { ActionButton } from '../../../components/ActionButton';
import { DestructiveButton } from '../../../components/DestructiveButton';
import { LinkedText } from '../../../components/LinkedText';
import { SavedLookChip } from '../../../components/SavedLookChip';

export interface SavedLookDialogProps {
  /** Сохранённый референс описи: образ создаётся только из его сохранённых снимков. */
  reference: SourceReference;
  rules: SavedLookRules;
  state: SavedLookState;
  looks: SavedLook[];
  fileUrl: (path: string) => string;
  onClose: () => void;
  /** Действия возвращают текст ошибки или null. */
  onCreate: (input: SavedLookInput) => Promise<string | null>;
  onBind: (look: string) => Promise<string | null>;
  onUnbind: () => Promise<string | null>;
  onRemove: (look: string) => Promise<string | null>;
}

/** Главный снимок по умолчанию — самый полный вид: в полный рост, затем спереди, затем первый. */
function defaultCover(reference: SourceReference): string {
  return (reference.files.find((file) => file.view === 'full') ?? reference.files.find((file) => file.view === 'front') ?? reference.files[0])?.path ?? '';
}

export function SavedLookDialog({
  reference,
  rules,
  state,
  looks,
  fileUrl,
  onClose,
  onCreate,
  onBind,
  onUnbind,
  onRemove
}: SavedLookDialogProps): ReactElement {
  const bound = state.status === 'ready' || state.status === 'stale';
  const [tab, setTab] = useState<'create' | 'choose'>('create');
  const [cover, setCover] = useState(() => defaultCover(reference));
  const [extra, setExtra] = useState<string[]>(() =>
    reference.files
      .map((file) => file.path)
      .filter((path) => path !== defaultCover(reference))
      .slice(0, rules.extraMax)
  );
  const [name, setName] = useState(() => defaultSavedLookName(reference.name, rules));
  const [kind, setKind] = useState(() => defaultSavedLookKind(reference.kind, rules));
  const [description, setDescription] = useState('');
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taken = useMemo(() => new Set(looks.map((look) => look.name.trim().toLocaleLowerCase('ru'))), [looks]);
  const length = savedLookNameLength(name);
  const nameError = !name.trim()
    ? savedLooksTexts.nameRequired
    : rules.nameMaxChars > 0 && length > rules.nameMaxChars
      ? savedLooksTexts.nameLong({ max: rules.nameMaxChars })
      : taken.has(name.trim().toLocaleLowerCase('ru'))
        ? savedLooksTexts.nameTaken
        : null;
  const extraChosen = extra.filter((path) => path !== cover);
  const tooFewFiles = reference.files.length < 1 + rules.extraMin;
  const extraError = extraChosen.length < rules.extraMin || extraChosen.length > rules.extraMax;
  const createBlocked = tooFewFiles
    ? savedLooksTexts.extraNeedFiles({ min: rules.extraMin })
    : (nameError ?? (extraError ? savedLooksTexts.extraHint({ min: rules.extraMin, max: rules.extraMax }) : null));

  const act = async (action: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    setError(null);
    const problem = await action();
    setBusy(false);
    setError(problem);
  };

  const toggleExtra = (path: string, checked: boolean): void =>
    setExtra((current) => (checked ? [...current.filter((item) => item !== path), path] : current.filter((item) => item !== path)));

  const thumbnail = (path: string, view: string): ReactElement => (
    <Stack direction="row" spacing={1} alignItems="center">
      <Box
        component="img"
        src={fileUrl(path)}
        alt={savedLooksTexts.coverAlt({ view })}
        sx={{ width: 72, height: 72, objectFit: 'contain', bgcolor: 'action.hover', borderRadius: 1 }}
      />
      <Typography variant="body2">{view}</Typography>
    </Stack>
  );

  const notice =
    state.status === 'ready'
      ? savedLooksTexts.readyNotice({ name: state.name ?? '' })
      : state.status === 'stale'
        ? savedLooksTexts.staleNotice({ name: state.name ?? '' })
        : state.status === 'missing'
          ? savedLooksTexts.missingNotice({ name: state.name ?? '' })
          : null;

  return (
    <Dialog open fullWidth maxWidth="md" aria-labelledby="saved-look-title">
      <DialogTitle id="saved-look-title">{savedLooksTexts.dialogTitle({ name: reference.name })}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} inert={busy || undefined}>
          <Box>
            <SavedLookChip state={state} />
          </Box>
          {notice ? <Alert severity={state.status === 'ready' ? 'success' : state.status === 'stale' ? 'warning' : 'error'}>{notice}</Alert> : null}
          {error ? (
            <Alert severity="error">
              <LinkedText text={error} />
            </Alert>
          ) : null}
          {bound || state.status === 'missing' ? (
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Tooltip title={savedLooksTexts.unbindHint} describeChild>
                <Button variant="outlined" startIcon={<LinkOffIcon />} onClick={() => void act(onUnbind)}>
                  {savedLooksTexts.unbind}
                </Button>
              </Tooltip>
              {bound && state.look ? (
                <DestructiveButton
                  label={savedLooksTexts.remove}
                  description={savedLooksTexts.removeDescription({ name: state.name ?? state.look })}
                  descriptionSeverity="warning"
                  confirmLabel={savedLooksTexts.remove}
                  startIcon={<DeleteForeverOutlinedIcon />}
                  variant="outlined"
                  size="medium"
                  onConfirm={() => void act(() => onRemove(state.look!))}
                />
              ) : null}
            </Stack>
          ) : null}
          {!bound ? (
            <>
              <Tabs value={tab} onChange={(_event, value: 'create' | 'choose') => setTab(value)}>
                <Tab value="create" label={savedLooksTexts.tabCreate} />
                <Tab value="choose" label={savedLooksTexts.tabChoose} />
              </Tabs>
              {tab === 'create' ? (
                <Stack spacing={2}>
                  <Alert severity="info">{savedLooksTexts.advice}</Alert>
                  {tooFewFiles ? <Alert severity="warning">{savedLooksTexts.extraNeedFiles({ min: rules.extraMin })}</Alert> : null}
                  <FormControl>
                    <FormLabel id="saved-look-cover">{savedLooksTexts.cover}</FormLabel>
                    {rules.coverFixed ? (
                      <Typography variant="caption" color="text.secondary">
                        {savedLooksTexts.coverFixed}
                      </Typography>
                    ) : null}
                    <RadioGroup aria-labelledby="saved-look-cover" value={cover} onChange={(event) => setCover(event.target.value)} sx={{ mt: 1, gap: 1 }}>
                      {reference.files.map((file) => (
                        <FormControlLabel
                          key={file.path}
                          value={file.path}
                          control={<Radio />}
                          label={thumbnail(file.path, REFERENCE_VIEW_LABELS[file.view])}
                        />
                      ))}
                    </RadioGroup>
                  </FormControl>
                  <FormControl error={extraError && !tooFewFiles}>
                    <FormLabel component="legend">{savedLooksTexts.extra}</FormLabel>
                    <Typography variant="caption" color={extraError && !tooFewFiles ? 'error' : 'text.secondary'}>
                      {savedLooksTexts.extraHint({ min: rules.extraMin, max: rules.extraMax })}
                    </Typography>
                    <FormGroup sx={{ mt: 1, gap: 1 }}>
                      {reference.files
                        .filter((file) => file.path !== cover)
                        .map((file) => (
                          <FormControlLabel
                            key={file.path}
                            control={<Checkbox checked={extraChosen.includes(file.path)} onChange={(event) => toggleExtra(file.path, event.target.checked)} />}
                            label={thumbnail(file.path, REFERENCE_VIEW_LABELS[file.view])}
                          />
                        ))}
                    </FormGroup>
                  </FormControl>
                  <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 2 }}>
                    <TextField
                      label={savedLooksTexts.name}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      error={!!nameError}
                      helperText={nameError ?? savedLooksTexts.nameCount({ length, max: rules.nameMaxChars })}
                    />
                    <TextField select label={savedLooksTexts.kind} value={kind} onChange={(event) => setKind(event.target.value)}>
                      {rules.kinds.map((item) => (
                        <MenuItem key={item} value={item}>
                          {savedLooksTexts.kinds[item] ?? item}
                        </MenuItem>
                      ))}
                    </TextField>
                  </Box>
                  <TextField
                    label={savedLooksTexts.description}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    multiline
                    minRows={3}
                    maxRows={10}
                    helperText={savedLooksTexts.descriptionHint}
                  />
                  <Box>
                    <ActionButton
                      variant="contained"
                      startIcon={<AddPhotoAlternateOutlinedIcon />}
                      disabled={!!createBlocked}
                      disabledReason={createBlocked}
                      onClick={() => void act(() => onCreate({ name: name.trim(), description: description.trim(), kind, cover, extra: extraChosen }))}
                    >
                      {savedLooksTexts.create}
                    </ActionButton>
                  </Box>
                </Stack>
              ) : (
                <Stack spacing={2}>
                  {looks.length ? (
                    <FormControl>
                      <FormLabel id="saved-look-choose">{savedLooksTexts.chooseLabel}</FormLabel>
                      <RadioGroup aria-labelledby="saved-look-choose" value={chosen} onChange={(event) => setChosen(event.target.value)}>
                        {looks.map((look) => (
                          <FormControlLabel key={look.id} value={look.id} control={<Radio />} label={look.name || look.id} />
                        ))}
                      </RadioGroup>
                    </FormControl>
                  ) : (
                    <Typography color="text.secondary">{savedLooksTexts.chooseEmpty}</Typography>
                  )}
                  <Box>
                    <ActionButton
                      variant="contained"
                      startIcon={<LinkIcon />}
                      disabled={!chosen}
                      disabledReason={looks.length ? savedLooksTexts.chooseLabel : savedLooksTexts.chooseEmpty}
                      onClick={() => void act(() => onBind(chosen))}
                    >
                      {savedLooksTexts.bind}
                    </ActionButton>
                  </Box>
                </Stack>
              )}
            </>
          ) : null}
        </Stack>
      </DialogContent>
      {busy ? <LinearProgress aria-label={savedLooksTexts.working} /> : null}
      <DialogActions sx={{ justifyContent: 'flex-start' }}>
        <Button startIcon={<CancelOutlinedIcon />} onClick={onClose} disabled={busy}>
          {commonTexts.close}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
