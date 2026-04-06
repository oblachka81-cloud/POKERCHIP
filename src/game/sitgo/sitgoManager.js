const { SITGO_CONFIG, BLIND_LEVELS } = require('../../config/constants');

let _io;
function init(io) { _io = io; }

const sitgoLobbies = {};

function startSitGo(sg) {
  const config = SITGO_CONFIG[sg.configId];
  sg.status='playing'; sg.handsPlayed=0; sg.blindLevel=0;
  sg.currentSb=BLIND_LEVELS[0].sb; sg.currentBb=BLIND_LEVELS[0].bb;
  sg.communityCards=[]; sg.pot=0; sg.currentBet=0; sg.deck=[]; sg.deckIdx=0;
  sg.round='waiting'; sg.winner=null; sg.handInProgress=false; sg.nextHandTimer=null;
  sg.dealerIndex=0;
  sg.players.forEach(p=>{ p.stack=config.startStack; p.cards=[]; p.bet=0; p.folded=false; p.hasActed=false; p.eliminated=false; p.place=null; p.isWaiting=false; });
  console.log('🏆 Sit&Go ' + sg.id + ' стартует! ' + sg.players.length + ' игроков');
  _io.to('sitgo_lobby_' + sg.id).emit('sitgoStarting', { lobbyId:sg.id });
  setTimeout(() => {
    const { startSitGoHand } = require('./sitgoFlow');
    startSitGoHand(sg);
  }, 3000);
}

function getSitGoNonEliminated(sg) { return sg.players.filter(p=>!p.eliminated); }

module.exports = { init, sitgoLobbies, startSitGo, getSitGoNonEliminated };
