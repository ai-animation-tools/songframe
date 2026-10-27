import { useEffect, useState } from 'react';
import { joinPath } from '../../format';
import { slugify } from './helpers';

export interface NewProjectValues {
  name: string;
  path: string;
  video: string;
}

/** Проверка относится к точному набору полей; отменённые ответы не разрешают создание проекта. */
export function useNewProjectForm(describeError: (error: unknown) => string) {
  const [values, setValues] = useState<NewProjectValues>({ name: '', path: '', video: '' });
  const [problems, setProblems] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [validated, setValidated] = useState<string | null>(null);
  const { name, path, video } = values;
  const validationKey = JSON.stringify([name, path, video]);

  useEffect(() => {
    if (!touched) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      window.api.projects
        .validateNew({ name, path, animaticVideo: video || undefined })
        .then((next) => {
          if (!cancelled) {
            setProblems(next);
            setValidated(validationKey);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setProblems([describeError(error)]);
            setValidated(validationKey);
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [name, path, video, touched, validationKey, describeError]);

  const changeField = (field: keyof NewProjectValues, value: string): void => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setTouched(true);
  };

  const pickParent = async (): Promise<void> => {
    const parent = await window.api.dialog.pickFolder({ title: 'Где создать папку проекта' });
    if (!parent) return;
    changeField('path', joinPath(parent, slugify(name) || 'new-clip'));
  };

  const ready = Boolean(touched && validated === validationKey && problems.length === 0 && name.trim() && path.trim());

  return { values, changeField, pickParent, problems, touched, ready };
}
