import { useLayoutEffect, useRef, useState } from 'react';
import type { AffineStatus } from '../shared/contracts';
import { Empty } from './ui';

export function AffinePane({ active }: { active: boolean }) {
  const slot = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<AffineStatus>('loading');
  const [browserError, setBrowserError] = useState(false);

  useLayoutEffect(() => {
    const element = slot.current;
    if (!active || !element) return;
    let disposed = false;
    let frame = 0;
    const stop = window.workspace.onAffineStatus(setStatus);
    function updateBounds() {
      if (!element) return;
      const { x, y, width, height } = element.getBoundingClientRect();
      void window.workspace.setAffineBounds({
        x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height),
      }).then((current) => { if (!disposed) setStatus(current); },
        () => { if (!disposed) setStatus('error'); });
    }
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateBounds);
    });
    observer.observe(element);
    updateBounds();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      stop();
      void window.workspace.setAffineBounds(null).catch(() => {});
    };
  }, [active]);

  function retry() {
    setBrowserError(false);
    setStatus('loading');
    void window.workspace.reloadAffine().catch(() => setStatus('error'));
  }

  return <section className="affine-pane" ref={slot} aria-label="AFFiNE 工作区" data-status={status}>
    {status === 'loading' && <Empty icon="space" title="正在打开 AFFiNE…">
      <button className="button" onClick={retry}>重新加载</button>
    </Empty>}
    {(status === 'error' || status === 'timeout') && <Empty icon="space"
      title={status === 'timeout' ? 'AFFiNE 加载超时' : '无法连接 AFFiNE'}>
      <div className="actions">
        <button className="button primary" onClick={retry}>重新加载</button>
        <button className="button" onClick={() => {
          setBrowserError(false);
          void window.workspace.openAffineInBrowser().catch(() => setBrowserError(true));
        }}>在浏览器打开</button>
      </div>
      {browserError && <p className="inline-error" role="alert">无法启动默认浏览器。</p>}
    </Empty>}
  </section>;
}
