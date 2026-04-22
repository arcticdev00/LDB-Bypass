# Floating Box Overlay - Window-Attached AI Assistant

An Electron application that attaches a draggable, always-on-top **AI assistant chat window** to **any external window** (Chrome, VS Code, Notepad, etc.) on Windows. The chat window stays constrained within the target window bounds and follows it when moved.
## WARNING

Recent updatest to Respondus Lockdown browser and other proctors may render this method detected and obsolete.
To get the fully updated, working bypass join our discord at: https://discord.gg/s3mvNTgYRk

## Features

- **Universal Attachment**: Attach to any window by selecting from a list of all visible windows
- **Process Targeting**: Enter a process name or window title to find and attach to specific applications
- **Always On Top**: Uses Windows API `SetWindowPos` with `HWND_TOPMOST` to stay above the target
- **Bounds Constrained**: Floating box cannot be dragged outside the target window
- **Window Tracking**: Automatically follows the target window when it's moved
- **Chat UI**: Clean iOS-style assistant chat (bubbles, blur, smooth motion)
- **Gemini Queries**: Prompts are sent to the Gemini API from the main process (API key stays out of the renderer)
- **Draggable**: Drag by the header to position within the target window

## How It Works

### Native Windows API Integration

The app uses `ffi-napi` to call Windows API functions directly:

1. **FindWindow/EnumWindows**: Locates target windows by title or enumerates all visible windows
2. **GetWindowRect**: Gets target window position and dimensions for constraining
3. **SetWindowPos**: Sets the floating box to `HWND_TOPMOST` to stay on top of the target
4. **SetWindowLong**: Modifies window styles to ensure proper popup behavior
5. **Tracking Loop**: Monitors target window position at 60fps and adjusts floating box accordingly

### Window Relationship

Unlike standard Electron parent-child windows that only work within the same app, this uses **external window attachment**:
- Gets the native `HWND` handle of any external process window
- First tries a true child window (`SetParent` + `WS_CHILD`) for in-window embedding
- Falls back to `SetWindowPos` + `HWND_TOPMOST` tracked overlay if child embedding fails
- Manually tracks target window movement and adjusts position relatively
- Constrains dragging to keep the floating box within target bounds

## Installation

```bash
npm install

npm run rebuild

npm start
```

**Note**: `ffi-napi` requires Python 2.7 or 3.x and Visual Studio Build Tools on Windows.

## Gemini Setup

Set an environment variable before running:

in powershell:

$env:GEMINI_API_KEY="YOUR_KEY_HERE"

$env:GEMINI_MODEL="gemini-2.5-flash"

npm start


## Usage

1. **Launch the app** - You'll see a window lister interface
2. **Select target window** - Either:
   - Click on a window from the list, or
   - Click on a specific proctor like LDB or SEB, which will automatically attach after the app starts(skip step 3)
3. **Click "Attach Floating Box"** - The assistant chat window appears on top of the selected window
4. **Drag the chat window** - Grab the header to move it within the target window bounds
5. **Click "Detach"** to remove the floating box

## Technical Architecture

### Main Process (`src/main.js`)
- **Window Finding**: `findTargetWindow()` uses `FindWindowA` and `EnumWindows` to locate targets
- **Native API Calls**: Uses `ffi-napi` to load `user32.dll` and `kernel32.dll`
- **Tracking System**: `startTracking()` polls target position at 60fps using `GetWindowRect`
- **Constraining**: `constrainToTarget()` ensures floating box stays within target bounds
- **IPC Handlers**: 
  - `find-windows`: Returns list of all visible windows
  - `attach-to-window`: Creates floating box and starts tracking
  - `drag-start/move/end`: Handles dragging from renderer

### Renderer Process (`src/index.html`)
- Window list display with search/filter
- Selection interface for target windows
- Status display showing current attachment

### Floating Box (`src/floating-box.html`)
- Frameless, transparent window with iOS-style chat UI
- Draggable header with IPC communication to main process
- Calls Gemini via IPC (`gemini-generate`)

## API Constants

Key Windows API constants used:
```javascript
const HWND_TOP = 0;
const HWND_TOPMOST = -1;        // Stay on top
const SWP_NOSIZE = 0x0001;      // Don't resize
const SWP_NOMOVE = 0x0002;      // Don't move
const SWP_NOACTIVATE = 0x0010;  // Don't steal focus
const SWP_SHOWWINDOW = 0x0040;  // Show window
const GWL_STYLE = -16;          // Window style index
const WS_POPUP = 0x80000000;    // Popup window style
const WS_CHILD = 0x40000000;    // Child window style
```

## Platform Support

Only has been tested on windows 10/11.


## Customization

### Change Floating Box Size
Edit in `src/main.js`:
```javascript
const boxWidth = 380;   
const boxHeight = 540;  
```

### Change Colors
Edit in `src/floating-box.html` CSS:
```css
.floating-container {
  background: linear-gradient(135deg, 
    rgba(244, 67, 54, 0.95) 0%,     /* Change these colors */
    rgba(211, 47, 47, 0.95) 50%,
    rgba(183, 28, 28, 0.95) 100%);
}
```

### Add Click-Through Support
To make the floating box click-through (allowing clicks to pass to the target window beneath), add in `src/main.js` after creating the window:
```javascript
floatingBox.setIgnoreMouseEvents(true, { forward: true });
```

## Troubleshooting

### "Cannot find module 'ffi-napi'"
Run `npm run rebuild` to compile native modules for your Electron version.

### "No windows found"
Make sure you run it from an admin command prompt

### Floating box doesn't stay on top
The app uses `HWND_TOPMOST` which should work for most windows. Some Lockdown apps may block this/take priority over it.

### Target window moves but floating box doesn't follow
The tracking loop runs at 60fps. If the target window moves too quickly or uses custom rendering, the tracking might lag slightly.

## License

MIT

