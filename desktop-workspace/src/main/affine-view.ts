import { shell, WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import type { AffineStatus, Rect } from '../shared/contracts';

const affineUrl = 'https://app.affine.pro/';
const affineOrigin = new URL(affineUrl).origin;
const startupTimeout = 15_000;
const affinePreferences = {
  partition: 'persist:affine',
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
};

function isAffineUrl(url: string) {
  return URL.canParse(url) && new URL(url).origin === affineOrigin;
}

function isWebPopup(url: string) {
  return url === 'about:blank' || (URL.canParse(url) && new URL(url).protocol === 'https:');
}

function restrictNavigation(contents: WebContents, allowed: (url: string) => boolean) {
  contents.on('will-navigate', (event) => {
    if (!allowed(event.url)) event.preventDefault();
  });
  contents.on('will-redirect', (event) => {
    if (event.isMainFrame && !allowed(event.url)) event.preventDefault();
  });
}

export class AffineView {
  private view: WebContentsView | undefined;
  private bounds: Rect | null = null;
  private status: AffineStatus = 'loading';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;

  constructor(private readonly owner: BrowserWindow) {
    owner.once('closed', () => {
      clearTimeout(this.timer);
      const contents = this.view?.webContents;
      if (contents && !contents.isDestroyed()) contents.close();
    });
  }

  private update(status: AffineStatus) {
    if (this.owner.isDestroyed()) return;
    if (status !== 'loading') clearTimeout(this.timer);
    if (status === this.status) return;
    this.status = status;
    this.layout();
    this.owner.webContents.send('workspace:affineStatus', status);
  }

  private layout() {
    if (!this.view) return;
    const bounds = this.bounds;
    if (!bounds || !bounds.width || !bounds.height || this.status !== 'ready') {
      this.view.setVisible(false);
      return;
    }
    this.view.setBounds(bounds);
    this.view.setVisible(true);
  }

  private createView() {
    const view = new WebContentsView({ webPreferences: affinePreferences });
    view.setVisible(false);
    this.owner.contentView.addChildView(view);
    this.view = view;
    const contents = view.webContents;
    const allowedPermission = (origin: string, permission: string) =>
      isAffineUrl(origin) && (permission === 'clipboard-sanitized-write' || permission === 'fullscreen');
    contents.session.setPermissionCheckHandler((_contents, permission, origin) => allowedPermission(origin, permission));
    contents.session.setPermissionRequestHandler((_contents, permission, answer, details) =>
      answer(allowedPermission(details.requestingUrl, permission)));
    restrictNavigation(contents, isAffineUrl);
    contents.setWindowOpenHandler(({ url }) => isWebPopup(url) ? {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent: this.owner, autoHideMenuBar: true, webPreferences: affinePreferences,
      },
    } : { action: 'deny' });
    contents.on('did-create-window', (popup) => {
      restrictNavigation(popup.webContents, isWebPopup);
      popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    });
    let httpError = false;
    contents.on('did-navigate', (_event, _url, responseCode) => {
      httpError = responseCode >= 400;
      if (httpError) this.update('error');
    });
    // Let AFFiNE display as soon as the document is usable, even if a page resource is still loading.
    contents.on('dom-ready', () => {
      if (!httpError && isAffineUrl(contents.getURL())) this.update('ready');
    });
    contents.on('did-fail-load', (_event, code, _message, _url, mainFrame) => {
      if (code !== -3 && mainFrame) this.update('error');
    });
    contents.on('render-process-gone', () => this.update('error'));
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && !input.isAutoRepeat
        && (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r'))) {
        event.preventDefault();
        this.reload();
      }
    });
  }

  setBounds(bounds: Rect | null) {
    this.bounds = bounds;
    if (bounds && !this.view) {
      this.createView();
      this.reload();
    }
    this.layout();
    return this.status;
  }

  reload() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const attempt = ++this.attempt;
    clearTimeout(this.timer);
    this.update('loading');
    this.timer = setTimeout(() => this.update('timeout'), startupTimeout);
    const current = contents.getURL();
    void contents.loadURL(isAffineUrl(current) ? current : affineUrl).catch((error: Error) => {
      if (attempt === this.attempt && !error.message.includes('ERR_ABORTED')) this.update('error');
    });
  }

  openInBrowser() {
    return shell.openExternal(affineUrl);
  }
}
