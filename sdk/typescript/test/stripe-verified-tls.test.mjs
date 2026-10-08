import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import pg from 'pg';
import { verifiedDatabaseConfig } from '../examples/stripe-sandbox-refund/verified-database.mjs';
test('host DSN cannot disable verified TLS or expose malformed credentials',()=>{
 const config=verifiedDatabaseConfig('postgresql://fixture:synthetic@db.example/once');
 assert.equal(config.connectionString,undefined);
 assert.deepEqual(new pg.Client(config).connectionParameters.ssl,{rejectUnauthorized:true});
 for(const suffix of ['?sslmode=disable','?sslmode=no-verify','?sslmode=require','?ssl=false','#fragment']) {
  assert.throws(()=>verifiedDatabaseConfig(`postgresql://fixture:synthetic@db.example/once${suffix}`),error=>!inspect(error).includes('synthetic'));
 }
 assert.throws(()=>verifiedDatabaseConfig('malformed-synthetic-secret'),error=>!inspect(error).includes('synthetic'));
});
