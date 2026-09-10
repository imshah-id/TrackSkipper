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

if __name__ == '__main__': unittest.main()
