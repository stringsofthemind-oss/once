"""Falsification checks against a newly generated report: python test_evidence.py REPORT."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile

source = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
checker = Path(__file__).with_name('check_evidence.py')
def check(value, expected):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'evidence.json'
        path.write_text(json.dumps(value), encoding='utf-8')
        result = subprocess.run([sys.executable, str(checker), str(path)], capture_output=True)
        if (result.returncode == 0) != expected:
            raise AssertionError(result.stderr.decode())
check(source, True)
mutations = [
    lambda e: e['scenarios'][1]['provider_effects'].append(e['scenarios'][1]['provider_effects'][0]),
    lambda e: e.pop('raw_controls'),
    lambda e: e['raw_controls'][1].update(ambiguous_retry_performed=True),
    lambda e: e['safety'][1]['probes'][0].update(effects_after=2),
    lambda e: e['lookup_controls'].update(duplicate_lookup={'status': 'CONFIRMED'}),
    lambda e: e['scenarios'].__setitem__(6, copy.deepcopy(e['scenarios'][5])),
]
for mutate in mutations:
    changed = copy.deepcopy(source)
    mutate(changed)
    check(changed, False)
print('PASS: valid report accepted; six falsified reports rejected')
