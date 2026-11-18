/**
 * SlickPay Gateway Core SDK (Node.js / Universal Fetch)
 * Gère la création de factures SlickPay API v2, la vérification de statut
 * et un mode Sandbox Simulé (sans clé ou avec clé de test) qui reproduit fidèlement
 * le retour SATIM EPG.
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

export class SlickPayGateway {
  /**
   * @param {Object} config
   * @param {string} [config.publicKey] - Clé publique SlickPay (Bearer Token)
   * @param {'sandbox'|'production'|'mock'} [config.mode='mock'] - Mode d'exécution
   * @param {'users'|'merchants'} [config.accountType='users'] - Route API v2 : 'users' (/api/v2/users/invoices) ou 'merchants' (/api/v2/merchants/invoices comme dans slickpay-npm/MerchantInvoice)
   * @param {string} [config.defaultReturnUrl] - URL de retour après paiement SATIM
   * @param {string} [config.webhookSecret] - Secret HMAC pour signer les callbacks internes
   */
  constructor(config = {}) {
    this.publicKey = config.publicKey || process.env.SLICKPAY_PUBLIC_KEY || '';
    this.mode = config.mode || process.env.SLICKPAY_MODE || (this.publicKey ? 'sandbox' : 'mock');
    this.accountType = config.accountType || process.env.SLICKPAY_ACCOUNT_TYPE || 'users';
    this.defaultReturnUrl = config.defaultReturnUrl || process.env.SLICKPAY_RETURN_URL || 'http://localhost:3400/payment-return';
    this.webhookSecret = config.webhookSecret || process.env.SLICKPAY_WEBHOOK_SECRET || 'slickpay-dev-secret';
    this.invoicesStore = new Map();
  }

  get baseUrl() {
    return this.mode === 'production'
      ? SLICKPAY_ENDPOINTS.production
      : SLICKPAY_ENDPOINTS.sandbox;
  }

  /**
   * Retourne le chemin d'endpoint factures selon accountType ('users/invoices' ou 'merchants/invoices')
   */
  getInvoiceEndpoint(overrideAccountType) {
    const type = overrideAccountType || this.accountType;
    return type === 'merchants' ? 'merchants/invoices' : 'users/invoices';
  }

  /**
   * Valide et normalise la charge utile d'une commande provenant du widget frontend
   */
  validateCheckoutPayload(payload) {
    const errors = [];
    const unitPrice = Number(payload.amount || payload.unitPrice || 0);
    const quantity = Math.max(1, parseInt(payload.quantity ?? 1, 10) || 1);
    const deliveryFee = Math.max(0, Number(payload.deliveryFee ?? 0) || 0);

    if (!Number.isFinite(unitPrice) || unitPrice < 100) {
      errors.push('Le montant unitaire doit être supérieur ou égal à 100 DZD.');
    }

    const fullName = String(payload.fullName || '').trim();
    if (!fullName || fullName.length < 2) {
      errors.push('Le nom complet du client est obligatoire.');
    }

    const email = String(payload.email || '').trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push('Une adresse e-mail valide est obligatoire.');
    }

    const phone = String(payload.phone || '').trim();
    if (!phone || phone.length < 8) {
      errors.push('Un numéro de téléphone valide est obligatoire.');
    }

    const wilaya = String(payload.wilaya || '16').padStart(2, '0');
    const address = String(payload.address || 'Algérie').trim();
    const productName = String(payload.productName || 'Commande Marchand').trim();

    // Champs personnalisés B2B (ex: NIF, RC, AI)
    const customFields = payload.customFields && typeof payload.customFields === 'object'
      ? payload.customFields
      : {};

    if (errors.length > 0) {
      const err = new Error(errors.join(' '));
      err.statusCode = 400;
      err.validationErrors = errors;
      throw err;
    }

    const baseAmountDzd = unitPrice * quantity + deliveryFee;
    const customerFeeDzd = 0;
    const totalChargeDzd = baseAmountDzd + customerFeeDzd;

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
      phone,
      wilaya,
      address,
      customFields,
      returnUrl: payload.returnUrl || this.defaultReturnUrl,
      shopSlug: payload.shopSlug || null,
      totals: {
        baseDzd: baseAmountDzd,
        customerFeeDzd,
        totalChargeDzd,
        // Format identique au Server Action SlickPay en centimes (1 DZD = 100)
        base: Math.round(baseAmountDzd * 100),
        customerFee: Math.round(customerFeeDzd * 100),
        totalCharge: Math.round(totalChargeDzd * 100),
      },
    };
  }

  /**
   * Crée une session de paiement / facture SlickPay et retourne l'URL SATIM/CIB
   */
  async createCheckoutSession(rawPayload) {
    const clean = this.validateCheckoutPayload(rawPayload);
    const invoiceId = `sp_${crypto.randomBytes(8).toString('hex')}`;
    const mdOrder = crypto.randomBytes(10).toString('base64url').slice(0, 20);

    // Si mode mock ou aucune clé API fournie, on simule la réponse exacte de SlickPay / SATIM
    if (this.mode === 'mock' || !this.publicKey) {
      const satimPaymentUrl = `https://cib.satim.dz/payment/epg/merchants/merchantsatim/payment.html?mdOrder=${mdOrder}&language=fr`;
      const record = {
        ok: true,
        mode: 'mock',
        invoiceId,
        mdOrder,
        status: 'pending',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 25 * 60 * 1000).toISOString(), // Réservé 25 min comme sur SlickPay
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
      this.invoicesStore.set(invoiceId, record);
      return record;
    }

    // Mode API SlickPay v2 réel (Sandbox ou Production - developers.slick-pay.com)
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.publicKey}`,
    };

    // Selon la doc officielle (POST /api/v2/users/invoices) :
    // - Si `contact` (UUID) est omis, `firstname`, `lastname`, `phone`, `email` et `address` sont passés directement
    //   (cela évite d'avoir à appeler /users/contacts qui exige un RIB de 20 chiffres).
    // - Support natif de `webhook_url`, `webhook_signature`, `webhook_meta_data` et `qrcode`.
    const webhookSignature = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(`${invoiceId}:${clean.totals.totalChargeDzd}:${clean.email}`)
      .digest('hex');

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
      phone: clean.phone.replace(/[\s\-\.]+/g, ''),
      address: `${clean.address} (Wilaya ${clean.wilaya})`,
      items: [
        {
          name: clean.productName,
          price: clean.unitPrice,
          quantity: clean.quantity,
        },
      ],
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

    const endpointPath = this.getInvoiceEndpoint(rawPayload.accountType);
    const response = await fetch(`${this.baseUrl}/${endpointPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(invoicePayload),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.errors) {
      const err = new Error(
        data?.message || `Erreur API SlickPay (${response.status})`
      );
      err.statusCode = response.status || 502;
      err.details = data;
      throw err;
    }

    const remoteId = String(data?.id || data?.data?.id || invoiceId);
    const paymentUrl =
      data?.url ||
      data?.data?.url ||
      `https://cib.satim.dz/payment/epg/merchants/merchantsatim/payment.html?mdOrder=${mdOrder}&language=fr`;

    const record = {
      ok: true,
      mode: this.mode,
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
      rawResponse: data,
    };

    this.invoicesStore.set(remoteId, record);
    return record;
  }

  /**
   * Vérifie le statut d'une facture (Mock ou API v2 GET /users/invoices/:id ou /merchants/invoices/:id)
   */
  async getInvoiceStatus(invoiceId, accountTypeOverride) {
    const localRecord = this.invoicesStore.get(String(invoiceId));

    if (this.mode === 'mock' || !this.publicKey) {
      if (!localRecord) {
        const err = new Error(`Facture introuvable : ${invoiceId}`);
        err.statusCode = 404;
        throw err;
      }
      return localRecord;
    }

    const endpointPath = this.getInvoiceEndpoint(accountTypeOverride);
    const response = await fetch(`${this.baseUrl}/${endpointPath}/${encodeURIComponent(invoiceId)}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.publicKey}`,
      },
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (localRecord) return localRecord;
      const err = new Error(data?.message || `Facture ${invoiceId} introuvable`);
      err.statusCode = response.status;
      throw err;
    }

    const completed = Boolean(data?.completed || data?.data?.completed || data?.status === 'paid');
    const merged = {
      ...(localRecord || {}),
      invoiceId: String(invoiceId),
      status: completed ? 'paid' : 'pending',
      remoteData: data?.data || data,
    };
    this.invoicesStore.set(String(invoiceId), merged);
    return merged;
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

    const response = await fetch(`${this.baseUrl}/users/invoices/commission`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.publicKey}`,
      },
      body: JSON.stringify({ amount }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data?.message || `Erreur calcul commission (${response.status})`);
      err.statusCode = response.status;
      throw err;
    }
    return data;
  }

  /**
   * Pont vers un lien boutique moderne (`https://app.slick-pay.com/{locale}/shop/{slug}`)
   * Permet de déclencher directement la création de commande SATIM sur un lien e-commerce SlickPay
   * depuis votre propre site web, sans que le visiteur n'ait à quitter votre interface avant l'étape SATIM.
   */
  async createShopLinkSession(shopSlug, rawPayload, locale = 'fr') {
    const clean = this.validateCheckoutPayload({ ...rawPayload, shopSlug });
    const shopUrl = `https://app.slick-pay.com/${encodeURIComponent(locale)}/shop/${encodeURIComponent(shopSlug)}`;

    // Si on est en mode mock/test local, on retourne une session simulée fidèle au format Server Action
    if (this.mode === 'mock') {
      const session = await this.createCheckoutSession({ ...rawPayload, shopSlug });
      return {
        ...session,
        bridge: 'shop-link',
        shopUrl,
      };
    }

    // Sinon on route vers createCheckoutSession API v2 ou le lien direct
    return this.createCheckoutSession({ ...rawPayload, shopSlug });
  }

  /**
   * Simule la confirmation de paiement (utile en mode sandbox/mock pour tester les webhooks)
   */
  markInvoicePaid(invoiceId) {
    const localRecord = this.invoicesStore.get(String(invoiceId));
    if (!localRecord) {
      const err = new Error(`Facture introuvable : ${invoiceId}`);
      err.statusCode = 404;
      throw err;
    }
    localRecord.status = 'paid';
    localRecord.paidAt = new Date().toISOString();
    const signature = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(`${localRecord.invoiceId}:${localRecord.totals.totalCharge}:${localRecord.paidAt}`)
      .digest('hex');
    localRecord.webhookSignature = signature;
    return localRecord;
  }
}

/**
 * Classes compatibles 100% avec la signature officielle `@slick-pay-algeria/slickpay-npm`
 * (sans dépendance axios et avec le endpoint commission corrigé).
 */
export class Invoice {
  constructor(publicKey, sandbox = false) {
    this.gateway = new SlickPayGateway({
      publicKey,
      mode: sandbox ? 'sandbox' : 'production',
      accountType: 'users',
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
  constructor(publicKey, sandbox = false) {
    this.gateway = new SlickPayGateway({
      publicKey,
      mode: sandbox ? 'sandbox' : 'production',
      accountType: 'merchants',
    });
  }
  store(data) {
    return this.gateway.createCheckoutSession({ ...data, accountType: 'merchants' });
  }
  show(id) {
    return this.gateway.getInvoiceStatus(id, 'merchants');
  }
}

