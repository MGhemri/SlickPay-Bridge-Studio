/**
 * Serveur HTTP de la Passerelle Universelle SlickPay
 * - Sert le script Web Component `/sdk/slickpay-widget.js`
 * - Sert le Playground Développeur `/`
 * - Expose les routes REST :
 *   - POST /api/slickpay/checkout      (Création facture API v2 ou session Shop Link)
 *   - POST /api/slickpay/commission    (Calcul commission API v2)
 *   - GET  /api/slickpay/status/:id    (Vérification statut de paiement)
 *   - POST /api/slickpay/webhook       (Réception / simulation du webhook SlickPay)
 *   - GET  /api/slickpay/wilayas       (Liste complète des 58 wilayas)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SlickPayGateway, WILAYAS_58 } from './slickpay-sdk.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error('Payload trop volumineux'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

export function createGatewayServer(gatewayConfig = {}) {
  const gateway = new SlickPayGateway(gatewayConfig);

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    // Pré-vol CORS pour permettre l'intégration sur n'importe quel site externe
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      return res.end();
    }

    try {
      // 1. Liste complète des 58 wilayas
      if (req.method === 'GET' && pathname === '/api/slickpay/wilayas') {
        return sendJson(res, 200, { ok: true, count: WILAYAS_58.length, wilayas: WILAYAS_58 });
      }

      // 2. Calcul de commission (/api/v2/users/invoices/commission)
      if (req.method === 'POST' && pathname === '/api/slickpay/commission') {
        const body = await readJsonBody(req);
        const result = await gateway.calculateInvoiceCommission(body.amount);
        return sendJson(res, 200, { ok: true, ...result });
      }

      // 3. Création d'une session de paiement (POST /api/slickpay/checkout)
      if (req.method === 'POST' && pathname === '/api/slickpay/checkout') {
        const body = await readJsonBody(req);
        const session = body.shopSlug
          ? await gateway.createShopLinkSession(body.shopSlug, body, body.locale || 'fr')
          : await gateway.createCheckoutSession(body);
        return sendJson(res, 201, session);
      }

      // 4. Statut d'une facture (GET /api/slickpay/status/:id)
      if (req.method === 'GET' && pathname.startsWith('/api/slickpay/status/')) {
        const invoiceId = pathname.replace('/api/slickpay/status/', '');
        const status = await gateway.getInvoiceStatus(invoiceId);
        return sendJson(res, 200, { ok: true, ...status });
      }

      // 5. Simulation / Réception Webhook de paiement confirmé
      if (req.method === 'POST' && pathname === '/api/slickpay/webhook') {
        const body = await readJsonBody(req);
        const invoiceId = body.invoiceId || body.id;
        const updated = gateway.markInvoicePaid(invoiceId);
        return sendJson(res, 200, { ok: true, event: 'invoice.paid', invoice: updated });
      }

      // 6. Fichiers statiques (/sdk/slickpay-widget.js et /index.html)
      const safePath = pathname === '/' ? '/index.html' : pathname;
      const filePath = path.join(PUBLIC_DIR, path.normalize(safePath));
      if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
        });
        return fs.createReadStream(filePath).pipe(res);
      }

      return sendJson(res, 404, { ok: false, error: `Route introuvable : ${pathname}` });
    } catch (err) {
      const code = err.statusCode || 500;
      return sendJson(res, code, {
        ok: false,
        error: err.message,
        validationErrors: err.validationErrors || undefined,
      });
    }
  });

  return { server, gateway };
}

// Démarrage direct si exécuté via `npm start`
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const port = Number(process.env.PORT || 3400);
  const { server, gateway } = createGatewayServer();
  server.listen(port, () => {
    console.log(`[SlickPay Bridge] Serveur actif sur http://localhost:${port}`);
    console.log(`[SlickPay Bridge] Script Widget : http://localhost:${port}/sdk/slickpay-widget.js`);
    console.log(`[SlickPay Bridge] Mode actif    : ${gateway.mode}`);
  });
}
