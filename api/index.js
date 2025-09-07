// api/index.js
import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import cors from 'cors';

console.log('Stripe key prefix:', process.env.STRIPE_SECRET?.slice(0,7)); // deve imprimir sk_live

const app = express();
app.use(cors());
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
 * ETAPA 1 — Checkout do SETUP (paga AGORA).
 * - Cria Customer (customer_creation: 'always')
 * - Salva o método de pagamento para uso futuro (setup_future_usage: 'off_session')
 * success_url inclui setup_session_id para a etapa 2.
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
      // garante customer e guarda o cartão para cobrança futura
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
 * ETAPA 2 — Cria a ASSINATURA no backend com cobrança DAQUI 30 DIAS.
 * - Não usa Checkout (assim não aparece "teste grátis" para o cliente)
 * - Usa o Customer criado na etapa 1 e o cartão salvo
 */
app.post('/api/subscribe/after-setup', async (req, res) => {
  try {
    const { setupSessionId, plan = 'starter' } = req.body || {};
    if (!setupSessionId) return res.status(400).json({ error: 'setupSessionId é obrigatório' });

    const priceSub = PLAN_SUB[plan];
    if (!priceSub) return res.status(400).json({ error: 'Plano inválido ou price ausente (subscription)' });

    // Recupera a sessão do checkout (etapa 1) para obter o Customer e o PaymentMethod
    const session = await stripe.checkout.sessions.retrieve(setupSessionId, {
      expand: ['payment_intent.payment_method', 'customer'],
    });

    const customerId = session.customer;
    if (!customerId) return res.status(400).json({ error: 'Customer não encontrado a partir do setup' });

    // Usa o payment_method do pagamento do setup como default para futuras cobranças
    const paymentMethodId = session?.payment_intent?.payment_method?.id;
    if (paymentMethodId) {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    }

    // Âncora de cobrança daqui 30 dias (em segundos)
    const THIRTY_DAYS = 30 * 24 * 60 * 60;
    const anchor = Math.floor(Date.now() / 1000) + THIRTY_DAYS;

    // Cria assinatura para começar a cobrar só no anchor (sem pró-rata)
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceSub }],
      billing_cycle_anchor: anchor,
      proration_behavior: 'none',
      // só pra garantir que cobra automaticamente no cartão salvo
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
