/** Оценка стоимости относится к одному открытому подтверждению и не переживает смену запроса. */
import { useEffect, useState } from 'react';
import type { PackageView, ProductionQuote } from '@shared/types';
import { useApp } from '../../state';
import { isExternalPackage } from './decisions';

export function useRequestQuote(project: string, pkg: PackageView | null) {
  const { describeError } = useApp();
  const [storedQuote, setQuote] = useState<{ context: string; value: ProductionQuote } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const dir = pkg?.dir;
  const sha = pkg?.request?.sha256;
  const decisionToken = pkg?.decisionToken;
  const external = !!pkg && isExternalPackage(pkg);
  const context = `${project}\0${dir ?? ''}\0${sha ?? ''}\0${decisionToken ?? ''}\0${external}`;
  const quote = storedQuote?.context === context ? storedQuote.value : null;

  useEffect(() => {
    let active = true;
    setQuote(null);
    setError(null);
    setLoading(false);
    if (!dir || !sha || external) return;
    setLoading(true);
    void window.api.production
      .quote(project, dir, sha, decisionToken)
      .then((next) => {
        if (!active) return;
        if (next.requestSha !== sha) throw new Error('Оценка относится к другому запросу. Откройте пакет заново.');
        setQuote({ context, value: next });
      })
      .catch((reason) => {
        if (active) setError(describeError(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [context, project, dir, sha, decisionToken, external, describeError, revision]);

  return {
    quote,
    error,
    loading,
    external,
    refreshQuote: () => {
      setQuote(null);
      setRevision((current) => current + 1);
    },
    consumeQuote: () => setQuote(null)
  };
}
