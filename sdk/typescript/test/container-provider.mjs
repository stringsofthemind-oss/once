import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const path = '/tmp/provider.jsonl';
createServer(async (req,res) => {
  if (req.url === '/journal') { res.end(JSON.stringify(existsSync(path) ? readFileSync(path,'utf8').trim().split('\n').map(JSON.parse) : [])); return; }
  let text=''; for await (const chunk of req) text += chunk;
  const args = JSON.parse(text), receipt = { ...args, receipt: randomUUID() };
  appendFileSync(path, JSON.stringify(receipt)+'\n', { flush:true });
  res.end(JSON.stringify(receipt));
}).listen(8080,'0.0.0.0');
