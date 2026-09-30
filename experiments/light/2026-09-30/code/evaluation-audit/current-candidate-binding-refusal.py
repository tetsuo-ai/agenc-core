"""Synthetic predicate-only gate; no client, build, provider, or contract output."""
import hashlib
from pathlib import Path
import subprocess
import sys
import unittest

HERE = Path('/private/tmp/light-takeover/fair-confirmation/prompt-binding-v2')
PINS = {
    'prompt_binding.py': '513a9eb249c593fb3bff7c2b69601ec5d2c6a141b9c2f5796b61b7144776c4e6',
    'test_prompt_binding.py': '2228c6b8d24d403384f38a1c1ac16fa7e46898ac540ad4f28d41ab4165443934',
}
for name, pin in PINS.items():
    if hashlib.sha256((HERE / name).read_bytes()).hexdigest() != pin:
        raise ValueError('frozen fixture changed')
sys.path.insert(0, str(HERE))
import prompt_binding as binding
from test_prompt_binding import fixture

REV = '28e21d055fa052f0f27810bd65f76fd8f6b1ce15'
REPO = '/private/tmp/light-takeover/startup-core'


class CurrentCandidateRefusal(unittest.TestCase):
    def test_all_four_old_profiles_accept_their_synthetic_preimage_then_refuse_actual_28e_pins(self):
        for name in binding.PROFILES:
            if not name.startswith('light-'):
                continue
            with self.subTest(profile=name):
                case = fixture(name)  # source recipe, never a captured request
                self.assertTrue(binding.bind_initial_request(**case)['binding_verified'])
                measured = {}
                for path in case['deployed_source_pins']:
                    raw = subprocess.check_output(['git', 'show', REV + ':' + path], cwd=REPO)
                    measured[path] = hashlib.sha256(raw).hexdigest()
                case['deployed_source_pins'] = measured
                self.assertEqual(binding.bind_initial_request(**case), {
                    'binding_verified': None,
                    'unknown_reason': 'deployed_source_pin_mismatch',
                })


if __name__ == '__main__':
    unittest.main(verbosity=2)
