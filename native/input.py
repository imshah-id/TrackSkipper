"""Bounded native input for an explicitly focused, inert replay field. Stdlib only."""
import ctypes as C
import ctypes.util
import json
import math
import os
import sys
import time


def bind(lib, name, result, *args):
    function = getattr(lib, name)
    function.restype, function.argtypes = result, args
    return function


class InputInterrupted(ValueError):
    """A changed physical target suspends delivery until the preview requests a new arm."""


class InputExpired(ValueError):
    """A delayed VM request is discarded without restarting the input helper."""


class Mac:
    def __init__(self):
        self.cg = C.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
        self.cf = C.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
        if not bind(self.cg, 'AXIsProcessTrusted', C.c_bool)():
            raise ValueError('macOS Accessibility permission is required for the Python helper; grant it manually and re-arm.')
        if not bind(self.cg, 'CGPreflightPostEventAccess', C.c_bool)():
            raise ValueError('macOS is blocking event posting. Grant Accessibility permission and re-arm.')
        class Point(C.Structure):
            _fields_ = [('x', C.c_double), ('y', C.c_double)]
        self.Point = Point
        self.release = bind(self.cf, 'CFRelease', None, C.c_void_p)
        # The system-wide AXFocusedApplication lookup can fail even for trusted clients.
        # NSWorkspace identifies the foreground app; AX still verifies its focused field.
        self.appkit = C.CDLL('/System/Library/Frameworks/AppKit.framework/AppKit')
        objc = C.CDLL('/usr/lib/libobjc.A.dylib')
        get_class = bind(objc, 'objc_getClass', C.c_void_p, C.c_char_p)
        self.selector = bind(objc, 'sel_registerName', C.c_void_p, C.c_char_p)
        self.message = C.CFUNCTYPE(C.c_void_p, C.c_void_p, C.c_void_p)(('objc_msgSend', objc))
        self.pid_message = C.CFUNCTYPE(C.c_int, C.c_void_p, C.c_void_p)(('objc_msgSend', objc))
        self.workspace = self.message(get_class(b'NSWorkspace'), self.selector(b'sharedWorkspace'))
        self.pool_class = get_class(b'NSAutoreleasePool')
        self.create_app = bind(self.cg, 'AXUIElementCreateApplication', C.c_void_p, C.c_int)
        string = bind(self.cf, 'CFStringCreateWithCString', C.c_void_p, C.c_void_p, C.c_char_p, C.c_uint32)
        self.attributes = {name: string(None, name.encode(), 0x08000100)
                           for name in ('AXFocusedUIElement', 'AXManualAccessibility')}
        self.true = C.c_void_p.in_dll(self.cf, 'kCFBooleanTrue').value
        self.set_attribute = bind(self.cg, 'AXUIElementSetAttributeValue', C.c_int, C.c_void_p, C.c_void_p, C.c_void_p)
        self.timeout = bind(self.cg, 'AXUIElementSetMessagingTimeout', C.c_int, C.c_void_p, C.c_float)
        self.copy = bind(self.cg, 'AXUIElementCopyAttributeValue', C.c_int, C.c_void_p, C.c_void_p, C.POINTER(C.c_void_p))
        self.equal = bind(self.cf, 'CFEqual', C.c_bool, C.c_void_p, C.c_void_p)
        self.focus = None
        self.create = bind(self.cg, 'CGEventCreate', C.c_void_p, C.c_void_p)
        self.location = bind(self.cg, 'CGEventGetLocation', Point, C.c_void_p)
        self.key_state = bind(self.cg, 'CGEventSourceKeyState', C.c_bool, C.c_int, C.c_uint16)
        self.button_state = bind(self.cg, 'CGEventSourceButtonState', C.c_bool, C.c_int, C.c_uint32)
        self.key = bind(self.cg, 'CGEventCreateKeyboardEvent', C.c_void_p, C.c_void_p, C.c_uint16, C.c_bool)
        self.mouse = bind(self.cg, 'CGEventCreateMouseEvent', C.c_void_p, C.c_void_p, C.c_uint32, Point, C.c_uint32)
        self.flags = bind(self.cg, 'CGEventSetFlags', None, C.c_void_p, C.c_uint64)
        self.post = bind(self.cg, 'CGEventPost', None, C.c_uint32, C.c_void_p)
        self.prepare_accessibility()

    def frontmost_pid(self):
        pool = self.message(self.pool_class, self.selector(b'new'))
        try:
            app = self.message(self.workspace, self.selector(b'frontmostApplication'))
            return self.pid_message(app, self.selector(b'processIdentifier')) if app else 0
        finally:
            self.message(pool, self.selector(b'drain'))

    def read_attribute(self, element, name):
        value = C.c_void_p()
        error = self.copy(element, self.attributes[name], C.byref(value))
        if error or not value.value:
            if value.value: self.release(value)
            hint = ('macOS could not contact the app accessibility service. Check Accessibility permission '
                    'for Visual Studio Code and the configured Python executable, restart the editor, then re-arm.'
                    if error == -25204 else
                    'Set VS Code Editor: Accessibility Support to on, then re-arm VM input.')
            raise ValueError(f'Cannot verify {name} (AX error {error}). {hint}')
        return value.value

    def focused_element(self):
        if self.frontmost_pid() != self.app_pid:
            raise InputInterrupted('Focused application changed; return to the replay preview.')
        return self.read_attribute(self.app, 'AXFocusedUIElement')

    def prepare_accessibility(self):
        self.app_pid = self.frontmost_pid()
        if self.app_pid <= 0: raise ValueError('Cannot verify the foreground application. Unlock the VM desktop and re-arm.')
        self.app = self.create_app(self.app_pid)
        if not self.app: raise ValueError('Cannot create the application accessibility object.')
        self.timeout(self.app, 0.2)
        # Electron does not expose its webview tree until an accessibility client requests it.
        value = C.c_void_p()
        error = self.copy(self.app, self.attributes['AXManualAccessibility'], C.byref(value))
        try:
            if not error and value.value and not self.equal(value, self.true):
                error = self.set_attribute(self.app, self.attributes['AXManualAccessibility'], self.true)
            if error not in (0, -25205):  # Native apps may not support Electron's attribute.
                raise ValueError(f'Cannot enable Electron accessibility (AX error {error}). '
                                 'Set VS Code Editor: Accessibility Support to on, then re-arm VM input.')
        finally:
            if value.value: self.release(value)
        # Build the tree before "ready", so arming never waits on an expired input request.
        for attempt in range(10):
            try:
                self.release(self.focused_element())
                return
            except ValueError:
                if attempt == 9: raise
                time.sleep(0.05)

    def snapshot(self):
        element = self.focused_element()
        if self.focus is None:
            self.focus = element
            same = True
        else:
            same = self.equal(self.focus, element)
            self.release(element)
        event = self.create(None)
        if not event: raise ValueError('Cannot read the pointer.')
        point = self.location(event)
        self.release(event)
        return same, (point.x, point.y)

    def busy(self):
        return any(self.key_state(1, key) for key in range(128)) or any(self.button_state(1, button) for button in range(32))

    def emit(self, kind, position):
        if kind in ('type', 'delete'):
            code = 0 if kind == 'type' else 51  # A / Backspace, never a shortcut.
            events = [self.key(None, code, True), self.key(None, code, False)]
        else:
            types = [1, 2] if kind == 'click' else [5]
            events = [self.mouse(None, event_type, self.Point(*position), 0) for event_type in types]
        try:
            if not all(events): raise ValueError('Cannot create native events.')
            for event in events:
                self.flags(event, 0)
                self.post(0, event)
        finally:
            for event in events:
                if event: self.release(event)


class Windows:
    def __init__(self):
        from ctypes import wintypes as W
        self.user = C.WinDLL('user32', use_last_error=True)
        self.focus = bind(self.user, 'GetForegroundWindow', W.HWND)
        self.get_pos = bind(self.user, 'GetCursorPos', W.BOOL, C.POINTER(W.POINT))
        self.Point = W.POINT
        self.key_state = bind(self.user, 'GetAsyncKeyState', C.c_short, C.c_int)
        # Correct pointer-sized INPUT layout on both 32- and 64-bit Windows.
        class Mouse(C.Structure):
            _fields_ = [('dx', W.LONG), ('dy', W.LONG), ('data', W.DWORD), ('flags', W.DWORD), ('time', W.DWORD), ('extra', C.c_size_t)]
        class Keyboard(C.Structure):
            _fields_ = [('vk', W.WORD), ('scan', W.WORD), ('flags', W.DWORD), ('time', W.DWORD), ('extra', C.c_size_t)]
        class Data(C.Union):
            _fields_ = [('mouse', Mouse), ('keyboard', Keyboard)]
        class Input(C.Structure):
            _fields_ = [('type', W.DWORD), ('data', Data)]
        self.Input = Input
        self.send = bind(self.user, 'SendInput', W.UINT, W.UINT, C.POINTER(Input), C.c_int)

    def snapshot(self):
        point = self.Point()
        focus = self.focus()
        if not focus or not self.get_pos(C.byref(point)): raise ValueError('Cannot verify the foreground window or pointer.')
        return focus, (point.x, point.y)

    def busy(self):
        return any(self.key_state(key) & 0x8000 for key in range(1, 256))

    def emit(self, kind, position):
        events = (self.Input * (2 if kind != 'move' else 1))()
        if kind in ('type', 'delete'):
            for index, event in enumerate(events):
                event.type = 1
                event.data.keyboard.vk = 0x41 if kind == 'type' else 0x08
                event.data.keyboard.flags = index * 2
        else:
            for event, flags in zip(events, [2, 4] if kind == 'click' else [1]):
                event.data.mouse.flags = flags  # Move has zero displacement; never drag or relocate.
        sent = self.send(len(events), events, C.sizeof(self.Input))
        if sent != len(events):
            if len(events) == 2 and sent == 1: self.send(1, C.byref(events[1]), C.sizeof(self.Input))
            raise ValueError('Windows blocked native input (check VM privileges).')


class Linux:
    def __init__(self):
        if os.environ.get('XDG_SESSION_TYPE') == 'wayland' or os.environ.get('WAYLAND_DISPLAY'):
            raise ValueError('Native input requires Linux X11; Wayland is unsupported.')
        self.x = C.CDLL(ctypes.util.find_library('X11') or 'libX11.so.6')
        self.test = C.CDLL(ctypes.util.find_library('Xtst') or 'libXtst.so.6')
        ptr, window, integer = C.c_void_p, C.c_ulong, C.c_int
        self.display = bind(self.x, 'XOpenDisplay', ptr, C.c_char_p)(None)
        if not self.display: raise ValueError('Cannot connect to the X11 display.')
        values = [integer() for _ in range(4)]
        if not bind(self.test, 'XTestQueryExtension', integer, ptr, *([C.POINTER(integer)] * 4))(self.display, *(C.byref(v) for v in values)):
            raise ValueError('X11 XTEST extension is unavailable.')
        self.root = bind(self.x, 'XDefaultRootWindow', window, ptr)(self.display)
        self.focus = bind(self.x, 'XGetInputFocus', integer, ptr, C.POINTER(window), C.POINTER(integer))
        self.query = bind(self.x, 'XQueryPointer', integer, ptr, window, C.POINTER(window), C.POINTER(window), *([C.POINTER(integer)] * 4), C.POINTER(C.c_uint))
        self.keymap = bind(self.x, 'XQueryKeymap', integer, ptr, C.c_void_p)
        self.keycode = bind(self.x, 'XKeysymToKeycode', C.c_ubyte, ptr, C.c_ulong)
        self.key = bind(self.test, 'XTestFakeKeyEvent', integer, ptr, C.c_uint, integer, C.c_ulong)
        self.button = bind(self.test, 'XTestFakeButtonEvent', integer, ptr, C.c_uint, integer, C.c_ulong)
        self.move = bind(self.test, 'XTestFakeRelativeMotionEvent', integer, ptr, integer, integer, C.c_ulong)
        self.sync = bind(self.x, 'XSync', integer, ptr, integer)

    def pointer(self):
        root, child, mask = C.c_ulong(), C.c_ulong(), C.c_uint()
        coordinates = [C.c_int() for _ in range(4)]
        if not self.query(self.display, self.root, C.byref(root), C.byref(child), *(C.byref(v) for v in coordinates), C.byref(mask)):
            raise ValueError('Cannot verify the X11 pointer.')
        return (coordinates[0].value, coordinates[1].value), mask.value

    def snapshot(self):
        focus, revert = C.c_ulong(), C.c_int()
        self.focus(self.display, C.byref(focus), C.byref(revert))
        if focus.value in (0, 1): raise ValueError('No focused X11 window.')
        return focus.value, self.pointer()[0]

    def busy(self):
        keys = C.create_string_buffer(32)
        self.keymap(self.display, keys)
        return any(keys.raw) or bool(self.pointer()[1] & 0x1F00)

    def emit(self, kind, position):
        if kind in ('type', 'delete'):
            code = self.keycode(self.display, 0x61 if kind == 'type' else 0xFF08)
            if not code: raise ValueError('Required key is unavailable on this keyboard.')
            self.key(self.display, code, 1, 0)
            self.key(self.display, code, 0, 0)
        elif kind == 'click':
            self.button(self.display, 1, 1, 0)
            self.button(self.display, 1, 0, 0)
        else: self.move(self.display, 0, 0, 0)
        self.sync(self.display, 0)


class Guard:
    def __init__(self, backend):
        self.backend, self.anchor, self.last = backend, None, -math.inf

    def handle(self, command):
        if not isinstance(command, dict) or set(command) - {'op', 'at', 'kind'}:
            raise ValueError('Invalid native input request.')
        stamp = command.get('at')
        if type(stamp) not in (int, float) or not math.isfinite(stamp):
            raise ValueError('Invalid input heartbeat.')
        if not 0 <= time.time() * 1000 - stamp <= 250:
            raise InputExpired('Input heartbeat expired.')
        if command.get('op') == 'arm' and self.anchor is None:
            if self.backend.busy(): raise InputInterrupted('Release all keys and mouse buttons before arming.')
            self.anchor = self.backend.snapshot()
            return 'armed'
        if command.get('op') != 'pulse' or self.anchor is None or command.get('kind') not in ('type', 'delete', 'move', 'click'):
            raise ValueError('Invalid or unarmed native input request.')
        if self.backend.snapshot() != self.anchor or self.backend.busy():
            raise InputInterrupted('Focus, pointer, or physical input changed; return to the replay preview.')
        if not 0 <= time.time() * 1000 - stamp <= 250:
            raise InputExpired('Input heartbeat expired during the native focus check.')
        if time.monotonic() - self.last >= 0.5:
            self.backend.emit(command['kind'], self.anchor[1])
            self.last = time.monotonic()
        return 'armed'


def main():
    try:
        backend = {'darwin': Mac, 'win32': Windows}.get(sys.platform, Linux)()
        guard = Guard(backend)
        print(json.dumps({'status': 'ready'}), flush=True)
        while True:
            line = sys.stdin.buffer.readline(1025)
            if not line: return
            if len(line) > 1024: raise ValueError('Oversized input request.')
            try:
                status = guard.handle(json.loads(line))
            except InputExpired:
                status = 'armed' if guard.anchor is not None else 'ready'
            print(json.dumps({'status': status}), flush=True)
    except Exception as error:
        print(json.dumps({'error': str(error)[:512], 'retry': isinstance(error, InputInterrupted)}), flush=True)
        sys.exit(1)


if __name__ == '__main__': main()
