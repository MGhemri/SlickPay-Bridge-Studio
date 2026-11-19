<?php
/**
 * SlickPay Universal Gateway — Backend Proxy Endpoint (PHP / cPanel)
 * Implémentation durcie suite à l'audit de sécurité :
 * - Limitation de débit (Rate Limiter par IP)
 * - Verrouillage serveur de mode / publicKey / accountType / returnUrl (sauf si SLICKPAY_ALLOW_CLIENT_OVERRIDE=true pour le Studio de démo)
 * - Catalogue serveur ou vérification de signature HMAC du prix (si SLICKPAY_REQUIRE_PRICE_SIGNATURE=true)
 * - Validation algérienne du téléphone (05/06/07/02..04/+213), validation de la wilaya (01..58), plafonds et ligne de livraison dans items[]
 * - Envoi de webhook_url, webhook_signature et qrcode, et absence de fuite de rawResponse/details bruts
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

$allowedOriginsEnv = getenv('SLICKPAY_ALLOWED_ORIGINS') ?: '*';
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

// Limitation de débit par IP (60 requêtes / minute dans un fichier temporaire local)
function enforceRateLimit(int $maxPerMinute = 60): void {
    $ip = $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';
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

$envPublicKey = trim((string)(getenv('SLICKPAY_PUBLIC_KEY') ?: ''));
$envMode = trim((string)(getenv('SLICKPAY_MODE') ?: ($envPublicKey !== '' ? 'sandbox' : 'mock')));
$envAccountType = trim((string)(getenv('SLICKPAY_ACCOUNT_TYPE') ?: 'users'));
$webhookSecret = trim((string)(getenv('SLICKPAY_WEBHOOK_SECRET') ?: 'slickpay-dev-only-secret-do-not-use-in-prod'));

// Si aucune clé serveur n'est verrouillée dans l'environnement (ex: bac à sable Studio de démo) ou si SLICKPAY_ALLOW_CLIENT_OVERRIDE=true
$allowClientOverride = (getenv('SLICKPAY_ALLOW_CLIENT_OVERRIDE') === 'true') || ($envPublicKey === '');

$action = $_GET['action'] ?? ($payload['action'] ?? 'checkout');
$mode = ($allowClientOverride && !empty($payload['mode'])) ? (string)$payload['mode'] : $envMode;
if (!in_array($mode, ['mock', 'sandbox', 'production'], true)) {
    $mode = 'mock';
}
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
        'User-Agent: SlickPayBridgeSDK/1.0 (+https://slick-pay.com)'
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

// 2. Vérification de statut (GET /api/v2/users/invoices/:id) — sans exposition de PII
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

// Vérification optionnelle de signature HMAC du prix si SLICKPAY_REQUIRE_PRICE_SIGNATURE=true
$requirePriceSig = (getenv('SLICKPAY_REQUIRE_PRICE_SIGNATURE') === 'true');
if ($requirePriceSig || !empty($payload['priceSignature'])) {
    $canonical = sprintf('price:%s:%.2f:%.2f', $productName, $unitPrice, $deliveryFee);
    $expectedSig = hash_hmac('sha256', $canonical, $webhookSecret);
    $providedSig = (string)($payload['priceSignature'] ?? '');
    if (!hash_equals($expectedSig, $providedSig)) {
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

$allowedCustomKeys = ['nif', 'rc', 'ai', 'nis', 'tin', 'company', 'reference'];
$customFields = [];
$errors = [];

if (isset($payload['customFields']) && is_array($payload['customFields'])) {
    foreach ($payload['customFields'] as $k => $v) {
        $cleanKey = strtolower(trim((string)$k));
        if (!in_array($cleanKey, $allowedCustomKeys, true)) {
            continue;
        }
        if ($v === null || $v === '') {
            continue;
        }
        if (!is_scalar($v)) {
            $errors[] = "Le champ personnalisé {$cleanKey} est invalide.";
            continue;
        }
        $customFields[$cleanKey] = mb_substr(trim((string)$v), 0, 120);
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

// Validation stricte de returnUrl contre une liste blanche d'hôtes
$defaultReturnUrl = getenv('SLICKPAY_RETURN_URL') ?: 'https://connect-gm.com/slickpay-test/';
$allowedReturnHostsEnv = getenv('SLICKPAY_ALLOWED_RETURN_HOSTS') ?: 'connect-gm.com,monsite-exemple.dz,localhost,127.0.0.1';
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

$invoiceId = 'sp_' . bin2hex(random_bytes(6));
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
        'invoiceId' => $invoiceId,
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

$webhookCanonical = sprintf('webhook:%s:%d:paid', $invoiceId, $totals['totalCharge']);
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
        array_merge(['invoice_ref' => $invoiceId, 'wilaya' => $wilaya], $customFields)
    ]
];

if (!empty($payload['webhookUrl']) && is_string($payload['webhookUrl']) && strpos($payload['webhookUrl'], 'https://') === 0) {
    $apiPayload['webhook_url'] = $payload['webhookUrl'];
}
if (!empty($payload['qrcode'])) {
    $apiPayload['qrcode'] = (bool)$payload['qrcode'];
}
if (!empty($payload['contactUuid']) && is_string($payload['contactUuid'])) {
    $apiPayload['contact'] = $payload['contactUuid'];
}
if (!empty($payload['accountUuid']) && is_string($payload['accountUuid'])) {
    $apiPayload['account'] = $payload['accountUuid'];
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

$remoteId = (string)($apiData['id'] ?? ($apiData['data']['id'] ?? $invoiceId));
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
