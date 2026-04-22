const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
const path = require('path');
const ffi = require('@lwahonen/ffi-napi');
const ref = require('@lwahonen/ref-napi');
const Struct = require('ref-struct-di')(ref);
let windowManager = null;

function getWindowManager() {
  if (windowManager) return windowManager;
  try {
    windowManager = require('node-window-manager').windowManager;
    return windowManager;
  } catch (e) {
    return null;
  }
}

const user32 = ffi.Library('user32', {
  'FindWindowA': ['long', ['string', 'string']],
  'FindWindowExA': ['long', ['long', 'long', 'string', 'string']],
  'EnumWindows': ['bool', ['pointer', 'long']],
  'GetWindowTextA': ['int', ['long', 'pointer', 'int']],
  'GetClassNameA': ['int', ['long', 'pointer', 'int']],
  'IsWindow': ['bool', ['long']],
  'IsWindowVisible': ['bool', ['long']],
  'SetWindowPos': ['bool', ['long', 'long', 'int', 'int', 'int', 'int', 'uint']],
  'GetWindowRect': ['bool', ['long', 'pointer']],
  'GetClientRect': ['bool', ['long', 'pointer']],
  'ClientToScreen': ['bool', ['long', 'pointer']],
  'SetParent': ['long', ['long', 'long']],
  'GetParent': ['long', ['long']],
  'SetWindowLongA': ['long', ['long', 'int', 'long']],
  'GetWindowLongA': ['long', ['long', 'int']],
  'GetWindowThreadProcessId': ['uint', ['long', 'pointer']],
  'SetLayeredWindowAttributes': ['bool', ['long', 'uint', 'byte', 'uint']],
});

const kernel32 = ffi.Library('kernel32', {
  'GetLastError': ['uint', []],
});

const HWND_TOP = 0;
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const SWP_FRAMECHANGED = 0x0020;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_CLIPCHILDREN = 0x02000000;
const WS_CLIPSIBLINGS = 0x04000000;
const WS_CAPTION = 0x00C00000;
const WS_THICKFRAME = 0x00040000;
const WS_VISIBLE = 0x10000000;
const LWA_ALPHA = 0x00000002;
const LWA_COLORKEY = 0x00000001;

const RECT = Struct({
  left: ref.types.long,
  top: ref.types.long,
  right: ref.types.long,
  bottom: ref.types.long
});

const POINT = Struct({
  x: ref.types.long,
  y: ref.types.long
});

let mainWindow;
let floatingBox;
let targetWindowHwnd = null;
let targetWindowTitle = '';
let trackingInterval = null;
let dragOffset = null;
let isDragging = false;
let embeddedChild = null;
let arm = {
  config: null,
  pollTimer: null,
  attachTimer: null,
  found: null
};

function sendArmUpdate(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('arm-update', payload);
}

function stopArming(reason) {
  if (arm.pollTimer) clearInterval(arm.pollTimer);
  if (arm.attachTimer) clearTimeout(arm.attachTimer);
  arm.pollTimer = null;
  arm.attachTimer = null;
  arm.config = null;
  arm.found = null;

  if (typeof reason === 'string') {
    sendArmUpdate({ state: 'idle', message: reason || 'Disarmed' });
  }
}

function normalizeExeName(name) {
  const n = (name || '').trim().toLowerCase();
  if (!n) return '';
  if (n.endsWith('.exe')) return n;
  return `${n}.exe`;
}

function findWindowByProcessName(processName) {
  const wantedExe = normalizeExeName(processName);
  const wantedBare = wantedExe.endsWith('.exe') ? wantedExe.slice(0, -4) : wantedExe;
  if (!wantedExe) return null;

  const wm = getWindowManager();
  if (!wm) return null;

  const wins = wm.getWindows();
  const candidates = [];

  for (const w of wins) {
    try {
      if (!w.isVisible()) continue;
      const exe = (w.path ? path.basename(w.path) : '').toLowerCase();
      if (!exe) continue;
      const exeBare = exe.endsWith('.exe') ? exe.slice(0, -4) : exe;
      if (exe !== wantedExe && exeBare !== wantedBare) continue;

      const title = (typeof w.getTitle === 'function') ? (w.getTitle() || '') : '';
      candidates.push({
        hwnd: w.id,
        title,
        processId: w.processId,
        path: w.path || ''
      });
    } catch (e) {
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => (b.title || '').length - (a.title || '').length);
  return candidates[0];
}

function armFindOnce() {
  if (!arm.config) return null;

  if (arm.config.processName) {
    const found = findWindowByProcessName(arm.config.processName);
    if (found && found.hwnd) return found;
  }

  if (arm.config.windowTitle) {
    const hwnd = findTargetWindow(arm.config.windowTitle);
    if (hwnd) return { hwnd, title: getWindowTitle(hwnd) };
  }

  return null;
}

function armBeginPolling() {
  if (!arm.config) return;
  if (arm.pollTimer) clearInterval(arm.pollTimer);
  arm.pollTimer = setInterval(armPollOnce, arm.config.pollMs);
  armPollOnce();
}

function armPollOnce() {
  if (!arm.config || arm.attachTimer) return;

  const found = armFindOnce();
  if (!found || !found.hwnd) return;

  armScheduleAttach(found);
}

function armScheduleAttach(found) {
  if (!arm.config) return;

  arm.found = found;
  if (arm.pollTimer) clearInterval(arm.pollTimer);
  arm.pollTimer = null;

  const t = found.title ? `"${found.title}"` : `HWND ${found.hwnd}`;
  sendArmUpdate({
    state: 'found',
    message: `Found ${t}. Waiting 5s for initialization...`,
    hwnd: String(found.hwnd),
    title: found.title || ''
  });

  if (arm.attachTimer) clearTimeout(arm.attachTimer);
  arm.attachTimer = setTimeout(armAttachFound, arm.config.initDelayMs);
}

function armAttachFound() {
  arm.attachTimer = null;
  if (!arm.config || !arm.found) return;

  const hwnd = arm.found.hwnd;
  if (!isValidWindow(hwnd)) {
    sendArmUpdate({ state: 'armed', message: 'Window disappeared; waiting...' });
    arm.found = null;
    armBeginPolling();
    return;
  }

  targetWindowHwnd = hwnd;
  targetWindowTitle = getWindowTitle(hwnd) || (arm.found.title || '');

  const box = createFloatingBox(hwnd);
  if (box) {
    sendArmUpdate({
      state: 'attached',
      message: `Attached to ${targetWindowTitle || hwnd}`,
      hwnd: String(hwnd),
      title: targetWindowTitle || ''
    });
  } else {
    sendArmUpdate({ state: 'armed', message: 'Attach failed; waiting...' });
    arm.found = null;
    armBeginPolling();
  }
}

function readHwndFromBuffer(handleBuf) {
  if (!handleBuf || !Buffer.isBuffer(handleBuf)) return null;

  if (handleBuf.length >= 8) {
    const v = handleBuf.readBigInt64LE(0);
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }

  if (handleBuf.length >= 4) return handleBuf.readInt32LE(0);
  return null;
}

function getFloatingBoxHwnd() {
  if (!floatingBox) return null;
  return readHwndFromBuffer(floatingBox.getNativeWindowHandle());
}

function getClientMetrics(hwnd) {
  const rect = new RECT();
  const ok = user32.GetClientRect(hwnd, rect.ref());
  if (!ok) return null;

  const pt = new POINT();
  pt.x = 0;
  pt.y = 0;
  const ok2 = user32.ClientToScreen(hwnd, pt.ref());
  if (!ok2) return null;

  return {
    originX: pt.x,
    originY: pt.y,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top
  };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function setEmbeddedChildPos(childX, childY) {
  if (!embeddedChild) return;
  const x = Math.round(childX);
  const y = Math.round(childY);

  user32.SetWindowPos(
    embeddedChild.boxHwnd,
    HWND_TOP,
    x,
    y,
    0,
    0,
    SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW
  );

  embeddedChild.x = x;
  embeddedChild.y = y;
}

function tryEmbedAsChild(targetHwnd, boxHwnd, boxWidth, boxHeight) {
  try {
    user32.SetParent(boxHwnd, targetHwnd);
  } catch (e) {
    return false;
  }

  const parentNow = user32.GetParent(boxHwnd);
  if (parentNow !== targetHwnd) return false;

  const style = user32.GetWindowLongA(boxHwnd, GWL_STYLE);
  const newStyle =
    (style & ~WS_POPUP) |
    WS_CHILD |
    WS_VISIBLE |
    WS_CLIPCHILDREN |
    WS_CLIPSIBLINGS;

  user32.SetWindowLongA(boxHwnd, GWL_STYLE, newStyle);

  const metrics = getClientMetrics(targetHwnd);
  if (!metrics) return false;

  const paddingX = 20;
  const paddingY = 20;
  const startX = clamp(metrics.width - boxWidth - paddingX, 0, Math.max(0, metrics.width - boxWidth));
  const startY = clamp(metrics.height - boxHeight - paddingY, 0, Math.max(0, metrics.height - boxHeight));

  embeddedChild = {
    parentHwnd: targetHwnd,
    boxHwnd,
    boxWidth,
    boxHeight,
    x: startX,
    y: startY
  };

  user32.SetWindowPos(
    boxHwnd,
    HWND_TOP,
    startX,
    startY,
    boxWidth,
    boxHeight,
    SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED
  );

  return true;
}

async function geminiGenerate({ contents }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { success: false, error: 'Missing GEMINI_API_KEY environment variable' };
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const body = {
    contents: Array.isArray(contents) ? contents : []
  };

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : String(e) };
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    const msg = `Gemini returned HTTP ${resp.status} but response was not JSON`;
    return { success: false, error: msg };
  }

  if (!resp.ok) {
    const details = (data && data.error && data.error.message) ? data.error.message : JSON.stringify(data);
    return { success: false, error: `Gemini HTTP ${resp.status}: ${details}` };
  }

  const text =
    data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text;

  if (typeof text !== 'string') {
    return { success: false, error: 'Gemini response missing candidates[0].content.parts[0].text' };
  }

  return { success: true, text };
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 700,
    title: 'Floating Box Overlay - Target Selector',
    backgroundColor: '#1a1a2e',
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    icon: path.join(__dirname, 'assets', 'icon.png')
  });

  try {
    mainWindow.removeMenu();
    mainWindow.setMenuBarVisibility(false);
  } catch (e) {}

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopTracking();
    if (floatingBox) {
      floatingBox.destroy();
      floatingBox = null;
    }
  });
}

function findTargetWindow(identifier) {
  let hwnd = user32.FindWindowA(null, identifier);

  if (hwnd && !isValidWindow(hwnd)) {
    hwnd = null;
  }

  if (!hwnd) {
    hwnd = findWindowByPartialTitle(identifier);
  }

  return hwnd;
}

function isValidWindow(hwnd) {
  return user32.IsWindow(hwnd) && user32.IsWindowVisible(hwnd);
}

function findWindowByPartialTitle(partialTitle) {
  const matches = [];
  const callback = ffi.Callback('int', ['long', 'long'], (hwnd, lParam) => {
    if (!user32.IsWindowVisible(hwnd)) return 1;

    const buf = Buffer.alloc(256);
    user32.GetWindowTextA(hwnd, buf, 256);
    const title = buf.toString('utf8').replace(/\x00/g, '').trim();

    if (title.toLowerCase().includes(partialTitle.toLowerCase())) {
      matches.push({ hwnd, title });
    }
    return 1;
  });

  user32.EnumWindows(callback, 0);

  const validMatch = matches.find(m => m.title && m.title.length > 0);
  return validMatch ? validMatch.hwnd : null;
}

function getWindowRect(hwnd) {
  const rect = new RECT();
  const success = user32.GetWindowRect(hwnd, rect.ref());
  if (!success) return null;

  return {
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top
  };
}

function getWindowTitle(hwnd) {
  const buf = Buffer.alloc(256);
  const length = user32.GetWindowTextA(hwnd, buf, 256);
  return buf.toString('utf8').replace(/\x00/g, '').trim();
}

function createFloatingBox(targetHwnd) {
  if (floatingBox) {
    floatingBox.destroy();
  }
  embeddedChild = null;

  const targetRect = getWindowRect(targetHwnd);
  if (!targetRect) {
    console.error('Could not get target window rect');
    return null;
  }

  const boxWidth = 380;
  const boxHeight = 540;

  floatingBox = new BrowserWindow({
    width: boxWidth,
    height: boxHeight,
    x: clamp(targetRect.x + targetRect.width - boxWidth - 20, targetRect.x, Math.max(targetRect.x, targetRect.x + targetRect.width - boxWidth)),
    y: clamp(targetRect.y + targetRect.height - boxHeight - 20, targetRect.y, Math.max(targetRect.y, targetRect.y + targetRect.height - boxHeight)),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    show: false,
    type: 'toolbar'
  });

  floatingBox.loadFile(path.join(__dirname, 'floating-box.html'));

  floatingBox.once('ready-to-show', () => {
    const boxHwnd = getFloatingBoxHwnd();

    const embeddedOk = boxHwnd ? tryEmbedAsChild(targetHwnd, boxHwnd, boxWidth, boxHeight) : false;

    if (embeddedOk) {
      try { floatingBox.setAlwaysOnTop(false); } catch (e) {}
    }

    if (!embeddedOk && boxHwnd) {
      const style = user32.GetWindowLongA(boxHwnd, GWL_STYLE);
      const newStyle = (style & ~WS_CHILD) | WS_POPUP | WS_VISIBLE;
      user32.SetWindowLongA(boxHwnd, GWL_STYLE, newStyle);

      user32.SetWindowPos(
        boxHwnd,
        HWND_TOPMOST,
        0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_FRAMECHANGED
      );
    }

    floatingBox.show();
    startTracking(targetHwnd);
  });

  floatingBox.on('closed', () => {
    floatingBox = null;
    embeddedChild = null;
    stopTracking();
  });

  return floatingBox;
}

function startTracking(targetHwnd) {
  stopTracking();

  let lastTargetRect = null;

  trackingInterval = setInterval(() => {
    if (!floatingBox || !isValidWindow(targetHwnd)) {
      if (floatingBox) {
        floatingBox.close();
      }
      return;
    }

    if (embeddedChild && embeddedChild.parentHwnd === targetHwnd) {
      const metrics = getClientMetrics(targetHwnd);
      if (!metrics) return;

      const maxX = Math.max(0, metrics.width - embeddedChild.boxWidth);
      const maxY = Math.max(0, metrics.height - embeddedChild.boxHeight);

      const nextX = clamp(embeddedChild.x, 0, maxX);
      const nextY = clamp(embeddedChild.y, 0, maxY);
      if (nextX !== embeddedChild.x || nextY !== embeddedChild.y) {
        setEmbeddedChildPos(nextX, nextY);
      }

      user32.SetWindowPos(
        embeddedChild.boxHwnd,
        HWND_TOP,
        0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
      );

      return;
    }

    const targetRect = getWindowRect(targetHwnd);
    if (!targetRect) return;

    if (lastTargetRect && 
        (lastTargetRect.x !== targetRect.x || 
         lastTargetRect.y !== targetRect.y ||
         lastTargetRect.width !== targetRect.width ||
         lastTargetRect.height !== targetRect.height)) {

      const boxBounds = floatingBox.getBounds();
      const dx = targetRect.x - lastTargetRect.x;
      const dy = targetRect.y - lastTargetRect.y;

      floatingBox.setPosition(
        Math.round(boxBounds.x + dx),
        Math.round(boxBounds.y + dy)
      );
    }

    lastTargetRect = targetRect;
    constrainToTarget(targetRect);

    const boxHwnd = getFloatingBoxHwnd();
    if (!boxHwnd) return;
    user32.SetWindowPos(
      boxHwnd,
      HWND_TOPMOST,
      0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
    );

  }, 16);
}

function stopTracking() {
  if (trackingInterval) {
    clearInterval(trackingInterval);
    trackingInterval = null;
  }
}

function constrainToTarget(targetRect) {
  if (!floatingBox) return;

  const boxBounds = floatingBox.getBounds();
  let newX = boxBounds.x;
  let newY = boxBounds.y;

  if (newX < targetRect.x) {
    newX = targetRect.x;
  } else if (newX + boxBounds.width > targetRect.x + targetRect.width) {
    newX = targetRect.x + targetRect.width - boxBounds.width;
  }

  if (newY < targetRect.y) {
    newY = targetRect.y;
  } else if (newY + boxBounds.height > targetRect.y + targetRect.height) {
    newY = targetRect.y + targetRect.height - boxBounds.height;
  }

  if (newX !== boxBounds.x || newY !== boxBounds.y) {
    floatingBox.setPosition(Math.round(newX), Math.round(newY));
  }
}

ipcMain.handle('find-windows', async () => {
  const windows = [];
  const callback = ffi.Callback('int', ['long', 'long'], (hwnd, lParam) => {
    if (!user32.IsWindowVisible(hwnd)) return 1;

    const titleBuf = Buffer.alloc(256);
    const classBuf = Buffer.alloc(256);
    user32.GetWindowTextA(hwnd, titleBuf, 256);
    user32.GetClassNameA(hwnd, classBuf, 256);

    const title = titleBuf.toString('utf8').replace(/\x00/g, '').trim();
    const className = classBuf.toString('utf8').replace(/\x00/g, '').trim();

    if (title && title.length > 0) {
      const rect = getWindowRect(hwnd);
      windows.push({
        hwnd: hwnd.toString(),
        title: title,
        className: className,
        bounds: rect
      });
    }
    return 1;
  });

  user32.EnumWindows(callback, 0);
  return windows.slice(0, 50);
});

ipcMain.handle('attach-to-window', async (event, hwndStr) => {
  stopArming('Manual attach selected');
  const hwnd = parseInt(hwndStr);

  if (!isValidWindow(hwnd)) {
    return { success: false, error: 'Invalid window handle' };
  }

  targetWindowHwnd = hwnd;
  targetWindowTitle = getWindowTitle(hwnd);

  const box = createFloatingBox(hwnd);

  if (box) {
    return { 
      success: true, 
      title: targetWindowTitle,
      bounds: getWindowRect(hwnd)
    };
  } else {
    return { success: false, error: 'Failed to create floating box' };
  }
});

ipcMain.handle('detach-window', async () => {
  stopArming('Detached');
  stopTracking();
  targetWindowHwnd = null;
  targetWindowTitle = '';
  embeddedChild = null;
  if (floatingBox) {
    floatingBox.close();
    floatingBox = null;
  }
  return { success: true };
});

ipcMain.handle('gemini-generate', async (event, { contents }) => {
  return geminiGenerate({ contents });
});

ipcMain.handle('arm-start', async (event, { processName, windowTitle } = {}) => {
  stopArming();

  const proc = (processName || '').trim();
  const title = (windowTitle || '').trim();
  if (!proc && !title) return { success: false, error: 'Provide a process name and/or a window title' };
  if (proc && !getWindowManager()) {
    return { success: false, error: 'Process arming requires node-window-manager (native module). Use window title arming instead.' };
  }

  arm.config = {
    processName: proc,
    windowTitle: title,
    pollMs: 1000,
    initDelayMs: 5000
  };

  sendArmUpdate({
    state: 'armed',
    message: 'Armed: waiting for ' + (proc ? proc : 'window') + (title ? ' (' + title + ')' : '')
  });

  armBeginPolling();
  return { success: true };
});
ipcMain.handle('arm-stop', async () => {
  stopArming('Disarmed');
  return { success: true };
});

ipcMain.on('drag-start', (event, { screenX, screenY }) => {
  if (!floatingBox) return;
  isDragging = true;

  const boxHwnd = getFloatingBoxHwnd();
  const rect = boxHwnd ? getWindowRect(boxHwnd) : null;
  const bounds = rect || floatingBox.getBounds();

  dragOffset = {
    x: screenX - bounds.x,
    y: screenY - bounds.y
  };
});

ipcMain.on('drag-move', (event, { screenX, screenY }) => {
  if (!isDragging || !floatingBox || !dragOffset) return;

  const newScreenX = screenX - dragOffset.x;
  const newScreenY = screenY - dragOffset.y;

  if (embeddedChild && targetWindowHwnd && embeddedChild.parentHwnd === targetWindowHwnd) {
    const metrics = getClientMetrics(targetWindowHwnd);
    if (!metrics) return;

    const desiredChildX = newScreenX - metrics.originX;
    const desiredChildY = newScreenY - metrics.originY;
    const maxX = Math.max(0, metrics.width - embeddedChild.boxWidth);
    const maxY = Math.max(0, metrics.height - embeddedChild.boxHeight);
    setEmbeddedChildPos(clamp(desiredChildX, 0, maxX), clamp(desiredChildY, 0, maxY));
    return;
  }

  floatingBox.setPosition(Math.round(newScreenX), Math.round(newScreenY));

  if (targetWindowHwnd && isValidWindow(targetWindowHwnd)) {
    const targetRect = getWindowRect(targetWindowHwnd);
    if (targetRect) constrainToTarget(targetRect);
  }
});

ipcMain.on('drag-end', () => {
  isDragging = false;
  dragOffset = null;
});

app.whenReady().then(() => {
  try { Menu.setApplicationMenu(null); } catch (e) {}
  createMainWindow();
});

app.on('window-all-closed', () => {
  stopTracking();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createMainWindow();
  }
});