"""Read-only evidence structure and effect-count checker (no dependencies)."""
import json
import sys

if not __debug__:
    raise SystemExit('Assertions are required')
for filename in sys.argv[1:]:
    with open(filename, encoding='utf-8') as file:
        evidence = json.load(file)
    assert evidence['schema_version'] == 1 and evidence['status'] == 'PASS'
    assert len(evidence['scenarios']) == 7 and len(evidence['safety']) == 3
    assert {(s['protected'], s['forced'], s['mode'], s['changed']) for s in evidence['scenarios']} == {
        (False, False, 'confirmed', False), (True, False, 'confirmed', False),
        (False, True, 'confirmed', False), (True, True, 'confirmed', False),
        (True, True, 'confirmed', True), (True, True, 'lost-ack', False),
        (True, True, 'crash', False)}
    assert {s['mode'] for s in evidence['safety']} == {'confirmed', 'lost-ack', 'crash'}
    if 'recorded_at' in evidence:
        assert len(evidence['raw_controls']) == 3
        assert evidence['platform'] and evidence['dependencies'] and evidence['claim_ceiling']
    if 'raw_controls' in evidence:
        assert len(evidence['raw_controls']) == 3
        assert {s['mode'] for s in evidence['raw_controls']} == {'confirmed', 'lost-ack', 'crash'}
        for item in evidence['raw_controls']:
            count = 3 if item['mode'] == 'confirmed' else 1
            assert len(item['provider_effects']) == len(set(item['processes'])) == count
            assert item['ambiguous_retry_performed'] is False
            assert item['reconciled']['status'] == 'CONFIRMED'
            assert item['first']['status'] == ('CONFIRMED' if item['mode'] == 'confirmed' else 'UNKNOWN')
    for item in evidence['scenarios']:
        if 'once_revision' in evidence:
            assert item['logical_action_id'] == 'host-ticket-intent-001'
            attempts = item['model_attempts']
            assert len({a['id'] for a in attempts}) == len(attempts)
            assert all(a['id'] != item['logical_action_id'] for a in attempts)
        repeated = item['forced'] or not evidence['expect_kept']
        count = 1 if item['protected'] else 1 + int(repeated)
        assert len(item['provider_effects']) == count
        assert len(item['first_responses']) == int(evidence['expect_kept'])
        assert all(row['operation'] == 'host-ticket-intent-001' for row in item['provider_effects'])
        if item['protected'] and repeated:
            assert item['boundary_processes'] == 2
            if item['changed']:
                assert item['tool_results'][1]['status'] == 'CONFLICT'
            elif item['mode'] != 'confirmed':
                assert all(result['status'] == 'UNKNOWN' for result in item['tool_results'])
            else:
                assert item['tool_results'][0] == item['tool_results'][1]
    for item in evidence['safety']:
        assert len(item['provider_effects']) == 1
        assert item['missing_state'] == 'STATE_UNAVAILABLE'
        assert sum(probe['response']['status'] == 'CONFLICT' for probe in item['probes']) == 3
        for probe in item['probes']:
            assert probe['effects_before'] == probe['effects_after'] == 1
        if item['mode'] != 'confirmed':
            assert [probe['response']['status'] for probe in item['probes'] if probe['request'].get('reconcile') in ['UNKNOWN', 'NOT_FOUND']] == ['UNKNOWN', 'UNKNOWN']
            recovered = next(probe['response'] for probe in item['probes'] if probe['request'].get('reconcile') == 'provider')
            assert recovered['status'] == 'CONFIRMED'
            assert recovered['result'] == {'ticket_id': 1, 'effect': item['provider_effects'][0]['effect']}
            assert any(probe['request'] == {} and probe['response'] == recovered for probe in item['probes'])
    controls = evidence['lookup_controls']
    assert controls['mismatched_lookup'] == controls['duplicate_lookup'] == {'status': 'UNKNOWN'}
    assert len(controls['provider_effects']) == 3 and controls['deliberate_bypass_effects'] == 1
    assert [row['operation'] for row in controls['provider_effects']] == ['host-ticket-intent-001', 'host-ticket-intent-002', 'host-ticket-intent-001']
    print(filename + ': evidence checks PASS')
if len(sys.argv) == 1:
    raise SystemExit('Usage: python check_evidence.py evidence.json [more.json ...]')
