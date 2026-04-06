function createDeck() {
  const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const suits = ['hearts','diamonds','clubs','spades'];
  const deck = [];
  for (const suit of suits) for (const rank of ranks) deck.push({ rank, suit });
  return deck;
}

function shuffle(deck) {
  for (let i=deck.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [deck[i],deck[j]] = [deck[j],deck[i]];
  }
  return deck;
}

function validateDeck(deck) {
  const seen = new Set();
  for (const card of deck) {
    const key = card.rank + '_' + card.suit;
    if (seen.has(key)) { console.error('❌ ДУБЛИКАТ: ' + key); return false; }
    seen.add(key);
  }
  return true;
}

function createValidDeck() {
  let deck;
  do { deck = shuffle(createDeck()); } while (!validateDeck(deck));
  return deck;
}

function rankToNum(r) {
  return {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14}[r];
}

function eval5(cards) {
  const nums = cards.map(c=>rankToNum(c.rank)).sort((a,b)=>b-a);
  const suits = cards.map(c=>c.suit);
  const flush = suits.every(s=>s===suits[0]);
  const counts = {};
  nums.forEach(n=>counts[n]=(counts[n]||0)+1);
  const groups = Object.entries(counts).map(([r,c])=>({r:+r,c})).sort((a,b)=>b.c-a.c||b.r-a.r);
  const gc = groups.map(g=>g.c);
  const gv = groups.map(g=>g.r);
  const uniq = [...new Set(nums)];
  let straight=false, sHigh=nums[0];
  if (uniq.length>=5) {
    for (let i=0; i<=uniq.length-5; i++) {
      if (uniq[i]-uniq[i+4]===4) { straight=true; sHigh=uniq[i]; break; }
    }
    if (!straight && [14,5,4,3,2].every(v=>uniq.includes(v))) { straight=true; sHigh=5; }
  }
  if (straight&&flush) return { rank:9, val:[sHigh], name:'Стрит-флеш' };
  if (gc[0]===4) return { rank:8, val:gv, name:'Каре' };
  if (gc[0]===3&&gc[1]===2) return { rank:7, val:gv, name:'Фулл-хаус' };
  if (flush) return { rank:6, val:nums, name:'Флеш' };
  if (straight) return { rank:5, val:[sHigh], name:'Стрит' };
  if (gc[0]===3) return { rank:4, val:gv, name:'Тройка' };
  if (gc[0]===2&&gc[1]===2) return { rank:3, val:gv, name:'Две пары' };
  if (gc[0]===2) return { rank:2, val:gv, name:'Пара' };
  return { rank:1, val:nums, name:'Старшая карта' };
}

function bestHand(cards) {
  const result = [];
  for (let a=0;a<cards.length-4;a++)
    for (let b=a+1;b<cards.length-3;b++)
      for (let c=b+1;c<cards.length-2;c++)
        for (let d=c+1;d<cards.length-1;d++)
          for (let e=d+1;e<cards.length;e++)
            result.push(eval5([cards[a],cards[b],cards[c],cards[d],cards[e]]));
  return result.reduce((best,h) => {
    if (!best||h.rank>best.rank) return h;
    if (h.rank===best.rank) {
      for (let i=0;i<Math.min(h.val.length,best.val.length);i++) {
        if (h.val[i]>best.val[i]) return h;
        if (h.val[i]<best.val[i]) return best;
      }
    }
    return best;
  }, null);
}

module.exports = { createDeck, shuffle, validateDeck, createValidDeck, rankToNum, eval5, bestHand };
