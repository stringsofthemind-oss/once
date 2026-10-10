"""Deterministic ADK #7428 regression, loopback effects only; no model credentials."""
import argparse
import asyncio
import importlib.metadata
import json
import logging
import hashlib
from contextlib import closing
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen, url2pathname
from urllib.parse import urlparse

parser = argparse.ArgumentParser()
parser.add_argument('--adk-src', type=Path, help='Optional pinned upstream src directory')
parser.add_argument('--expect-kept', action='store_true')
parser.add_argument('--label', default='google-adk-2.11.0')
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--sdk-url', help='Optional packed/published SDK file URL')
args = parser.parse_args()
if not __debug__:
    raise SystemExit('Assertions are required; do not use python -O')
# A failed rerun must not leave an old PASS artifact at the requested path.
args.output.unlink(missing_ok=True)
if args.adk_src:
    if not (args.adk_src / 'google/adk/runners.py').is_file():
        raise SystemExit('ADK source directory not found: ' + str(args.adk_src))
    sys.path.insert(0, str(args.adk_src.resolve()))

import google.adk
from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.genai import types
from pydantic import PrivateAttr

logging.disable(logging.CRITICAL)  # Expected sibling errors are asserted below.

HERE = Path(__file__).resolve().parent
OPERATION = 'host-ticket-intent-001'
EFFECT = {'tool': 'fixture.tenant-A.create_ticket', 'args': {'project': 'disposable', 'title': 'disk full'}}


class Provider:
    """Independent provider journal: commits every POST, with no deduplication."""
    def __init__(self, root):
        self.path = root / 'provider.sqlite'
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('CREATE TABLE effects (id INTEGER PRIMARY KEY, operation TEXT, effect TEXT)')
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                with closing(sqlite3.connect(owner.path)) as db, db:
                    if self.path == '/tickets':
                        row = db.execute('INSERT INTO effects(operation,effect) VALUES (?,?)',
                                         (payload['operationId'], json.dumps(payload['effect'], sort_keys=True)))
                        ticket_id = row.lastrowid
                        db.commit()  # External effect is durable before responding.
                        result = {'ticket_id': ticket_id, 'effect': payload['effect']}
                    elif self.path == '/lookup':
                        rows = db.execute('SELECT id,effect FROM effects WHERE operation=?',
                                          (payload['operationId'],)).fetchall()
                        result = {'status': 'UNKNOWN'}
                        if len(rows) == 1 and json.loads(rows[0][1]) == payload['effect']:
                            result = {'status': 'CONFIRMED', 'result': {
                                'ticket_id': rows[0][0], 'effect': json.loads(rows[0][1])}}
                    else:
                        self.send_error(404)
                        return
                body = json.dumps(result).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def rows(self):
        # The verifier reads provider truth separately from the Once response.
        with closing(sqlite3.connect(self.path)) as db:
            return [{'ticket_id': row[0], 'operation': row[1], 'effect': json.loads(row[2])}
                    for row in db.execute('SELECT id,operation,effect FROM effects ORDER BY id')]

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class Boundary:
    def __init__(self, root, provider):
        self.state = root / 'once.sqlite'
        self.provider = provider
        self.expected = False
        self.pids = []

    def call(self, effect=EFFECT, **changes):
        request = dict(operationId=OPERATION, effect=effect, statePath=str(self.state),
                       providerUrl=self.provider.url, expectedState=self.expected,
                       metadata={'transport_attempt': len(self.pids) + 1})
        if args.sdk_url:
            request['sdkUrl'] = args.sdk_url
        request.update(changes)
        child = subprocess.Popen(['node', str(HERE / 'boundary.mjs')], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.pids.append(child.pid)
        try:
            stdout, stderr = child.communicate(json.dumps(request), timeout=15)
        except subprocess.TimeoutExpired:
            child.kill()
            child.communicate()
            raise
        self.expected = self.expected or self.state.exists()
        if request.get('mode') == 'crash':
            assert child.returncode == 71, (stdout, stderr)
            return {'status': 'CRASHED'}
        assert child.returncode == 0, (stdout, stderr)
        return json.loads(stdout)


class ScriptedModel(BaseLlm):
    """First parallel call; next turn repeats only when history lacks success."""
    force: bool = False
    replay_title: str = 'disk full'
    _calls: int = PrivateAttr(default=0)
    _requests: list = PrivateAttr(default_factory=list)

    async def generate_content_async(self, llm_request, stream=False):
        self._calls += 1
        responses = [p.function_response for c in llm_request.contents for p in c.parts or []
                     if p.function_response]
        self._requests.append([r.model_dump(mode='json') for r in responses])
        success = any(r.name == 'create_ticket' and r.response.get('status') == 'CONFIRMED'
                      for r in responses)
        call = types.Part.from_function_call
        if self._calls == 1:
            parts = [call(name='create_ticket', args={'title': 'disk full'}),
                     call(name='notify_oncall', args={'message': 'disk full'})]
        elif self._calls == 2 and (self.force or not success):
            parts = [call(name='create_ticket', args={'title': self.replay_title})]
        else:
            parts = [types.Part(text='finished')]
        # Attempt identity deliberately differs from host logical identity.
        for i, part in enumerate(parts):
            if part.function_call:
                part.function_call.id = f'attempt-{self._calls}-{i}'
        yield LlmResponse(content=types.Content(role='model', parts=parts))


async def run_adk(root, protected, force=False, mode='confirmed', changed=False):
    provider = Provider(root)
    boundary = Boundary(root, provider)
    tool_finished = asyncio.Event()
    tool_results = []
    model = ScriptedModel(model='scripted', force=force,
                          replay_title='changed' if changed else 'disk full')

    async def create_ticket(title: str) -> dict:
        effect = {'tool': EFFECT['tool'], 'args': {**EFFECT['args'], 'title': title}}
        if protected:
            result = await asyncio.to_thread(boundary.call, effect,
                                             mode=mode if not tool_results else 'confirmed')
            if result['status'] == 'CRASHED':
                result = {'status': 'UNKNOWN'}  # Host cannot know crash outcome.
        else:
            def raw():
                request = Request(provider.url + '/tickets', data=json.dumps({
                    'operationId': OPERATION, 'effect': effect}).encode(),
                    headers={'Content-Type': 'application/json'})
                with urlopen(request, timeout=5) as response:
                    return {'status': 'CONFIRMED', 'result': json.load(response)}
            result = await asyncio.to_thread(raw)
        tool_results.append(result)
        tool_finished.set()
        return result

    async def notify_oncall(message: str) -> dict:
        # Event handshake, no sleep-based ordering. The create task completes
        # before this waiter is resumed by the event loop.
        await asyncio.wait_for(tool_finished.wait(), timeout=10)
        raise RuntimeError('pager service returned 500')

    agent = LlmAgent(name='ops', model=model, tools=[create_ticket, notify_oncall])
    runner = InMemoryRunner(agent=agent, app_name='repro')
    session = await runner.session_service.create_session(app_name='repro', user_id='u')
    async def turn(text):
        async for _ in runner.run_async(user_id='u', session_id=session.id,
                                        new_message=types.Content(role='user', parts=[types.Part(text=text)])):
            pass
    try:
        try:
            await turn('Open a ticket and page on-call.')
            raise AssertionError('Expected original sibling error')
        except RuntimeError as error:
            assert str(error) == 'pager service returned 500', str(error)
        session = await runner.session_service.get_session(app_name='repro', user_id='u', session_id=session.id)
        first_responses = [r.model_dump(mode='json') for e in session.events for r in e.get_function_responses()]
        assert len(provider.rows()) == 1
        assert len(first_responses) == int(args.expect_kept), first_responses
        if first_responses:
            assert first_responses[0]['name'] == 'create_ticket'
        await turn('Please finish the task.')
        repeated = force or not args.expect_kept
        expected_effects = 1 if protected else 1 + int(repeated)
        assert len(provider.rows()) == expected_effects, provider.rows()
        assert len(tool_results) == 1 + int(repeated)
        if repeated and protected:
            if changed:
                assert tool_results[1]['status'] == 'CONFLICT', tool_results
            elif mode != 'confirmed':
                assert all(r['status'] == 'UNKNOWN' for r in tool_results), tool_results
            else:
                assert tool_results[0] == tool_results[1]
            assert len(set(boundary.pids)) == 2
        # Verify what ADK actually put in the next model request.
        next_has_success = any(r['name'] == 'create_ticket' for r in model._requests[1])
        assert next_has_success == args.expect_kept, model._requests
        return dict(protected=protected, forced=force, mode=mode, changed=changed,
                    first_responses=first_responses,
                    next_request_responses=model._requests[1], tool_results=tool_results,
                    provider_effects=provider.rows(), boundary_processes=len(boundary.pids))
    finally:
        await runner.close()
        provider.close()


def safety_cases(root):
    evidence = []
    for mode in ['confirmed', 'lost-ack', 'crash']:
        case = root / mode
        case.mkdir()
        provider = Provider(case)
        boundary = Boundary(case, provider)
        probes = []
        def probe(effect=EFFECT, **changes):
            before = len(provider.rows())
            result = boundary.call(effect, **changes)
            after = len(provider.rows())
            assert after == before, (changes, result, before, after)
            probes.append(dict(request=changes, effect=effect, response=result,
                               effects_before=before, effects_after=after))
            return result
        try:
            first = boundary.call(mode=mode)
            assert first['status'] == {'confirmed': 'CONFIRMED', 'lost-ack': 'UNKNOWN', 'crash': 'CRASHED'}[mode]
            retry = boundary.call()
            assert retry['status'] == ('CONFIRMED' if mode == 'confirmed' else 'UNKNOWN'), retry
            if mode == 'confirmed':
                assert first == retry
            for effect in [
                {'tool': EFFECT['tool'], 'args': {**EFFECT['args'], 'title': 'changed'}},
                {'tool': EFFECT['tool'], 'args': {**EFFECT['args'], 'project': 'other'}},
                {'tool': 'fixture.tenant-B.create_ticket', 'args': EFFECT['args']},
            ]:
                assert probe(effect)['status'] == 'CONFLICT'
            if mode != 'confirmed':
                for truth in ['UNKNOWN', 'NOT_FOUND']:
                    assert probe(reconcile=truth)['status'] == 'UNKNOWN'
                recovered = probe(reconcile='provider')
                assert recovered['status'] == 'CONFIRMED'
                assert recovered['result'] == {'ticket_id': 1, 'effect': EFFECT}
                assert probe() == recovered
            assert len(provider.rows()) == 1
            assert probe(operationId='')['status'] == 'IDENTITY_REQUIRED'
            before = len(provider.rows())
            # A missing expected authority must never silently become a new DB.
            boundary.state.rename(case / 'saved.sqlite')
            assert probe()['status'] == 'STATE_UNAVAILABLE'
            assert not boundary.state.exists()
            assert len(provider.rows()) == before
            evidence.append(dict(mode=mode, first=first, retry=retry,
                                 conflicts=3, provider_effects=provider.rows(),
                                 boundary_processes=len(boundary.pids), missing_state='STATE_UNAVAILABLE'))
            evidence[-1]['probes'] = probes
        finally:
            provider.close()
    return evidence


def lookup_controls(root):
    """Falsification controls for complete-effect matching and fresh intents."""
    root.mkdir()
    provider = Provider(root)
    boundary = Boundary(root, provider)
    def lookup(effect):
        request = Request(provider.url + '/lookup', data=json.dumps({
            'operationId': OPERATION, 'effect': effect}).encode(),
            headers={'Content-Type': 'application/json'})
        with urlopen(request, timeout=5) as response:
            return json.load(response)
    try:
        first = boundary.call()
        assert first['status'] == 'CONFIRMED'
        mismatched = lookup({'tool': EFFECT['tool'], 'args': {**EFFECT['args'], 'title': 'other'}})
        assert mismatched == {'status': 'UNKNOWN'}
        fresh = boundary.call(operationId='host-ticket-intent-002')
        assert fresh['status'] == 'CONFIRMED' and fresh['result']['ticket_id'] == 2
        # Deliberate out-of-bound write to challenge the lookup's uniqueness gate.
        request = Request(provider.url + '/tickets', data=json.dumps({
            'operationId': OPERATION, 'effect': EFFECT}).encode(),
            headers={'Content-Type': 'application/json'})
        with urlopen(request, timeout=5) as response:
            json.load(response)
        duplicate = lookup(EFFECT)
        assert duplicate == {'status': 'UNKNOWN'}
        assert len(provider.rows()) == 3
        return dict(mismatched_lookup=mismatched, duplicate_lookup=duplicate,
                    fresh_intent=fresh, provider_effects=provider.rows(),
                    deliberate_bypass_effects=1)
    finally:
        provider.close()


async def main():
    with tempfile.TemporaryDirectory(prefix='once-adk-') as directory:
        root = Path(directory)
        scenarios = []
        for protected, force, mode, changed in [
            (False, False, 'confirmed', False), (True, False, 'confirmed', False),
            (False, True, 'confirmed', False), (True, True, 'confirmed', False),
            (True, True, 'confirmed', True), (True, True, 'lost-ack', False),
            (True, True, 'crash', False),
        ]:
            case = root / f'adk-{protected}-{force}-{mode}-{changed}'
            case.mkdir()
            scenarios.append(await asyncio.wait_for(
                run_adk(case, protected, force, mode, changed), timeout=40))
        sdk_path = Path(url2pathname(urlparse(args.sdk_url).path)) if args.sdk_url else HERE.parent.parent / 'sdk/typescript/dist/index.js'
        source_revision = subprocess.check_output(['git', '-C', str(args.adk_src), 'rev-parse', 'HEAD'], text=True).strip() if args.adk_src else None
        evidence = dict(schema_version=1, status='PASS', label=args.label, adk_file=google.adk.__file__,
                        adk_source_revision=source_revision,
                        adk_runners_sha256=hashlib.sha256(Path(google.adk.__file__).with_name('runners.py').read_bytes()).hexdigest(),
                        sdk_entry_sha256=hashlib.sha256(sdk_path.read_bytes()).hexdigest(),
                        requirements_sha256=hashlib.sha256((HERE / 'requirements.lock.txt').read_bytes()).hexdigest(),
                        installed_adk_version=importlib.metadata.version('google-adk'),
                        python=sys.version, node=subprocess.check_output(['node', '--version'], text=True).strip(),
                        sdk=args.sdk_url or 'repository build', expect_kept=args.expect_kept,
                        scenarios=scenarios, safety=safety_cases(root),
                        lookup_controls=lookup_controls(root / 'lookup-controls'))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'label': args.label, 'status': 'PASS', 'adk_scenarios': len(scenarios),
                          'safety_cases': len(evidence['safety']), 'output': str(args.output)}))


if __name__ == '__main__':
    asyncio.run(main())
