import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGatewayServer } from '../server/index.mjs';
import {
  SlickPayGateway,
  WILAYAS_58,
  Invoice,
  MerchantInvoice,
} from '../server/slickpay-sdk.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, '..');

test('SlickPay Universal Gateway SDK - Suite complète & Audit Sécurité (Claude AI)', async (t) => {
  const { server, gateway } = createGatewayServer({
    mode: 'mock',
    webhookSecret: 'unit-test-secret-key-2026',
  });
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

  await t.test('2. Création de session Checkout B2B, protection PII sur /status/:id et Webhook signé HMAC', async () => {
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

    // Point 6 de l'audit : /api/slickpay/status/:id ne doit exposer AUCUNE donnée personnelle (customer, email, phone, NIF/RC)
    const statusRes = await fetch(`${baseUrl}/api/slickpay/status/${session.invoiceId}`);
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.status, 'pending');
    assert.equal(statusData.customer, undefined, 'Aucune PII ne doit fuiter sur /status/:id');
    assert.equal(statusData.rawResponse, undefined);

    // Point 3 de l'audit : Webhook sans signature HMAC doit être rejeté en 401
    const unauthWh = await fetch(`${baseUrl}/api/slickpay/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceId: session.invoiceId }),
    });
    assert.equal(unauthWh.status, 401);

    // Webhook avec signature HMAC valide doit passer en 200 et marquer la facture 'paid'
    const validSig = gateway.computeWebhookSignature(
      session.invoiceId,
      session.totals.totalCharge,
      'paid'
    );
    const authWh = await fetch(`${baseUrl}/api/slickpay/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SlickPay-Signature': validSig,
      },
      body: JSON.stringify({ invoiceId: session.invoiceId }),
    });
    assert.equal(authWh.status, 200);
    const whData = await authWh.json();
    assert.equal(whData.invoice.status, 'paid');
  });

  await t.test('3. Compatibilité directe de /api/checkout.php sur le serveur Node.js (Point 5 de l’audit)', async () => {
    const res = await fetch(`${baseUrl}/api/checkout.php`, {
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

    // Interdiction absolue de télécharger le code source PHP ou .htaccess en statique
    const phpGet = await fetch(`${baseUrl}/api/checkout.php`);
    assert.equal(phpGet.status, 404);
    const htaccessGet = await fetch(`${baseUrl}/.htaccess`);
    assert.equal(htaccessGet.status, 404);
  });

  await t.test('4. Verrouillage des prix côté serveur : Catalogue productId & Signature HMAC priceSignature (Point 1 de l’audit)', async () => {
    const strictGateway = new SlickPayGateway({
      mode: 'mock',
      webhookSecret: 'strict-price-secret',
      requirePriceSignature: true,
      catalog: {
        'plan-pro': { name: 'Pack Business Pro', unitPrice: 45000, deliveryFee: 500 },
      },
    });

    // A. Si un productId du catalogue est fourni, le prix falsifié par le client (100 DZD) est écrasé par le prix serveur (45 000 + 500 = 45 500 DZD)
    const catalogSession = await strictGateway.createCheckoutSession({
      productId: 'plan-pro',
      amount: 100, // tentative de fraude client
      quantity: 1,
      fullName: 'Amine Benali',
      email: 'client@exemple-dz.com',
      phone: '0550123456',
      wilaya: '16',
    });
    assert.equal(catalogSession.totals.totalChargeDzd, 45500);

    // B. Sans productId et sans signature HMAC valide, la requête est rejetée (400)
    await assert.rejects(
      () =>
        strictGateway.createCheckoutSession({
          productName: 'Produit Libre',
          amount: 100,
          fullName: 'Amine Benali',
          email: 'client@exemple-dz.com',
          phone: '0550123456',
          wilaya: '16',
        }),
      (err) => err.statusCode === 400 && err.message.includes('Signature de prix')
    );

    // C. Avec une signature HMAC valide générée par le marchand, le prix est accepté
    const validPriceSig = strictGateway.signProductPrice('Produit Signé', 12500, 0);
    const signedSession = await strictGateway.createCheckoutSession({
      productName: 'Produit Signé',
      amount: 12500,
      priceSignature: validPriceSig,
      fullName: 'Amine Benali',
      email: 'client@exemple-dz.com',
      phone: '0550123456',
      wilaya: '16',
    });
    assert.equal(signedSession.totals.totalChargeDzd, 12500);
  });

  await t.test('5. Chemins réels API Sandbox & Production avec fetch mocké, livraison dans items[] et non-fallback status (Points 2 & 3)', async () => {
    const capturedRequests = [];
    const mockFetch = async (url, options = {}) => {
      capturedRequests.push({ url, options });
      if (url.endsWith('/users/invoices/commission')) {
        return new Response(
          JSON.stringify({ success: 1, amount: 10000, commission: 100, total: 10100 }),
          { status: 200 }
        );
      }
      if (options.method === 'POST' && url.includes('/invoices')) {
        return new Response(
          JSON.stringify({
            success: 1,
            id: 987654,
            url: 'https://satim.slick-pay.com/payment/TEST987654',
          }),
          { status: 200 }
        );
      }
      if (options.method === 'GET' && url.includes('/invoices/987654')) {
        return new Response(
          JSON.stringify({
            success: 1,
            completed: 1,
            data: { payment_status: 'paid' },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ message: 'Upstream error' }), { status: 502 });
    };

    const liveGateway = new SlickPayGateway({
      mode: 'sandbox',
      publicKey: '54|SANDBOX_KEY',
      webhookSecret: 'live-secret',
      fetchImpl: mockFetch,
    });

    // Test création facture Sandbox avec frais de livraison (vérifie que items[] contient bien 2 lignes dont la livraison)
    const session = await liveGateway.createCheckoutSession({
      mode: 'mock', // tentative client d'imposer mock alors que allowClientConfigOverride=false
      productName: 'Pack Cloud',
      amount: 10000,
      quantity: 2,
      deliveryFee: 600,
      fullName: 'Amine',
      email: 'client@exemple-dz.com',
      phone: '0550123456',
      wilaya: '16',
      address: 'Alger',
    });

    assert.equal(session.mode, 'sandbox', 'Le client ne peut pas forcer le mode mock');
    assert.equal(session.invoiceId, '987654');
    assert.equal(session.paymentUrl, 'https://satim.slick-pay.com/payment/TEST987654');

    const sentBody = JSON.parse(capturedRequests[0].options.body);
    assert.equal(sentBody.amount, 20600);
    assert.equal(sentBody.items.length, 2, 'La livraison doit figurer dans items[]');
    assert.equal(sentBody.items[0].price * sentBody.items[0].quantity + sentBody.items[1].price, 20600);
    assert.equal(sentBody.lastname, 'Amine');

    // Test vérification de statut distant (completed: 1 -> paid)
    const status = await liveGateway.getInvoiceStatus('987654');
    assert.equal(status.status, 'paid');

    // Si l'API distante tombe en panne (502), getInvoiceStatus DOIT lever une erreur et NE PAS renvoyer l'enregistrement local
    const failingGateway = new SlickPayGateway({
      mode: 'sandbox',
      publicKey: '54|SANDBOX_KEY',
      webhookSecret: 'live-secret',
      fetchImpl: async () => new Response('Bad Gateway', { status: 502 }),
    });
    failingGateway.storeInvoiceRecord('987654', { invoiceId: '987654', status: 'paid' });
    await assert.rejects(
      () => failingGateway.getInvoiceStatus('987654'),
      (err) => err.statusCode === 502
    );

    // Test classes drop-in Invoice et MerchantInvoice avec fetch mocké
    const invClient = new Invoice('54|SANDBOX_KEY', true, mockFetch);
    const comm = await invClient.commission(10000);
    assert.equal(comm.commission, 100);

    const merchClient = new MerchantInvoice('54|SANDBOX_KEY', false, mockFetch);
    const merchSession = await merchClient.store({
      productName: 'Produit Marchand',
      amount: 5000,
      fullName: 'Amine Benali',
      email: 'client@exemple-dz.com',
      phone: '0550123456',
      wilaya: '16',
    });
    assert.equal(merchSession.invoiceId, '987654');
  });

  await t.test('6. Validation stricte : téléphone algérien, wilaya 01-58, plafonds et refus de production sans secret', async () => {
    // Refus de démarrer en production sans SLICKPAY_WEBHOOK_SECRET
    assert.throws(
      () => new SlickPayGateway({ mode: 'production', publicKey: 'prod-key', webhookSecret: '' }),
      /SLICKPAY_WEBHOOK_SECRET est obligatoire/
    );

    const res = await fetch(`${baseUrl}/api/slickpay/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: 50,
        quantity: 5000,
        fullName: '',
        email: 'invalide',
        phone: '12345678', // faux numéro ne commençant pas par 05/06/07/02..04/+213
        wilaya: '99',      // wilaya hors 01..58
      }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.ok(data.validationErrors.length >= 5);
  });

  await t.test('7. Protection XSS (escapeHtml & sanitizeUrl) et compatibilité CSP dans le Widget', async () => {
    const res = await fetch(`${baseUrl}/sdk/slickpay-widget.js`);
    assert.equal(res.status, 200);
    const js = await res.text();
    assert.ok(js.includes('function escapeHtml'));
    assert.ok(js.includes('function sanitizeUrl'));
    assert.ok(js.includes('captureCurrentInputs'));
    assert.ok(js.includes('aria-labelledby="sp-modal-title"'));
    assert.ok(js.includes('role="alert"'));

    const filesToCheck = [
      path.join(ROOT_DIR, 'public', 'index.html'),
      path.join(ROOT_DIR, 'public', 'playground.js'),
      path.join(ROOT_DIR, 'public', 'sdk', 'slickpay-widget.js'),
    ];
    for (const file of filesToCheck) {
      const content = fs.readFileSync(file, 'utf8');
      assert.equal(/<style[\s>]/i.test(content), false);
      assert.equal(/\sstyle\s*=\s*["']/i.test(content), false);
    }
  });

  await t.test('8. Conformité de la licence et anonymisation des formulaires', async () => {
    const licenseContent = fs.readFileSync(path.join(ROOT_DIR, 'LICENSE'), 'utf8');
    assert.ok(licenseContent.includes('GHEMRI M'));
    assert.ok(licenseContent.includes('contact@connect-gm.com'));
    assert.ok(licenseContent.includes('USAGE PROPRE UNIQUEMENT'));

    const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'public', 'index.html'), 'utf8');
    assert.equal(/napoli/i.test(indexHtml), false);
    assert.ok(indexHtml.includes('Boutique Demo DZ'));
  });
});
