<?php
/**
 * SlickPay Universal Gateway — Backend Proxy Endpoint (PHP / cPanel)
 * Compatible avec:
 *  - Mode 'mock' (test instantané sans clé API : génère une session SATIM simulée)
 *  - Mode 'sandbox' (https://devapi.slick-pay.com/api/v2/users/invoices ou merchants/invoices)
 *  - Mode 'production' (https://prodapi.slick-pay.com/api/v2/users/invoices ou merchants/invoices)
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$rawBody = file_get_contents('php://input');
$payload = json_decode($rawBody, true) ?: [];

$action = $_GET['action'] ?? ($payload['action'] ?? 'checkout');
$mode = $payload['mode'] ?? (getenv('SLICKPAY_MODE') ?: 'mock');
$publicKey = trim((string)($payload['publicKey'] ?? (getenv('SLICKPAY_PUBLIC_KEY') ?: '')));
$accountType = $payload['accountType'] ?? (getenv('SLICKPAY_ACCOUNT_TYPE') ?: 'users'); // 'users' | 'merchants'
$baseUrl = ($mode === 'production')
    ? 'https://prodapi.slick-pay.com/api/v2'
    : 'https://devapi.slick-pay.com/api/v2';

// En-têtes HTTP avec User-Agent standard pour éviter les blocages Cloudflare (403) sur prodapi.slick-pay.com
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

// Formate un message d'erreur clair à partir du code HTTP et de la réponse SlickPay
function formatSlickPayError(int $httpCode, array $apiData, string $curlErr, string $mode, string $publicKey, string $accountType): string {
    // Détection spécifique : utilisation de la clé publique Sandbox de démo en mode Production
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
        foreach ($apiData['errors'] as $field => $msgs) {
            if (is_array($msgs)) {
                $flat[] = implode(' ', $msgs);
            } elseif (is_string($msgs)) {
                $flat[] = $msgs;
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

    if (!empty($apiData['message'])) {
        if (stripos($apiData['message'], 'tpv account') !== false) {
            return "Compte TPV Marchand non configuré sur SlickPay pour la route /merchants/invoices. Utilisez le type de compte 'Standard (/api/v2/users/invoices)'.";
        }
        return "SlickPay ({$httpCode}) : " . $apiData['message'];
    }

    return $curlErr ?: "Erreur API SlickPay ({$httpCode})";
}

// 1. Calcul de commission (POST /api/v2/users/invoices/commission)
if ($action === 'commission') {
    $amount = (float)($payload['amount'] ?? 0);
    if ($amount < 100) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Le montant doit être >= 100 DZD']);
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
        CURLOPT_TIMEOUT => 20,
    ]);
    $res = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    http_response_code($status ?: 200);
    echo $res ?: json_encode(['ok' => false, 'error' => 'Erreur réseau SlickPay']);
    exit;
}

// 2. Vérification de statut (GET /api/v2/users/invoices/:id)
if ($action === 'status') {
    $invoiceId = $_GET['id'] ?? ($payload['invoiceId'] ?? '');
    if (empty($invoiceId)) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Identifiant de facture manquant']);
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
        CURLOPT_TIMEOUT => 20,
    ]);
    $res = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    http_response_code($status ?: 200);
    echo $res ?: json_encode(['ok' => false, 'error' => 'Erreur réseau SlickPay']);
    exit;
}

// 3. Création d'une session de paiement / Facture (POST)
$unitPrice = (float)($payload['amount'] ?? $payload['unitPrice'] ?? 0);
$quantity = max(1, (int)($payload['quantity'] ?? 1));
$deliveryFee = max(0, (float)($payload['deliveryFee'] ?? 0));
$fullName = trim((string)($payload['fullName'] ?? ''));
$email = trim((string)($payload['email'] ?? ''));
$rawPhone = trim((string)($payload['phone'] ?? ''));
// Normalisation du téléphone (suppression des espaces/tirets)
$phone = preg_replace('/[\s\-\.]+/', '', $rawPhone);
$wilaya = str_pad(trim((string)($payload['wilaya'] ?? '16')), 2, '0', STR_PAD_LEFT);
$address = trim((string)($payload['address'] ?? 'Algérie'));
$productName = trim((string)($payload['productName'] ?? 'Commande Marchand'));
$customFields = is_array($payload['customFields'] ?? null) ? $payload['customFields'] : [];

$errors = [];
if ($unitPrice < 100) {
    $errors[] = 'Le montant unitaire doit être supérieur ou égal à 100 DZD.';
}
if (mb_strlen($fullName) < 2) {
    $errors[] = 'Le nom complet du client est obligatoire.';
}
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    $errors[] = 'Une adresse e-mail valide est obligatoire.';
}
if (strlen($phone) < 8) {
    $errors[] = 'Un numéro de téléphone valide est obligatoire.';
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

$baseAmountDzd = ($unitPrice * $quantity) + $deliveryFee;
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

// Séparation sécurisée prénom / nom : si l'utilisateur n'a saisi qu'un seul mot,
// on renseigne automatiquement lastname pour éviter l'erreur HTTP 422 de SlickPay ("Le champ lastname est obligatoire.")
$nameParts = preg_split('/\s+/', $fullName, 2);
$firstname = !empty($nameParts[0]) ? $nameParts[0] : 'Client';
$lastname = (!empty($nameParts[1]) && strlen(trim($nameParts[1])) > 0) ? trim($nameParts[1]) : $firstname;

// Si mode Mock ou absence de clé API publique : simulation fidèle de la réponse SATIM / SlickPay
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

// Vérification préventive : clé Sandbox utilisée en mode Production
if ($mode === 'production' && strpos($publicKey, '54|BZ7F6N4KwSD46GEXToOv3ZBpJpf7WVxnBzK5cOE6') === 0) {
    http_response_code(400);
    echo json_encode([
        'ok' => false,
        'mode' => $mode,
        'error' => formatSlickPayError(403, [], '', $mode, $publicKey, $accountType)
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

// Mode API SlickPay v2 réel (Sandbox ou Production)
$notes = [];
foreach ($customFields as $k => $v) {
    if ($v !== '') {
        $notes[] = strtoupper((string)$k) . ': ' . (string)$v;
    }
}

$returnUrl = !empty($payload['returnUrl']) ? $payload['returnUrl'] : 'https://example.com/payment-return';
$apiPayload = [
    'amount' => $totalChargeDzd,
    'url' => $returnUrl,
    'name' => "{$firstname} {$lastname}", // Requis par /api/v2/merchants/invoices
    'firstname' => $firstname,            // Requis par /api/v2/users/invoices
    'lastname' => $lastname,              // Requis par /api/v2/users/invoices
    'email' => $email,
    'phone' => $phone,
    'address' => "{$address} (Wilaya {$wilaya})",
    'items' => [
        [
            'name' => $productName,
            'price' => $unitPrice,
            'quantity' => $quantity,
        ]
    ],
    'note' => implode(' | ', $notes),
    'webhook_meta_data' => [
        array_merge(['invoice_ref' => $invoiceId, 'wilaya' => $wilaya], $customFields)
    ]
];

if (!empty($payload['contactUuid'])) {
    $apiPayload['contact'] = $payload['contactUuid'];
}
if (!empty($payload['accountUuid'])) {
    $apiPayload['account'] = $payload['accountUuid'];
}

$endpoint = ($accountType === 'merchants') ? 'merchants/invoices' : 'users/invoices';
$ch = curl_init("{$baseUrl}/{$endpoint}");
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode($apiPayload),
    CURLOPT_HTTPHEADER => buildSlickPayHeaders($publicKey, true),
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 20,
]);

$rawRes = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr = curl_error($ch);
curl_close($ch);

$apiData = json_decode($rawRes, true) ?: [];

if ($httpCode >= 400 || !empty($apiData['errors']) || empty($rawRes)) {
    http_response_code($httpCode >= 400 ? $httpCode : 502);
    echo json_encode([
        'ok' => false,
        'mode' => $mode,
        'error' => formatSlickPayError($httpCode, $apiData, $curlErr, $mode, $publicKey, $accountType),
        'details' => $apiData
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$remoteId = (string)($apiData['id'] ?? ($apiData['data']['id'] ?? $invoiceId));
$paymentUrl = $apiData['url']
    ?? ($apiData['data']['url'] ?? "https://cib.satim.dz/payment/epg/merchants/merchantsatim/payment.html?mdOrder={$mdOrder}&language=fr");

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
    'paymentUrl' => $paymentUrl,
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
    ],
    'rawResponse' => $apiData
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
