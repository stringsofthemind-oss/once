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
    for item in evidence['scenarios']:
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
            assert recovered['result'] == {'ticket_id': 1, 'effect': item['provider_effects'][0]['effect']}
    controls = evidence['lookup_controls']
    assert controls['mismatched_lookup'] == controls['duplicate_lookup'] == {'status': 'UNKNOWN'}
    assert len(controls['provider_effects']) == 3 and controls['deliberate_bypass_effects'] == 1
    assert [row['operation'] for row in controls['provider_effects']] == ['host-ticket-intent-001', 'host-ticket-intent-002', 'host-ticket-intent-001']
    print(filename + ': evidence checks PASS')
if len(sys.argv) == 1:
    raise SystemExit('Usage: python check_evidence.py evidence.json [more.json ...]')
