# SlickPay Bridge Studio (`MGhemri/SlickPay-Bridge-Studio`)

Passerelle & Studio Générateur d'Intégration Multi-Produits pour **SlickPay (CIB / Edahabia / SATIM)** en Algérie, avec une expérience utilisateur inspirée de **Stripe Checkout** (modale Shadow DOM en 3 étapes, 100 % compatible `Content-Security-Policy`, 58 wilayas complètes, FR / AR / EN).

- **Démo Live & Générateur Multi-Produits** : [https://connect-gm.com/slickpay-test/](https://connect-gm.com/slickpay-test/)

---

## ✨ Fonctionnalités Clés

1. **Configuration Globale Unique (`SlickPay.init`)** :
   - Le développeur configure sa boutique **une seule fois** sur son site (Clé publique SlickPay, mode `mock` / `sandbox` / `production`, route `users/invoices` ou `merchants/invoices`, langue `fr` / `ar` / `en`, frais de livraison et champs fiscaux B2B optionnels `NIF`, `RC`, `AI`).
2. **Intégration Multi-Produits Instantanée (3 formats au choix)** :
   - **Format 1 — Web Component `<slickpay-button>`** :
     ```html
     <slickpay-button product-name="Abonnement Starter" product-description="Licence 1 poste" amount="4500"></slickpay-button>
     ```
   - **Format 2 — Attributs `data-slickpay` sur n'importe quel bouton HTML/CSS existant** :
     ```html
     <button class="mon-bouton" data-slickpay data-product-name="Pack Pro" data-amount="45000">
       Acheter Pack Pro (45 000 DZD)
     </button>
     ```
   - **Format 3 — Appel JavaScript Dynamique (`SlickPay.openCheckout`)** :
     ```javascript
     SlickPay.openCheckout({
       productName: "Panier #1042",
       amount: 25000,
       quantity: 1,
       prefill: { fullName: "Client", email: "client@domaine.dz", phone: "0550123456", wilaya: "16" }
     });
     ```
3. **Modale Stripe Checkout en 3 Étapes (Shadow DOM & CSP-Safe)** :
   - **Étape 1 (`1. Coordonnées`)** : Quantité, Nom complet / Raison sociale, E-mail, Téléphone.
   - **Étape 2 (`2. Facturation`)** : Wilaya (`01 - Adrar` à `58 - El Meniaa`), Adresse et champs fiscaux B2B (`NIF`, `RC`, `AI`).
   - **Étape 3 (`3. Paiement`)** : Récapitulatif de la transaction et redirection sécurisée vers la page de paiement SATIM (`cib.satim.dz` / `satim.slick-pay.com`).
4. **Double Backend Inclus (Node.js & PHP/cPanel)** :
   - `server/slickpay-sdk.mjs` & `server/index.mjs` : SDK et serveur Node.js zero-dependency (inclut aussi les classes drop-in `Invoice` et `MerchantInvoice` compatibles avec `@slick-pay-algeria/slickpay-npm` mais sans le bug de `/commission`).
   - `public/api/checkout.php` : Passerelle PHP légère prête pour tout hébergement cPanel / Apache / Nginx.

---

## 🚀 Démarrage Rapide en Local

```bash
npm test
npm start
```

Ouvrez ensuite `http://localhost:3400` pour accéder au **SlickPay Bridge Studio**.
