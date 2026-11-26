import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceDocument } from '../shared/contracts';
import { errorMessage } from './ui';

type Draft = { id: string; saved: string; revision: number; edits: number; savedEdits: number };

export function useDraft(onSaved: (item: WorkspaceDocument) => void, readEditor: () => Promise<string | undefined> | undefined) {
  const active = useRef<Draft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const currentSave = useRef<Promise<void> | null>(null);
  const savedCallback = useRef(onSaved);
  const readCallback = useRef(readEditor);
  const [status, setStatus] = useState<'saved' | 'pending' | 'saving' | 'error'>('saved');
  const [error, setError] = useState('');
  savedCallback.current = onSaved;
  readCallback.current = readEditor;

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (currentSave.current) return currentSave.current;
    const draft = active.current;
    if (!draft || draft.edits === draft.savedEdits) return Promise.resolve();
    const saving = (async () => {
      setStatus('saving');
      setError('');
      try {
        while (active.current === draft && draft.edits !== draft.savedEdits) {
          const edits = draft.edits;
          const text = await readCallback.current();
          if (text === undefined) throw new Error('编辑器未就绪，请重试保存。');
          if (edits !== draft.edits) continue;
          if (text !== draft.saved) {
            const result = await window.workspace.saveMarkdown(draft.id, text, draft.revision);
            draft.saved = text;
            draft.revision = result.revision;
            savedCallback.current(result);
          }
          draft.savedEdits = edits;
        }
        setStatus('saved');
      } catch (failure) {
        setError(errorMessage(failure));
        setStatus('error');
        throw failure;
      }
    })().finally(() => { currentSave.current = null; });
    currentSave.current = saving;
    return saving;
  }, []);

  const change = useCallback(() => {
    const draft = active.current;
    if (!draft) return;
    draft.edits++;
    setStatus('pending');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush().catch(() => {}); }, 1100);
  }, [flush]);

  const initialize = useCallback((item: WorkspaceDocument) => {
    if (item.markdown === null) return;
    active.current = { id: item.id, saved: item.markdown, revision: item.revision, edits: 0, savedEdits: 0 };
    setStatus('saved');
  }, []);

  useEffect(() => {
    const dispose = window.workspace.onFlushDocument((ticket) => {
      void flush().then(() => window.workspace.completeFlush(ticket), (error: unknown) => window.workspace.completeFlush(ticket, errorMessage(error)));
    });
    return () => { clearTimeout(timer.current); dispose(); };
  }, [flush]);

  return { initialize, change, flush, status, error, revision: () => active.current?.revision ?? 0 };
}
