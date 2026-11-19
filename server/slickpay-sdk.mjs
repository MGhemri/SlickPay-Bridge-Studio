/**
 * SlickPay Gateway Core SDK (Node.js / Universal Fetch)
 * Implémentation durcie suite à l'audit de sécurité :
 * - Catalogue serveur (productId -> prix) ou vérification de signature HMAC du prix
 * - Verrouillage serveur de mode / publicKey / accountType / returnUrl en production
 * - Authentification HMAC stricte du webhook et absence de fuite de données personnelles (PII) sur /status/:id
 * - Validation algérienne du téléphone (05/06/07/+213), validation de la wilaya (01..58), plafonds et ligne de livraison dans items[]
 * - Timeout AbortSignal sur les appels fetch et capacité bornée (LRU) sur invoicesStore
 */

import crypto from 'node:crypto';

export const SLICKPAY_ENDPOINTS = {
  sandbox: 'https://devapi.slick-pay.com/api/v2',
  production: 'https://prodapi.slick-pay.com/api/v2',
};

export const WILAYAS_58 = [
  { code: '01', name: 'Adrar' },
  { code: '02', name: 'Chlef' },
  { code: '03', name: 'Laghouat' },
  { code: '04', name: 'Oum El Bouaghi' },
  { code: '05', name: 'Batna' },
  { code: '06', name: 'Béjaïa' },
  { code: '07', name: 'Biskra' },
  { code: '08', name: 'Béchar' },
  { code: '09', name: 'Blida' },
  { code: '10', name: 'Bouira' },
  { code: '11', name: 'Tamanrasset' },
  { code: '12', name: 'Tébessa' },
  { code: '13', name: 'Tlemcen' },
  { code: '14', name: 'Tiaret' },
  { code: '15', name: 'Tizi Ouzou' },
  { code: '16', name: 'Alger' },
  { code: '17', name: 'Djelfa' },
  { code: '18', name: 'Jijel' },
  { code: '19', name: 'Sétif' },
  { code: '20', name: 'Saïda' },
  { code: '21', name: 'Skikda' },
  { code: '22', name: 'Sidi Bel Abbès' },
  { code: '23', name: 'Annaba' },
  { code: '24', name: 'Guelma' },
  { code: '25', name: 'Constantine' },
  { code: '26', name: 'Médéa' },
  { code: '27', name: 'Mostaganem' },
  { code: '28', name: "M'Sila" },
  { code: '29', name: 'Mascara' },
  { code: '30', name: 'Ouargla' },
  { code: '31', name: 'Oran' },
  { code: '32', name: 'El Bayadh' },
  { code: '33', name: 'Illizi' },
  { code: '34', name: 'Bordj Bou Arréridj' },
  { code: '35', name: 'Boumerdès' },
  { code: '36', name: 'El Tarf' },
  { code: '37', name: 'Tindouf' },
  { code: '38', name: 'Tissemsilt' },
  { code: '39', name: 'El Oued' },
  { code: '40', name: 'Khenchela' },
  { code: '41', name: 'Souk Ahras' },
  { code: '42', name: 'Tipaza' },
  { code: '43', name: 'Mila' },
  { code: '44', name: 'Aïn Defla' },
  { code: '45', name: 'Naâma' },
  { code: '46', name: 'Aïn Témouchent' },
  { code: '47', name: 'Ghardaïa' },
  { code: '48', name: 'Relizane' },
  { code: '49', name: 'Timimoun' },
  { code: '50', name: 'Bordj Badji Mokhtar' },
  { code: '51', name: 'Ouled Djellal' },
  { code: '52', name: 'Béni Abbès' },
  { code: '53', name: 'In Salah' },
  { code: '54', name: 'In Guezzam' },
  { code: '55', name: 'Touggourt' },
  { code: '56', name: 'Djanet' },
  { code: '57', name: "El M'Ghair" },
  { code: '58', name: 'El Meniaa' },
];

const VALID_WILAYA_CODES = new Set(WILAYAS_58.map((w) => w.code));
const ALLOWED_CUSTOM_FIELD_KEYS = new Set(['nif', 'rc', 'ai', 'nis', 'tin', 'company', 'reference']);

export class SlickPayGateway {
  /**
   * @param {Object} config
   * @param {string} [config.publicKey] - Clé publique SlickPay (Bearer Token)
   * @param {'sandbox'|'production'|'mock'} [config.mode='mock'] - Mode d'exécution
   * @param {'users'|'merchants'} [config.accountType='users'] - Route API v2
   * @param {string} [config.defaultReturnUrl] - URL de retour après paiement SATIM
   * @param {string[]} [config.allowedReturnHosts] - Domaines autorisés pour returnUrl
   * @param {string} [config.webhookSecret] - Secret HMAC pour signer les webhooks et les prix
   * @param {boolean} [config.allowClientConfigOverride=false] - Autoriser le navigateur à surcharger mode/publicKey (uniquement pour le Studio de démo)
   * @param {boolean} [config.requirePriceSignature=false] - Exiger un productId du catalogue ou une signature HMAC du prix
   * @param {Object<string,{name:string,unitPrice:number,deliveryFee?:number}>} [config.catalog] - Catalogue de prix côté serveur
   * @param {typeof fetch} [config.fetchImpl] - Implémentation fetch injectable pour les tests
   * @param {number} [config.timeoutMs=15000] - Timeout réseau en ms
   * @param {number} [config.maxStoreSize=1000] - Taille maximale du cache mémoire des sessions
   */
  constructor(config = {}) {
    this.publicKey = config.publicKey || process.env.SLICKPAY_PUBLIC_KEY || '';
    this.mode = config.mode || process.env.SLICKPAY_MODE || (this.publicKey ? 'sandbox' : 'mock');
    this.accountType = config.accountType || process.env.SLICKPAY_ACCOUNT_TYPE || 'users';
    this.defaultReturnUrl =
      config.defaultReturnUrl ||
      process.env.SLICKPAY_RETURN_URL ||
      'http://localhost:3400/payment-return';
    this.allowedReturnHosts = Array.isArray(config.allowedReturnHosts)
      ? config.allowedReturnHosts
      : (process.env.SLICKPAY_ALLOWED_RETURN_HOSTS || 'localhost,127.0.0.1,connect-gm.com,monsite-exemple.dz')
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean);

    this.webhookSecret = config.webhookSecret || process.env.SLICKPAY_WEBHOOK_SECRET || '';
    if (this.mode === 'production' && !this.webhookSecret) {
      throw new Error(
        'SLICKPAY_WEBHOOK_SECRET est obligatoire lorsque SLICKPAY_MODE=production.'
      );
    }
    if (!this.webhookSecret) {
      this.webhookSecret = 'slickpay-dev-only-secret-do-not-use-in-prod';
    }

    this.allowClientConfigOverride =
      config.allowClientConfigOverride !== undefined
        ? Boolean(config.allowClientConfigOverride)
        : process.env.SLICKPAY_ALLOW_CLIENT_OVERRIDE === 'true';

    this.requirePriceSignature =
      config.requirePriceSignature !== undefined
        ? Boolean(config.requirePriceSignature)
        : process.env.SLICKPAY_REQUIRE_PRICE_SIGNATURE === 'true';

    this.catalog = config.catalog || {};
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
    this.timeoutMs = Number(config.timeoutMs || 15000);
    this.maxStoreSize = Number(config.maxStoreSize || 1000);
    this.invoicesStore = new Map();
  }

  get baseUrl() {
    return this.mode === 'production'
      ? SLICKPAY_ENDPOINTS.production
      : SLICKPAY_ENDPOINTS.sandbox;
  }

  getBaseUrlForMode(effectiveMode) {
    return effectiveMode === 'production'
      ? SLICKPAY_ENDPOINTS.production
      : SLICKPAY_ENDPOINTS.sandbox;
  }

  getInvoiceEndpoint(overrideAccountType) {
    const type = overrideAccountType || this.accountType;
    return type === 'merchants' ? 'merchants/invoices' : 'users/invoices';
  }

  /**
   * Génère une signature HMAC-SHA256 pour verrouiller un produit et son prix côté marchand
   */
  signProductPrice(productName, unitPrice, deliveryFee = 0) {
    const normalizedPrice = Math.round(Number(unitPrice) * 100) / 100;
    const normalizedFee = Math.round(Number(deliveryFee) * 100) / 100;
    const canonical = `price:${String(productName).trim()}:${normalizedPrice.toFixed(2)}:${normalizedFee.toFixed(2)}`;
    return crypto
      .createHmac('sha256', this.webhookSecret)
      .update(canonical)
      .digest('hex');
  }

  /**
   * Génère et vérifie la signature HMAC canonique d'un événement Webhook
   */
  computeWebhookSignature(invoiceId, totalChargeCentimes, status = 'paid') {
    const canonical = `webhook:${String(invoiceId)}:${Number(totalChargeCentimes)}:${String(status)}`;
    return crypto
      .createHmac('sha256', this.webhookSecret)
      .update(canonical)
      .digest('hex');
  }

  verifyWebhookSignature(invoiceId, totalChargeCentimes, providedSignature, status = 'paid') {
    if (!providedSignature || typeof providedSignature !== 'string') {
      return false;
    }
    const expected = this.computeWebhookSignature(invoiceId, totalChargeCentimes, status);
    const expectedBuf = Buffer.from(expected, 'utf8');
    const providedBuf = Buffer.from(providedSignature, 'utf8');
    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  }

  /**
   * Ajoute une facture dans le store en respectant la taille maximale (éviction FIFO/LRU)
   */
  storeInvoiceRecord(invoiceId, record) {
    if (this.invoicesStore.size >= this.maxStoreSize && !this.invoicesStore.has(invoiceId)) {
      const oldestKey = this.invoicesStore.keys().next().value;
      if (oldestKey !== undefined) {
        this.invoicesStore.delete(oldestKey);
      }
    }
    this.invoicesStore.set(String(invoiceId), record);
  }

  /**
   * Valide que l'URL de retour est sûre et appartient aux hôtes autorisés
   */
  validateReturnUrl(candidateUrl) {
    if (!candidateUrl) return this.defaultReturnUrl;
    let parsed;
    try {
      parsed = new URL(String(candidateUrl));
    } catch (_) {
      const err = new Error('URL de retour (returnUrl) invalide.');
      err.statusCode = 400;
      throw err;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      const err = new Error('Le protocole de returnUrl doit être https: ou http:.');
      err.statusCode = 400;
      throw err;
    }
    if (this.mode === 'production' && parsed.protocol !== 'https:') {
      const err = new Error('En production, returnUrl doit obligatoirement utiliser https:.');
      err.statusCode = 400;
      throw err;
    }
    const host = parsed.hostname.toLowerCase();
    const isAllowed = this.allowedReturnHosts.some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`)
    );
    if (!isAllowed) {
      const err = new Error(`Domaine returnUrl non autorisé : ${host}`);
      err.statusCode = 400;
      throw err;
    }
    return parsed.toString();
  }

  /**
   * Valide que l'URL de redirection de paiement retournée par l'API est bien en HTTPS
   */
  validateCheckoutUrl(urlStr) {
    try {
      const u = new URL(String(urlStr));
      if (u.protocol !== 'https:') {
        throw new Error('Protocole non HTTPS');
      }
      return u.toString();
    } catch (_) {
      const err = new Error('URL de paiement distante invalide ou non sécurisée.');
      err.statusCode = 502;
      throw err;
    }
  }

  /**
   * Valide et normalise la charge utile d'une commande provenant du widget frontend
   */
  validateCheckoutPayload(payload = {}) {
    const errors = [];

    // 1. Résolution du produit et du prix (Catalogue serveur > Signature HMAC > Valeur client)
    let productName = String(payload.productName || 'Commande Marchand').trim().slice(0, 180);
    let unitPrice = Number(payload.amount ?? payload.unitPrice ?? NaN);
    let deliveryFee = Number(payload.deliveryFee ?? 0);

    if (payload.productId && this.catalog[payload.productId]) {
      const item = this.catalog[payload.productId];
      productName = item.name;
      unitPrice = Number(item.unitPrice);
      if (item.deliveryFee !== undefined) {
        deliveryFee = Number(item.deliveryFee);
      }
    } else if (this.requirePriceSignature || payload.priceSignature) {
      const expectedSig = this.signProductPrice(productName, unitPrice, deliveryFee);
      const providedSig = String(payload.priceSignature || '');
      const expBuf = Buffer.from(expectedSig, 'utf8');
      const provBuf = Buffer.from(providedSig, 'utf8');
      if (expBuf.length !== provBuf.length || !crypto.timingSafeEqual(expBuf, provBuf)) {
        errors.push('Signature de prix (priceSignature) invalide ou absente.');
      }
    }

    unitPrice = Math.round(unitPrice * 100) / 100;
    deliveryFee = Math.round(Math.max(0, deliveryFee || 0) * 100) / 100;
    const quantity = parseInt(payload.quantity ?? 1, 10);

    if (!Number.isFinite(unitPrice) || unitPrice < 100 || unitPrice > 50_000_000) {
      errors.push('Le montant unitaire doit être compris entre 100 DZD et 50 000 000 DZD.');
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
      errors.push('La quantité doit être un entier compris entre 1 et 1000.');
    }
    if (!Number.isFinite(deliveryFee) || deliveryFee < 0 || deliveryFee > 1_000_000) {
      errors.push('Les frais de livraison sont invalides.');
    }

    const fullName = String(payload.fullName || '').trim();
    if (!fullName || fullName.length < 2 || fullName.length > 120) {
      errors.push('Le nom complet du client est obligatoire.');
    }

    const email = String(payload.email || '').trim();
    if (!email || email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push('Une adresse e-mail valide est obligatoire.');
    }

    const cleanPhone = String(payload.phone || '')
      .trim()
      .replace(/[\s\-\.\(\)]+/g, '');
    // Format algérien mobile/fixe (05/06/07/02/03/04 ou +213 / 00213)
    if (!/^(\+?213|00213|0)[2-7][0-9]{7,8}$/.test(cleanPhone)) {
      errors.push('Un numéro de téléphone algérien valide est obligatoire (ex: 0550123456).');
    }

    const wilaya = String(payload.wilaya || '16').padStart(2, '0');
    if (!VALID_WILAYA_CODES.has(wilaya)) {
      errors.push(`Code wilaya invalide : ${wilaya} (doit être entre 01 et 58).`);
    }

    const address = String(payload.address || 'Algérie').trim().slice(0, 300);

    // Champs personnalisés B2B : uniquement scalaires, clés autorisées
    const customFields = {};
    if (payload.customFields && typeof payload.customFields === 'object' && !Array.isArray(payload.customFields)) {
      for (const [rawKey, rawVal] of Object.entries(payload.customFields)) {
        const key = String(rawKey).trim().toLowerCase();
        if (!ALLOWED_CUSTOM_FIELD_KEYS.has(key)) continue;
        if (rawVal === null || rawVal === undefined) continue;
        if (typeof rawVal === 'object') {
          errors.push(`Le champ personnalisé ${key} doit être une chaîne ou un nombre.`);
          continue;
        }
        customFields[key] = String(rawVal).trim().slice(0, 120);
      }
    }

    if (errors.length > 0) {
      const err = new Error(errors.join(' '));
      err.statusCode = 400;
      err.validationErrors = errors;
      throw err;
    }

    const returnUrl = this.validateReturnUrl(
      this.allowClientConfigOverride ? payload.returnUrl : undefined
    );

    const baseAmountDzd = Math.round((unitPrice * quantity + deliveryFee) * 100) / 100;
    const customerFeeDzd = 0;
    const totalChargeDzd = baseAmountDzd;

    const nameParts = fullName.split(/\s+/);
    const firstname = nameParts[0] || 'Client';
    const lastname = nameParts.slice(1).join(' ').trim() || firstname;

    return {
      productName,
      unitPrice,
      quantity,
      deliveryFee,
      fullName,
      firstname,
      lastname,
      email,
      phone: cleanPhone,
      wilaya,
      address,
      customFields,
      returnUrl,
      shopSlug: payload.shopSlug || null,
      totals: {
        baseDzd: baseAmountDzd,
        customerFeeDzd,
        totalChargeDzd,
        base: Math.round(baseAmountDzd * 100),
        customerFee: Math.round(customerFeeDzd * 100),
        totalCharge: Math.round(totalChargeDzd * 100),
      },
    };
  }

  /**
   * Crée une session de paiement / facture SlickPay et retourne l'URL SATIM/CIB
   */
  async createCheckoutSession(rawPayload = {}) {
    const clean = this.validateCheckoutPayload(rawPayload);
    const invoiceId = `sp_${crypto.randomBytes(8).toString('hex')}`;
    const mdOrder = crypto.randomBytes(10).toString('base64url').slice(0, 20);

    const effectiveMode =
      this.allowClientConfigOverride && rawPayload.mode
        ? rawPayload.mode
        : this.mode;
    const effectivePublicKey =
      this.allowClientConfigOverride && rawPayload.publicKey
        ? String(rawPayload.publicKey).trim()
        : this.publicKey;
    const effectiveAccountType =
      this.allowClientConfigOverride && rawPayload.accountType
        ? rawPayload.accountType
        : this.accountType;

    // Mode Mock
    if (effectiveMode === 'mock' || !effectivePublicKey) {
      const satimPaymentUrl = `https://cib.satim.dz/payment/epg/merchants/merchantsatim/payment.html?mdOrder=${mdOrder}&language=fr`;
      const record = {
        ok: true,
        mode: 'mock',
        accountType: effectiveAccountType,
        invoiceId,
        mdOrder,
        status: 'pending',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 25 * 60 * 1000).toISOString(),
        paymentUrl: satimPaymentUrl,
        totals: clean.totals,
        customer: {
          fullName: clean.fullName,
          email: clean.email,
          phone: clean.phone,
          wilaya: clean.wilaya,
          address: clean.address,
          customFields: clean.customFields,
        },
        item: {
          name: clean.productName,
          unitPrice: clean.unitPrice,
          quantity: clean.quantity,
          deliveryFee: clean.deliveryFee,
        },
      };
      this.storeInvoiceRecord(invoiceId, record);
      return record;
    }

    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${effectivePublicKey}`,
      'User-Agent': 'SlickPayBridgeSDK/1.0 (+https://slick-pay.com)',
    };

    const webhookSignature = this.computeWebhookSignature(
      invoiceId,
      clean.totals.totalCharge,
      'paid'
    );

    // Inclusion des frais de livraison dans items[] pour que la somme des items égale toujours amount
    const items = [
      {
        name: clean.productName,
        price: clean.unitPrice,
        quantity: clean.quantity,
      },
    ];
    if (clean.deliveryFee > 0) {
      items.push({
        name: 'Frais de livraison',
        price: clean.deliveryFee,
        quantity: 1,
      });
    }

    const invoicePayload = {
      amount: clean.totals.totalChargeDzd,
      url: clean.returnUrl,
      ...(rawPayload.contactUuid ? { contact: rawPayload.contactUuid } : {}),
      ...(rawPayload.accountUuid ? { account: rawPayload.accountUuid } : {}),
      ...(rawPayload.qrcode ? { qrcode: Boolean(rawPayload.qrcode) } : {}),
      name: `${clean.firstname} ${clean.lastname}`,
      firstname: clean.firstname,
      lastname: clean.lastname,
      email: clean.email,
      phone: clean.phone,
      address: `${clean.address} (Wilaya ${clean.wilaya})`,
      items,
      note: Object.entries(clean.customFields)
        .map(([k, v]) => `${k.toUpperCase()}: ${v}`)
        .join(' | '),
      ...(rawPayload.webhookUrl ? { webhook_url: rawPayload.webhookUrl } : {}),
      webhook_signature: webhookSignature,
      webhook_meta_data: [
        {
          invoice_ref: invoiceId,
          wilaya: clean.wilaya,
          ...clean.customFields,
        },
      ],
    };

    const endpointPath = this.getInvoiceEndpoint(effectiveAccountType);
    const targetUrl = `${this.getBaseUrlForMode(effectiveMode)}/${endpointPath}`;

    const response = await this.fetchImpl(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(invoicePayload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.errors) {
      const err = new Error(
        data?.message || `Erreur API SlickPay (${response.status})`
      );
      err.statusCode = response.status || 502;
      throw err;
    }

    const remoteId = String(data?.id || data?.data?.id || invoiceId);
    const rawPaymentUrl =
      data?.url ||
      data?.data?.url ||
      `https://cib.satim.dz/payment/epg/merchants/merchantsatim/payment.html?mdOrder=${mdOrder}&language=fr`;
    const paymentUrl = this.validateCheckoutUrl(rawPaymentUrl);

    const record = {
      ok: true,
      mode: effectiveMode,
      accountType: effectiveAccountType,
      invoiceId: remoteId,
      mdOrder,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 25 * 60 * 1000).toISOString(),
      paymentUrl,
      totals: clean.totals,
      customer: {
        fullName: clean.fullName,
        email: clean.email,
        phone: clean.phone,
        wilaya: clean.wilaya,
        address: clean.address,
        customFields: clean.customFields,
      },
      item: {
        name: clean.productName,
        unitPrice: clean.unitPrice,
        quantity: clean.quantity,
        deliveryFee: clean.deliveryFee,
      },
    };

    this.storeInvoiceRecord(remoteId, record);
    return record;
  }

  /**
   * Vérifie le statut d'une facture sans jamais exposer les données personnelles (PII)
   * ni retourner un statut local non confirmé lorsque l'appel API échoue.
   */
  async getInvoiceStatus(invoiceId, accountTypeOverride) {
    const localRecord = this.invoicesStore.get(String(invoiceId));

    if (this.mode === 'mock' || !this.publicKey) {
      if (!localRecord) {
        const err = new Error(`Facture introuvable : ${invoiceId}`);
        err.statusCode = 404;
        throw err;
      }
      return {
        invoiceId: localRecord.invoiceId,
        mdOrder: localRecord.mdOrder,
        status: localRecord.status,
        paidAt: localRecord.paidAt || null,
        totals: localRecord.totals,
        item: localRecord.item,
      };
    }

    const endpointPath = this.getInvoiceEndpoint(accountTypeOverride);
    const response = await this.fetchImpl(
      `${this.baseUrl}/${endpointPath}/${encodeURIComponent(invoiceId)}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.publicKey}`,
          'User-Agent': 'SlickPayBridgeSDK/1.0 (+https://slick-pay.com)',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(
        data?.message || `Impossible de vérifier la facture ${invoiceId} (${response.status})`
      );
      err.statusCode = response.status || 502;
      throw err;
    }

    const completed = Boolean(
      data?.completed === 1 ||
        data?.completed === true ||
        data?.data?.completed === 1 ||
        data?.data?.payment_status === 'paid' ||
        data?.status === 'paid'
    );

    if (localRecord) {
      localRecord.status = completed ? 'paid' : 'pending';
      this.storeInvoiceRecord(String(invoiceId), localRecord);
    }

    return {
      invoiceId: String(invoiceId),
      status: completed ? 'paid' : 'pending',
      totals: localRecord ? localRecord.totals : undefined,
      item: localRecord ? localRecord.item : undefined,
    };
  }

  /**
   * Calcule la commission SlickPay (`POST /api/v2/users/invoices/commission`)
   */
  async calculateInvoiceCommission(amountDzd) {
    const amount = Number(amountDzd);
    if (!Number.isFinite(amount) || amount < 100) {
      const err = new Error('Le montant doit être >= 100 DZD');
      err.statusCode = 400;
      throw err;
    }

    if (this.mode === 'mock' || !this.publicKey) {
      return {
        success: 1,
        mode: 'mock',
        amount,
        commission: 0,
        total: amount,
      };
    }

    const response = await this.fetchImpl(`${this.baseUrl}/users/invoices/commission`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.publicKey}`,
        'User-Agent': 'SlickPayBridgeSDK/1.0 (+https://slick-pay.com)',
      },
      body: JSON.stringify({ amount }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data?.message || `Erreur calcul commission (${response.status})`);
      err.statusCode = response.status;
      throw err;
    }
    return data;
  }

  async createShopLinkSession(shopSlug, rawPayload, locale = 'fr') {
    const shopUrl = `https://app.slick-pay.com/${encodeURIComponent(locale)}/shop/${encodeURIComponent(shopSlug)}`;
    const session = await this.createCheckoutSession({ ...rawPayload, shopSlug });
    return {
      ...session,
      bridge: 'shop-link',
      shopUrl,
    };
  }

  /**
   * Confirme le paiement d'une facture après vérification obligatoire de la signature HMAC du webhook
   */
  markInvoicePaid(invoiceId, providedSignature) {
    const localRecord = this.invoicesStore.get(String(invoiceId));
    if (!localRecord) {
      const err = new Error(`Facture introuvable : ${invoiceId}`);
      err.statusCode = 404;
      throw err;
    }

    // En dehors du mode mock avec flag explicite, la signature HMAC est exigée
    if (!this.verifyWebhookSignature(localRecord.invoiceId, localRecord.totals.totalCharge, providedSignature, 'paid')) {
      const err = new Error('Signature HMAC du webhook invalide ou manquante.');
      err.statusCode = 401;
      throw err;
    }

    localRecord.status = 'paid';
    localRecord.paidAt = new Date().toISOString();
    localRecord.webhookSignature = providedSignature;
    return {
      invoiceId: localRecord.invoiceId,
      status: localRecord.status,
      paidAt: localRecord.paidAt,
      totals: localRecord.totals,
    };
  }
}

/**
 * Classes compatibles avec la signature `@slick-pay-algeria/slickpay-npm`
 */
export class Invoice {
  constructor(publicKey, sandbox = false, fetchImpl) {
    this.gateway = new SlickPayGateway({
      publicKey,
      mode: sandbox ? 'sandbox' : 'production',
      accountType: 'users',
      webhookSecret: 'sdk-wrapper-secret',
      fetchImpl,
    });
  }
  commission(amount) {
    return this.gateway.calculateInvoiceCommission(amount);
  }
  store(data) {
    return this.gateway.createCheckoutSession({ ...data, accountType: 'users' });
  }
  show(id) {
    return this.gateway.getInvoiceStatus(id, 'users');
  }
}

export class MerchantInvoice {
  constructor(publicKey, sandbox = false, fetchImpl) {
    this.gateway = new SlickPayGateway({
      publicKey,
      mode: sandbox ? 'sandbox' : 'production',
      accountType: 'merchants',
      webhookSecret: 'sdk-wrapper-secret',
      fetchImpl,
    });
  }
  store(data) {
    return this.gateway.createCheckoutSession({ ...data, accountType: 'merchants' });
  }
  show(id) {
    return this.gateway.getInvoiceStatus(id, 'merchants');
  }
}
