<?php
/**
 * SlickPay Universal Gateway — Backend Proxy Endpoint (PHP / cPanel)
 * - Verrouillage explicite opt-in de l'override client (SLICKPAY_ALLOW_CLIENT_OVERRIDE=true requis)
 * - En production (SLICKPAY_MODE=production), SLICKPAY_WEBHOOK_SECRET est obligatoire et le verrouillage des prix
 *   (catalogue SLICKPAY_CATALOG_JSON ou signature HMAC priceSignature) est actif par défaut
 * - webhookUrl, contactUuid, accountUuid et qrcode proviennent exclusivement de la configuration serveur
 * - Validation stricte des champs personnalisés, téléphone algérien (05/06/07/02..04/+213) et wilaya (01..58)
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

$envPublicKey = trim((string)(getenv('SLICKPAY_PUBLIC_KEY') ?: ''));
$envMode = trim((string)(getenv('SLICKPAY_MODE') ?: ($envPublicKey !== '' ? 'sandbox' : 'mock')));
$envAccountType = trim((string)(getenv('SLICKPAY_ACCOUNT_TYPE') ?: 'users'));
$envWebhookSecret = trim((string)(getenv('SLICKPAY_WEBHOOK_SECRET') ?: ''));

// CORS : en production, pas de wildcard '*' par défaut si SLICKPAY_ALLOWED_ORIGINS n'est pas défini
$defaultCors = ($envMode === 'production') ? '' : '*';
$allowedOriginsEnv = getenv('SLICKPAY_ALLOWED_ORIGINS') !== false ? (string)getenv('SLICKPAY_ALLOWED_ORIGINS') : $defaultCors;
$allowedOrigins = array_values(array_filter(array_map('trim', explode(',', $allowedOriginsEnv))));
$requestOrigin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array('*', $allowedOrigins, true)) {
    header('Access-Control-Allow-Origin: *');
} elseif ($requestOrigin && in_array($requestOrigin, $allowedOrigins, true)) {
    header("Access-Control-Allow-Origin: {$requestOrigin}");
    header('Vary: Origin');
} elseif (!empty($allowedOrigins)) {
    header("Access-Control-Allow-Origin: {$allowedOrigins[0]}");
}
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-SlickPay-Signature');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

/**
 * Calcule la signature HMAC-SHA256 d'un produit pour verrouiller son prix côté serveur
 */
function slickpaySignProductPrice(string $productName, float $unitPrice, float $deliveryFee, string $secret): string {
    $canonical = sprintf('price:%s:%.2f:%.2f', trim($productName), round($unitPrice, 2), round($deliveryFee, 2));
    return hash_hmac('sha256', $canonical, $secret);
}

// Limitation de débit par IP (supporte CF-Connecting-IP / X-Forwarded-For uniquement si SLICKPAY_TRUST_PROXY=true)
function resolveClientIp(): string {
    if (getenv('SLICKPAY_TRUST_PROXY') === 'true') {
        if (!empty($_SERVER['HTTP_CF_CONNECTING_IP'])) {
            return trim((string)$_SERVER['HTTP_CF_CONNECTING_IP']);
        }
        if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
            $parts = explode(',', (string)$_SERVER['HTTP_X_FORWARDED_FOR']);
            return trim($parts[0]);
        }
    }
    return $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';
}

function enforceRateLimit(int $maxPerMinute = 60): void {
    $ip = resolveClientIp();
    $bucketFile = sys_get_temp_dir() . '/sp_rl_' . md5($ip) . '.json';
    $now = time();
    $data = ['count' => 0, 'resetAt' => $now + 60];
    if (is_file($bucketFile)) {
        $raw = @file_get_contents($bucketFile);
        $decoded = $raw ? json_decode($raw, true) : null;
        if (is_array($decoded) && isset($decoded['resetAt']) && $now < $decoded['resetAt']) {
            $data = $decoded;
        }
    }
    $data['count'] = (int)($data['count'] ?? 0) + 1;
    @file_put_contents($bucketFile, json_encode($data), LOCK_EX);
    if ($data['count'] > $maxPerMinute) {
        http_response_code(429);
        echo json_encode(['ok' => false, 'error' => 'Trop de requêtes. Veuillez réessayer dans une minute.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
}
enforceRateLimit((int)(getenv('SLICKPAY_RATE_LIMIT_MAX') ?: 60));

// Lecture bornée à 64 Ko
$rawBody = file_get_contents('php://input', false, null, 0, 65537);
if ($rawBody !== false && strlen($rawBody) > 65536) {
    http_response_code(413);
    echo json_encode(['ok' => false, 'error' => 'Payload trop volumineux (limite 64 Ko dépassée).'], JSON_UNESCAPED_UNICODE);
    exit;
}
$payload = $rawBody ? (json_decode($rawBody, true) ?: []) : [];

// L'override client est strictement opt-in via SLICKPAY_ALLOW_CLIENT_OVERRIDE=true (et jamais implicite quand la clé est vide)
$allowClientOverride = (getenv('SLICKPAY_ALLOW_CLIENT_OVERRIDE') === 'true');

$action = $_GET['action'] ?? ($payload['action'] ?? 'checkout');
$mode = ($allowClientOverride && !empty($payload['mode'])) ? (string)$payload['mode'] : $envMode;
if (!in_array($mode, ['mock', 'sandbox', 'production'], true)) {
    $mode = 'mock';
}

// En mode production, SLICKPAY_WEBHOOK_SECRET est strictement obligatoire
if ($mode === 'production' && $envWebhookSecret === '') {
    http_response_code(500);
    echo json_encode([
        'ok' => false,
        'error' => 'Configuration serveur incomplète : SLICKPAY_WEBHOOK_SECRET est obligatoire en mode production.'
    ], JSON_UNESCAPED_UNICODE);
    exit;
}
$webhookSecret = $envWebhookSecret !== '' ? $envWebhookSecret : 'slickpay-dev-only-secret-do-not-use-in-prod';

$publicKey = ($allowClientOverride && isset($payload['publicKey']))
    ? trim((string)$payload['publicKey'])
    : $envPublicKey;
$accountType = ($allowClientOverride && !empty($payload['accountType']))
    ? (string)$payload['accountType']
    : $envAccountType;
if (!in_array($accountType, ['users', 'merchants'], true)) {
    $accountType = 'users';
}

$baseUrl = ($mode === 'production')
    ? 'https://prodapi.slick-pay.com/api/v2'
    : 'https://devapi.slick-pay.com/api/v2';

function buildSlickPayHeaders(string $publicKey, bool $isJson = true): array {
    $headers = [
        'Accept: application/json',
        "Authorization: Bearer {$publicKey}",
        'User-Agent: SlickPayBridgeSDK/1.1 (+https://slick-pay.com)'
    ];
    if ($isJson) {
        $headers[] = 'Content-Type: application/json';
    }
    return $headers;
}

function formatSlickPayError(int $httpCode, array $apiData, string $curlErr, string $mode, string $publicKey): string {
    if ($mode === 'production' && strpos($publicKey, '54|BZ7F6N4KwSD46GEXToOv3ZBpJpf7WVxnBzK5cOE6') === 0) {
        return 'Cette clé publique (54|BZ7F...) est une clé de test Sandbox. Pour utiliser le mode Production (prodapi.slick-pay.com), veuillez renseigner une clé publique de Production valide ou basculer sur Sandbox.';
    }
    if ($httpCode === 401) {
        return "Clé publique SlickPay refusée (401 Unauthenticated) sur l'environnement [{$mode}]. Vérifiez que votre clé correspond bien à cet environnement.";
    }
    if ($httpCode === 403) {
        return "Accès refusé par l'API SlickPay (403) en mode [{$mode}]. Si vous utilisez la clé de test Sandbox, sélectionnez l'environnement Sandbox (devapi.slick-pay.com).";
    }
    if (!empty($apiData['errors']) && is_array($apiData['errors'])) {
        $flat = [];
        foreach ($apiData['errors'] as $msgs) {
            if (is_array($msgs)) {
                $flat[] = implode(' ', array_map('strval', $msgs));
            } elseif (is_scalar($msgs)) {
                $flat[] = (string)$msgs;
            }
        }
        if (!empty($flat)) {
            $detailMsg = implode(' | ', $flat);
            if (stripos($detailMsg, 'tpv account') !== false) {
                return "Compte TPV Marchand non configuré sur SlickPay pour la route /merchants/invoices. Utilisez le type de compte 'Standard (/api/v2/users/invoices)'.";
            }
            return "Erreur de validation SlickPay ({$httpCode}) : {$detailMsg}";
        }
    }
    if (!empty($apiData['message']) && is_string($apiData['message'])) {
        if (stripos($apiData['message'], 'tpv account') !== false) {
            return "Compte TPV Marchand non configuré sur SlickPay pour la route /merchants/invoices. Utilisez le type de compte 'Standard (/api/v2/users/invoices)'.";
        }
        return "SlickPay ({$httpCode}) : " . $apiData['message'];
    }
    return $curlErr ?: "Erreur API SlickPay ({$httpCode})";
}

// 1. Calcul de commission (POST /api/v2/users/invoices/commission)
if ($action === 'commission') {
    $amount = round((float)($payload['amount'] ?? 0), 2);
    if ($amount < 100 || $amount > 50000000) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Le montant doit être compris entre 100 DZD et 50 000 000 DZD.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    if ($mode === 'mock' || empty($publicKey)) {
        echo json_encode([
            'ok' => true,
            'mode' => 'mock',
            'success' => 1,
            'amount' => $amount,
            'commission' => 0,
            'total' => $amount
        ]);
        exit;
    }

    $ch = curl_init("{$baseUrl}/users/invoices/commission");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode(['amount' => $amount]),
        CURLOPT_HTTPHEADER => buildSlickPayHeaders($publicKey, true),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 15,
    ]);
    $res = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    $decoded = $res ? (json_decode($res, true) ?: []) : [];
    if ($status >= 400 || empty($res)) {
        http_response_code($status ?: 502);
        echo json_encode(['ok' => false, 'error' => 'Impossible de calculer la commission SlickPay.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    echo json_encode([
        'ok' => true,
        'amount' => $decoded['amount'] ?? $amount,
        'commission' => $decoded['commission'] ?? 0,
        'total' => $decoded['total'] ?? ($decoded['amount'] ?? $amount)
    ]);
    exit;
}

// 2. Vérification de statut (GET /api/v2/users/invoices/:id)
if ($action === 'status') {
    $invoiceId = trim((string)($_GET['id'] ?? ($payload['invoiceId'] ?? '')));
    if ($invoiceId === '' || !preg_match('/^[a-zA-Z0-9_-]{1,64}$/', $invoiceId)) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Identifiant de facture invalide.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    if ($mode === 'mock' || empty($publicKey)) {
        echo json_encode([
            'ok' => true,
            'mode' => 'mock',
            'invoiceId' => $invoiceId,
            'completed' => 0,
            'status' => 'pending'
        ]);
        exit;
    }

    $endpoint = ($accountType === 'merchants') ? 'merchants/invoices' : 'users/invoices';
    $ch = curl_init("{$baseUrl}/{$endpoint}/" . urlencode($invoiceId));
    curl_setopt_array($ch, [
        CURLOPT_HTTPHEADER => buildSlickPayHeaders($publicKey, false),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 15,
    ]);
    $res = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    $decoded = $res ? (json_decode($res, true) ?: []) : [];
    if ($status >= 400 || empty($res)) {
        http_response_code($status ?: 502);
        echo json_encode(['ok' => false, 'error' => 'Impossible de vérifier le statut de la facture.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $completed = !empty($decoded['completed']) || (($decoded['data']['payment_status'] ?? '') === 'paid') || (($decoded['status'] ?? '') === 'paid');
    echo json_encode([
        'ok' => true,
        'invoiceId' => $invoiceId,
        'completed' => $completed ? 1 : 0,
        'status' => $completed ? 'paid' : 'pending'
    ]);
    exit;
}

// 3. Création d'une session de paiement / Facture (POST)
$productName = mb_substr(trim((string)($payload['productName'] ?? 'Commande Marchand')), 0, 180);
$unitPrice = round((float)($payload['amount'] ?? $payload['unitPrice'] ?? 0), 2);
$quantity = (int)($payload['quantity'] ?? 1);
$deliveryFee = round(max(0.0, (float)($payload['deliveryFee'] ?? 0)), 2);

// Résolution du prix via Catalogue serveur (SLICKPAY_CATALOG_JSON) ou Signature HMAC (priceSignature)
$catalogJson = getenv('SLICKPAY_CATALOG_JSON');
$catalog = $catalogJson ? (json_decode($catalogJson, true) ?: []) : [];
$productId = trim((string)($payload['productId'] ?? ''));

$requirePriceSigEnv = getenv('SLICKPAY_REQUIRE_PRICE_SIGNATURE');
$requirePriceSig = ($requirePriceSigEnv !== false && $requirePriceSigEnv !== '')
    ? ($requirePriceSigEnv === 'true')
    : ($mode === 'production');

if ($productId !== '' && isset($catalog[$productId]) && is_array($catalog[$productId])) {
    $productName = (string)($catalog[$productId]['name'] ?? $productName);
    $unitPrice = round((float)($catalog[$productId]['unitPrice'] ?? $unitPrice), 2);
    if (isset($catalog[$productId]['deliveryFee'])) {
        $deliveryFee = round(max(0.0, (float)$catalog[$productId]['deliveryFee']), 2);
    }
} elseif ($requirePriceSig || !empty($payload['priceSignature'])) {
    if ($envWebhookSecret === '' && $mode === 'production') {
        http_response_code(500);
        echo json_encode(['ok' => false, 'error' => 'SLICKPAY_WEBHOOK_SECRET est requis pour vérifier la signature de prix.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $expectedSig = slickpaySignProductPrice($productName, $unitPrice, $deliveryFee, $webhookSecret);
    $providedSig = (string)($payload['priceSignature'] ?? '');
    if ($providedSig === '' || !hash_equals($expectedSig, $providedSig)) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Signature de prix (priceSignature) invalide ou absente.'], JSON_UNESCAPED_UNICODE);
        exit;
    }
}

$fullName = trim((string)($payload['fullName'] ?? ''));
$email = trim((string)($payload['email'] ?? ''));
$rawPhone = trim((string)($payload['phone'] ?? ''));
$phone = preg_replace('/[\s\-\.\(\)]+/', '', $rawPhone);
$wilaya = str_pad(trim((string)($payload['wilaya'] ?? '16')), 2, '0', STR_PAD_LEFT);
$address = mb_substr(trim((string)($payload['address'] ?? 'Algérie')), 0, 300);

$customFields = [];
$errors = [];

if (isset($payload['customFields'])) {
    if (!is_array($payload['customFields'])) {
        $errors[] = 'Le paramètre customFields doit être un objet clé-valeur.';
    } else {
        if (count($payload['customFields']) > 10) {
            $errors[] = 'Maximum 10 champs personnalisés autorisés.';
        }
        foreach ($payload['customFields'] as $k => $v) {
            $cleanKey = strtolower(trim((string)$k));
            if (!preg_match('/^[a-z0-9_]{1,32}$/', $cleanKey)) {
                $errors[] = "Nom de champ personnalisé invalide : {$cleanKey}.";
                continue;
            }
            if ($v === null || $v === '') {
                continue;
            }
            if (!is_scalar($v)) {
                $errors[] = "Le champ personnalisé {$cleanKey} doit être une chaîne ou un nombre.";
                continue;
            }
            $customFields[$cleanKey] = mb_substr(trim((string)$v), 0, 120);
        }
    }
}

if ($unitPrice < 100 || $unitPrice > 50000000) {
    $errors[] = 'Le montant unitaire doit être compris entre 100 DZD et 50 000 000 DZD.';
}
if ($quantity < 1 || $quantity > 1000) {
    $errors[] = 'La quantité doit être comprise entre 1 et 1000.';
}
if ($deliveryFee < 0 || $deliveryFee > 1000000) {
    $errors[] = 'Les frais de livraison sont invalides.';
}
if (mb_strlen($fullName) < 2 || mb_strlen($fullName) > 120) {
    $errors[] = 'Le nom complet du client est obligatoire.';
}
if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 160) {
    $errors[] = 'Une adresse e-mail valide est obligatoire.';
}
if (!preg_match('/^(\+?213|00213|0)[2-7][0-9]{7,8}$/', $phone)) {
    $errors[] = 'Un numéro de téléphone algérien valide est obligatoire (ex: 0550123456).';
}
$wilayaInt = (int)$wilaya;
if (!preg_match('/^[0-9]{2}$/', $wilaya) || $wilayaInt < 1 || $wilayaInt > 58) {
    $errors[] = "Code wilaya invalide : {$wilaya} (doit être compris entre 01 et 58).";
}

if (!empty($errors)) {
    http_response_code(400);
    echo json_encode([
        'ok' => false,
        'error' => implode(' ', $errors),
        'validationErrors' => $errors
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

// URL de retour neutre basée sur l'hôte courant si SLICKPAY_RETURN_URL n'est pas configuré
$currentHost = strtolower(preg_replace('/:[0-9]+$/', '', $_SERVER['HTTP_HOST'] ?? 'localhost'));
$currentScheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$defaultReturnUrl = getenv('SLICKPAY_RETURN_URL') ?: "{$currentScheme}://{$currentHost}/";
$allowedReturnHostsEnv = getenv('SLICKPAY_ALLOWED_RETURN_HOSTS') ?: "{$currentHost},localhost,127.0.0.1";
$allowedReturnHosts = array_values(array_filter(array_map('strtolower', array_map('trim', explode(',', $allowedReturnHostsEnv)))));

$returnUrl = $defaultReturnUrl;
if ($allowClientOverride && !empty($payload['returnUrl']) && is_string($payload['returnUrl'])) {
    $parsedUrl = parse_url($payload['returnUrl']);
    $scheme = strtolower($parsedUrl['scheme'] ?? '');
    $host = strtolower($parsedUrl['host'] ?? '');
    $hostAllowed = false;
    foreach ($allowedReturnHosts as $allowedHost) {
        if ($host === $allowedHost || substr($host, -strlen('.' . $allowedHost)) === '.' . $allowedHost) {
            $hostAllowed = true;
            break;
        }
    }
    if (!in_array($scheme, ['https', 'http'], true) || !$hostAllowed) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => "Domaine ou protocole returnUrl non autorisé."], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $returnUrl = $payload['returnUrl'];
}

$baseAmountDzd = round(($unitPrice * $quantity) + $deliveryFee, 2);
$totalChargeDzd = $baseAmountDzd;
$totals = [
    'baseDzd' => $baseAmountDzd,
    'customerFeeDzd' => 0,
    'totalChargeDzd' => $totalChargeDzd,
    'base' => (int)round($baseAmountDzd * 100),
    'customerFee' => 0,
    'totalCharge' => (int)round($totalChargeDzd * 100),
];

$localInvoiceRef = 'sp_' . bin2hex(random_bytes(6));
$mdOrder = substr(rtrim(strtr(base64_encode(random_bytes(15)), '+/', '-_'), '='), 0, 20);

$nameParts = preg_split('/\s+/', $fullName, 2);
$firstname = !empty($nameParts[0]) ? $nameParts[0] : 'Client';
$lastname = (!empty($nameParts[1]) && strlen(trim($nameParts[1])) > 0) ? trim($nameParts[1]) : $firstname;

if ($mode === 'mock' || empty($publicKey)) {
    http_response_code(201);
    echo json_encode([
        'ok' => true,
        'mode' => 'mock',
        'accountType' => $accountType,
        'invoiceId' => $localInvoiceRef,
        'localInvoiceRef' => $localInvoiceRef,
        'mdOrder' => $mdOrder,
        'status' => 'pending',
        'createdAt' => gmdate('c'),
        'expiresAt' => gmdate('c', time() + 25 * 60),
        'paymentUrl' => "https://cib.satim.dz/payment/epg/merchants/merchantsatim/payment.html?mdOrder={$mdOrder}&language=fr",
        'totals' => $totals,
        'customer' => [
            'fullName' => $fullName,
            'firstname' => $firstname,
            'lastname' => $lastname,
            'email' => $email,
            'phone' => $phone,
            'wilaya' => $wilaya,
            'address' => $address,
            'customFields' => $customFields,
        ],
        'item' => [
            'name' => $productName,
            'unitPrice' => $unitPrice,
            'quantity' => $quantity,
            'deliveryFee' => $deliveryFee,
        ]
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if ($mode === 'production' && strpos($publicKey, '54|BZ7F6N4KwSD46GEXToOv3ZBpJpf7WVxnBzK5cOE6') === 0) {
    http_response_code(400);
    echo json_encode([
        'ok' => false,
        'mode' => $mode,
        'error' => formatSlickPayError(403, [], '', $mode, $publicKey)
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$notes = [];
foreach ($customFields as $k => $v) {
    if ($v !== '') {
        $notes[] = strtoupper((string)$k) . ': ' . (string)$v;
    }
}

$items = [
    [
        'name' => $productName,
        'price' => $unitPrice,
        'quantity' => $quantity,
    ]
];
if ($deliveryFee > 0) {
    $items[] = [
        'name' => 'Frais de livraison',
        'price' => $deliveryFee,
        'quantity' => 1,
    ];
}

$webhookCanonical = sprintf('webhook:%s:%d:paid', $localInvoiceRef, $totals['totalCharge']);
$webhookSignature = hash_hmac('sha256', $webhookCanonical, $webhookSecret);

$apiPayload = [
    'amount' => $totalChargeDzd,
    'url' => $returnUrl,
    'name' => "{$firstname} {$lastname}",
    'firstname' => $firstname,
    'lastname' => $lastname,
    'email' => $email,
    'phone' => $phone,
    'address' => "{$address} (Wilaya {$wilaya})",
    'items' => $items,
    'note' => implode(' | ', $notes),
    'webhook_signature' => $webhookSignature,
    'webhook_meta_data' => [
        array_merge(['invoice_ref' => $localInvoiceRef, 'wilaya' => $wilaya], $customFields)
    ]
];

// Paramètres métier sensibles lus exclusivement depuis les variables d'environnement du serveur
$serverWebhookUrl = trim((string)(getenv('SLICKPAY_WEBHOOK_URL') ?: ''));
if ($serverWebhookUrl !== '' && strpos($serverWebhookUrl, 'https://') === 0) {
    $apiPayload['webhook_url'] = $serverWebhookUrl;
}
if (getenv('SLICKPAY_QRCODE') === 'true') {
    $apiPayload['qrcode'] = true;
}
$serverContactUuid = trim((string)(getenv('SLICKPAY_CONTACT_UUID') ?: ''));
if ($serverContactUuid !== '') {
    $apiPayload['contact'] = $serverContactUuid;
}
$serverAccountUuid = trim((string)(getenv('SLICKPAY_ACCOUNT_UUID') ?: ''));
if ($serverAccountUuid !== '') {
    $apiPayload['account'] = $serverAccountUuid;
}

$endpoint = ($accountType === 'merchants') ? 'merchants/invoices' : 'users/invoices';
$ch = curl_init("{$baseUrl}/{$endpoint}");
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode($apiPayload),
    CURLOPT_HTTPHEADER => buildSlickPayHeaders($publicKey, true),
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => 15,
]);

$rawRes = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr = curl_error($ch);
curl_close($ch);

$apiData = $rawRes ? (json_decode($rawRes, true) ?: []) : [];

if ($httpCode >= 400 || !empty($apiData['errors']) || empty($rawRes)) {
    http_response_code($httpCode >= 400 ? $httpCode : 502);
    echo json_encode([
        'ok' => false,
        'mode' => $mode,
        'error' => formatSlickPayError($httpCode, $apiData, $curlErr, $mode, $publicKey)
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$remoteId = (string)($apiData['id'] ?? ($apiData['data']['id'] ?? $localInvoiceRef));
$candidatePaymentUrl = (string)($apiData['url']
    ?? ($apiData['data']['url'] ?? "https://cib.satim.dz/payment/epg/merchants/merchantsatim/payment.html?mdOrder={$mdOrder}&language=fr"));

if (strpos($candidatePaymentUrl, 'https://') !== 0) {
    http_response_code(502);
    echo json_encode(['ok' => false, 'error' => 'URL de paiement distante invalide ou non sécurisée.'], JSON_UNESCAPED_UNICODE);
    exit;
}

http_response_code(201);
echo json_encode([
    'ok' => true,
    'mode' => $mode,
    'accountType' => $accountType,
    'invoiceId' => $remoteId,
    'localInvoiceRef' => $localInvoiceRef,
    'mdOrder' => $mdOrder,
    'status' => 'pending',
    'createdAt' => gmdate('c'),
    'expiresAt' => gmdate('c', time() + 25 * 60),
    'paymentUrl' => $candidatePaymentUrl,
    'totals' => $totals,
    'customer' => [
        'fullName' => $fullName,
        'email' => $email,
        'phone' => $phone,
        'wilaya' => $wilaya,
        'address' => $address,
        'customFields' => $customFields,
    ],
    'item' => [
        'name' => $productName,
        'unitPrice' => $unitPrice,
        'quantity' => $quantity,
        'deliveryFee' => $deliveryFee,
    ]
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
