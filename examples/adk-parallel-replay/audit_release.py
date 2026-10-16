"""Verify PyPI artifacts against fetched upstream tags; never infer a fixed release."""
import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import subprocess
from urllib.request import urlopen
import zipfile
from packaging.version import Version

FIX = '7d3658ef1a1f61c4c18cc4781f6892460add960c'
FILES = ['flows/llm_flows/tools/_batch_executor.py',
         'flows/llm_flows/core/_function_call_postprocessor.py']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.unlink(missing_ok=True)
    def git(*words):
        return subprocess.check_output(['git', '-C', str(args.upstream), *words])
    metadata = json.load(urlopen('https://pypi.org/pypi/google-adk/json', timeout=30))
    rows = []
    for version in sorted(metadata['releases'], key=Version):
        if Version(version) < Version('2.11.0'):
            continue
        artifacts = metadata['releases'][version]
        wheels = [a for a in artifacts if a['filename'].endswith('.whl')]
        for artifact in wheels:
            data = urlopen(artifact['url'], timeout=60).read()
            digest = hashlib.sha256(data).hexdigest()
            if digest != artifact['digests']['sha256']:
                raise RuntimeError('PyPI digest mismatch')
            tag = 'v' + version
            revision = git('rev-parse', tag + '^{commit}').decode().strip()
            ancestry = subprocess.run(['git', '-C', str(args.upstream),
                                      'merge-base', '--is-ancestor', FIX, revision])
            if ancestry.returncode not in (0, 1):
                raise RuntimeError('Cannot establish ancestry')
            with zipfile.ZipFile(io.BytesIO(data)) as wheel:
                matches = {name: wheel.read('google/adk/' + name) ==
                           git('show', tag + ':src/google/adk/' + name) for name in FILES}
                marker = b'_keep_completed_responses' in wheel.read('google/adk/' + FILES[0])
            rows.append(dict(version=version, filename=artifact['filename'],
                             url=artifact['url'], sha256=digest,
                             uploaded=artifact['upload_time_iso_8601'], yanked=artifact['yanked'],
                             tag_revision=revision, fix_ancestor=ancestry.returncode == 0,
                             source_matches_tag=matches, completed_response_marker=marker,
                             verified_contains_fix=ancestry.returncode == 0 and all(matches.values()) and marker))
    fixed = [r for r in rows if r['verified_contains_fix'] and not r['yanked']]
    report = dict(schema_version=1, checked_at=datetime.now(timezone.utc).isoformat(),
                  fix_commit=FIX, pypi_latest=metadata['info']['version'],
                  first_verified_fixed_release=min(fixed, key=lambda r: r['uploaded'])['version'] if fixed else None,
                  artifacts=rows,
                  claim_ceiling='Tags must be fetched first. Checks published wheels >=2.11.0, exact affected source files and ancestry; behavioral qualification is separate.')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
