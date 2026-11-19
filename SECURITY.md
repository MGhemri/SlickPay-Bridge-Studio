# Politique de Sécurité (Security Policy)

## Versions supportées

| Version | Support de sécurité |
| :--- | :--- |
| `1.1.x` | Oui |
| `1.0.x` | Mise à jour vers `1.1.x` recommandée |

## Mesures de sécurité implémentées

1. **Verrouillage des prix côté serveur (Catalogue ou Signature HMAC)** :
   - Le SDK supporte la résolution des prix depuis un catalogue serveur (`catalog: { [productId]: { name, unitPrice, deliveryFee } }`) ou la vérification cryptographique d'une signature HMAC-SHA256 (`priceSignature` / `SLICKPAY_REQUIRE_PRICE_SIGNATURE=true`), empêchant un client de modifier le montant dans le DOM.
2. **Verrouillage de la configuration serveur (`mode`, `publicKey`, `returnUrl`)** :
   - Par défaut (`allowClientConfigOverride: false`), le serveur ignore les paramètres `mode`, `publicKey`, `accountType` et `returnUrl` envoyés par le navigateur et utilise exclusivement les variables d'environnement du marchand, avec une liste blanche stricte de domaines autorisés (`SLICKPAY_ALLOWED_RETURN_HOSTS`).
3. **Authentification HMAC des Webhooks et Protection des Données Personnelles (PII)** :
   - La route `POST /api/slickpay/webhook` exige une signature HMAC-SHA256 valide (`X-SlickPay-Signature` ou `webhook_signature`) comparée en temps constant (`crypto.timingSafeEqual`).
   - La route `GET /api/slickpay/status/:id` ne divulgue aucune donnée personnelle (ni e-mail, ni téléphone, ni adresse, ni `NIF`/`RC`, ni réponse brute `rawResponse`) et ne renvoie jamais un statut local en cas d'échec de l'API distante.
4. **Protection contre les injections XSS et compatibilité CSP** :
   - Toutes les chaînes dynamiques injectées dans le DOM et le Shadow DOM du widget passent par `escapeHtml(...)`, et toutes les URLs (`paymentUrl`, `shopUrl`) sont filtrées par `sanitizeUrl(...)` (rejetant `javascript:` et exigeant `https:` pour l'URL de paiement).
   - Aucun `<style>` inline ni attribut `style="..."` n'est utilisé afin de respecter les politiques `Content-Security-Policy` sans `unsafe-inline`.
5. **Durcissement du serveur HTTP et Limitation de Débit** :
   - Le serveur Node.js n'expose qu'une liste blanche d'extensions statiques (`.html`, `.js`, `.css`, `.json`, `.png`, `.svg`, `.ico`) et bloque tout accès aux fichiers `.php`, `.htaccess` ou dotfiles.
   - Une limitation de débit par IP (`60 req/min` par défaut) et une limite stricte de `64 Ko` par requête sont appliquées sur les backends Node.js et PHP.

## Signaler une vulnérabilité

Ne publiez pas de vulnérabilité de sécurité dans une Issue publique GitHub. Veuillez la signaler directement à l'auteur :

- **Responsable** : GHEMRI M
- **E-mail** : [contact@connect-gm.com](mailto:contact@connect-gm.com)
- **Téléphone** : 0549 77 73 66
- **Site web** : [https://connect-gm.com](https://connect-gm.com)
