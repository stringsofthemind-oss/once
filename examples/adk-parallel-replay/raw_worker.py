"""Disposable unprotected control. One POST only, never an automatic retry."""
import json
import os
import sys
from urllib.request import Request, urlopen

request = json.load(sys.stdin)
with urlopen(Request(request['url'] + '/tickets',
                     data=json.dumps(request['payload']).encode(),
                     headers={'Content-Type': 'application/json'}), timeout=5) as response:
    receipt = json.load(response)
if request['mode'] == 'crash':
    os._exit(71)
print(json.dumps({'status': 'UNKNOWN'} if request['mode'] == 'lost-ack'
                 else {'status': 'CONFIRMED', 'result': receipt}))
