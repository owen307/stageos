/**
 * LightScript License Webhook — Vercel Serverless Function
 * ──────────────────────────────────────────────────────────
 * Deploy to Vercel (free tier) — handles Lemon Squeezy order webhooks.
 * Generates a signed license key and sends it to the customer via email.
 *
 * Setup:
 *   1. Copy this file to api/webhook.js in a new Vercel project
 *   2. Set environment variables in Vercel dashboard:
 *        LS_PRIVATE_KEY     — your EC private key PEM (from license-gen.js)
 *        LS_WEBHOOK_SECRET  — from Lemon Squeezy dashboard → Webhooks
 *        RESEND_API_KEY     — from resend.com (free: 3000 emails/mo)
 *        FROM_EMAIL         — e.g. licenses@yourdomain.com
 *   3. In Lemon Squeezy: Settings → Webhooks → add your Vercel URL
 *      Events: order_created
 *
 * Product variant IDs (set in Lemon Squeezy product variants):
 *   Set a metadata field "lightscript_plan" = "pro" | "studio" | "custom"
 *   Set a metadata field "lightscript_channels" = "512" | "2048" | etc.
 */

const crypto = require('crypto');

// ── Plan map — Lemon Squeezy variant ID → license params ─────────────────────
// Set your actual variant IDs here after creating products in Lemon Squeezy
const VARIANT_PLANS = {
  // 'variant_id': { plan, channels, label }
  // Example — replace these with your real variant IDs:
  // '123456': { plan: 'pro',    channels: 512,  label: 'Pro' },
  // '123457': { plan: 'studio', channels: 2048, label: 'Studio' },
};

// ── Generate license key (same logic as license-gen.js) ──────────────────────
function generateKey(plan, channels, label, email) {
  const PRIVATE_KEY_PEM = process.env.LS_PRIVATE_KEY;
  if (!PRIVATE_KEY_PEM) throw new Error('LS_PRIVATE_KEY not set');

  function b64url(buf) {
    return Buffer.from(buf).toString('base64')
      .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  }
  const payload = {
    v:1, plan, channels, label, email,
    issued: Date.now(), expires: null,
    id: crypto.randomBytes(8).toString('hex'),
  };
  const header  = b64url(JSON.stringify({alg:'ES256',typ:'JWT'}));
  const body    = b64url(JSON.stringify(payload));
  const signing = `${header}.${body}`;
  const privateKey = crypto.createPrivateKey(PRIVATE_KEY_PEM);
  const sig = crypto.sign('sha256', Buffer.from(signing), {key:privateKey,dsaEncoding:'ieee-p1363'});
  return `LSC1-${signing}.${b64url(sig)}`;
}

// ── Verify Lemon Squeezy webhook signature ────────────────────────────────────
function verifySignature(rawBody, signature) {
  const secret = process.env.LS_WEBHOOK_SECRET;
  if (!secret) return false;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const expected = hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

// ── Send license email via Resend ─────────────────────────────────────────────
async function sendLicenseEmail(email, plan, channels, key) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('RESEND_API_KEY not set — skipping email'); return; }
  const fromEmail = process.env.FROM_EMAIL || 'licenses@lightscript.app';

  const body = JSON.stringify({
    from: `LightScript Licensing <${fromEmail}>`,
    to: [email],
    subject: `Your LightScript ${plan} License Key`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;background:#07080a;color:#e8eaf0;padding:40px 32px;border-radius:8px">
        <div style="font-size:24px;font-weight:900;letter-spacing:4px;color:#c090ff;margin-bottom:8px">LIGHTSCRIPT</div>
        <div style="font-size:12px;letter-spacing:2px;color:rgba(192,144,255,0.5);margin-bottom:32px">PROFESSIONAL DMX CONSOLE</div>

        <p style="color:#b0b8c8">Thanks for your purchase! Here's your license key for the <strong style="color:#c090ff">${plan} plan</strong> (${channels} channels):</p>

        <div style="background:rgba(42,16,96,0.4);border:1px solid rgba(144,96,224,0.4);border-radius:6px;padding:20px 24px;margin:24px 0;word-break:break-all">
          <div style="font-size:10px;letter-spacing:2px;color:rgba(192,144,255,0.5);margin-bottom:8px">YOUR LICENSE KEY</div>
          <code style="font-family:'Courier New',monospace;font-size:12px;color:#c090ff;line-height:1.6">${key}</code>
        </div>

        <p style="color:#b0b8c8;font-size:14px"><strong style="color:#e8eaf0">How to activate:</strong></p>
        <ol style="color:#b0b8c8;font-size:14px;line-height:2">
          <li>Launch LightScript</li>
          <li>Paste your key in the activation screen</li>
          <li>Click Activate</li>
        </ol>

        <p style="color:#b0b8c8;font-size:14px">This license works <strong style="color:#e8eaf0">fully offline</strong> — no internet required after activation. Keep this email as your proof of purchase.</p>

        <hr style="border:none;border-top:1px solid rgba(144,96,224,0.2);margin:32px 0">
        <p style="color:rgba(176,184,200,0.5);font-size:12px">Questions? Reply to this email.</p>
      </div>
    `,
  });

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {'Content-Type':'application/json','Authorization':`Bearer ${apiKey}`},
    body,
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error('Resend error:', err);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});

  // Read raw body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString();

  // Verify signature
  const sig = req.headers['x-signature'];
  if (!sig || !verifySignature(rawBody, sig)) {
    console.error('Invalid webhook signature');
    return res.status(401).json({error:'Invalid signature'});
  }

  let event;
  try { event = JSON.parse(rawBody); }
  catch (e) { return res.status(400).json({error:'Invalid JSON'}); }

  // Only handle order_created
  if (event.meta?.event_name !== 'order_created') {
    return res.status(200).json({ok:true, skipped:true});
  }

  const order = event.data?.attributes;
  if (!order) return res.status(400).json({error:'No order data'});

  const email      = order.user_email;
  const variantId  = String(event.data?.relationships?.first_order_item?.data?.id || '');
  const variantMeta = order.first_order_item?.variant_id;

  // Determine plan from variant or metadata
  const variantPlan = VARIANT_PLANS[variantId] || VARIANT_PLANS[String(variantMeta)];
  const meta = order.meta || {};

  const plan     = variantPlan?.plan     || meta.lightscript_plan     || 'pro';
  const channels = parseInt(variantPlan?.channels || meta.lightscript_channels || 512);
  const label    = variantPlan?.label    || meta.lightscript_label    || 'Pro';

  try {
    const key = generateKey(plan, channels, label, email);
    await sendLicenseEmail(email, label, channels, key);
    console.log(`License issued: ${plan} (${channels}ch) → ${email}`);
    return res.status(200).json({ok:true});
  } catch(e) {
    console.error('License generation failed:', e.message);
    return res.status(500).json({error:e.message});
  }
};
