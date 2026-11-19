/**
 * Serveur HTTP de la Passerelle Universelle SlickPay
 * - Liste blanche stricte d'extensions statiques (interdit .php, .htaccess et dotfiles)
 * - Supporte /api/slickpay/checkout, /api/checkout.php et /api/slickpay/sign-price
 * - Limitation de débit (Rate Limiter par IP avec éviction LRU et support trustProxy)
 * - Authentification HMAC-SHA256 sur /api/slickpay/webhook
 * - Vérification dynamique du statut sur la page /payment-return
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SlickPayGateway, WILAYAS_58 } from './slickpay-sdk.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const ALLOWED_STATIC_EXTENSIONS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const MAX_BODY_BYTES = 64 * 1024;

function resolveCorsOrigin(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (!allowedOrigins || allowedOrigins.includes('*')) {
    return '*';
  }
  if (origin && allowedOrigins.includes(origin)) {
    return origin;
  }
  return allowedOrigins[0] || 'null';
}

function sendJson(req, res, statusCode, payload, allowedOrigins) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': resolveCorsOrigin(req, allowedOrigins),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-SlickPay-Signature',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        aborted = true;
        req.destroy();
        const err = new Error('Payload trop volumineux (limite 64 Ko dépassée).');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      if (totalBytes === 0) return resolve({});
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch (_) {
        const err = new Error('Corps JSON invalide.');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

export function createGatewayServer(gatewayConfig = {}) {
  const gateway = new SlickPayGateway(gatewayConfig);
  const allowedOrigins = Array.isArray(gatewayConfig.allowedOrigins)
    ? gatewayConfig.allowedOrigins
    : (
        process.env.SLICKPAY_ALLOWED_ORIGINS ||
        (gateway.mode === 'production' ? 'null' : '*')
      )
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);

  const trustProxy =
    gatewayConfig.trustProxy !== undefined
      ? Boolean(gatewayConfig.trustProxy)
      : process.env.SLICKPAY_TRUST_PROXY === 'true';

  const rateLimitMax = Number(
    gatewayConfig.rateLimitMax || process.env.SLICKPAY_RATE_LIMIT_MAX || 60
  );
  const rateLimitMap = new Map();

  function getClientIp(req) {
    if (trustProxy) {
      const cfIp = req.headers['cf-connecting-ip'];
      if (cfIp && typeof cfIp === 'string') return cfIp.trim();
      const xff = req.headers['x-forwarded-for'];
      if (xff && typeof xff === 'string') return xff.split(',')[0].trim();
    }
    return req.socket?.remoteAddress || '127.0.0.1';
  }

  function checkRateLimit(req) {
    const ip = getClientIp(req);
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || now > entry.resetAt) {
      if (rateLimitMap.size >= 5000 && !rateLimitMap.has(ip)) {
        const oldestKey = rateLimitMap.keys().next().value;
        if (oldestKey !== undefined) rateLimitMap.delete(oldestKey);
      }
      rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    entry.count += 1;
    return entry.count <= rateLimitMax;
  }

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': resolveCorsOrigin(req, allowedOrigins),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-SlickPay-Signature',
      });
      return res.end();
    }

    if (!checkRateLimit(req)) {
      return sendJson(
        req,
        res,
        429,
        { ok: false, error: 'Trop de requêtes. Veuillez réessayer dans une minute.' },
        allowedOrigins
      );
    }

    try {
      // 1. Liste complète des 58 wilayas
      if (req.method === 'GET' && pathname === '/api/slickpay/wilayas') {
        return sendJson(
          req,
          res,
          200,
          { ok: true, count: WILAYAS_58.length, wilayas: WILAYAS_58 },
          allowedOrigins
        );
      }

      // 2. Calcul de commission (/api/v2/users/invoices/commission)
      if (req.method === 'POST' && pathname === '/api/slickpay/commission') {
        const body = await readJsonBody(req);
        const result = await gateway.calculateInvoiceCommission(body.amount);
        return sendJson(req, res, 200, { ok: true, ...result }, allowedOrigins);
      }

      // 3. Création ou vérification via /api/slickpay/checkout OU /api/checkout.php
      if (pathname === '/api/slickpay/checkout' || pathname === '/api/checkout.php') {
        if (req.method === 'GET' && urlObj.searchParams.get('action') === 'status') {
          const invoiceId = urlObj.searchParams.get('id') || '';
          const status = await gateway.getInvoiceStatus(invoiceId);
          return sendJson(req, res, 200, { ok: true, ...status }, allowedOrigins);
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          if (body.action === 'commission') {
            const result = await gateway.calculateInvoiceCommission(body.amount);
            return sendJson(req, res, 200, { ok: true, ...result }, allowedOrigins);
          }
          if (body.action === 'status') {
            const status = await gateway.getInvoiceStatus(body.invoiceId || body.id);
            return sendJson(req, res, 200, { ok: true, ...status }, allowedOrigins);
          }
          const session = body.shopSlug
            ? await gateway.createShopLinkSession(body.shopSlug, body, body.locale || 'fr')
            : await gateway.createCheckoutSession(body);
          return sendJson(req, res, 201, session, allowedOrigins);
        }
      }

      // 4. Statut d'une facture (GET /api/slickpay/status/:id)
      if (req.method === 'GET' && pathname.startsWith('/api/slickpay/status/')) {
        const invoiceId = pathname.replace('/api/slickpay/status/', '');
        const status = await gateway.getInvoiceStatus(invoiceId);
        return sendJson(req, res, 200, { ok: true, ...status }, allowedOrigins);
      }

      // 5. Réception Webhook de paiement confirmé (authentifié par signature HMAC)
      if (req.method === 'POST' && pathname === '/api/slickpay/webhook') {
        const body = await readJsonBody(req);
        const invoiceId = body.invoiceId || body.id || body.invoice_ref;
        const signature =
          req.headers['x-slickpay-signature'] ||
          body.signature ||
          body.webhook_signature ||
          '';
        const updated = gateway.markInvoicePaid(invoiceId, signature);
        return sendJson(
          req,
          res,
          200,
          { ok: true, event: 'invoice.paid', invoice: updated },
          allowedOrigins
        );
      }

      // 6. Page de retour après paiement (/payment-return) avec vérification réelle du statut
      if (req.method === 'GET' && pathname === '/payment-return') {
        const rawId =
          urlObj.searchParams.get('invoiceId') || urlObj.searchParams.get('id') || '';
        const safeId = String(rawId).replace(/[^a-zA-Z0-9_-]/g, '');
        let statusLabel = 'Non vérifié';
        if (safeId) {
          try {
            const st = await gateway.getInvoiceStatus(safeId);
            statusLabel = st.status === 'paid' ? 'Payé (Confirmé)' : 'En attente de règlement';
          } catch (_) {
            statusLabel = 'Facture introuvable ou en attente';
          }
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <title>Confirmation de paiement — SlickPay Bridge</title>
  <link rel="stylesheet" href="/playground.css" />
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>Retour de la passerelle de paiement</h1>
      <p class="lead">Référence transaction : <code>${safeId || 'N/A'}</code></p>
      <p class="lead">Statut vérifié : <strong>${statusLabel}</strong></p>
      <p><a href="/">Retour à l'accueil</a></p>
    </div>
  </div>
</body>
</html>`);
      }

      // 7. Fichiers statiques sécurisés
      const safePath = pathname === '/' || pathname === '/index.php' ? '/index.html' : pathname;
      const ext = path.extname(safePath).toLowerCase();
      const baseName = path.basename(safePath);

      if (baseName.startsWith('.') || !ALLOWED_STATIC_EXTENSIONS[ext]) {
        return sendJson(
          req,
          res,
          404,
          { ok: false, error: `Ressource non disponible : ${pathname}` },
          allowedOrigins
        );
      }

      const filePath = path.join(PUBLIC_DIR, path.normalize(safePath));
      if (
        filePath.startsWith(PUBLIC_DIR) &&
        fs.existsSync(filePath) &&
        fs.statSync(filePath).isFile()
      ) {
        res.writeHead(200, {
          'Content-Type': ALLOWED_STATIC_EXTENSIONS[ext],
          'Access-Control-Allow-Origin': resolveCorsOrigin(req, allowedOrigins),
          'X-Content-Type-Options': 'nosniff',
        });
        return fs.createReadStream(filePath).pipe(res);
      }

      return sendJson(
        req,
        res,
        404,
        { ok: false, error: `Route introuvable : ${pathname}` },
        allowedOrigins
      );
    } catch (err) {
      const code = err.statusCode || 500;
      return sendJson(
        req,
        res,
        code,
        {
          ok: false,
          error: err.message,
          validationErrors: err.validationErrors || undefined,
        },
        allowedOrigins
      );
    }
  });

  return { server, gateway };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const port = Number(process.env.PORT || 3400);
  const { server, gateway } = createGatewayServer();
  server.listen(port, () => {
    console.log(`[SlickPay Bridge] Serveur actif sur http://localhost:${port}`);
    console.log(`[SlickPay Bridge] Script Widget : http://localhost:${port}/sdk/slickpay-widget.js`);
    console.log(`[SlickPay Bridge] Mode actif    : ${gateway.mode}`);
  });
}
