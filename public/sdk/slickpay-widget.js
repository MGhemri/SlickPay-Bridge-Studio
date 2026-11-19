/**
 * SlickPay Universal Web Component & JS SDK (slickpay-widget.js)
 * Design inspiré de Stripe Checkout (épuré, multi-étapes progressives, 100% compatible CSP).
 *
 * Durcissement Sécurité & Accessibilité (Audit) :
 * - Échappement HTML systématique (escapeHtml) sur toutes les valeurs dynamiques (prévention XSS DOM/Shadow DOM)
 * - Validation stricte des URLs paymentUrl / shopUrl (sanitizeUrl : seuls https:// et http:// sont acceptés, javascript: rejeté)
 * - Conservation des saisies (formValues) lors du clic sur +/- quantité
 * - Montant par défaut cohérent (45000 DZD) et support de productId / priceSignature pour la vérification de prix côté serveur
 * - Accessibilité : fermeture par touche Escape, piégeage du focus (Tab/Shift+Tab), aria-labelledby et role="alert"
 * - Suivi de statut post-création via SlickPay.checkStatus(invoiceId) et bouton de vérification dans l'Étape 3
 */

(function (global) {
  'use strict';

  const currentScript =
    document.currentScript ||
    document.querySelector('script[src*="slickpay-widget.js"]');
  const scriptBaseUrl =
    currentScript && currentScript.src
      ? currentScript.src.replace(/\/slickpay-widget\.js(\?.*)?$/, '')
      : './sdk';
  const defaultApiUrl =
    currentScript && currentScript.src
      ? currentScript.src.replace(/\/sdk\/slickpay-widget\.js(\?.*)?$/, '/api/checkout.php')
      : './api/checkout.php';
  const widgetCssUrl = `${scriptBaseUrl}/slickpay-widget.css?v=6`;

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeUrl(candidateUrl, requireHttps = true) {
    if (!candidateUrl) return '';
    try {
      const parsed = new URL(String(candidateUrl), global.location ? global.location.href : 'https://localhost');
      if (requireHttps && parsed.protocol !== 'https:') {
        return '';
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return '';
      }
      return parsed.toString();
    } catch (_) {
      return '';
    }
  }

  const globalConfig = {
    endpoint: defaultApiUrl,
    mode: 'mock',
    publicKey: '',
    accountType: 'users',
    merchantName: 'Boutique Demo DZ',
    locale: 'fr',
    brandColor: '#635bff',
    deliveryFee: 0,
    shopUrl: '',
    returnUrl: '',
    customFields: [],
  };

  function readScriptDatasetConfig() {
    if (!currentScript || !currentScript.dataset) return;
    const ds = currentScript.dataset;
    if (ds.endpoint) globalConfig.endpoint = ds.endpoint;
    if (ds.mode) globalConfig.mode = ds.mode;
    if (ds.publicKey) globalConfig.publicKey = ds.publicKey;
    if (ds.accountType) globalConfig.accountType = ds.accountType;
    if (ds.merchantName) globalConfig.merchantName = ds.merchantName;
    if (ds.locale) globalConfig.locale = ds.locale;
    if (ds.brandColor) globalConfig.brandColor = ds.brandColor;
    if (ds.deliveryFee) globalConfig.deliveryFee = Number(ds.deliveryFee) || 0;
    if (ds.shopUrl) globalConfig.shopUrl = ds.shopUrl;
    if (ds.returnUrl) globalConfig.returnUrl = ds.returnUrl;
    if (ds.customFields) {
      try {
        globalConfig.customFields = JSON.parse(ds.customFields);
      } catch (_) {}
    }
  }
  readScriptDatasetConfig();

  if (
    typeof document !== 'undefined' &&
    !document.getElementById('slickpay-widget-global-css')
  ) {
    const linkEl = document.createElement('link');
    linkEl.id = 'slickpay-widget-global-css';
    linkEl.rel = 'stylesheet';
    linkEl.href = widgetCssUrl;
    document.head.appendChild(linkEl);
  }

  // Liste complète des 58 Wilayas d'Algérie
  const WILAYAS_58 = [
    ['01', 'Adrar'], ['02', 'Chlef'], ['03', 'Laghouat'], ['04', 'Oum El Bouaghi'],
    ['05', 'Batna'], ['06', 'Béjaïa'], ['07', 'Biskra'], ['08', 'Béchar'],
    ['09', 'Blida'], ['10', 'Bouira'], ['11', 'Tamanrasset'], ['12', 'Tébessa'],
    ['13', 'Tlemcen'], ['14', 'Tiaret'], ['15', 'Tizi Ouzou'], ['16', 'Alger'],
    ['17', 'Djelfa'], ['18', 'Jijel'], ['19', 'Sétif'], ['20', 'Saïda'],
    ['21', 'Skikda'], ['22', 'Sidi Bel Abbès'], ['23', 'Annaba'], ['24', 'Guelma'],
    ['25', 'Constantine'], ['26', 'Médéa'], ['27', 'Mostaganem'], ['28', "M'Sila"],
    ['29', 'Mascara'], ['30', 'Ouargla'], ['31', 'Oran'], ['32', 'El Bayadh'],
    ['33', 'Illizi'], ['34', 'Bordj Bou Arréridj'], ['35', 'Boumerdès'], ['36', 'El Tarf'],
    ['37', 'Tindouf'], ['38', 'Tissemsilt'], ['39', 'El Oued'], ['40', 'Khenchela'],
    ['41', 'Souk Ahras'], ['42', 'Tipaza'], ['43', 'Mila'], ['44', 'Aïn Defla'],
    ['45', 'Naâma'], ['46', 'Aïn Témouchent'], ['47', 'Ghardaïa'], ['48', 'Relizane'],
    ['49', 'Timimoun'], ['50', 'Bordj Badji Mokhtar'], ['51', 'Ouled Djellal'], ['52', 'Béni Abbès'],
    ['53', 'In Salah'], ['54', 'In Guezzam'], ['55', 'Touggourt'], ['56', 'Djanet'],
    ['57', "El M'Ghair"], ['58', 'El Meniaa'],
  ];

  const I18N = {
    fr: {
      ctaDefault: 'Payer par carte CIB / Edahabia',
      step1Label: 'Coordonnées',
      step2Label: 'Facturation',
      step3Label: 'Paiement',
      step1Title: 'Vos coordonnées de contact',
      step2Title: 'Adresse & informations fiscales',
      step3Title: 'Récapitulatif avant redirection SATIM',
      securedBy: 'Passerelle de paiement SlickPay · SATIM',
      quantity: 'Quantité',
      delivery: 'Frais de livraison',
      freeDelivery: 'Inclus',
      wilaya: 'Wilaya',
      chooseWilaya: 'Sélectionner une wilaya...',
      address: 'Adresse de facturation',
      fullName: 'Nom complet ou Raison sociale',
      email: 'Adresse e-mail',
      phone: 'Téléphone mobile',
      product: 'Article',
      total: 'Total',
      nextBtn: 'Continuer →',
      backBtn: '← Retour',
      generateBtn: 'Valider & préparer le paiement',
      verifyHeading: 'Commande prête pour le règlement',
      paidHeading: 'Paiement confirmé',
      reservedNotice: 'Lien de paiement SATIM valable pendant 25 minutes.',
      payNow: 'Procéder au paiement',
      checkStatusBtn: 'Vérifier le statut du paiement',
      editOrder: '← Modifier',
      openShopLink: 'Lien marchand',
      processing: 'Connexion à la passerelle...',
    },
    en: {
      ctaDefault: 'Pay with CIB / Edahabia',
      step1Label: 'Contact',
      step2Label: 'Billing',
      step3Label: 'Pay',
      step1Title: 'Contact information',
      step2Title: 'Billing address & tax details',
      step3Title: 'Order review before SATIM payment',
      securedBy: 'Payment gateway by SlickPay · SATIM',
      quantity: 'Quantity',
      delivery: 'Delivery',
      freeDelivery: 'Free',
      wilaya: 'Wilaya (Province)',
      chooseWilaya: 'Select a wilaya...',
      address: 'Billing address',
      fullName: 'Full name or Company',
      email: 'Email address',
      phone: 'Phone number',
      product: 'Item',
      total: 'Total',
      nextBtn: 'Continue →',
      backBtn: '← Back',
      generateBtn: 'Confirm & prepare payment',
      verifyHeading: 'Ready for payment',
      paidHeading: 'Payment confirmed',
      reservedNotice: 'SATIM payment session reserved for 25 minutes.',
      payNow: 'Pay',
      checkStatusBtn: 'Check payment status',
      editOrder: '← Edit',
      openShopLink: 'Merchant link',
      processing: 'Connecting to gateway...',
    },
    ar: {
      ctaDefault: 'الدفع بالبطاقة البنكية (CIB / الذهبية)',
      step1Label: 'المعلومات',
      step2Label: 'الفوترة',
      step3Label: 'الدفع',
      step1Title: 'معلومات الاتصال الخاصة بك',
      step2Title: 'عنوان الفوترة والمعلومات الجبائية',
      step3Title: 'مراجعة الطلب قبل الدفع عبر SATIM',
      securedBy: 'بوابة الدفع عبر SlickPay · شبكة SATIM',
      quantity: 'الكمية',
      delivery: 'التوصيل',
      freeDelivery: 'مجاني',
      wilaya: 'الولاية',
      chooseWilaya: 'اختر الولاية...',
      address: 'عنوان الفوترة',
      fullName: 'الاسم الكامل أو اسم المؤسسة',
      email: 'البريد الإلكتروني',
      phone: 'رقم الهاتف',
      product: 'المنتج',
      total: 'المجموع',
      nextBtn: 'متابعة ←',
      backBtn: 'رجوع →',
      generateBtn: 'تأكيد وتحضير رابط الدفع',
      verifyHeading: 'الطلب جاهز للدفع',
      paidHeading: 'تم تأكيد الدفع',
      reservedNotice: 'رابط الدفع محجوز لمدة 25 دقيقة.',
      payNow: 'ادفع الآن',
      checkStatusBtn: 'تحقق من حالة الدفع',
      editOrder: 'تعديل',
      openShopLink: 'رابط المتجر',
      processing: 'جاري الاتصال بالبوابة...',
    },
  };

  function formatDzd(amount) {
    return new Intl.NumberFormat('fr-DZ').format(Number(amount) || 0) + ' DZD';
  }

  class SlickPayModalController {
    constructor() {
      this.host = null;
      this.shadow = null;
      this.boundKeyDown = this.handleKeyDown.bind(this);
      this.state = {
        step: 1,
        quantity: 1,
        loading: false,
        error: null,
        session: null,
        formValues: {
          wilaya: '16',
          address: '',
          fullName: '',
          email: '',
          phone: '',
          customFields: {},
        },
      };
    }

    open(config = {}) {
      const parsedAmount = Number(config.amount);
      const hasValidAmount = Number.isFinite(parsedAmount) && parsedAmount >= 100;
      const hasProductId = Boolean(config.productId && String(config.productId).trim());

      this.config = {
        endpoint: config.endpoint || globalConfig.endpoint,
        mode: config.mode || globalConfig.mode,
        publicKey: config.publicKey !== undefined ? config.publicKey : globalConfig.publicKey,
        accountType: config.accountType || globalConfig.accountType,
        productId: config.productId || '',
        priceSignature: config.priceSignature || '',
        productName: config.productName || 'Commande',
        productDescription:
          config.productDescription || 'Paiement sécurisé CIB / Edahabia',
        amount: hasValidAmount ? parsedAmount : 0,
        deliveryFee:
          config.deliveryFee !== undefined
            ? Number(config.deliveryFee)
            : Number(globalConfig.deliveryFee || 0),
        merchantName: config.merchantName || globalConfig.merchantName,
        locale: config.locale || globalConfig.locale || 'fr',
        shopUrl: config.shopUrl !== undefined ? config.shopUrl : globalConfig.shopUrl,
        returnUrl: config.returnUrl || globalConfig.returnUrl || '',
        customFields:
          Array.isArray(config.customFields) && config.customFields.length > 0
            ? config.customFields
            : globalConfig.customFields,
        prefill: config.prefill || {},
        onSuccess: config.onSuccess || null,
        onSessionCreated: config.onSessionCreated || config.onSuccess || null,
        onPaymentVerified: config.onPaymentVerified || null,
        onError: config.onError || null,
      };

      this.state.step = 1;
      this.state.quantity = Math.max(1, Math.min(1000, parseInt(config.quantity || 1, 10) || 1));
      this.state.loading = false;
      this.state.error =
        !hasValidAmount && !hasProductId
          ? 'Configuration du bouton incomplète : attribut amount (>= 100 DZD) ou product-id requis.'
          : null;
      this.state.session = null;
      this.state.formValues = {
        wilaya: this.config.prefill.wilaya || '16',
        address: this.config.prefill.address || '',
        fullName: this.config.prefill.fullName || '',
        email: this.config.prefill.email || '',
        phone: this.config.prefill.phone || '',
        customFields: { ...(this.config.prefill.customFields || {}) },
      };

      if (!this.host) {
        this.host = document.createElement('div');
        this.host.id = 'slickpay-universal-modal-host';
        this.shadow = this.host.attachShadow({ mode: 'open' });
        document.body.appendChild(this.host);
        document.addEventListener('keydown', this.boundKeyDown);
      }

      this.render();
    }

    close() {
      document.removeEventListener('keydown', this.boundKeyDown);
      if (this.host && this.host.parentNode) {
        this.host.parentNode.removeChild(this.host);
        this.host = null;
        this.shadow = null;
      }
    }

    handleKeyDown(e) {
      if (!this.shadow) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
        return;
      }
      if (e.key === 'Tab') {
        const focusables = Array.from(
          this.shadow.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]'
          )
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = this.shadow.activeElement;
        if (e.shiftKey && (active === first || !active)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    /**
     * Sauvegarde les champs en cours de saisie avant un re-rendu (ex: clic sur +/- quantité)
     */
    captureCurrentInputs() {
      if (!this.shadow) return;
      const fnEl = this.shadow.getElementById('sp-fullName');
      const emEl = this.shadow.getElementById('sp-email');
      const phEl = this.shadow.getElementById('sp-phone');
      const wiEl = this.shadow.getElementById('sp-wilaya');
      const adEl = this.shadow.getElementById('sp-address');

      if (fnEl) this.state.formValues.fullName = fnEl.value;
      if (emEl) this.state.formValues.email = emEl.value;
      if (phEl) this.state.formValues.phone = phEl.value;
      if (wiEl) this.state.formValues.wilaya = wiEl.value;
      if (adEl) this.state.formValues.address = adEl.value;

      if (this.config && Array.isArray(this.config.customFields)) {
        for (const f of this.config.customFields) {
          const cfEl = this.shadow.getElementById(`sp-custom-${f.key}`);
          if (cfEl) {
            this.state.formValues.customFields[f.key] = cfEl.value;
          }
        }
      }
    }

    get dict() {
      return I18N[this.config?.locale] || I18N.fr;
    }

    get totalAmount() {
      return Math.round((this.config.amount * this.state.quantity + this.config.deliveryFee) * 100) / 100;
    }

    handleStep1Next(event) {
      event.preventDefault();
      this.captureCurrentInputs();
      this.state.formValues.fullName = String(this.state.formValues.fullName || '').trim();
      this.state.formValues.email = String(this.state.formValues.email || '').trim();
      this.state.formValues.phone = String(this.state.formValues.phone || '').trim();
      this.state.error = null;
      this.state.step = 2;
      this.render();
    }

    async handleStep2Submit(event) {
      event.preventDefault();
      this.captureCurrentInputs();
      this.state.formValues.wilaya = this.state.formValues.wilaya || '16';
      this.state.formValues.address = String(this.state.formValues.address || '').trim();

      this.state.loading = true;
      this.state.error = null;
      this.render();

      try {
        const res = await fetch(this.config.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: this.config.mode,
            publicKey: this.config.publicKey || undefined,
            accountType: this.config.accountType,
            returnUrl: this.config.returnUrl || undefined,
            productId: this.config.productId || undefined,
            priceSignature: this.config.priceSignature || undefined,
            productName: this.config.productName,
            amount: this.config.amount,
            quantity: this.state.quantity,
            deliveryFee: this.config.deliveryFee,
            wilaya: this.state.formValues.wilaya,
            address: this.state.formValues.address,
            fullName: this.state.formValues.fullName,
            email: this.state.formValues.email,
            phone: this.state.formValues.phone,
            customFields: this.state.formValues.customFields,
          }),
        });

        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(
            data.error || 'Erreur lors de la création de la session SlickPay'
          );
        }

        this.state.session = data;
        this.state.step = 3;
        this.state.loading = false;
        this.render();

        window.dispatchEvent(
          new CustomEvent('slickpay:session-created', { detail: data })
        );
        if (typeof this.config.onSessionCreated === 'function') {
          this.config.onSessionCreated(data);
        }
      } catch (err) {
        this.state.loading = false;
        this.state.error = err.message;
        this.render();
        window.dispatchEvent(
          new CustomEvent('slickpay:session-error', {
            detail: { error: err.message },
          })
        );
        if (typeof this.config.onError === 'function') {
          this.config.onError(err);
        }
      }
    }

    async verifyCurrentSessionStatus() {
      if (!this.state.session || !this.state.session.invoiceId) return;
      this.state.loading = true;
      this.state.error = null;
      this.render();
      try {
        const statusData = await checkStatusRequest(
          this.state.session.invoiceId,
          this.config
        );
        this.state.session.status = statusData.status || 'pending';
        this.state.loading = false;
        this.render();
        window.dispatchEvent(
          new CustomEvent('slickpay:status-checked', { detail: statusData })
        );
        if (
          statusData.status === 'paid' &&
          typeof this.config.onPaymentVerified === 'function'
        ) {
          this.config.onPaymentVerified(statusData);
        }
      } catch (err) {
        this.state.loading = false;
        this.state.error = err.message;
        this.render();
      }
    }

    render() {
      if (!this.shadow) return;
      const t = this.dict;
      const isRtl = this.config.locale === 'ar';
      const s = this.state.step;

      const wilayaOptions = WILAYAS_58.map(
        ([code, name]) =>
          `<option value="${escapeHtml(code)}" ${
            this.state.formValues.wilaya === code ? 'selected' : ''
          }>${escapeHtml(code)} - ${escapeHtml(name)}</option>`
      ).join('');

      const customFieldsHtml = this.config.customFields
        .map((f) => {
          const safeKey = escapeHtml(f.key);
          const safeLabel = escapeHtml(f.label);
          const safePlaceholder = escapeHtml(f.placeholder || f.label);
          const val = escapeHtml(this.state.formValues.customFields[f.key] || '');
          return `
            <div class="sp-field">
              <label for="sp-custom-${safeKey}">${safeLabel}${f.required ? ' *' : ''}</label>
              <input
                id="sp-custom-${safeKey}"
                name="custom_${safeKey}"
                type="text"
                value="${val}"
                placeholder="${safePlaceholder}"
                ${f.required ? 'required' : ''}
              />
            </div>
          `;
        })
        .join('');

      const step1Html = `
        <form id="sp-step1-form">
          <p class="sp-step-title">${escapeHtml(t.step1Title)}</p>

          <div class="sp-qty-bar">
            <span>${escapeHtml(t.quantity)} (${escapeHtml(formatDzd(this.config.amount))} / u)</span>
            <div class="sp-stepper">
              <button type="button" id="sp-qty-minus" ${this.state.quantity <= 1 ? 'disabled' : ''}>−</button>
              <output id="sp-qty-val">${escapeHtml(this.state.quantity)}</output>
              <button type="button" id="sp-qty-plus">+</button>
            </div>
          </div>

          <div class="sp-field">
            <label for="sp-fullName">${escapeHtml(t.fullName)} *</label>
            <input id="sp-fullName" name="fullName" type="text" required value="${escapeHtml(this.state.formValues.fullName)}" placeholder="Ex: Amine Benali" />
          </div>

          <div class="sp-field">
            <label for="sp-email">${escapeHtml(t.email)} *</label>
            <input id="sp-email" name="email" type="email" required value="${escapeHtml(this.state.formValues.email)}" placeholder="nom@entreprise.dz" />
          </div>

          <div class="sp-field">
            <label for="sp-phone">${escapeHtml(t.phone)} *</label>
            <input id="sp-phone" name="phone" type="tel" required value="${escapeHtml(this.state.formValues.phone)}" placeholder="0550 00 00 00" />
          </div>

          ${
            this.state.error
              ? `<div class="sp-error" role="alert">${escapeHtml(this.state.error)}</div>`
              : ''
          }

          <div class="sp-actions-row">
            <button type="submit" class="sp-btn-primary" id="sp-step1-next" ${this.state.error ? 'disabled' : ''}>
              ${escapeHtml(t.nextBtn)}
            </button>
          </div>
        </form>
      `;

      const step2Html = `
        <form id="sp-step2-form">
          <p class="sp-step-title">${escapeHtml(t.step2Title)}</p>

          <div class="sp-field">
            <label for="sp-wilaya">${escapeHtml(t.wilaya)} *</label>
            <select id="sp-wilaya" name="wilaya" required>
              <option value="">${escapeHtml(t.chooseWilaya)}</option>
              ${wilayaOptions}
            </select>
          </div>

          <div class="sp-field">
            <label for="sp-address">${escapeHtml(t.address)} *</label>
            <input id="sp-address" name="address" type="text" required value="${escapeHtml(this.state.formValues.address)}" placeholder="Rue, Commune, Ville..." />
          </div>

          ${
            customFieldsHtml
              ? `<div class="sp-grid-2">${customFieldsHtml}</div>`
              : ''
          }

          ${
            this.state.error
              ? `<div class="sp-error" role="alert">${escapeHtml(this.state.error)}</div>`
              : ''
          }

          <div class="sp-actions-row">
            <button type="button" class="sp-btn-secondary" id="sp-step2-back">
              ${escapeHtml(t.backBtn)}
            </button>
            <button type="submit" class="sp-btn-primary" id="sp-step2-submit" ${this.state.loading ? 'disabled' : ''}>
              ${escapeHtml(this.state.loading ? t.processing : t.generateBtn)}
            </button>
          </div>
        </form>
      `;

      const session = this.state.session;
      const safePaymentUrl = session ? sanitizeUrl(session.paymentUrl, true) : '';
      const safeShopUrl = sanitizeUrl(this.config.shopUrl, false);
      const isPaid = session && session.status === 'paid';

      const step3Html = session
        ? `
        <div>
          <div class="sp-status-pill">✓ ${escapeHtml(isPaid ? t.paidHeading : t.verifyHeading)}</div>
          <p class="sp-reserve-note">${escapeHtml(t.reservedNotice)}</p>

          <div class="sp-summary-card">
            <div class="sp-summary-row">
              <span>${escapeHtml(t.product)}</span>
              <strong>${escapeHtml(this.config.productName)} × ${escapeHtml(this.state.quantity)}</strong>
            </div>
            <div class="sp-summary-row">
              <span>Client</span>
              <span>${escapeHtml(session.customer?.fullName || this.state.formValues.fullName)}</span>
            </div>
            <div class="sp-summary-row">
              <span>Wilaya</span>
              <span>${escapeHtml(session.customer?.wilaya || this.state.formValues.wilaya)}</span>
            </div>
            <div class="sp-summary-row">
              <span>Réf. transaction</span>
              <code>${escapeHtml(session.invoiceId)}</code>
            </div>
            <div class="sp-summary-row sp-total">
              <span>${escapeHtml(t.total)}</span>
              <strong>${escapeHtml(formatDzd(session.totals?.totalChargeDzd || this.totalAmount))}</strong>
            </div>
          </div>

          ${
            this.state.error
              ? `<div class="sp-error" role="alert">${escapeHtml(this.state.error)}</div>`
              : ''
          }

          <div class="sp-actions-row">
            <button type="button" class="sp-btn-secondary" id="sp-edit-order-btn">
              ${escapeHtml(t.editOrder)}
            </button>
            ${
              safePaymentUrl
                ? `<a href="${escapeHtml(safePaymentUrl)}" target="_blank" rel="noopener noreferrer" class="sp-btn-primary" id="sp-pay-satim-btn">
                    ${escapeHtml(t.payNow)} (${escapeHtml(formatDzd(session.totals?.totalChargeDzd || this.totalAmount))}) →
                  </a>`
                : ''
            }
          </div>
          <div class="sp-actions-row">
            <button type="button" class="sp-btn-secondary" id="sp-check-status-btn" ${this.state.loading ? 'disabled' : ''}>
              ${escapeHtml(this.state.loading ? t.processing : t.checkStatusBtn)}
            </button>
          </div>
        </div>
      `
        : '';

      this.shadow.innerHTML = `
        <link rel="stylesheet" href="${escapeHtml(widgetCssUrl)}" />
        <div class="sp-overlay" dir="${isRtl ? 'rtl' : 'ltr'}">
          <div class="sp-modal" role="dialog" aria-modal="true" aria-labelledby="sp-modal-title">
            <div class="sp-header">
              <div class="sp-merchant-info">
                <span class="sp-merchant-tag">
                  <span class="sp-dot"></span>
                  ${escapeHtml(this.config.merchantName)}
                </span>
                <h3 class="sp-amount-hero" id="sp-modal-title">${escapeHtml(formatDzd(this.totalAmount))}</h3>
                <p class="sp-product-sub">${escapeHtml(this.config.productName)} — ${escapeHtml(this.config.productDescription)}</p>
              </div>
              <button type="button" class="sp-close" id="sp-close-btn" aria-label="Fermer">✕</button>
            </div>

            <div class="sp-steps-bar">
              <div class="sp-step-item ${s === 1 ? 'active' : s > 1 ? 'done' : ''}">
                <span class="sp-step-num">${s > 1 ? '✓' : '1'}</span>
                <span>${escapeHtml(t.step1Label)}</span>
              </div>
              <div class="sp-step-sep"></div>
              <div class="sp-step-item ${s === 2 ? 'active' : s > 2 ? 'done' : ''}">
                <span class="sp-step-num">${s > 2 ? '✓' : '2'}</span>
                <span>${escapeHtml(t.step2Label)}</span>
              </div>
              <div class="sp-step-sep"></div>
              <div class="sp-step-item ${s === 3 ? 'active' : ''}">
                <span class="sp-step-num">3</span>
                <span>${escapeHtml(t.step3Label)}</span>
              </div>
            </div>

            <div class="sp-body">
              ${s === 1 ? step1Html : s === 2 ? step2Html : step3Html}
            </div>

            <div class="sp-footer">
              <span>${escapeHtml(t.securedBy)}</span>
              ${
                safeShopUrl
                  ? `<a href="${escapeHtml(safeShopUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.openShopLink)} ↗</a>`
                  : ''
              }
            </div>
          </div>
        </div>
      `;

      const closeBtn = this.shadow.getElementById('sp-close-btn');
      if (closeBtn) closeBtn.addEventListener('click', () => this.close());

      const minusBtn = this.shadow.getElementById('sp-qty-minus');
      if (minusBtn) {
        minusBtn.addEventListener('click', () => {
          if (this.state.quantity > 1) {
            this.captureCurrentInputs();
            this.state.quantity -= 1;
            this.render();
          }
        });
      }

      const plusBtn = this.shadow.getElementById('sp-qty-plus');
      if (plusBtn) {
        plusBtn.addEventListener('click', () => {
          if (this.state.quantity < 1000) {
            this.captureCurrentInputs();
            this.state.quantity += 1;
            this.render();
          }
        });
      }

      const step1Form = this.shadow.getElementById('sp-step1-form');
      if (step1Form) {
        step1Form.addEventListener('submit', (e) => this.handleStep1Next(e));
      }

      const step2Back = this.shadow.getElementById('sp-step2-back');
      if (step2Back) {
        step2Back.addEventListener('click', () => {
          this.captureCurrentInputs();
          this.state.step = 1;
          this.state.error = null;
          this.render();
        });
      }

      const step2Form = this.shadow.getElementById('sp-step2-form');
      if (step2Form) {
        step2Form.addEventListener('submit', (e) => this.handleStep2Submit(e));
      }

      const editBtn = this.shadow.getElementById('sp-edit-order-btn');
      if (editBtn) {
        editBtn.addEventListener('click', () => {
          this.state.step = 2;
          this.render();
        });
      }

      const checkStatusBtn = this.shadow.getElementById('sp-check-status-btn');
      if (checkStatusBtn) {
        checkStatusBtn.addEventListener('click', () =>
          this.verifyCurrentSessionStatus()
        );
      }
    }
  }

  async function checkStatusRequest(invoiceId, opts = {}) {
    const endpoint = opts.endpoint || globalConfig.endpoint;
    const mode = opts.mode || globalConfig.mode;
    const publicKey =
      opts.publicKey !== undefined ? opts.publicKey : globalConfig.publicKey;
    const accountType = opts.accountType || globalConfig.accountType;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'status',
        invoiceId,
        mode,
        publicKey: publicKey || undefined,
        accountType,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Impossible de vérifier le statut de la facture.');
    }
    return data;
  }

  const modalSingleton = new SlickPayModalController();

  if (typeof document !== 'undefined') {
    document.addEventListener('click', function (e) {
      const trigger = e.target.closest && e.target.closest('[data-slickpay]');
      if (!trigger) return;
      e.preventDefault();
      const ds = trigger.dataset;
      modalSingleton.open({
        productId: ds.productId || '',
        priceSignature: ds.priceSignature || '',
        productName: ds.productName || ds.name || 'Article',
        productDescription: ds.productDescription || ds.description || '',
        amount: ds.amount !== undefined || ds.price !== undefined ? Number(ds.amount ?? ds.price) : NaN,
        quantity: Number(ds.quantity || 1),
        deliveryFee:
          ds.deliveryFee !== undefined ? Number(ds.deliveryFee) : undefined,
      });
    });
  }

  class SlickPayButtonElement extends HTMLElement {
    connectedCallback() {
      this.renderButton();
    }

    static get observedAttributes() {
      return ['label', 'amount', 'product-name', 'locale'];
    }

    attributeChangedCallback() {
      if (this.isConnected) this.renderButton();
    }

    renderButton() {
      const locale = this.getAttribute('locale') || globalConfig.locale || 'fr';
      const dict = I18N[locale] || I18N.fr;
      const amount = this.getAttribute('amount') || '45000';
      const label =
        this.getAttribute('label') ||
        `${dict.ctaDefault} · ${formatDzd(amount)}`;

      this.innerHTML = `
        <button type="button" class="slickpay-trigger-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="5" width="20" height="14" rx="2"></rect>
            <line x1="2" y1="10" x2="22" y2="10"></line>
          </svg>
          <span>${escapeHtml(label)}</span>
        </button>
      `;

      const btn = this.querySelector('button');
      btn.addEventListener('click', () => this.openCheckout());
    }

    openCheckout() {
      let customFields = undefined;
      const rawCustom = this.getAttribute('custom-fields');
      if (rawCustom) {
        try {
          customFields = JSON.parse(rawCustom);
        } catch (_) {}
      }

      modalSingleton.open({
        endpoint: this.getAttribute('endpoint') || undefined,
        mode: this.getAttribute('mode') || undefined,
        publicKey: this.getAttribute('public-key') || undefined,
        accountType: this.getAttribute('account-type') || undefined,
        productId: this.getAttribute('product-id') || undefined,
        priceSignature: this.getAttribute('price-signature') || undefined,
        productName: this.getAttribute('product-name') || 'Produit',
        productDescription:
          this.getAttribute('product-description') || undefined,
        amount: this.hasAttribute('amount') ? Number(this.getAttribute('amount')) : NaN,
        quantity: Number(this.getAttribute('quantity') || 1),
        deliveryFee: this.hasAttribute('delivery-fee')
          ? Number(this.getAttribute('delivery-fee'))
          : undefined,
        merchantName: this.getAttribute('merchant-name') || undefined,
        locale: this.getAttribute('locale') || undefined,
        shopUrl: this.getAttribute('shop-url') || undefined,
        customFields,
      });
    }
  }

  if (!customElements.get('slickpay-button')) {
    customElements.define('slickpay-button', SlickPayButtonElement);
  }

  global.SlickPay = {
    init: function (options = {}) {
      Object.assign(globalConfig, options);
      document.querySelectorAll('slickpay-button').forEach((el) => {
        if (typeof el.renderButton === 'function') el.renderButton();
      });
      return globalConfig;
    },
    getConfig: function () {
      return { ...globalConfig };
    },
    openCheckout: (options) => modalSingleton.open(options),
    closeCheckout: () => modalSingleton.close(),
    checkStatus: (invoiceId, options) => checkStatusRequest(invoiceId, options),
    escapeHtml,
    sanitizeUrl,
    WILAYAS_58,
  };
})(typeof window !== 'undefined' ? window : globalThis);
