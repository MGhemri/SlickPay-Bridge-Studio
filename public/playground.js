(function () {
  'use strict';

  // État du catalogue de produits du développeur
  let products = [
    { name: 'Abonnement Starter', desc: 'Licence mensuelle 1 poste', price: 4500 },
    { name: 'Pack Business Pro', desc: 'Licence annuelle multi-utilisateurs', price: 45000 },
    { name: 'Passerelle Cloud Enterprise', desc: 'Serveur dédié + Support 24/7', price: 120000 }
  ];

  let activeCodeFormat = 'webcomponent'; // 'webcomponent' | 'dataattr' | 'js'

  // Références DOM
  const merchantInput = document.getElementById('cfg-merchant');
  const modeSelect = document.getElementById('cfg-mode');
  const accountSelect = document.getElementById('cfg-account-type');
  const pubkeyInput = document.getElementById('cfg-pubkey');
  const localeSelect = document.getElementById('cfg-locale');
  const deliveryInput = document.getElementById('cfg-delivery');
  const returnUrlInput = document.getElementById('cfg-return-url');
  const chkNif = document.getElementById('chk-nif');
  const chkRc = document.getElementById('chk-rc');
  const chkAi = document.getElementById('chk-ai');

  const catalogListEl = document.getElementById('catalog-list');
  const btnAddProd = document.getElementById('btn-add-prod');
  const previewGridEl = document.getElementById('preview-store-grid');
  const globalCodeEl = document.getElementById('code-global-snippet');
  const productsCodeEl = document.getElementById('code-products-snippet');
  const logEl = document.getElementById('event-log');

  function getCustomFieldsArray() {
    const arr = [];
    if (chkNif && chkNif.checked) {
      arr.push({ key: 'nif', label: 'NIF (Identification Fiscale)', required: true });
    }
    if (chkRc && chkRc.checked) {
      arr.push({ key: 'rc', label: 'RC (Registre du Commerce)', required: true });
    }
    if (chkAi && chkAi.checked) {
      arr.push({ key: 'ai', label: 'Article d’Imposition (AI)', required: false });
    }
    return arr;
  }

  function formatDzd(val) {
    return new Intl.NumberFormat('fr-DZ').format(Number(val) || 0) + ' DZD';
  }

  // 1. Appliquer la config globale à SlickPay.init(...)
  function syncGlobalBridge() {
    if (!window.SlickPay || typeof window.SlickPay.init !== 'function') return;
    window.SlickPay.init({
      endpoint: './api/checkout.php',
      merchantName: merchantInput.value.trim() || 'Ma Boutique',
      mode: modeSelect.value,
      accountType: accountSelect.value,
      publicKey: pubkeyInput.value.trim(),
      locale: localeSelect.value,
      deliveryFee: Number(deliveryInput.value || 0),
      returnUrl: returnUrlInput.value.trim(),
      customFields: getCustomFieldsArray()
    });
  }

  // 2. Rendu de l'éditeur de catalogue (Colonne gauche)
  function renderCatalogEditor() {
    catalogListEl.innerHTML = '';
    products.forEach(function (prod, idx) {
      const row = document.createElement('div');
      row.className = 'catalog-row';
      row.innerHTML =
        '<input type="text" data-idx="' + idx + '" data-field="name" value="' + prod.name.replace(/"/g, '&quot;') + '" placeholder="Nom du produit" />' +
        '<input type="text" data-idx="' + idx + '" data-field="desc" value="' + prod.desc.replace(/"/g, '&quot;') + '" placeholder="Description courte" />' +
        '<input type="number" data-idx="' + idx + '" data-field="price" value="' + prod.price + '" min="100" step="100" placeholder="Prix DZD" />' +
        '<button type="button" class="btn-remove-prod" data-remove="' + idx + '" title="Supprimer">✕</button>';
      catalogListEl.appendChild(row);
    });

    catalogListEl.querySelectorAll('input').forEach(function (inp) {
      inp.addEventListener('input', function (e) {
        const i = Number(e.target.getAttribute('data-idx'));
        const field = e.target.getAttribute('data-field');
        if (field === 'price') {
          products[i].price = Number(e.target.value || 0);
        } else {
          products[i][field] = e.target.value;
        }
        updateOutputAndPreview();
      });
    });

    catalogListEl.querySelectorAll('[data-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (products.length <= 1) return;
        const i = Number(btn.getAttribute('data-remove'));
        products.splice(i, 1);
        renderCatalogEditor();
        updateOutputAndPreview();
      });
    });
  }

  // 3. Mise à jour des blocs de code générés + Aperçu Boutique Multi-Produits
  function updateOutputAndPreview() {
    syncGlobalBridge();

    const merchant = merchantInput.value.trim() || 'Ma Boutique';
    const mode = modeSelect.value;
    const accountType = accountSelect.value;
    const pubKey = pubkeyInput.value.trim();
    const locale = localeSelect.value;
    const deliveryFee = Number(deliveryInput.value || 0);
    const returnUrl = returnUrlInput.value.trim();
    const customFields = getCustomFieldsArray();

    // A. Code Global Unique (à mettre 1 seule fois dans <head> ou avant </body>)
    const initConfigObj = {
      endpoint: 'https://connect-gm.com/slickpay-test/api/checkout.php',
      merchantName: merchant,
      mode: mode,
      accountType: accountType,
      publicKey: pubKey || 'VOTRE_CLE_PUBLIQUE_SLICKPAY',
      locale: locale,
      ...(deliveryFee > 0 ? { deliveryFee: deliveryFee } : {}),
      ...(returnUrl ? { returnUrl: returnUrl } : {}),
      ...(customFields.length > 0 ? { customFields: customFields } : {})
    };

    globalCodeEl.textContent =
      '<!-- À placer UNE SEULE FOIS dans votre site (ex: <head> ou footer) -->\n' +
      '<script src="https://connect-gm.com/slickpay-test/sdk/slickpay-widget.js"></script>\n' +
      '<script>\n' +
      '  SlickPay.init(' + JSON.stringify(initConfigObj, null, 4) + ');\n' +
      '</script>';

    // B. Code Multi-Produits selon l'onglet choisi
    if (activeCodeFormat === 'webcomponent') {
      productsCodeEl.textContent =
        '<!-- Placez ces balises sur chacune de vos fiches produits -->\n' +
        products
          .map(function (p) {
            return (
              '<slickpay-button\n' +
              '  product-name="' + p.name + '"\n' +
              '  product-description="' + p.desc + '"\n' +
              '  amount="' + p.price + '"\n' +
              '></slickpay-button>'
            );
          })
          .join('\n\n');
    } else if (activeCodeFormat === 'dataattr') {
      productsCodeEl.textContent =
        '<!-- Ajoutez simplement data-slickpay sur VOS propres boutons HTML/CSS existants -->\n' +
        products
          .map(function (p) {
            return (
              '<button\n' +
              '  class="mon-bouton-site"\n' +
              '  data-slickpay\n' +
              '  data-product-name="' + p.name + '"\n' +
              '  data-product-description="' + p.desc + '"\n' +
              '  data-amount="' + p.price + '"\n' +
              '>\n' +
              '  Acheter ' + p.name + ' (' + formatDzd(p.price) + ')\n' +
              '</button>'
            );
          })
          .join('\n\n');
    } else {
      const sampleProd = products[0] || { name: 'Produit', desc: '', price: 4500 };
      productsCodeEl.textContent =
        '// Déclenchement dynamique en JavaScript (Panier e-commerce, React, Vue)\n' +
        'SlickPay.openCheckout({\n' +
        '  productName: ' + JSON.stringify(sampleProd.name) + ',\n' +
        '  productDescription: ' + JSON.stringify(sampleProd.desc) + ',\n' +
        '  amount: ' + sampleProd.price + ',\n' +
        '  quantity: 1,\n' +
        '  prefill: {\n' +
        '    fullName: "Client Pré-rempli",\n' +
        '    email: "client@domaine.dz",\n' +
        '    phone: "0550123456",\n' +
        '    wilaya: "16"\n' +
        '  }\n' +
        '});';
    }

    // C. Rendu de l'aperçu Boutique Multi-Produits en direct
    previewGridEl.innerHTML = '';
    products.forEach(function (p) {
      const card = document.createElement('div');
      card.className = 'store-product-card';

      if (activeCodeFormat === 'dataattr') {
        card.innerHTML =
          '<div>' +
            '<h4 class="store-prod-name">' + p.name + '</h4>' +
            '<p class="store-prod-desc">' + p.desc + '</p>' +
            '<div class="store-prod-price">' + formatDzd(p.price) + '</div>' +
          '</div>' +
          '<button type="button" class="custom-html-btn" data-slickpay ' +
            'data-product-name="' + p.name.replace(/"/g, '&quot;') + '" ' +
            'data-product-description="' + p.desc.replace(/"/g, '&quot;') + '" ' +
            'data-amount="' + p.price + '">' +
            'Acheter (' + formatDzd(p.price) + ') →' +
          '</button>';
      } else {
        card.innerHTML =
          '<div>' +
            '<h4 class="store-prod-name">' + p.name + '</h4>' +
            '<p class="store-prod-desc">' + p.desc + '</p>' +
            '<div class="store-prod-price">' + formatDzd(p.price) + '</div>' +
          '</div>' +
          '<slickpay-button ' +
            'product-name="' + p.name.replace(/"/g, '&quot;') + '" ' +
            'product-description="' + p.desc.replace(/"/g, '&quot;') + '" ' +
            'amount="' + p.price + '">' +
          '</slickpay-button>';
      }
      previewGridEl.appendChild(card);
    });
  }

  // Écouteurs sur les champs de configuration globale
  [
    merchantInput,
    modeSelect,
    accountSelect,
    pubkeyInput,
    localeSelect,
    deliveryInput,
    returnUrlInput,
    chkNif,
    chkRc,
    chkAi
  ].forEach(function (el) {
    if (!el) return;
    el.addEventListener('input', updateOutputAndPreview);
    el.addEventListener('change', updateOutputAndPreview);
  });

  if (btnAddProd) {
    btnAddProd.addEventListener('click', function () {
      products.push({
        name: 'Nouveau Produit ' + (products.length + 1),
        desc: 'Description du produit',
        price: 15000
      });
      renderCatalogEditor();
      updateOutputAndPreview();
    });
  }

  // Onglets de format de code produit
  document.querySelectorAll('[data-tab-format]').forEach(function (tabBtn) {
    tabBtn.addEventListener('click', function () {
      document.querySelectorAll('[data-tab-format]').forEach(function (b) {
        b.classList.remove('active');
      });
      tabBtn.classList.add('active');
      activeCodeFormat = tabBtn.getAttribute('data-tab-format');
      updateOutputAndPreview();
    });
  });

  // Boutons Copier le code
  document.querySelectorAll('[data-copy-target]').forEach(function (copyBtn) {
    copyBtn.addEventListener('click', function () {
      const targetId = copyBtn.getAttribute('data-copy-target');
      const codeEl = document.getElementById(targetId);
      if (!codeEl) return;
      navigator.clipboard.writeText(codeEl.textContent).then(function () {
        const orig = copyBtn.textContent;
        copyBtn.textContent = '✓ Copié !';
        setTimeout(function () {
          copyBtn.textContent = orig;
        }, 1800);
      });
    });
  });

  // Journal des événements de paiement
  window.addEventListener('slickpay:session-created', function (e) {
    if (logEl) {
      logEl.textContent = JSON.stringify(e.detail, null, 2);
    }
  });

  window.addEventListener('slickpay:session-error', function (e) {
    if (logEl) {
      logEl.textContent = JSON.stringify(e.detail, null, 2);
    }
  });

  // Initialisation au chargement
  window.addEventListener('DOMContentLoaded', function () {
    renderCatalogEditor();
    updateOutputAndPreview();
  });
})();
