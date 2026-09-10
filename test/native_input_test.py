import importlib.util
import pathlib
import unittest
from unittest.mock import patch

path = pathlib.Path(__file__).parents[1] / 'native' / 'input.py'
spec = importlib.util.spec_from_file_location('native_input', path)
module = importlib.util.module_from_spec(spec)
if path.exists():
    spec.loader.exec_module(module)

class Backend:
    def __init__(self):
        self.current = (1, (100, 100))
        self.held = False
        self.events = []
    def snapshot(self): return self.current
    def busy(self): return self.held
    def emit(self, kind, position): self.events.append((kind, position))

class SafetyTest(unittest.TestCase):
    def test_input_requires_fresh_arm_and_unchanged_target(self):
        self.assertTrue(hasattr(module, 'Guard'), 'native input guard must exist')
        backend = Backend()
        guard = module.Guard(backend)
        with patch.object(module.time, 'time', return_value=100), patch.object(module.time, 'monotonic', return_value=10):
            guard.handle({'op': 'arm', 'at': 100000})
            guard.handle({'op': 'pulse', 'kind': 'click', 'at': 100000})
            guard.handle({'op': 'pulse', 'kind': 'type', 'at': 100000})
        self.assertEqual(backend.events, [('click', (100, 100))], 'rate limit prevents bursts')
        for mutation in ('focus', 'pointer', 'held', 'stale', 'unknown'):
            backend = Backend()
            guard = module.Guard(backend)
            with patch.object(module.time, 'time', return_value=100):
                guard.handle({'op': 'arm', 'at': 100000})
                if mutation == 'focus': backend.current = (2, (100, 100))
                if mutation == 'pointer': backend.current = (1, (101, 100))
                if mutation == 'held': backend.held = True
                with self.assertRaises(ValueError):
                    guard.handle({'op': 'pulse', 'kind': 'exec' if mutation == 'unknown' else 'type', 'at': 99000 if mutation == 'stale' else 100000})
                self.assertEqual(backend.events, [])
        backend = Backend()
        with self.assertRaises(ValueError):
            module.Guard(backend).handle({'op': 'pulse', 'kind': 'type', 'at': 100000})
        self.assertEqual(backend.events, [])

class MacFocusTest(unittest.TestCase):
    def backend(self):
        backend = module.Mac.__new__(module.Mac)
        backend.system = 1
        backend.app = None
        backend.focus = None
        backend.true = 99
        backend.attributes = {name: name for name in ('AXFocusedApplication', 'AXFocusedUIElement', 'AXManualAccessibility')}
        backend.equal = lambda a, b: getattr(a, 'value', a) == getattr(b, 'value', b)
        backend.released = []
        backend.release = lambda value: backend.released.append(getattr(value, 'value', value))
        backend.timeout = lambda *args: 0
        backend.calls = []
        backend.enabled = False
        backend.current_app = 10
        backend.current_field = 20
        def copy(element, attribute, output):
            backend.calls.append((element, attribute))
            value = None
            if element == 1 and attribute == 'AXFocusedApplication': value = backend.current_app
            elif element == 10 and attribute == 'AXManualAccessibility': value = 99 if backend.enabled else 98
            elif element == 10 and attribute == 'AXFocusedUIElement' and backend.enabled: value = backend.current_field
            if value is None: return -25212
            module.C.cast(output, module.C.POINTER(module.C.c_void_p))[0] = value
            return 0
        backend.copy = copy
        def set_attribute(element, attribute, value):
            self.assertEqual((element, attribute, value), (10, 'AXManualAccessibility', 99))
            backend.enabled = True
            return 0
        backend.set_attribute = set_attribute
        return backend

    def test_electron_tree_is_enabled_before_reading_application_focus(self):
        backend = self.backend()
        self.assertTrue(hasattr(backend, 'prepare_accessibility'), 'request Electron accessibility before arming')
        backend.prepare_accessibility()
        self.assertTrue(backend.enabled)
        self.assertEqual(backend.focused_element(), 20)
        self.assertIn((10, 'AXFocusedUIElement'), backend.calls)
        self.assertNotIn((1, 'AXFocusedUIElement'), backend.calls)
        backend.current_app = 11
        with self.assertRaisesRegex(ValueError, 'application changed'):
            backend.focused_element()

    def test_missing_focus_remains_an_error_with_the_ax_code(self):
        backend = self.backend()
        self.assertTrue(hasattr(backend, 'prepare_accessibility'))
        backend.prepare_accessibility()
        backend.current_field = None
        with self.assertRaisesRegex(ValueError, 'AXFocusedUIElement.*-25212'):
            backend.focused_element()

    def test_slow_native_focus_read_cannot_emit_an_expired_pulse(self):
        backend = Backend()
        guard = module.Guard(backend)
        with patch.object(module.time, 'time', return_value=100):
            guard.handle({'op': 'arm', 'at': 100000})
        with patch.object(module.time, 'time', side_effect=[100, 101]):
            with self.assertRaisesRegex(ValueError, 'expired'):
                guard.handle({'op': 'pulse', 'kind': 'click', 'at': 100000})
        self.assertEqual(backend.events, [])

if __name__ == '__main__': unittest.main()
