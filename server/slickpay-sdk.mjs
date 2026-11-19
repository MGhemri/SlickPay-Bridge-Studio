/**
 * SlickPay Gateway Core SDK (Node.js / Universal Fetch)
 * Gère la création de factures SlickPay API v2, la vérification de statut,
 * le verrouillage des prix (catalogue serveur ou signature HMAC-SHA256)
 * et l'authentification cryptographique des webhooks.
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
  { code: '49', 'name': 'Timimoun' },
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
const CUSTOM_FIELD_KEY_REGEX = /^[a-z0-9_]{1,32}$/i;

export class SlickPayGateway {
  /**
   * @param {Object} config
   * @param {string} [config.publicKey] - Clé publique SlickPay (Bearer Token)
   * @param {'sandbox'|'production'|'mock'} [config.mode='mock'] - Mode d'exécution
   * @param {'users'|'merchants'} [config.accountType='users'] - Route API v2
   * @param {string} [config.defaultReturnUrl] - URL de retour après paiement SATIM
   * @param {string[]} [config.allowedReturnHosts] - Domaines autorisés pour returnUrl
   * @param {string} [config.webhookUrl] - URL serveur de notification Webhook (SLICKPAY_WEBHOOK_URL)
   * @param {string} [config.contactUuid] - UUID contact serveur (SLICKPAY_CONTACT_UUID)
   * @param {string} [config.accountUuid] - UUID compte de réception serveur (SLICKPAY_ACCOUNT_UUID)
   * @param {boolean} [config.qrcode] - Activer le QR code mobile SlickPay côté serveur (SLICKPAY_QRCODE)
   * @param {string} [config.webhookSecret] - Secret HMAC pour signer les webhooks et les prix
   * @param {boolean} [config.allowClientConfigOverride=false] - Autoriser le navigateur à surcharger mode/publicKey (Studio de démo uniquement)
   * @param {boolean} [config.requirePriceSignature] - Exiger un productId du catalogue ou une signature HMAC du prix (true par défaut en production)
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
      : (process.env.SLICKPAY_ALLOWED_RETURN_HOSTS || 'localhost,127.0.0.1')
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean);

    // Paramètres métier sensibles pilotés exclusivement par le serveur
    this.webhookUrl = config.webhookUrl || process.env.SLICKPAY_WEBHOOK_URL || '';
    this.contactUuid = config.contactUuid || process.env.SLICKPAY_CONTACT_UUID || '';
    this.accountUuid = config.accountUuid || process.env.SLICKPAY_ACCOUNT_UUID || '';
    this.qrcode =
      config.qrcode !== undefined
        ? Boolean(config.qrcode)
        : process.env.SLICKPAY_QRCODE === 'true';

    this.webhookSecret = config.webhookSecret || process.env.SLICKPAY_WEBHOOK_SECRET || '';
    if (this.mode === 'production' && !this.webhookSecret) {
      throw new Error(
        'SLICKPAY_WEBHOOK_SECRET est obligatoire lorsque SLICKPAY_MODE=production.'
      );
    }
    if (!this.webhookSecret) {
      this.webhookSecret = 'slickpay-dev-only-secret-do-not-use-in-prod';
    }

    if (this.mode === 'production') {
      this.validateReturnUrl(this.defaultReturnUrl);
      if (this.webhookUrl && !this.webhookUrl.startsWith('https://')) {
        throw new Error('En production, SLICKPAY_WEBHOOK_URL doit utiliser https://.');
      }
    }

    this.allowClientConfigOverride =
      config.allowClientConfigOverride !== undefined
        ? Boolean(config.allowClientConfigOverride)
        : process.env.SLICKPAY_ALLOW_CLIENT_OVERRIDE === 'true';

    // Verrouillage des prix actif par défaut en production (ou si SLICKPAY_REQUIRE_PRICE_SIGNATURE !== 'false' en prod)
    if (config.requirePriceSignature !== undefined) {
      this.requirePriceSignature = Boolean(config.requirePriceSignature);
    } else if (process.env.SLICKPAY_REQUIRE_PRICE_SIGNATURE !== undefined) {
      this.requirePriceSignature = process.env.SLICKPAY_REQUIRE_PRICE_SIGNATURE === 'true';
    } else {
      this.requirePriceSignature = this.mode === 'production';
    }

    this.catalog = config.catalog || {};
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
    this.timeoutMs = Number(config.timeoutMs || 15000);
    this.maxStoreSize = Number(config.maxStoreSize || 1000);
    this.invoicesStore = new Map();
    this.localRefIndex = new Map();
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
  computeWebhookSignature(invoiceRef, totalChargeCentimes, status = 'paid') {
    const canonical = `webhook:${String(invoiceRef)}:${Number(totalChargeCentimes)}:${String(status)}`;
    return crypto
      .createHmac('sha256', this.webhookSecret)
      .update(canonical)
      .digest('hex');
  }

  verifyWebhookSignature(invoiceRef, totalChargeCentimes, providedSignature, status = 'paid') {
    if (!providedSignature || typeof providedSignature !== 'string') {
      return false;
    }
    const expected = this.computeWebhookSignature(invoiceRef, totalChargeCentimes, status);
    const expectedBuf = Buffer.from(expected, 'utf8');
    const providedBuf = Buffer.from(providedSignature, 'utf8');
    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  }

  /**
   * Enregistre la facture sous son ID distant ET sous sa référence locale (localInvoiceRef)
   * afin que la vérification HMAC du webhook fonctionne de manière cohérente en Mock, Sandbox et Production.
   */
  storeInvoiceRecord(invoiceId, record) {
    const key = String(invoiceId);
    if (this.invoicesStore.size >= this.maxStoreSize && !this.invoicesStore.has(key)) {
      const oldestKey = this.invoicesStore.keys().next().value;
      if (oldestKey !== undefined) {
        const oldRec = this.invoicesStore.get(oldestKey);
        if (oldRec && oldRec.localInvoiceRef) {
          this.localRefIndex.delete(oldRec.localInvoiceRef);
        }
        this.invoicesStore.delete(oldestKey);
      }
    }
    this.invoicesStore.set(key, record);
    if (record.localInvoiceRef) {
      this.localRefIndex.set(String(record.localInvoiceRef), key);
    }
  }

  resolveLocalRecord(idOrRef) {
    const key = String(idOrRef);
    if (this.invoicesStore.has(key)) {
      return this.invoicesStore.get(key);
    }
    const mappedId = this.localRefIndex.get(key);
    if (mappedId && this.invoicesStore.has(mappedId)) {
      return this.invoicesStore.get(mappedId);
    }
    return null;
  }

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
    if (!/^(\+?213|00213|0)[2-7][0-9]{7,8}$/.test(cleanPhone)) {
      errors.push('Un numéro de téléphone algérien valide est obligatoire (ex: 0550123456).');
    }

    const wilaya = String(payload.wilaya || '16').padStart(2, '0');
    if (!VALID_WILAYA_CODES.has(wilaya)) {
      errors.push(`Code wilaya invalide : ${wilaya} (doit être entre 01 et 58).`);
    }

    const address = String(payload.address || 'Algérie').trim().slice(0, 300);

    // Champs personnalisés B2B : validation stricte du format de clé et de la valeur scalaire
    const customFields = {};
    if (payload.customFields !== undefined && payload.customFields !== null) {
      if (typeof payload.customFields !== 'object' || Array.isArray(payload.customFields)) {
        errors.push('Le paramètre customFields doit être un objet clé-valeur.');
      } else {
        const entries = Object.entries(payload.customFields);
        if (entries.length > 10) {
          errors.push('Maximum 10 champs personnalisés autorisés.');
        }
        for (const [rawKey, rawVal] of entries) {
          const key = String(rawKey).trim().toLowerCase();
          if (!CUSTOM_FIELD_KEY_REGEX.test(key)) {
            errors.push(`Nom de champ personnalisé invalide : ${rawKey} (caractères alphanumériques uniquement).`);
            continue;
          }
          if (rawVal === null || rawVal === undefined || rawVal === '') continue;
          if (typeof rawVal === 'object') {
            errors.push(`Le champ personnalisé ${key} doit être une chaîne ou un nombre.`);
            continue;
          }
          customFields[key] = String(rawVal).trim().slice(0, 120);
        }
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
    const localInvoiceRef = `sp_${crypto.randomBytes(8).toString('hex')}`;
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

    // La signature HMAC de webhook est toujours indexée sur localInvoiceRef
    // (et stockée dans l'enregistrement pour une vérification cohérente quel que soit l'ID distant retourné par SlickPay)
    const webhookSignature = this.computeWebhookSignature(
      localInvoiceRef,
      clean.totals.totalCharge,
      'paid'
    );

    if (effectiveMode === 'mock' || !effectivePublicKey) {
      const satimPaymentUrl = `https://cib.satim.dz/payment/epg/merchants/merchantsatim/payment.html?mdOrder=${mdOrder}&language=fr`;
      const record = {
        ok: true,
        mode: 'mock',
        accountType: effectiveAccountType,
        invoiceId: localInvoiceRef,
        localInvoiceRef,
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
      this.storeInvoiceRecord(localInvoiceRef, record);
      return record;
    }

    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${effectivePublicKey}`,
      'User-Agent': 'SlickPayBridgeSDK/1.1 (+https://slick-pay.com)',
    };

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

    // webhookUrl, contactUuid, accountUuid et qrcode proviennent exclusivement de la configuration serveur
    const invoicePayload = {
      amount: clean.totals.totalChargeDzd,
      url: clean.returnUrl,
      ...(this.contactUuid ? { contact: this.contactUuid } : {}),
      ...(this.accountUuid ? { account: this.accountUuid } : {}),
      ...(this.qrcode ? { qrcode: true } : {}),
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
      ...(this.webhookUrl ? { webhook_url: this.webhookUrl } : {}),
      webhook_signature: webhookSignature,
      webhook_meta_data: [
        {
          invoice_ref: localInvoiceRef,
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

    const remoteId = String(data?.id || data?.data?.id || localInvoiceRef);
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
      localInvoiceRef,
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
   */
  async getInvoiceStatus(invoiceId, accountTypeOverride) {
    const localRecord = this.resolveLocalRecord(invoiceId);

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

    const targetId = localRecord ? localRecord.invoiceId : String(invoiceId);
    const endpointPath = this.getInvoiceEndpoint(accountTypeOverride);
    const response = await this.fetchImpl(
      `${this.baseUrl}/${endpointPath}/${encodeURIComponent(targetId)}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.publicKey}`,
          'User-Agent': 'SlickPayBridgeSDK/1.1 (+https://slick-pay.com)',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(
        data?.message || `Impossible de vérifier la facture ${targetId} (${response.status})`
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
      this.storeInvoiceRecord(localRecord.invoiceId, localRecord);
    }

    return {
      invoiceId: targetId,
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
        'User-Agent': 'SlickPayBridgeSDK/1.1 (+https://slick-pay.com)',
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
   * Confirme le paiement d'une facture après vérification obligatoire de la signature HMAC du webhook.
   * Accepte une signature calculée soit sur localInvoiceRef (envoyée à SlickPay lors de la création)
   * soit sur invoiceId (ID distant).
   */
  markInvoicePaid(invoiceIdOrRef, providedSignature) {
    const localRecord = this.resolveLocalRecord(invoiceIdOrRef);
    if (!localRecord) {
      const err = new Error(`Facture introuvable : ${invoiceIdOrRef}`);
      err.statusCode = 404;
      throw err;
    }

    const validByLocalRef =
      localRecord.localInvoiceRef &&
      this.verifyWebhookSignature(
        localRecord.localInvoiceRef,
        localRecord.totals.totalCharge,
        providedSignature,
        'paid'
      );
    const validByRemoteId = this.verifyWebhookSignature(
      localRecord.invoiceId,
      localRecord.totals.totalCharge,
      providedSignature,
      'paid'
    );

    if (!validByLocalRef && !validByRemoteId) {
      const err = new Error('Signature HMAC du webhook invalide ou manquante.');
      err.statusCode = 401;
      throw err;
    }

    localRecord.status = 'paid';
    localRecord.paidAt = new Date().toISOString();
    localRecord.webhookSignature = providedSignature;
    return {
      invoiceId: localRecord.invoiceId,
      localInvoiceRef: localRecord.localInvoiceRef,
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
  constructor(publicKey, sandbox = false, options = {}) {
    const isFn = typeof options === 'function';
    const fetchImpl = isFn ? options : options.fetchImpl;
    const webhookSecret = isFn ? undefined : options.webhookSecret;
    const requirePriceSignature = isFn ? false : Boolean(options.requirePriceSignature);
    const defaultReturnUrl = isFn
      ? 'https://localhost/payment-return'
      : options.defaultReturnUrl || 'https://localhost/payment-return';
    this.gateway = new SlickPayGateway({
      publicKey,
      mode: sandbox ? 'sandbox' : 'production',
      accountType: 'users',
      webhookSecret,
      requirePriceSignature,
      defaultReturnUrl,
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
  constructor(publicKey, sandbox = false, options = {}) {
    const isFn = typeof options === 'function';
    const fetchImpl = isFn ? options : options.fetchImpl;
    const webhookSecret = isFn ? undefined : options.webhookSecret;
    const requirePriceSignature = isFn ? false : Boolean(options.requirePriceSignature);
    const defaultReturnUrl = isFn
      ? 'https://localhost/payment-return'
      : options.defaultReturnUrl || 'https://localhost/payment-return';
    this.gateway = new SlickPayGateway({
      publicKey,
      mode: sandbox ? 'sandbox' : 'production',
      accountType: 'merchants',
      webhookSecret,
      requirePriceSignature,
      defaultReturnUrl,
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
