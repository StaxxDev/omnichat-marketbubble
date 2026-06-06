'use strict';

const { makeMessage } = require('../schema');

// Synthetic message generator so the merged, labeled, filterable feed works with zero config.
const POOL = {
  twitch: {
    channels: ['ansem_live', 'cryptostream'],
    authors: ['degenApe', 'liqHunter', 'gmFren', 'chartWizard', 'sol_maxi'],
    colors: ['#FF4500', '#1E90FF', '#00FF7F', '#FF69B4', '#FFD700'],
  },
  kick: {
    channels: ['ansem', 'tradingpit'],
    authors: ['kickWhale', 'pumpitup', 'redCandle', 'greenDildo', 'moonboi'],
    colors: ['#53FC18', '#9B59B6', '#E67E22', '#1ABC9C', '#E74C3C'],
  },
  x: {
    channels: ['mentions:blknoiz06', 'hashtag:SOL'],
    authors: ['alphaLeaks', 'onchain_ed', 'tier1cap', 'memecoinCEO', 'exitLiquidity'],
    colors: [''],
  },
};

const TEXTS = [
  'LFG this candle is sending 🚀',
  'who is buying this dip',
  'ansem called the top again ser',
  'longs getting liquidated rn',
  'new ATH incoming, mark my words',
  'down bad but still bullish',
  'this is financial advice (it is not)',
  'wen lambo wen moon',
  'closed my short, respect the trade',
  'bags packed, ready for the pump',
  'liquidity sweep then reversal classic',
  'gm to everyone except paper hands',
  'that wick took out my stop loss 😭',
  'aping in with the rent money',
  'chart looks like a staircase to heaven',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function startDemo(emit, log, intervalMs) {
  const sources = ['twitch', 'kick', 'x'];
  let i = 0;
  log('demo: injecting synthetic Twitch/Kick/X messages (~' + (intervalMs || 800) + 'ms)');
  const timer = setInterval(() => {
    const source = sources[i % sources.length];
    i += 1;
    const cfg = POOL[source];
    emit(
      makeMessage({
        source,
        channel: pick(cfg.channels),
        author: pick(cfg.authors),
        text: pick(TEXTS),
        color: pick(cfg.colors),
      })
    );
  }, intervalMs || 800);

  return function stop() {
    clearInterval(timer);
  };
}

module.exports = { startDemo };
