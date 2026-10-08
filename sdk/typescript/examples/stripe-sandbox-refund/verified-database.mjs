// Parse host-owned bindings without allowing pg's DSN parser to override TLS.
export function verifiedDatabaseConfig(binding) {
 try {
  const url = new URL(binding);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash || !url.hostname || !url.username || !url.password || !url.pathname.slice(1)) throw new Error();
  return {host:url.hostname,port:url.port ? Number(url.port) : 5432,user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),database:decodeURIComponent(url.pathname.slice(1)),ssl:{rejectUnauthorized:true},connectionTimeoutMillis:5000,query_timeout:10000};
 } catch { throw new Error('Invalid host-managed verified-TLS database binding; no connection attempted'); }
}
