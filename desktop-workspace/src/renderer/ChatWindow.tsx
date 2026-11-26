import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage } from '../shared/contracts';
import { Empty, errorMessage, Icon, Modal, Notice, useNotice } from './ui';

export function ChatWindow() {
  const [config, setConfig] = useState({ model: 'deepseek-flash', keyConfigured: false });
  const [settings, setSettings] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const feed = useRef<HTMLDivElement>(null);
  const notice = useNotice();
  useEffect(() => { void window.workspace.chatSettings().then(setConfig, notice.failure); }, []);
  useEffect(() => { feed.current?.scrollTo({ top: feed.current.scrollHeight }); }, [messages, busy]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    if (!config.keyConfigured) { setSettings(true); return; }
    const conversation: ChatMessage[] = [...messages, { role: 'user', content }];
    setMessages(conversation);
    setDraft('');
    setBusy(true);
    try {
      const reply = await window.workspace.sendChat(conversation.slice(-61));
      setMessages([...conversation, { role: 'assistant', content: reply }]);
    } catch (failure) {
      setMessages(messages);
      setDraft(content);
      notice.failure(failure);
    } finally { setBusy(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const key = String(data.get('key') ?? '').trim();
    const model = String(data.get('model') ?? '').trim();
    setSaving(true);
    setFormError('');
    try {
      await window.workspace.saveChatSettings(model, key || undefined);
      setConfig(await window.workspace.chatSettings());
      setSettings(false);
    } catch (error) { setFormError(errorMessage(error)); }
    finally { setSaving(false); }
  }

  return <section className="chat-shell" aria-label="AI 聊天">
    <header className="document-header"><h1 className="sr-only">AI 聊天</h1><span className="chat-model">{config.model}</span>
      <div className="actions"><button className="button compact" onClick={() => { setFormError(''); setSettings(true); }}><Icon name="settings" size={16} />模型设置</button></div></header>
    <div ref={feed} className="chat-feed">
      {!messages.length && <Empty icon="chat" title={config.keyConfigured ? '输入消息开始聊天' : '设置 API 密钥后开始聊天'}>
        {!config.keyConfigured && <button className="button" onClick={() => setSettings(true)}>设置 API 密钥</button>}
      </Empty>}
      {messages.map((message, index) => <article key={index} className={'bubble ' + message.role}>
        <strong>{message.role === 'user' ? '你' : 'DeepSeek'}</strong><p>{message.content}</p>
      </article>)}
      {busy && <p className="muted">正在等待回复…</p>}
    </div>
    <form className="chat-form" onSubmit={(event) => void submit(event)}>
      <textarea placeholder="输入或粘贴消息" aria-label="聊天消息" rows={3} maxLength={60_000} value={draft} disabled={busy}
        onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} />
      <button className="button primary" disabled={busy || !draft.trim()}><Icon name="send" size={16} />发送</button>
    </form>
    {settings && <Modal title="模型设置" close={() => { if (!saving) setSettings(false); }}>
      <form className="form-stack" onSubmit={(event) => void save(event)}>
        <label>模型名称<input name="model" defaultValue={config.model} maxLength={100} required /></label>
        <label>DeepSeek API 密钥<input name="key" type="password" autoFocus maxLength={500} required={!config.keyConfigured}
          placeholder={config.keyConfigured ? '已配置，留空保留原密钥' : '输入 API 密钥'} /></label>
        {formError && <p className="inline-error" role="alert">{formError}</p>}
        <footer className="form-actions"><button type="button" className="button" disabled={saving} onClick={() => setSettings(false)}>取消</button>
          <button className="button primary" disabled={saving}>保存</button></footer>
      </form>
    </Modal>}
    <Notice message={notice.message} clear={notice.clear} />
  </section>;
}
