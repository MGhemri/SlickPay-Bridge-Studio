import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGatewayServer } from '../server/index.mjs';
import { WILAYAS_58, Invoice, MerchantInvoice } from '../server/slickpay-sdk.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');

test('SlickPay Universal Gateway SDK - Suite de tests & Garde-fous CI/CD', async (t) => {
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
    assert.ok(
      session.paymentUrl.startsWith(
        'https://cib.satim.dz/payment/epg/merchants/merchantsatim/payment.html?mdOrder='
      )
    );
    assert.equal(session.totals.totalChargeDzd, 90000);
    assert.equal(session.totals.totalCharge, 9000000);
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

  await t.test('3. Support du nom en un seul mot (prévention erreur 422 SlickPay lastname)', async () => {
    const res = await fetch(`${baseUrl}/api/slickpay/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productName: 'Abonnement Starter',
        amount: 4500,
        quantity: 1,
        wilaya: '16',
        address: 'Alger',
        fullName: 'Amine',
        email: 'client@exemple-dz.com',
        phone: '0550 12 34 56',
      }),
    });
    assert.equal(res.status, 201);
    const session = await res.json();
    assert.equal(session.ok, true);
  });

  await t.test('4. Validation stricte des champs obligatoires (< 100 DZD ou email invalide)', async () => {
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

  await t.test('5. Distribution du script Web Component /sdk/slickpay-widget.js et API SlickPay.init', async () => {
    const res = await fetch(`${baseUrl}/sdk/slickpay-widget.js`);
    assert.equal(res.status, 200);
    const js = await res.text();
    assert.ok(js.includes("customElements.define('slickpay-button'"));
    assert.ok(js.includes('init: function'));
    assert.ok(js.includes('[data-slickpay]'));
  });

  await t.test('6. Compatibilité CSP stricte : aucun attribut style="..." ni <style> inline dans public/', async () => {
    const filesToCheck = [
      path.join(ROOT_DIR, 'public', 'index.html'),
      path.join(ROOT_DIR, 'public', 'playground.js'),
      path.join(ROOT_DIR, 'public', 'sdk', 'slickpay-widget.js'),
    ];
    for (const file of filesToCheck) {
      const content = fs.readFileSync(file, 'utf8');
      assert.equal(
        /<style[\s>]/i.test(content),
        false,
        `Balise <style> inline interdite pour CSP dans ${path.basename(file)}`
      );
      assert.equal(
        /\sstyle\s*=\s*["']/i.test(content),
        false,
        `Attribut style="..." inline interdit pour CSP dans ${path.basename(file)}`
      );
    }
  });

  await t.test('7. Conformité de la licence et anonymisation des formulaires', async () => {
    const licenseContent = fs.readFileSync(path.join(ROOT_DIR, 'LICENSE'), 'utf8');
    assert.ok(licenseContent.includes('GHEMRI M'));
    assert.ok(licenseContent.includes('0549 77 73 66'));
    assert.ok(licenseContent.includes('contact@connect-gm.com'));
    assert.ok(licenseContent.includes('USAGE PROPRE UNIQUEMENT'));

    const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'public', 'index.html'), 'utf8');
    assert.equal(/napoli/i.test(indexHtml), false, 'Aucune référence projet tiers dans index.html');
    assert.ok(indexHtml.includes('Boutique Demo DZ'));
  });

  await t.test('8. Classes drop-in Invoice et MerchantInvoice exportées', () => {
    assert.equal(typeof Invoice, 'function');
    assert.equal(typeof MerchantInvoice, 'function');
  });
});
