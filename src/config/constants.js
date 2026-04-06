const TABLE_CONFIG = {
  test_bronze:  { type:'test',  tier:'bronze',  sb:10,  bb:20,  rake:0.03, rakeCap:10,  entryStars:0   },
  test_silver:  { type:'test',  tier:'silver',  sb:25,  bb:50,  rake:0.03, rakeCap:25,  entryStars:0   },
  test_gold:    { type:'test',  tier:'gold',    sb:50,  bb:100, rake:0.03, rakeCap:50,  entryStars:0   },
  stars_bronze: { type:'stars', tier:'bronze',  sb:10,  bb:20,  rake:0.03, rakeCap:30,  entryStars:50  },
  stars_silver: { type:'stars', tier:'silver',  sb:25,  bb:50,  rake:0.03, rakeCap:75,  entryStars:200 },
  stars_gold:   { type:'stars', tier:'gold',    sb:50,  bb:100, rake:0.03, rakeCap:150, entryStars:500 },
};

const SITGO_CONFIG = {
  sitgo_3_bronze: { maxPlayers:3, tier:'bronze', buyIn:100,  rake:10,  startStack:1500, sb:10, bb:20  },
  sitgo_3_silver: { maxPlayers:3, tier:'silver', buyIn:500,  rake:50,  startStack:1500, sb:25, bb:50  },
  sitgo_3_gold:   { maxPlayers:3, tier:'gold',   buyIn:1000, rake:100, startStack:1500, sb:50, bb:100 },
  sitgo_6_bronze: { maxPlayers:6, tier:'bronze', buyIn:100,  rake:10,  startStack:1500, sb:10, bb:20  },
  sitgo_6_silver: { maxPlayers:6, tier:'silver', buyIn:500,  rake:50,  startStack:1500, sb:25, bb:50  },
  sitgo_6_gold:   { maxPlayers:6, tier:'gold',   buyIn:1000, rake:100, startStack:1500, sb:50, bb:100 },
};

const PRIZE_DIST = { 1:[100], 2:[100], 3:[60,30,10], 4:[60,30,10], 5:[60,30,10], 6:[60,30,10] };

const BLIND_LEVELS = [
  { sb:10,  bb:20  },
  { sb:20,  bb:40  },
  { sb:40,  bb:80  },
  { sb:75,  bb:150 },
  { sb:150, bb:300 },
  { sb:300, bb:600 },
];

module.exports = { TABLE_CONFIG, SITGO_CONFIG, PRIZE_DIST, BLIND_LEVELS };
