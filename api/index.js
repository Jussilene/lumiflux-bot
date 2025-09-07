// api/index.js
import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';

console.log('Stripe key prefix:', process.env.STRIPE_SECRET?.slice(0,7)); // deve imprimir sk_live

const app = express();
app.use(cors()); // aberto; em produção você pode restringir a origin
app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET, { apiVersion: '2024-06-20' });

// ====== Prices LIVE ======
// Recorrentes (assinatura)
const PLAN_SUB = {
  starter: process.env.PRICE_STARTER_MONTHLY,
  pro:     process.env.PRICE_PRO_MONTHLY,
  full:    process.env.PRICE_FULL_MONTHLY,
};
// Avulsos (setup)
const PLAN_SETUP = {
  starter: process.env.PRICE_SETUP_STARTER,
  pro:     process.env.PRICE_SETUP_PRO,
  full:    process.env.PRICE_SETUP_FULL,
};

// Health
app.get('/', (_, res) => res.send('LumiFlux API OK'));
app.get('/api/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

/**
 * ETAPA 1 — Checkout do SETUP via POST (mantido)
 */
app.post('/api/checkout/setup-first', async (req, res) => {
  try {
    const { plan = 'starter', email } = req.body || {};
    const priceSetup = PLAN_SETUP[plan];
    if (!priceSetup) return res.status(400).json({ error: 'Plano inválido ou price ausente (setup)' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: priceSetup, quantity: 1 }],
      customer_creation: 'always',
      payment_intent_data: { setup_future_usage: 'off_session' },
      customer_email: email || undefined,
      success_url: `${process.env.APP_URL}/success.html?setup_session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
      cancel_url: `${process.env.APP_URL}/cancel.html`,
      metadata: { plan, kind: 'setup', source: 'lumiflux-bot' },
      locale: 'pt-BR',
    });

    return res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('checkout/setup-first error:', err?.type, err?.message, err?.raw);
    return res.status(500).json({ error: err?.message || 'Erro desconhecido' });
  }
});

/**
 * NOVO: ETAPA 1 — Checkout do SETUP via GET (fallback sem CORS)
 * Ex.: https://SEU-API.onrender.com/api/checkout/setup-first?plan=starter
 * Redireciona 303 direto para o Stripe.
 */
app.get('/api/checkout/setup-first', async (req, res) => {
  try {
    const plan = (req.query.plan || 'starter').toString();
    const priceSetup = PLAN_SETUP[plan];
    if (!priceSetup) return res.status(400).send('Plano inválido');

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: priceSetup, quantity: 1 }],
      customer_creation: 'always',
      payment_intent_data: { setup_future_usage: 'off_session' },
      success_url: `${process.env.APP_URL}/success.html?setup_session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
      cancel_url: `${process.env.APP_URL}/cancel.html`,
      metadata: { plan, kind: 'setup', source: 'lumiflux-bot' },
      locale: 'pt-BR',
    });

    return res.redirect(303, session.url);
  } catch (err) {
    console.error('checkout/setup-first GET error:', err?.type, err?.message, err?.raw);
    return res.status(500).send('Erro ao iniciar checkout');
  }
});

/**
 * ETAPA 2 — Cria ASSINATURA que começa a cobrar em 30 dias
 */
app.post('/api/subscribe/after-setup', async (req, res) => {
  try {
    const { setupSessionId, plan = 'starter' } = req.body || {};
    if (!setupSessionId) return res.status(400).json({ error: 'setupSessionId é obrigatório' });

    const priceSub = PLAN_SUB[plan];
    if (!priceSub) return res.status(400).json({ error: 'Plano inválido ou price ausente (subscription)' });

    const session = await stripe.checkout.sessions.retrieve(setupSessionId, {
      expand: ['payment_intent.payment_method', 'customer'],
    });

    const customerId = session.customer;
    if (!customerId) return res.status(400).json({ error: 'Customer não encontrado a partir do setup' });

    const paymentMethodId = session?.payment_intent?.payment_method?.id;
    if (paymentMethodId) {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    }

    const THIRTY_DAYS = 30 * 24 * 60 * 60;
    const anchor = Math.floor(Date.now() / 1000) + THIRTY_DAYS;

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceSub }],
      billing_cycle_anchor: anchor,
      proration_behavior: 'none',
      collection_method: 'charge_automatically',
      metadata: { plan, source: 'lumiflux-bot' },
    });

    return res.json({
      ok: true,
      subscriptionId: subscription.id,
      billingStartsAt: new Date(anchor * 1000).toISOString(),
    });
  } catch (err) {
    console.error('subscribe/after-setup error:', err?.type, err?.message, err?.raw);
    return res.status(500).json({ error: err?.message || 'Erro desconhecido' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`LumiFlux API on http://localhost:${PORT}`));
