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

test('SlickPay Universal Gateway SDK - Suite de tests unitaires et d’intégration', async (t) => {
  const { server, gateway } = createGatewayServer({
    mode: 'mock',
    webhookSecret: 'unit-test-secret-key-2026',
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  t.after(() => server.close());

  await t.test('1. Liste des 58 wilayas complète (01 à 58)', async () => {
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

  await t.test('2. Création de session Checkout B2B, confidentialité sur /status/:id et Webhook signé HMAC', async () => {
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

    // /api/slickpay/status/:id ne doit exposer aucune donnée personnelle du client
    const statusRes = await fetch(`${baseUrl}/api/slickpay/status/${session.invoiceId}`);
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.status, 'pending');
    assert.equal(statusData.customer, undefined);
    assert.equal(statusData.rawResponse, undefined);

    // Webhook sans signature HMAC rejeté en 401
    const unauthWh = await fetch(`${baseUrl}/api/slickpay/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceId: session.invoiceId }),
    });
    assert.equal(unauthWh.status, 401);

    // Webhook avec signature HMAC valide accepté en 200
    const validSig = gateway.computeWebhookSignature(
      session.localInvoiceRef,
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

    // Vérification de la page /payment-return après paiement
    const returnPage = await fetch(`${baseUrl}/payment-return?invoiceId=${session.invoiceId}`);
    assert.equal(returnPage.status, 200);
    const returnHtml = await returnPage.text();
    assert.ok(returnHtml.includes('Payé (Confirmé)'));
  });

  await t.test('3. Compatibilité de la route /api/checkout.php sur Node.js et blocage des fichiers statiques non autorisés', async () => {
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

    const phpGet = await fetch(`${baseUrl}/api/checkout.php`);
    assert.equal(phpGet.status, 404);
    const htaccessGet = await fetch(`${baseUrl}/.htaccess`);
    assert.equal(htaccessGet.status, 404);
  });

  await t.test('4. Verrouillage des prix côté serveur (Catalogue productId, Signature HMAC et défaut Production)', async () => {
    const prodGateway = new SlickPayGateway({
      mode: 'production',
      publicKey: '54|PROD_KEY',
      webhookSecret: 'strict-prod-secret',
      defaultReturnUrl: 'https://maboutique.dz/payment-return',
      allowedReturnHosts: ['maboutique.dz'],
      catalog: {
        'plan-pro': { name: 'Pack Business Pro', unitPrice: 45000, deliveryFee: 500 },
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: 1,
            id: 777111,
            url: 'https://satim.slick-pay.com/payment/PROD777111',
          }),
          { status: 200 }
        ),
    });

    // En production, requirePriceSignature est activé par défaut
    assert.equal(prodGateway.requirePriceSignature, true);

    // A. Avec productId du catalogue, le prix client est ignoré au profit du prix serveur
    const catalogSession = await prodGateway.createCheckoutSession({
      productId: 'plan-pro',
      amount: 100,
      quantity: 1,
      fullName: 'Amine Benali',
      email: 'client@exemple-dz.com',
      phone: '0550123456',
      wilaya: '16',
    });
    assert.equal(catalogSession.totals.totalChargeDzd, 45500);

    // B. Sans productId et sans signature HMAC valide, la requête est rejetée en 400
    await assert.rejects(
      () =>
        prodGateway.createCheckoutSession({
          productName: 'Produit Libre',
          amount: 100,
          fullName: 'Amine Benali',
          email: 'client@exemple-dz.com',
          phone: '0550123456',
          wilaya: '16',
        }),
      (err) => err.statusCode === 400 && err.message.includes('Signature de prix')
    );

    // C. Avec une signature HMAC valide, la création réussit
    const validPriceSig = prodGateway.signProductPrice('Produit Signé', 12500, 0);
    const signedSession = await prodGateway.createCheckoutSession({
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

  await t.test('5. Cohérence du Webhook HMAC entre localInvoiceRef et remoteId en mode API réel (Sandbox/Production)', async () => {
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
      webhookUrl: 'https://maboutique.dz/api/webhook',
      fetchImpl: mockFetch,
    });

    const session = await liveGateway.createCheckoutSession({
      mode: 'mock',
      webhookUrl: 'https://evil-attacker.com/steal-webhook', // Doit être ignoré par le serveur !
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

    assert.equal(session.mode, 'sandbox');
    assert.equal(session.invoiceId, '987654');
    assert.ok(session.localInvoiceRef.startsWith('sp_'));

    const sentBody = JSON.parse(capturedRequests[0].options.body);
    assert.equal(sentBody.webhook_url, 'https://maboutique.dz/api/webhook', 'webhookUrl client ignoré');
    assert.equal(sentBody.amount, 20600);
    assert.equal(sentBody.items.length, 2);

    // Vérification critique : la signature webhook_signature envoyée à SlickPay (calculée sur localInvoiceRef)
    // doit être acceptée par markInvoicePaid même quand on l'appelle avec l'ID distant '987654' !
    const paidResult = liveGateway.markInvoicePaid('987654', sentBody.webhook_signature);
    assert.equal(paidResult.status, 'paid');
    assert.equal(paidResult.invoiceId, '987654');

    // Test classes Invoice et MerchantInvoice : refus en mode production (sandbox=false) sans webhookSecret
    assert.throws(
      () => new MerchantInvoice('54|PROD_KEY', false),
      /SLICKPAY_WEBHOOK_SECRET est obligatoire/
    );

    const merchClient = new MerchantInvoice('54|PROD_KEY', false, {
      webhookSecret: 'merch-prod-secret',
      fetchImpl: mockFetch,
    });
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

  await t.test('6. Validation stricte : téléphone algérien, wilaya 01-58, champs personnalisés et plafonds', async () => {
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
        phone: '12345678',
        wilaya: '99',
        customFields: {
          'bad-key!': 'val',
        },
      }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.ok(data.validationErrors.length >= 6);
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
