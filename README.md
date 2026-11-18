# SlickPay Bridge Studio

Passerelle et générateur d'intégration multi-produits pour SlickPay (CIB / Edahabia / SATIM), avec une interface de paiement inspirée de Stripe Checkout (modale Shadow DOM en 3 étapes, compatible `Content-Security-Policy`, 58 wilayas, support FR / AR / EN).

- Démo et générateur : [https://connect-gm.com/slickpay-test/](https://connect-gm.com/slickpay-test/)

---

## Architecture et fonctionnalités

1. **Configuration globale unique (`SlickPay.init`)**
   Le développeur déclare la configuration de sa boutique une seule fois sur son site : clé publique SlickPay, environnement (`mock`, `sandbox`, `production`), route API v2 (`users/invoices` ou `merchants/invoices`), langue (`fr`, `ar`, `en`), frais de livraison par défaut et champs fiscaux B2B optionnels (`NIF`, `RC`, `AI`).

2. **Intégration multi-produits (3 modes supportés)**
   - **Balise Web Component `<slickpay-button>`** :
     ```html
     <slickpay-button
       product-name="Abonnement Starter"
       product-description="Licence mensuelle 1 poste"
       amount="4500"
     ></slickpay-button>
     ```
   - **Attributs `data-slickpay` sur des boutons HTML existants** :
     ```html
     <button
       class="btn-primary"
       data-slickpay
       data-product-name="Pack Pro"
       data-product-description="Licence annuelle"
       data-amount="45000"
     >
       Acheter Pack Pro (45 000 DZD)
     </button>
     ```
   - **Appel JavaScript (`SlickPay.openCheckout`)** :
     ```javascript
     SlickPay.openCheckout({
       productName: "Commande #1042",
       amount: 25000,
       quantity: 1,
       prefill: {
         fullName: "Client",
         email: "client@domaine.dz",
         phone: "0550123456",
         wilaya: "16"
       }
     });
     ```

3. **Parcours de paiement en 3 étapes (Shadow DOM, compatible CSP)**
   - **Étape 1 (Coordonnées)** : quantité, nom complet ou raison sociale, e-mail, téléphone.
   - **Étape 2 (Facturation)** : sélection de la wilaya (`01 - Adrar` à `58 - El Meniaa`), adresse de facturation et champs fiscaux B2B (`NIF`, `RC`, `AI`).
   - **Étape 3 (Paiement)** : récapitulatif de la commande et redirection vers la passerelle SATIM (`cib.satim.dz` / `satim.slick-pay.com`).

4. **Passerelles Backend incluses (Node.js et PHP)**
   - `server/slickpay-sdk.mjs` et `server/index.mjs` : SDK et serveur HTTP Node.js sans dépendances externes. Expose également les classes `Invoice` et `MerchantInvoice` compatibles avec `@slick-pay-algeria/slickpay-npm` (avec correction de la route `/api/v2/users/invoices/commission`).
   - `public/api/checkout.php` : relais PHP/cURL autonome pour hébergement mutualisé ou serveur cPanel/Apache/Nginx.

---

## Utilisation en local

```bash
npm test
npm start
```

L'interface du générateur est ensuite accessible sur `http://localhost:3400`.
