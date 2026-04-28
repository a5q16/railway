/**
 * ============================================================
 *  PlatiMarket Auto-Activation Backend
 *  Deployment target : Railway (lively-inspiration service)
 *  Author            : generated for production use
 * ============================================================
 *
 *  Required environment variables (set in Railway dashboard):
 *
 *    SUPABASE_URL            — Your Supabase project URL
 *    SUPABASE_SECRET_KEY     — Supabase service_role (secret) key
 *    DIGISELLER_SELLER_ID    — Your numeric Digiseller seller ID
 *    DIGISELLER_API_KEY      — Your Digiseller API key (for HMAC signing)
 *    AICHEAP_API_KEY         — Bearer / api-key header for backend.aicheap.vip
 *    FRONTEND_URL            — Allowed CORS origin (e.g. https://your-site.netlify.app)
 *    PORT                    — Injected automatically by Railway (do NOT hard-code)
 *
 *  Supabase table expected:
 *    orders (
 *      id            uuid primary key default gen_random_uuid(),
 *      unique_code   text unique not null,
 *      invoice_id    text,
 *      product_name  text,
 *      status        text default 'pending',   -- pending | processing | completed | failed
 *      error_message text,
 *      created_at    timestamptz default now(),
 *      updated_at    timestamptz default now()
 *    )
 * ============================================================
 */

'use strict';

// ─── Core imports ────────────────────────────────────────────────────────────
const express     = require('express');
const cors        = require('cors');
const axios       = require('axios');
const crypto      = require('crypto');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// ─── App & Supabase initialization ───────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));

app.get('/api/ping', (req, res) => res.json({ status: 'Backend is alive' }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } }
);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * sleep(ms) — Promise-based delay helper used inside retry loops.
 * @param {number} ms
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * log(level, ...args) — Structured console logger with ISO timestamp.
 * @param {'INFO'|'WARN'|'ERROR'} level
 */
const log = (level, ...args) =>
  console[level === 'ERROR' ? 'error' : 'log'](`[${new Date().toISOString()}] [${level}]`, ...args);

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: getDigisellerToken()
//
//  Digiseller authentication flow:
//    1. timestamp = current Unix epoch (seconds)
//    2. sign      = SHA-256( DIGISELLER_API_KEY + timestamp ).toHex()
//    3. POST https://api.digiseller.com/api/apilogin
//       Body: { seller_id, timestamp, sign }
//  Returns the token string (valid for ~1 hour).
// ─────────────────────────────────────────────────────────────────────────────
async function getDigisellerToken() {
  const timestamp = Math.floor(Date.now() / 1000);

  // SHA-256 of (API_KEY + timestamp) — Digiseller's required signing scheme
  const sign = crypto
    .createHash('sha256')
    .update(process.env.DIGISELLER_API_KEY + timestamp)
    .digest('hex');

  const { data } = await axios.post(
    'https://api.digiseller.com/api/apilogin',
    {
      seller_id: Number(process.env.DIGISELLER_SELLER_ID),
      timestamp,
      sign,
    },
    { headers: { Accept: 'application/json', 'Content-Type': 'application/json' } }
  );

  if (!data?.token) {
    throw new Error(`Digiseller login failed: ${JSON.stringify(data)}`);
  }

  log('INFO', `Digiseller token acquired (expires ~1h)`);
  return data.token;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: submitRecharge(uniqueCode, authSession)
//
//  Sends the activation payload to the aicheap recharge API.
//  allowOverwrite: true ensures it will override any stale attempt.
//  Returns the taskId string on success.
//  Throws on any API error (caller decides whether to retry).
// ─────────────────────────────────────────────────────────────────────────────
async function submitRecharge(uniqueCode, authSession) {
  const { data } = await axios.post(
    'https://backend.aicheap.vip/api/redeem/submit',
    {
      unique_code:    uniqueCode,
      auth_session:   authSession,
      allowOverwrite: true,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.AICHEAP_API_KEY || ''}`,
      },
      timeout: 30_000,
    }
  );

  if (!data?.taskId) {
    throw new Error(data?.message || data?.error || 'No taskId returned by recharge API');
  }

  return data.taskId;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: pollRechargeTask(taskId)
//
//  Polls GET /api/redeem/query/:taskId every 15 seconds until the task
//  reaches a terminal state (SUCCESS or FAILED/ERROR).
//  Returns { success: true } or throws with the failure message.
// ─────────────────────────────────────────────────────────────────────────────
async function pollRechargeTask(taskId) {
  const MAX_POLL_ATTEMPTS = 60; // 60 × 15 s = 15 minutes max wait
  let attempt = 0;

  while (attempt < MAX_POLL_ATTEMPTS) {
    attempt++;
    await sleep(15_000); // Wait 15 s before each check

    try {
      const { data } = await axios.get(
        `https://backend.aicheap.vip/api/redeem/query/${taskId}`,
        {
          headers: { 'Authorization': `Bearer ${process.env.AICHEAP_API_KEY || ''}` },
          timeout: 20_000,
        }
      );

      const status = (data?.status || '').toUpperCase();
      log('INFO', `  [poll] taskId=${taskId} attempt=${attempt} status=${status}`);

      if (status === 'SUCCESS' || status === 'COMPLETED' || status === 'DONE') {
        return { success: true, data };
      }

      if (status === 'FAILED' || status === 'ERROR' || status === 'CANCELLED') {
        throw new Error(data?.message || data?.error || `Task ${taskId} failed with status: ${status}`);
      }

      // Still pending/processing — keep looping

    } catch (err) {
      // Re-throw terminal task errors; swallow transient network blips
      if (err.message.includes('failed with status') || err.message.includes('Task')) {
        throw err;
      }
      log('WARN', `  [poll] network blip on attempt ${attempt}: ${err.message}`);
    }
  }

  throw new Error(`Polling timeout: task ${taskId} did not complete after ${MAX_POLL_ATTEMPTS} attempts.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: markDigisellerDelivered(uniqueCode, token)
//
//  Calls Digiseller's delivery confirmation endpoint so the order moves to
//  "delivered" status on the seller's dashboard and the buyer is notified.
// ─────────────────────────────────────────────────────────────────────────────
async function markDigisellerDelivered(uniqueCode, token) {
  await axios.put(
    `https://api.digiseller.com/api/purchases/unique-code/${uniqueCode}/deliver`,
    {},
    {
      params:  { token },
      headers: { Accept: 'application/json' },
      timeout: 15_000,
    }
  );
  log('INFO', `Digiseller delivery confirmed for code: ${uniqueCode}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKGROUND PROCESS: runActivationLoop(uniqueCode, authSession)
//
//  This is the core fire-and-forget engine. It is intentionally NOT awaited by
//  the /activate endpoint — the client receives an immediate 200 and polls
//  /api/plati/status/:code while this loop runs in the background.
//
//  Flow:
//    LOOP (unlimited retries for stock errors):
//      1. Submit recharge → if "stock not found" → sleep 60 s → retry
//      2. On taskId acquired → poll until SUCCESS
//      3. Update Supabase status = 'completed'
//      4. Notify Digiseller of delivery
//    ON any non-stock error → update Supabase status = 'failed'
// ─────────────────────────────────────────────────────────────────────────────
async function runActivationLoop(uniqueCode, authSession) {
  log('INFO', `[BG] Starting activation loop for: ${uniqueCode}`);

  let attempt = 0;

  // Outer retry loop — only exits on success or a non-recoverable error
  while (true) {
    attempt++;
    log('INFO', `[BG] Submit attempt #${attempt} for: ${uniqueCode}`);

    try {
      // ── Step A: Submit to recharge API ──
      const taskId = await submitRecharge(uniqueCode, authSession);
      log('INFO', `[BG] taskId received: ${taskId} (attempt #${attempt})`);

      // Update Supabase so the polling UI shows something meaningful
      await supabase
        .from('orders')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('unique_code', uniqueCode);

      // ── Step B: Poll until the task completes ──
      await pollRechargeTask(taskId);
      log('INFO', `[BG] Task SUCCESS for: ${uniqueCode}`);

      // ── Step C: Mark completed in Supabase ──
      await supabase
        .from('orders')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('unique_code', uniqueCode);

      // ── Step D: Confirm delivery on Digiseller ──
      try {
        const token = await getDigisellerToken();
        await markDigisellerDelivered(uniqueCode, token);
      } catch (digiErr) {
        // Non-fatal — the activation already succeeded; just log the failure
        log('WARN', `[BG] Digiseller delivery notification failed: ${digiErr.message}`);
      }

      log('INFO', `[BG] Activation complete for: ${uniqueCode}`);
      return; // ← exit the loop successfully

    } catch (err) {
      const errText = (err.message || '').toLowerCase();

      // ── RECOVERABLE: stock not available — wait and retry ──
      if (
        errText.includes('stock not found') ||
        errText.includes('out of stock')    ||
        errText.includes('no stock')        ||
        errText.includes('stock unavailable')
      ) {
        log('WARN', `[BG] Stock not found on attempt #${attempt}. Retrying in 60 s...`);

        // Keep Supabase status at 'processing' so the frontend sees we're still working
        await supabase
          .from('orders')
          .update({ status: 'processing', updated_at: new Date().toISOString() })
          .eq('unique_code', uniqueCode);

        await sleep(60_000); // Wait 60 seconds before next attempt
        continue;            // ← loop again
      }

      // ── FATAL: real error (invalid token, network failure, task failed) ──
      log('ERROR', `[BG] Fatal error on attempt #${attempt} for ${uniqueCode}: ${err.message}`);

      await supabase
        .from('orders')
        .update({
          status:        'failed',
          error_message: err.message,
          updated_at:    new Date().toISOString(),
        })
        .eq('unique_code', uniqueCode);

      return; // ← exit the loop with failure recorded
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  ENDPOINT 1: POST /api/plati/verify
//
//  Validates the unique_code against Digiseller, checks for duplicates in
//  Supabase, and registers a new pending order.
//
//  Request body  : { unique_code: string }
//  Success 200   : { success: true, product_name, invoice_id }
//  Error 400/409 : { error: string }
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/plati/verify', async (req, res) => {
  const { unique_code } = req.body;

  // ── Input validation ──────────────────────────────────────────────────────
  if (!unique_code || typeof unique_code !== 'string' || unique_code.trim().length !== 16) {
    return res.status(400).json({ error: 'unique_code must be a 16-character string.' });
  }

  const code = unique_code.trim().toUpperCase();

  try {
    // ── 1. Authenticate with Digiseller ──────────────────────────────────
    const token = await getDigisellerToken();

    // ── 2. Fetch purchase details from Digiseller ─────────────────────────
    const digiRes = await axios.get(
      `https://api.digiseller.com/api/purchases/unique-code/${code}`,
      {
        params:  { token },
        headers: { Accept: 'application/json' },
        timeout: 15_000,
      }
    );

    const data = digiRes.data;

    // Digiseller returns { retval: 0 } on success (0 = OK)
    if (data.retval !== 0) {
      return res.status(400).json({
        error: `Invalid purchase code. Digiseller response: ${data.retdesc || 'Unknown error'}`,
      });
    }

    const invoiceId   = String(data.inv || data.invoice_id || '');
    const productName = "PlatiMarket Order";
    const email       = data.email || 'N/A';
    const amount      = data.amount || '0.00';
    const type_curr   = data.type_curr || 'USD';
    const offerDetails = data.options && data.options.length > 0 ? data.options[0].name + ': ' + data.options[0].value : 'Default';

    // ── 3. Check Supabase for existing record ────────────────────────────
    const { data: existing, error: dbErr } = await supabase
      .from('orders')
      .select('status')
      .eq('unique_code', code)
      .maybeSingle();

    if (dbErr) {
      log('ERROR', 'Supabase select error:', dbErr.message);
      return res.status(500).json({ error: 'Database error during lookup.' });
    }

    if (existing) {
      if (existing.status === 'completed') {
        return res.status(409).json({ error: 'This code has already been activated.' });
      }
      // Code exists but is pending/processing/failed — allow re-verification
      return res.status(200).json({
        success: true,
        product: "PlatiMarket Order",
        invoice_id: invoiceId,
        email: email,
        price: `${amount} ${type_curr}`,
        offer: offerDetails
      });
    }

    // ── 4. Insert new pending order ──────────────────────────────────────
    const { error: insertErr } = await supabase.from('orders').insert({
      unique_code:  code,
      invoice_id:   invoiceId,
      product_name: productName,
      status:       'pending',
    });

    if (insertErr) {
      log('ERROR', 'Supabase insert error:', insertErr.message);
      return res.status(500).json({ error: 'Failed to register order in database.' });
    }

    log('INFO', `Verified & registered: ${code} → ${productName}`);

    return res.status(200).json({
      success: true,
      product: "PlatiMarket Order",
      invoice_id: invoiceId,
      email: email,
      price: `${amount} ${type_curr}`,
      offer: offerDetails
    });

  } catch (err) {
    log('ERROR', '/api/plati/verify error:', err.message);
    return res.status(500).json({ error: err.message || 'Verification failed.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  ENDPOINT 2: POST /api/plati/activate
//
//  Immediately returns 200 with status='processing', then fires the
//  background activation loop asynchronously. The frontend should start
//  polling /api/plati/status/:code as soon as it receives this response.
//
//  Request body : { unique_code: string, auth_session: string (JSON) }
//  Response 200 : { status: 'processing', message: string }
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/plati/activate', async (req, res) => {
  const { unique_code, auth_session } = req.body;

  // ── Input validation ──────────────────────────────────────────────────────
  if (!unique_code || typeof unique_code !== 'string') {
    return res.status(400).json({ error: 'unique_code is required.' });
  }
  if (!auth_session || typeof auth_session !== 'string') {
    return res.status(400).json({ error: 'auth_session is required.' });
  }

  const code = unique_code.trim().toUpperCase();

  // ── Validate the auth_session is parseable JSON ───────────────────────────
  let parsedSession;
  try {
    parsedSession = typeof auth_session === 'string' ? JSON.parse(auth_session) : auth_session;
  } catch {
    return res.status(400).json({ error: 'auth_session must be valid JSON.' });
  }

  if (!parsedSession.accessToken) {
    return res.status(400).json({ error: 'auth_session is missing accessToken.' });
  }

  try {
    // ── Verify the order exists and is eligible ───────────────────────────
    const { data: order, error: dbErr } = await supabase
      .from('orders')
      .select('status')
      .eq('unique_code', code)
      .maybeSingle();

    if (dbErr) {
      log('ERROR', 'Supabase select error in /activate:', dbErr.message);
      return res.status(500).json({ error: 'Database error.' });
    }

    if (!order) {
      return res.status(404).json({ error: 'Order not found. Please verify your code first.' });
    }

    if (order.status === 'completed') {
      return res.status(409).json({ error: 'This order has already been activated.' });
    }

    // ── Update status to 'processing' in Supabase ────────────────────────
    await supabase
      .from('orders')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('unique_code', code);

    // ── Respond IMMEDIATELY so the client can start polling ──────────────
    res.status(200).json({
      status:  'processing',
      message: 'Activation queued. Waiting for stock to replenish and license to be assigned…',
    });

    // ── Fire the background loop (intentionally NOT awaited) ─────────────
    // Pass the raw auth_session string — submitRecharge will handle it
    runActivationLoop(code, auth_session).catch((err) => {
      // This catch is a safety net; errors are already handled inside the loop
      log('ERROR', `[BG] Unhandled rejection in runActivationLoop for ${code}: ${err.message}`);
    });

  } catch (err) {
    log('ERROR', '/api/plati/activate error:', err.message);
    // Only reached if the pre-flight DB checks fail before we send a response
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message || 'Activation initiation failed.' });
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  ENDPOINT 3: GET /api/plati/status/:code
//
//  Frontend polls this every 10 seconds. Returns the live status from Supabase.
//
//  Response 200: { status: 'pending'|'processing'|'completed'|'failed', message? }
//  Response 404: { error: 'Order not found' }
// ═════════════════════════════════════════════════════════════════════════════
app.get('/api/plati/status/:code', async (req, res) => {
  const code = (req.params.code || '').trim().toUpperCase();

  if (!code) {
    return res.status(400).json({ error: 'unique_code path parameter is required.' });
  }

  try {
    const { data: order, error: dbErr } = await supabase
      .from('orders')
      .select('status, error_message, product_name, updated_at')
      .eq('unique_code', code)
      .maybeSingle();

    if (dbErr) {
      log('ERROR', 'Supabase select error in /status:', dbErr.message);
      return res.status(500).json({ error: 'Database error.' });
    }

    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    // Build a human-friendly message for the frontend polling UI
    const messages = {
      pending:    'Order registered. Waiting to begin activation…',
      processing: 'Activation in progress. Waiting for stock to replenish…',
      completed:  'Activation complete! Check your ChatGPT account.',
      failed:     order.error_message || 'Activation failed. Please contact support.',
    };

    return res.status(200).json({
      status:       order.status,
      message:      messages[order.status] || 'Unknown status.',
      product_name: order.product_name,
      updated_at:   order.updated_at,
    });

  } catch (err) {
    log('ERROR', '/api/plati/status error:', err.message);
    return res.status(500).json({ error: err.message || 'Status check failed.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Health check — Railway uses this to confirm the service is alive
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'platimarket-activation', ts: new Date().toISOString() });
});

// ═════════════════════════════════════════════════════════════════════════════
//  ENDPOINT 4: POST /api/check-auth
//  Validates a ChatGPT Auth Session JSON by decoding JWT payload locally
// ═════════════════════════════════════════════════════════════════════════════
app.post('/api/check-auth', (req, res) => {
  try {
    const { authJson } = req.body;
    if (!authJson) return res.json({ valid: false, message: 'No JSON provided' });

    let parsed;
    try { 
      parsed = typeof authJson === 'string' ? JSON.parse(authJson) : authJson; 
    } catch(e) { 
      return res.json({ valid: false, message: 'Invalid JSON format' }); 
    }

    const token = parsed.accessToken;
    if (!token) return res.json({ valid: false, message: 'Missing accessToken' });

    // Decode JWT Payload (the middle part of the token)
    const parts = token.split('.');
    if (parts.length !== 3) return res.json({ valid: false, message: 'Malformed accessToken format' });

    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));

    // Validate Expiration
    const currentUnixTime = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < currentUnixTime) {
      return res.json({ valid: false, message: 'Session Token has expired' });
    }

    // Extract secure data directly from the token
    const email = payload['https://api.openai.com/profile']?.email || parsed.user?.email || 'Unknown';
    const plan = payload['https://api.openai.com/auth']?.chatgpt_plan_type || parsed.account?.planType || 'Unknown Plan';

    return res.json({ 
      valid: true, 
      email: email, 
      plan: plan.toUpperCase() 
    });

  } catch (error) {
    console.error('JWT Decode Error:', error);
    return res.json({ valid: false, message: 'Failed to process token data' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 404 catch-all
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Backend Route NOT FOUND: ${req.method} ${req.url}` }));

app.use((err, req, res, next) => {
  console.error('Global Server Error:', err);
  res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start server — MUST bind 0.0.0.0 for Railway's reverse proxy to reach it
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  log('INFO', `PlatiMarket activation server listening on 0.0.0.0:${PORT}`);
  log('INFO', `Supabase URL : ${process.env.SUPABASE_URL}`);
  log('INFO', `Digiseller ID: ${process.env.DIGISELLER_SELLER_ID}`);
});
