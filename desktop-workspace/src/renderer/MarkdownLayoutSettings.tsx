import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { defaultMarkdownLayout, type MarkdownLayout } from '../shared/contracts';
import { errorMessage, Modal } from './ui';

export function layoutStyle(layout: MarkdownLayout): CSSProperties {
  return {
    '--md-font-size': layout.fontSize + 'px',
    '--md-line-height': layout.lineHeight,
    '--md-paragraph-gap': layout.paragraphGap + 'px',
    '--md-first-line': layout.indentParagraphs ? '2em' : '0',
  } as CSSProperties;
}

type Field = 'fontSize' | 'lineHeight' | 'paragraphGap';
const fields = [
  { name: 'fontSize', label: '正文字号', unit: 'px', min: 13, max: 22, step: 1 },
  { name: 'lineHeight', label: '行距倍数', unit: '倍', min: 1.35, max: 2.4, step: 0.05 },
  { name: 'paragraphGap', label: '段后间距', unit: 'px', min: 0, max: 28, step: 1 },
] as const;

function formValues(layout: MarkdownLayout) {
  return {
    fontSize: String(layout.fontSize), lineHeight: String(layout.lineHeight), paragraphGap: String(layout.paragraphGap),
    indentParagraphs: layout.indentParagraphs,
  };
}

function readField(field: Field, raw: string) {
  const rules = fields.find((item) => item.name === field)!;
  const value = raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= rules.min && value <= rules.max ? value : defaultMarkdownLayout[field];
}

export function MarkdownLayoutSettings({ close }: { close: () => void }) {
  const [draft, setDraft] = useState(() => formValues(defaultMarkdownLayout));
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    void window.workspace.markdownLayout().then(
      (layout) => { if (current) { setDraft(formValues(layout)); setReady(true); } },
      (failure) => { if (current) setError(errorMessage(failure)); },
    );
    return () => { current = false; };
  }, []);

  const preview = {
    fontSize: readField('fontSize', draft.fontSize),
    lineHeight: readField('lineHeight', draft.lineHeight),
    paragraphGap: readField('paragraphGap', draft.paragraphGap),
    indentParagraphs: draft.indentParagraphs,
  };

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      await window.workspace.saveMarkdownLayout(preview);
      close();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  return <Modal title="Markdown 排版设置" close={() => { if (!busy) close(); }}>
    <form className="form-stack" onSubmit={(event) => void save(event)}>
      <div className="layout-fields">
        {fields.map(({ name, label, unit, min, max, step }) => <label key={name}>{label}
          <span className="layout-number">
            <input type="number" aria-label={label} min={min} max={max} step={step} required
              autoFocus={name === 'fontSize'} readOnly={!ready} disabled={busy}
              value={draft[name]} onChange={(event) => setDraft((current) => ({ ...current, [name]: event.target.value }))} />
            <span aria-hidden="true">{unit}</span>
          </span>
        </label>)}
      </div>
      <label className="layout-indent"><input type="checkbox" disabled={!ready || busy} checked={draft.indentParagraphs}
        onChange={(event) => setDraft((current) => ({ ...current, indentParagraphs: event.target.checked }))} />首行缩进两个字符</label>
      <div className="layout-preview" aria-label="排版预览" style={layoutStyle(preview)}>
        <p>清晰的行距让长文更容易阅读，适当的段距也能帮助区分不同内容。</p>
        <p>这里可以预览正文设置。保存后，已打开的 Markdown 文档会同步更新。</p>
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <footer className="form-actions">
        <button type="button" className="text-button layout-default" disabled={!ready || busy}
          onClick={() => setDraft(formValues(defaultMarkdownLayout))}>恢复默认</button>
        <button type="button" className="button" disabled={busy} onClick={close}>取消</button>
        <button className="button primary" disabled={!ready || busy}>{busy ? '正在保存…' : '保存设置'}</button>
      </footer>
    </form>
  </Modal>;
}
