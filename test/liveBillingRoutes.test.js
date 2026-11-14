import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
test('actual billing routes expose the selected mode, deny anonymous charges and unsigned callbacks without provider calls', () => {
    const source = `
      import assert from 'node:assert/strict';
      import express from 'express';
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = () => { throw new Error('External provider calls forbidden in this test'); };
      const {default:router} = await import('./routes/billing.routes.js');
      const {billingWebhook} = await import('./utils/planBillingRuntime.js');
      const app = express();
      app.post('/api/billing/paypal/webhook', express.raw({type:'application/json'}), billingWebhook);
      app.use(express.json()); app.use('/api/billing', router);
      const server = app.listen(0,'127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      try {
        const base = 'http://127.0.0.1:'+server.address().port;
        const response = await nativeFetch(base+'/api/billing/config');
        const config = await response.json();
        const live = process.env.PAYPAL_LIVE_ENABLED === 'true';
        assert.equal(response.status, 200); assert.equal(config.sandbox, !live);
        assert.equal(config.enabled, live); assert.equal(config.capabilities.livePayments, live);
        assert.equal(config.protocolVersion, live ? 3 : 1);
        assert.equal((await nativeFetch(base+'/api/billing/orders', {method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
        assert.equal((await nativeFetch(base+'/api/billing/paypal/webhook', {method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,live ? 400 : 404);
        console.log(JSON.stringify({passed:true,live,financialRequests:0}));
      } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
    `;
    for (const live of ['false', 'true']) {
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15000,
            env: { ...process.env, NODE_ENV: 'test', APP_STAGE: 'development', MONGO_DB: 'bonzobyte_unit_tests',
                MONGO_URI: 'mongodb://127.0.0.1:27017/bonzobyte_unit_tests', JWT_SECRET: 'synthetic-only-no-real-account-secret',
                PAYPAL_LIVE_ENABLED: live, PAYPAL_SANDBOX_ENABLED: 'false', PAYPAL_MEMBERSHIP_ENABLED: 'false', BILLING_EMAIL_ENABLED: 'false',
                BILLING_LAB_ENABLED: '', ARCHIVES_ONLY: '', PAYPAL_LIVE_CLIENT_ID: 'synthetic-public-client',
                PAYPAL_LIVE_CLIENT_SECRET: 'synthetic-private-secret', PAYPAL_LIVE_WEBHOOK_ID: 'FIXTUREWEBHOOK12345' } });
        assert.equal(JSON.parse(output.trim().split('\n').at(-1)).passed, true);
    }
});
