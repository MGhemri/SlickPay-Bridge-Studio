import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayServer } from '../server/index.mjs';
import { WILAYAS_58 } from '../server/slickpay-sdk.mjs';

test('SlickPay Universal Gateway SDK - Suite de tests complète', async (t) => {
  const { server } = createGatewayServer({ mode: 'mock' });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  t.after(() => server.close());

  await t.test('1. Liste des 58 wilayas complète (y compris wilayas 41 à 58)', async () => {
    assert.equal(WILAYAS_58.length, 58);
    const res = await fetch(`${baseUrl}/api/slickpay/wilayas`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.count, 58);
    const tipaza = data.wilayas.find((w) => w.code === '42');
    assert.equal(tipaza.name, 'Tipaza');
    const elMeniaa = data.wilayas.find((w) => w.code === '58');
    assert.equal(elMeniaa.name, 'El Meniaa');
  });

  await t.test('2. Création de session Checkout B2B (45 000 DZD x 2 + NIF/RC)', async () => {
    const res = await fetch(`${baseUrl}/api/slickpay/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productName: 'Pack Business Pro',
        amount: 45000,
        quantity: 2,
        wilaya: '16',
        address: 'Alger Centre',
        fullName: 'Amine Benali',
        email: 'client@exemple-dz.com',
        phone: '0550123456',
        customFields: {
          nif: '002616001234567',
          rc: '16/00-1234567B26',
        },
      }),
    });

    assert.equal(res.status, 201);
    const session = await res.json();
    assert.equal(session.ok, true);
    assert.ok(session.paymentUrl.startsWith('https://cib.satim.dz/payment/epg/merchants/merchantsatim/payment.html?mdOrder='));
    assert.equal(session.totals.totalChargeDzd, 90000);
    assert.equal(session.totals.totalCharge, 9000000); // en centimes (format Server Action SlickPay)
    assert.equal(session.customer.customFields.nif, '002616001234567');

    // Vérification du statut initial (pending)
    const statusRes = await fetch(`${baseUrl}/api/slickpay/status/${session.invoiceId}`);
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.status, 'pending');

    // Simulation Webhook de confirmation de paiement
    const whRes = await fetch(`${baseUrl}/api/slickpay/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceId: session.invoiceId }),
    });
    assert.equal(whRes.status, 200);
    const whData = await whRes.json();
    assert.equal(whData.invoice.status, 'paid');
    assert.ok(whData.invoice.webhookSignature);
  });

  await t.test('3. Validation stricte des champs obligatoires (< 100 DZD ou email invalide)', async () => {
    const res = await fetch(`${baseUrl}/api/slickpay/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: 50,
        fullName: '',
        email: 'invalide',
        phone: '123',
      }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.ok(Array.isArray(data.validationErrors));
    assert.equal(data.validationErrors.length, 4);
  });

  await t.test('4. Distribution du script Web Component /sdk/slickpay-widget.js', async () => {
    const res = await fetch(`${baseUrl}/sdk/slickpay-widget.js`);
    assert.equal(res.status, 200);
    const js = await res.text();
    assert.ok(js.includes("customElements.define('slickpay-button'"));
  });
});
