// starter-bot/app.js
import 'dotenv/config';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import fs from 'fs';

// ===== hot-reload simples de menu/zonas (edite sem reiniciar) =====
let menu, zones;
const loadMenu  = () => JSON.parse(fs.readFileSync('./data/menu.json',  'utf8'));
const loadZones = () => JSON.parse(fs.readFileSync('./data/zones.json', 'utf8'));
menu  = loadMenu();
zones = loadZones();
fs.watch('./data', (evt, file) => {
  if (file === 'menu.json')  { menu  = loadMenu();  console.log('↻ menu.json recarregado'); }
  if (file === 'zones.json') { zones = loadZones(); console.log('↻ zones.json recarregado'); }
});

// ===== Config =====
const BOT_NAME   = process.env.BOT_NAME   || 'LumiFlux Bot';
const PIX_KEY    = process.env.PIX_KEY    || 'pix@exemplo.com';
const SUPPORT_WA = process.env.SUPPORT_WA || '5541998119767';

// Frase exata que deve ativar o bot
const TRIGGER_PHRASE = 'Olá, quero ver o LumiFlux Bot em ação!';

// ===== Utils =====
const S = {};  // estado por chat
const timers = {};
const TIMEOUT_MS = 10 * 60 * 1000;

fs.mkdirSync('./comprovantes', { recursive: true });

function normalizeSmart(s=''){
  // troca aspas “smart”, NBSP, normaliza acentos, colapsa espaços, mantém pontuação básica
  return s
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\u00A0/g, ' ')                  // NBSP
    .normalize('NFKD').replace(/[\u0300-\u036f]/g,'') // remove diacríticos
    .replace(/[ \t\r\n]+/g, ' ')              // colapsa espaços/linhas
    .trim()
    .toLowerCase();
}
const TRIGGER_NORM = normalizeSmart(TRIGGER_PHRASE);

function formatMoney(n){ return `R$ ${n.toFixed(2).replace('.',',')}`; }
function parseNumber(txt){ const n = parseInt((txt||'').trim(),10); return Number.isFinite(n)?n:null; }

function resumoPedido(st){
  const linhas = st.itens.map(it=>{
    const ops = it.opcoes?.length ? ` (${it.opcoes.map(o=>o.label).join(', ')})` : '';
    return `• ${it.qty}x ${it.nome}${ops} — ${formatMoney(it.subtotal)}`;
  });
  const subtotal = st.itens.reduce((a,b)=>a+b.subtotal,0);
  const total = subtotal + st.taxa;
  return ['*Resumo do pedido*', ...linhas, `Taxa: ${formatMoney(st.taxa)}`, `*Total:* ${formatMoney(total)}`].join('\n');
}

function reset(id){
  S[id] = {
    active:false, step:'start', nome:null, zone:null, taxa:0,
    itens:[], endereco:null, pagamento:null, troco:0, aguardandoComprovante:false, currentItem:null
  };
}

function startTimer(id, chat){
  clearTimeout(timers[id]);
  timers[id] = setTimeout(async ()=>{
    reset(id);
    await chat.sendMessage(
      '⏱️ Atendimento reiniciado por inatividade.\n' +
      'Envie *Olá, quero ver o LumiFlux Bot em ação!* para começar novamente.'
    );
  }, TIMEOUT_MS);
}

// ===== WhatsApp client =====
const sessionId = process.argv[2] || 'starter';
const client = new Client({
  authStrategy: new LocalAuth({ clientId: sessionId }),
  puppeteer: { headless: true, args: ['--no-sandbox'] }
});

client.on('qr', qr => qrcode.generate(qr, { small:true }));
client.on('ready', () => console.log('✅ Bot pronto:', BOT_NAME));

client.on('message', async msg => {
  if (msg.fromMe) return;
  const chat = await msg.getChat();
  if (chat.isGroup) return; // ignora grupos

  const id = msg.from;
  if (!S[id]) reset(id);
  startTimer(id, chat);

  const raw = (msg.body || '').trim();
  const txt = normalizeSmart(raw);

  console.log('RX', id, '→', raw); // log útil pra depurar o que realmente chegou

  // --- Gatilho: só ativa quando a frase NORMALIZADA bater ---
  if (!S[id].active) {
    if (txt === TRIGGER_NORM) {
      S[id].active = true;
      S[id].step = 'zone';
      const lista = zones.map((z,i)=>`${i+1}) ${z.nome} — taxa ${formatMoney(z.taxa)}`).join('\n');
      return void chat.sendMessage(
        `👋 Olá! Eu é sou o *${BOT_NAME}*.\n`+
        `Vamos começar seu pedido?\n\n`+
        `📍 *Qual a região/bairro?*\n${lista}\n\nResponda com o número.`
      );
    } else {
      return; // completamente silencioso fora do gatilho
    }
  }

  // atalhos
  if (/obrigad|valeu/.test(txt))  return void chat.sendMessage(`💖 De nada! Qualquer coisa estou aqui, *${S[id].nome || 'amigo(a)'}*!`);
  if (/^novo pedido$/.test(txt)) { reset(id); S[id].active = true; S[id].step='zone';
    const lista = zones.map((z,i)=>`${i+1}) ${z.nome} — taxa ${formatMoney(z.taxa)}`).join('\n');
    return void chat.sendMessage(`🆕 Novo pedido.\n${lista}\n\nResponda com o número.`); }
  if (/^sair$/.test(txt)) { reset(id); return void chat.sendMessage('Até logo! Quando quiser, envie: *'+TRIGGER_PHRASE+'*'); }

  const st = S[id];

  switch (st.step) {
    case 'start': st.step = 'zone'; // fallback
    case 'zone': {
      const n = parseNumber(raw);
      if (!n || n<1 || n>zones.length) {
        const lista = zones.map((z,i)=>`${i+1}) ${z.nome} — taxa ${formatMoney(z.taxa)}`).join('\n');
        return void chat.sendMessage(`Escolha um número da lista:\n${lista}`);
      }
      const z = zones[n-1]; st.zone = z.nome; st.taxa = z.taxa;
      st.step = 'menu';
      const itens = menu.itens.map(i=>`${i.id}) ${i.nome} — ${formatMoney(i.preco)}`).join('\n');
      return void chat.sendMessage(`🍽️ *Cardápio ${menu.categoria}*\n${itens}\n\nEnvie o *número* do item ou digite *finalizar*.`);
    }

    case 'menu': {
      if (/finalizar|finalizado/.test(txt)) {
        if (!st.itens.length) return void chat.sendMessage('Você ainda não escolheu nada. Selecione um item 😉');
        st.step='nome';
        await chat.sendMessage(resumoPedido(st));
        return void chat.sendMessage('Qual é o *seu nome*?');
      }
      const n = parseNumber(raw);
      const item = menu.itens.find(i=>i.id===n);
      if (!item) return void chat.sendMessage('Envie o *número* do item da lista, ou *finalizar*.');
      st.currentItem = JSON.parse(JSON.stringify(item));
      st.step = 'opcoes';
      if (!item.opcoes?.length) {
        st.step='qty'; return void chat.sendMessage('Quantidade? (ex.: 1, 2, 3)');
      }
      const ops = item.opcoes.map((o,i)=>`${i+1}) ${o.label}${o.preco?` +${formatMoney(o.preco)}`:''}`).join('\n');
      return void chat.sendMessage(`Alguma opção?\n${ops}\n\nResponda com os números separados por vírgula ou *0* para nenhuma.`);
    }

    case 'opcoes': {
      const escolha = raw.replace(/\s/g,'');
      let selecionadas = [];
      if (escolha!=='0') {
        const idxs = escolha.split(',').map(x=>parseInt(x,10)).filter(x=>x>=1 && x<=st.currentItem.opcoes.length);
        selecionadas = idxs.map(i=>st.currentItem.opcoes[i-1]);
      }
      st.currentItem.opcoes = selecionadas;
      st.step = 'qty';
      return void chat.sendMessage('Quantidade? (ex.: 1, 2, 3)');
    }

    case 'qty': {
      const q = parseNumber(raw);
      if (!q || q<1) return void chat.sendMessage('Me diga um número inteiro 🙂');
      const it = st.currentItem;
      const extra = (it.opcoes||[]).reduce((a,b)=>a+(b.preco||0),0);
      const subtotal = q * (it.preco + extra);
      st.itens.push({ nome: it.nome, opcoes: it.opcoes, qty: q, subtotal });
      st.currentItem = null;
      st.step = 'menu';
      await chat.sendMessage(`Adicionado: ${q}x ${it.nome}.`);
      const itens = menu.itens.map(i=>`${i.id}) ${i.nome} — ${formatMoney(i.preco)}`).join('\n');
      return void chat.sendMessage(`Quer mais algo?\n${itens}\n\nOu digite *finalizar*.`);
    }

    case 'nome': {
      st.nome = raw.replace(/\s+/g,' ').trim();
      st.step = 'endereco';
      return void chat.sendMessage(`Prazer, *${st.nome}* 😊\nMe envie o *endereço completo* (rua, número, complemento, bairro).`);
    }

    case 'endereco': {
      st.endereco = raw;
      st.step = 'pagamento';
      await chat.sendMessage(resumoPedido(st));
      return void chat.sendMessage(`💳 *Forma de pagamento*\n1) PIX\n2) Cartão na entrega\n3) Dinheiro\n\nResponda 1, 2 ou 3.`);
    }

    case 'pagamento': {
      const n = parseNumber(raw);
      if (![1,2,3].includes(n)) return void chat.sendMessage('Responda 1 (PIX), 2 (Cartão) ou 3 (Dinheiro).');
      if (n===1){ st.pagamento='pix'; st.step='aguardaPix';
        return void chat.sendMessage(`🔑 *Chave PIX:* \`${PIX_KEY}\`\nEnvie o *comprovante* aqui (foto ou PDF).`); }
      if (n===2){ st.pagamento='cartao'; st.step='confirma'; await chat.sendMessage('Cartão na entrega ✅'); break; }
      if (n===3){ st.pagamento='dinheiro'; st.step='troco'; return void chat.sendMessage('Precisa de troco? Se sim, para quanto? (ex.: 50,00). Se não, responda *não*.'); }
    }

    case 'troco': {
      if (/^nao|não|n$/.test(txt)) { st.troco=0; st.step='confirma'; }
      else {
        const v = Number((raw.replace(',','.').match(/[0-9.]+/)||['0'])[0]);
        if (!v) return void chat.sendMessage('Manda o valor do troco (ex.: 50,00) ou *não*.');
        st.troco = v; st.step='confirma';
      }
      await chat.sendMessage(`Troco anotado: ${st.troco ? formatMoney(st.troco) : 'não precisa'}.`);
      break;
    }

    case 'aguardaPix': {
      if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        const ts = Date.now();
        fs.writeFileSync(`./comprovantes/${ts}_${id}.txt`, media.filename || 'comprovante');
        st.aguardandoComprovante = false; st.step='confirma';
        await chat.sendMessage('✅ Comprovante recebido. Obrigado!');
      } else { return; }
      break;
    }
  }

  if (S[id].step === 'confirma') {
    await chat.sendMessage(resumoPedido(S[id]));
    await chat.sendMessage(
      `✅ *Pedido confirmado, ${S[id].nome}!* Vamos preparar com todo carinho 💖\n`+
      `Endereço: ${S[id].endereco}\n`+
      `Se precisar, responda aqui. Para *novo pedido*, digite *novo pedido*.\n`+
      `Suporte: wa.me/${SUPPORT_WA}`
    );
    reset(id); S[id].active = true; S[id].step = 'zone';
  }
});

client.initialize();
