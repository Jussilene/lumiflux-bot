// api/index.js
import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';

console.log('Stripe key prefix:', process.env.STRIPE_SECRET?.slice(0, 7));

const app = express();

// CORS amplo + OPTIONS para pré-flight
app.use(cors({ origin: '*' }));
app.options('*', cors());

app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET, { apiVersion: '2024-06-20' });

// Prices (assinatura mensal)
const PLAN_SUB = {
  starter: process.env.PRICE_STARTER_MONTHLY,
  pro:     process.env.PRICE_PRO_MONTHLY,
  full:    process.env.PRICE_FULL_MONTHLY,
};
// Prices (setup avulso)
const PLAN_SETUP = {
  starter: process.env.PRICE_SETUP_STARTER,
  pro:     process.env.PRICE_SETUP_PRO,
  full:    process.env.PRICE_SETUP_FULL,
};

// Health
app.get('/', (_, res) => res.send('LumiFlux API OK'));
app.get('/api/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

/**
 * ETAPA 1 — Checkout do SETUP (paga agora).
 * POST normal (SPA) + GET fallback (navegação direta).
 */
async function createSetupSession({ plan, email }) {
  const priceSetup = PLAN_SETUP[plan];
  if (!priceSetup) throw new Error('Plano inválido ou price ausente (setup)');

  return stripe.checkout.sessions.create({
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
}

// POST (AJAX)
app.post('/api/checkout/setup-first', async (req, res) => {
  try {
    const { plan = 'starter', email } = req.body || {};
    const session = await createSetupSession({ plan, email });
    return res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('checkout/setup-first POST:', err?.message);
    return res.status(500).json({ error: err?.message || 'Erro desconhecido' });
  }
});

// GET (fallback por navegação direta)
app.get('/api/checkout/setup-first', async (req, res) => {
  try {
    const plan = req.query.plan || 'starter';
    const email = req.query.email;
    const session = await createSetupSession({ plan, email });
    return res.redirect(session.url); // redireciona direto ao Stripe
  } catch (err) {
    console.error('checkout/setup-first GET:', err?.message);
    return res.status(500).send(`Erro: ${err?.message || 'desconhecido'}`);
  }
});

/**
 * ETAPA 2 — cria a assinatura para começar em 30 dias.
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
    console.error('subscribe/after-setup:', err?.message);
    return res.status(500).json({ error: err?.message || 'Erro desconhecido' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`LumiFlux API on http://localhost:${PORT}`));
