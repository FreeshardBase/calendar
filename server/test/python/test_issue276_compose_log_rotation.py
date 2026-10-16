"""Issue #276: every shipped container caps its own json-file log.

Parses docker-compose.yml as Compose does (YAML) and checks the effective
`logging` config of each service, so a rotation block that is missing,
misspelled, or uncapped on any service fails.
"""

import os
import re
import unittest

import yaml

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
COMPOSE_PATH = os.path.join(ROOT_DIR, 'docker-compose.yml')
EXPECTED_SERVICES = {'webcalendar', 'caldav-server', 'sync-worker'}
SIZE_UNITS = {'k': 1024, 'm': 1024 ** 2, 'g': 1024 ** 3}


def parse_size(value):
    match = re.fullmatch(r'(\d+)([kmg])', str(value).strip().lower())
    if not match:
        raise ValueError(f'unparseable max-size {value!r}')
    return int(match.group(1)) * SIZE_UNITS[match.group(2)]


class ComposeLogRotationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(COMPOSE_PATH, encoding='utf-8') as handle:
            cls.services = yaml.safe_load(handle)['services']

    def test_all_shipped_services_are_covered(self):
        self.assertEqual(set(self.services), EXPECTED_SERVICES)

    def test_each_service_rotates_its_json_file_log(self):
        for name, service in self.services.items():
            with self.subTest(service=name):
                logging = service.get('logging')
                self.assertIsInstance(logging, dict, f'{name} has no logging block')
                self.assertEqual(logging.get('driver'), 'json-file')
                options = logging.get('options') or {}
                self.assertIn('max-size', options)
                self.assertIn('max-file', options)
                self.assertEqual(parse_size(options['max-size']), 10 * 1024 ** 2)
                self.assertEqual(int(options['max-file']), 3)

    def test_total_log_footprint_per_service_is_bounded(self):
        for name, service in self.services.items():
            with self.subTest(service=name):
                options = (service.get('logging') or {}).get('options') or {}
                total = parse_size(options.get('max-size', '0k')) * int(options.get('max-file', 0))
                self.assertGreater(total, 0, f'{name} log is not capped')
                self.assertLessEqual(total, 30 * 1024 ** 2)


if __name__ == '__main__':
    unittest.main()
