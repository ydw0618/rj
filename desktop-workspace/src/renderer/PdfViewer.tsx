import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type PDFPageProxy, type PageViewport } from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type PointerEvent, type Ref } from 'react';
import type { Anchor, Annotation, Rect } from '../shared/contracts';
import { Icon } from './ui';

GlobalWorkerOptions.workerSrc = worker;
export type PdfAnchor = Extract<Anchor, { type: 'pdf' }>;
export type PdfHandle = { goto(anchor: PdfAnchor): void };
type Geometry = { page: PDFPageProxy; viewport: PageViewport };

const clamp = (value: number) => Math.max(0, Math.min(1, value));
function toAnchor(geometry: Geometry, page: number, rect: Rect, quote?: string): PdfAnchor {
  const [x0, y0, x1, y1] = geometry.page.view;
  const a = geometry.viewport.convertToPdfPoint(rect.x, rect.y);
  const b = geometry.viewport.convertToPdfPoint(rect.x + rect.width, rect.y + rect.height);
  const left = clamp((Math.min(a[0], b[0]) - x0) / (x1 - x0));
  const top = clamp((y1 - Math.max(a[1], b[1])) / (y1 - y0));
  const right = clamp((Math.max(a[0], b[0]) - x0) / (x1 - x0));
  const bottom = clamp((y1 - Math.min(a[1], b[1])) / (y1 - y0));
  return { type: 'pdf', page, rect: { x: left, y: top, width: right - left, height: bottom - top }, quote };
}

function toScreen(geometry: Geometry, rect: Rect) {
  const [x0, y0, x1, y1] = geometry.page.view;
  const a = geometry.viewport.convertToViewportPoint(x0 + rect.x * (x1 - x0), y1 - rect.y * (y1 - y0));
  const b = geometry.viewport.convertToViewportPoint(x0 + (rect.x + rect.width) * (x1 - x0), y1 - (rect.y + rect.height) * (y1 - y0));
  return { left: Math.min(a[0], b[0]), top: Math.min(a[1], b[1]), width: Math.max(7, Math.abs(b[0] - a[0])), height: Math.max(7, Math.abs(b[1] - a[1])) };
}

export function PdfViewer({ id, annotations, active, selection, follow, onSelection, onActivate, onError, handle }: {
  id: string; annotations: Annotation[]; active: string | null; selection: PdfAnchor | null; follow: PdfAnchor | null;
  onSelection: (anchor: PdfAnchor | null) => void; onActivate: (annotation: Annotation) => void;
  onError: (error: unknown) => void; handle: Ref<PdfHandle>;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [requestedPage, setRequestedPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [region, setRegion] = useState(false);
  const [drag, setDrag] = useState<Rect | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onSelection, onError });
  callbacks.current = { onSelection, onError };

  useImperativeHandle(handle, () => ({
    goto(anchor) { setRequestedPage((current) => anchor.page <= (pdf?.numPages ?? Infinity) ? anchor.page : current); },
  }), [pdf]);

  useEffect(() => {
    if (follow && pdf && follow.page <= pdf.numPages) setRequestedPage(follow.page);
  }, [follow, pdf]);

  useEffect(() => {
    if (!follow || !geometry || follow.page !== pageNumber) return;
    const visible = toScreen(geometry, follow.rect);
    scroll.current?.scrollTo({ top: Math.max(0, visible.top - 80), behavior: 'smooth' });
  }, [follow, geometry, pageNumber]);

  useEffect(() => {
    let canceled = false;
    let loading: ReturnType<typeof getDocument> | undefined;
    void window.workspace.asset(id).then(async (bytes) => {
      if (canceled) return;
      loading = getDocument({
        data: bytes, cMapUrl: 'workspace-asset://pdf/cmaps/', cMapPacked: true,
        standardFontDataUrl: 'workspace-asset://pdf/standard_fonts/', wasmUrl: 'workspace-asset://pdf/wasm/',
        iccUrl: 'workspace-asset://pdf/iccs/', useWorkerFetch: false,
      });
      const document = await loading.promise;
      if (!canceled) setPdf(document);
    }).catch((error) => { if (!canceled) callbacks.current.onError(error); });
    return () => { canceled = true; void loading?.destroy().catch(() => {}); };
  }, [id]);

  useEffect(() => {
    if (!pdf || !canvas.current || !text.current) return;
    const drawing = canvas.current;
    const content = text.current;
    let canceled = false;
    let render: ReturnType<PDFPageProxy['render']> | undefined;
    let layer: TextLayer | undefined;
    const number = Math.max(1, Math.min(pdf.numPages, requestedPage));
    void pdf.getPage(number).then(async (page) => {
      if (canceled) return;
      const viewport = page.getViewport({ scale });
      const pixelRatio = Math.min(2, window.devicePixelRatio || 1, 4096 / Math.max(viewport.width, viewport.height));
      drawing.width = Math.ceil(viewport.width * pixelRatio);
      drawing.height = Math.ceil(viewport.height * pixelRatio);
      content.replaceChildren();
      setGeometry({ page, viewport });
      setPageNumber(number);
      render = page.render({ canvas: drawing, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] });
      layer = new TextLayer({ textContentSource: page.streamTextContent(), container: content, viewport });
      await Promise.all([render.promise, layer.render()]);
    }).catch((error) => { if (!canceled) callbacks.current.onError(error); });
    return () => { canceled = true; render?.cancel(); layer?.cancel(); };
  }, [pdf, requestedPage, scale]);

  function pageTo(number: number) {
    setRequestedPage(Math.max(1, Math.min(number, pdf?.numPages ?? 1)));
    onSelection(null);
    scroll.current?.scrollTo({ top: 0 });
  }

  function localPoint(event: PointerEvent<HTMLDivElement>) {
    const box = stage.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(event.clientX - box.left, box.width)), y: Math.max(0, Math.min(event.clientY - box.top, box.height)) };
  }

  function area(event: PointerEvent<HTMLDivElement>): Rect | null {
    if (!start.current) return null;
    const a = start.current;
    const b = localPoint(event);
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    if (!geometry || !stage.current) return;
    if (region && start.current) {
      const rect = area(event);
      start.current = null;
      setDrag(null);
      setRegion(false);
      if (rect && rect.width >= 4 && rect.height >= 4) onSelection(toAnchor(geometry, pageNumber, rect));
      return;
    }
    const selectedText = window.getSelection();
    const quote = selectedText?.toString().trim();
    if (!selectedText?.rangeCount || !quote) return;
    const range = selectedText.getRangeAt(0);
    if (!text.current?.contains(range.startContainer) || !text.current.contains(range.endContainer)) return;
    const bounds = range.getBoundingClientRect();
    const board = stage.current.getBoundingClientRect();
    onSelection(toAnchor(geometry, pageNumber, { x: bounds.left - board.left, y: bounds.top - board.top, width: bounds.width, height: bounds.height }, quote.slice(0, 4000)));
  }

  return <div className="pdf-viewer">
    <div className="pdf-controls">
      <button className="icon-button" aria-label="上一页" disabled={!pdf || requestedPage <= 1} onClick={() => pageTo(requestedPage - 1)}><Icon name="left" size={16} /></button>
      <form onSubmit={(event) => { event.preventDefault(); pageTo(Number(new FormData(event.currentTarget).get('page')) || pageNumber); }}>
        <input type="number" name="page" aria-label="页码" min={1} max={pdf?.numPages ?? 1} key={pageNumber} defaultValue={pageNumber} />
      </form>
      <span>/ {pdf?.numPages ?? '–'}</span>
      <button className="icon-button" aria-label="下一页" disabled={!pdf || requestedPage >= pdf.numPages} onClick={() => pageTo(requestedPage + 1)}><Icon name="chevron" size={16} /></button>
      <select aria-label="缩放比例" value={scale} onChange={(event) => setScale(Number(event.target.value))}>
        <option value={0.75}>75%</option><option value={1}>100%</option><option value={1.25}>125%</option><option value={1.5}>150%</option><option value={2}>200%</option>
      </select>
      <button className={'button compact ' + (region ? 'primary' : '')} disabled={!geometry} onClick={() => { setRegion(!region); onSelection(null); }}>{region ? '拖拽选择区域' : '区域批注'}</button>
    </div>
    <div className="pdf-scroll" ref={scroll}>
      {!geometry && <div className="loading">正在打开 PDF…</div>}
      <div ref={stage} className={'pdf-page ' + (region ? 'region-mode' : '')}
        style={{ width: geometry?.viewport.width ?? 0, height: geometry?.viewport.height ?? 0, '--scale-factor': scale, '--total-scale-factor': scale } as CSSProperties}
        onPointerDown={(event) => {
          if (!region) return;
          event.preventDefault();
          start.current = localPoint(event);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => { if (region && start.current) setDrag(area(event)); }}
        onPointerCancel={() => { start.current = null; setDrag(null); setRegion(false); }}
        onPointerUp={finish}>
        <canvas ref={canvas} />
        <div ref={text} className="textLayer" />
        {geometry && annotations.map((item) => item.anchor.type === 'pdf' && item.anchor.page === pageNumber
          ? <button key={item.id} style={toScreen(geometry, item.anchor.rect)} className={'pdf-marker ' + (active === item.id ? 'active' : '')}
            title={item.text} aria-label={'查看批注：' + item.text} onClick={() => onActivate(item)} /> : null)}
        {geometry && [selection, follow].filter((item): item is PdfAnchor => item?.page === pageNumber)
          .map((item, index) => <span key={index} className="pdf-selection" style={toScreen(geometry, item.rect)} />)}
        {drag && <span className="pdf-selection" style={{ left: drag.x, top: drag.y, width: drag.width, height: drag.height }} />}
      </div>
    </div>
  </div>;
}
