import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function submissionAllowed({ eventName, ref, payload }) {
  if (eventName !== 'workflow_dispatch' || ref !== 'refs/heads/main') return false;
  if (!payload || payload.host !== 'onceexec.com' || payload.key !== 'e7446e8ebe87241334541be52e68eacd' || payload.keyLocation !== `https://onceexec.com/${payload.key}.txt`) return false;
  if (!Array.isArray(payload.urlList) || payload.urlList.length < 1 || payload.urlList.length > 10000) return false;
  return payload.urlList.every(value => {
    if (typeof value !== 'string') return false;
    try { const url = new URL(value); return url.protocol === 'https:' && url.host === payload.host && !url.username && !url.password; }
    catch { return false; }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const payload = JSON.parse(readFileSync('indexnow-payload.json', 'utf8'));
  if (!submissionAllowed({ eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF, payload })) throw Error('IndexNow submission blocked: explicit main-branch dispatch and complete canonical payload required.');
  console.log('Explicit manual IndexNow submission eligible.');
}
