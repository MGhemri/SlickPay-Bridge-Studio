# Politique de Sécurité (Security Policy)

## Versions supportées

| Version | Support de sécurité |
| :--- | :--- |
| `1.0.x` | Oui |

## Garanties de sécurité intégrées au SDK et à la CI

1. **Conformité `Content-Security-Policy` (CSP) stricte** :
   - Le widget Frontend (`public/sdk/slickpay-widget.js`) et sa feuille de style (`public/sdk/slickpay-widget.css`) n'injectent aucun `<style>` inline ni aucun attribut `style="..."` inline.
   - La suite de tests CI (`test/gateway.test.mjs`) échoue automatiquement si un style inline est introduit.
2. **Isolation DOM** :
   - La modale de paiement en 3 étapes est encapsulée dans un **Shadow DOM** afin d'éviter toute altération par le CSS de la page hôte.
3. **Protection contre la fuite de secrets** :
   - Le workflow GitHub Actions `security-guard` inspecte chaque commit et chaque Pull Request pour bloquer toute clé privée ou jeton secret.

## Signaler une vulnérabilité

Ne publiez pas de vulnérabilité de sécurité dans une Issue publique GitHub. Veuillez la signaler directement à l'auteur :

- **Responsable** : GHEMRI M
- **E-mail** : [contact@connect-gm.com](mailto:contact@connect-gm.com)
- **Téléphone** : 0549 77 73 66
- **Site web** : [https://connect-gm.com](https://connect-gm.com)
