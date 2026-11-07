/**
 * ==============================================================================
 * STEEL CLASH ARENA - MODERN REAL-TIME COMBAT ENGINE
 * Match History, Named Voters & High-Speed Dual-Damage Telemetry
 * ==============================================================================
 */

(function() {
  'use strict';

  // --- ARENA STATE ---
  const MAX_LIVES = 30;
  const MAX_VOTES = 10;

  const state = {
    volterLives: MAX_LIVES,
    maxLives: MAX_LIVES,
    status: 'OPERATIONAL',
    votes: {
      volter: 0,
      turbo: 0,
      remaining: MAX_VOTES,
      volterVoters: [],
      turboVoters: []
    },
    isGameOver: false,
    soundEnabled: true,
    threshold: 850,      // Small hit threshold (calibrated for ESP32 resting noise ~440 ADC)
    critThreshold: 1600, // Critical smash threshold
    currentAdc: 0,
    peakAdc: 0,
    totalHits: 0,
    smallHits: 0,
    criticalHits: 0,
    startTime: Date.now(),
    scopeData: new Array(120).fill(0),
    matchHistory: []
  };

  // --- DOM ELEMENT CACHE ---
  const el = {
    impactWrapper: document.getElementById('impactWrapper'),
    volterCard: document.getElementById('volterCard'),
    turboCard: document.getElementById('turboCard'),
    volterLivesDisplay: document.getElementById('volterLivesDisplay'),
    volterHealthBar: document.getElementById('volterHealthBar'),
    volterStatusBadge: document.getElementById('volterStatusBadge'),
    lifeNodesMatrix: document.getElementById('lifeNodesMatrix'),
    damageReductionPill: document.getElementById('damageReductionPill'),
    volterVoteCount: document.getElementById('volterVoteCount'),
    turboVoteCount: document.getElementById('turboVoteCount'),
    voteVolterBtn: document.getElementById('voteVolterBtn'),
    voteTurboBtn: document.getElementById('voteTurboBtn'),
    resetVotesBtn: document.getElementById('resetVotesBtn'),
    votePipsRow: document.getElementById('votePipsRow'),
    votesRemainingText: document.getElementById('votesRemainingText'),
    volterHypeBar: document.getElementById('volterHypeBar'),
    turboHypeBar: document.getElementById('turboHypeBar'),
    volterHypePercent: document.getElementById('volterHypePercent'),
    turboHypePercent: document.getElementById('turboHypePercent'),
    voterNameInput: document.getElementById('voterNameInput'),
    volterVotersList: document.getElementById('volterVotersList'),
    turboVotersList: document.getElementById('turboVotersList'),
    combatLogList: document.getElementById('combatLogList'),
    clearLogBtn: document.getElementById('clearLogBtn'),
    liveAdcText: document.getElementById('liveAdcText'),
    liveFrequency: document.getElementById('liveFrequency'),
    scopeCanvas: document.getElementById('scopeCanvas'),
    thresholdMarkerTag: document.getElementById('thresholdMarkerTag'),
    critMarkerTag: document.getElementById('critMarkerTag'),
    impactFlashOverlay: document.getElementById('impactFlashOverlay'),
    impactStatusText: document.getElementById('impactStatusText'),
    impactIcon: document.getElementById('impactIcon'),
    totalSmashCount: document.getElementById('totalSmashCount'),
    smallSmashCount: document.getElementById('smallSmashCount'),
    critSmashCount: document.getElementById('critSmashCount'),
    highestImpactDisplay: document.getElementById('highestImpactDisplay'),
    matchTimer: document.getElementById('matchTimer'),
    portStatusText: document.getElementById('portStatusText'),
    statusDot: document.getElementById('statusDot'),
    wifiStatusText: document.getElementById('wifiStatusText'),
    wifiStatusDot: document.getElementById('wifiStatusDot'),
    soundToggleBtn: document.getElementById('soundToggleBtn'),
    soundIcon: document.getElementById('soundIcon'),
    fullscreenBtn: document.getElementById('fullscreenBtn'),
    configToggleBtn: document.getElementById('configToggleBtn'),
    configModal: document.getElementById('configModal'),
    closeConfigBtn: document.getElementById('closeConfigBtn'),
    historyToggleBtn: document.getElementById('historyToggleBtn'),
    historyNavCount: document.getElementById('historyNavCount'),
    historyModal: document.getElementById('historyModal'),
    closeHistoryBtn: document.getElementById('closeHistoryBtn'),
    clearHistoryBtn: document.getElementById('clearHistoryBtn'),
    historyListContainer: document.getElementById('historyListContainer'),
    portInput: document.getElementById('portInput'),
    applyPortBtn: document.getElementById('applyPortBtn'),
    webSerialConnectBtn: document.getElementById('webSerialConnectBtn'),
    threshSlider: document.getElementById('threshSlider'),
    threshValueLabel: document.getElementById('threshValueLabel'),
    critSlider: document.getElementById('critSlider'),
    critValueLabel: document.getElementById('critValueLabel'),
    testStrikeBtn: document.getElementById('testStrikeBtn'),
    testCritBtn: document.getElementById('testCritBtn'),
    resetMatchBtn: document.getElementById('resetMatchBtn'),
    gameOverModal: document.getElementById('gameOverModal'),
    modalStrikes: document.getElementById('modalStrikes'),
    modalTime: document.getElementById('modalTime'),
    modalFav: document.getElementById('modalFav'),
    rematchBtn: document.getElementById('rematchBtn')
  };

  // ============================================================================
  // PROCEDURAL WEB AUDIO SYNTHESIZER
  // ============================================================================
  let audioCtx = null;
  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) audioCtx = new AudioContextClass();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function playSound(type, param = 1) {
    if (!state.soundEnabled) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;

      if (type === 'hammer-small') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(320, now);
        osc.frequency.exponentialRampToValueAtTime(80, now + 0.18);
        gain.gain.setValueAtTime(0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.19);
      }
      else if (type === 'hammer-critical') {
        // Sub boom
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(140, now);
        osc.frequency.exponentialRampToValueAtTime(30, now + 0.45);
        gain.gain.setValueAtTime(0.8, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.46);

        // Thunderous clang
        const clang = ctx.createOscillator();
        const clangGain = ctx.createGain();
        clang.type = 'triangle';
        clang.frequency.setValueAtTime(1100, now);
        clang.frequency.exponentialRampToValueAtTime(180, now + 0.22);
        clangGain.gain.setValueAtTime(0.55, now);
        clangGain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        clang.connect(clangGain);
        clangGain.connect(ctx.destination);
        clang.start(now);
        clang.stop(now + 0.23);
      }
      else if (type === 'vote') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(1040, now + 0.1);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.11);
      }
      else if (type === 'gameover') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(650, now);
        osc.frequency.linearRampToValueAtTime(280, now + 0.5);
        osc.frequency.linearRampToValueAtTime(650, now + 0.9);
        osc.frequency.linearRampToValueAtTime(150, now + 1.3);
        gain.gain.setValueAtTime(0.5, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 1.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 1.4);
      }
      else if (type === 'restart') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(260, now);
        osc.frequency.exponentialRampToValueAtTime(980, now + 0.28);
        gain.gain.setValueAtTime(0.35, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.31);
      }
    } catch (e) {}
  }

  // ============================================================================
  // 30-NODE VITAL MATRIX GENERATION
  // ============================================================================
  function init30LifeNodes() {
    el.lifeNodesMatrix.innerHTML = '';
    for (let i = 1; i <= MAX_LIVES; i++) {
      const pip = document.createElement('div');
      pip.className = 'life-pip';
      pip.id = `pip-${i}`;
      pip.title = `Vital Node #${i}`;
      el.lifeNodesMatrix.appendChild(pip);
    }
  }

  function renderLifeMatrix(currentLives, prevLives) {
    for (let i = 1; i <= MAX_LIVES; i++) {
      const pip = document.getElementById(`pip-${i}`);
      if (!pip) continue;

      if (i <= currentLives) {
        pip.className = 'life-pip';
      } else {
        if (prevLives && i <= prevLives) {
          pip.className = 'life-pip just-lost';
        } else {
          pip.className = 'life-pip depleted';
        }
      }
    }
  }

  // ============================================================================
  // 10-VOTE POOL TOKENS & VOTER ROSTER
  // ============================================================================
  function initVotePips() {
    el.votePipsRow.innerHTML = '';
    for (let i = 1; i <= MAX_VOTES; i++) {
      const pip = document.createElement('div');
      pip.className = 'vote-token-pip';
      pip.id = `vote-token-${i}`;
      pip.title = `Vote Token ${i}`;
      el.votePipsRow.appendChild(pip);
    }
  }

  function renderVotePips(remainingVotes) {
    for (let i = 1; i <= MAX_VOTES; i++) {
      const token = document.getElementById(`vote-token-${i}`);
      if (!token) continue;
      if (i <= remainingVotes) {
        token.classList.remove('used');
      } else {
        token.classList.add('used');
      }
    }
  }

  function renderVotersList(volterVoters = [], turboVoters = []) {
    state.votes.volterVoters = volterVoters;
    state.votes.turboVoters = turboVoters;

    // Volter Voters
    if (!volterVoters || volterVoters.length === 0) {
      el.volterVotersList.innerHTML = '<span class="no-voters-msg">No votes yet</span>';
    } else {
      el.volterVotersList.innerHTML = volterVoters.map(v => 
        `<span class="voter-chip-pill volter-voter-chip">⚡ ${v.name || v}</span>`
      ).join('');
    }

    // Turbo Voters
    if (!turboVoters || turboVoters.length === 0) {
      el.turboVotersList.innerHTML = '<span class="no-voters-msg">No votes yet</span>';
    } else {
      el.turboVotersList.innerHTML = turboVoters.map(v => 
        `<span class="voter-chip-pill turbo-voter-chip">🔨 ${v.name || v}</span>`
      ).join('');
    }
  }

  // ============================================================================
  // HEALTH & DUAL DAMAGE PROCESSING
  // ============================================================================
  function updateHealthDisplay(newLives, damageDealt = 0, hitType = 'SMALL', rawVal = 0) {
    const prevLives = state.volterLives;
    state.volterLives = newLives;

    el.volterLivesDisplay.textContent = state.volterLives;

    // Dynamic color coding
    if (state.volterLives > 18) {
      el.volterLivesDisplay.style.color = '#34d399';
    } else if (state.volterLives > 8) {
      el.volterLivesDisplay.style.color = '#fbbf24';
    } else {
      el.volterLivesDisplay.style.color = '#ff385c';
    }

    const percent = Math.max(0, Math.min(100, (state.volterLives / MAX_LIVES) * 100));
    el.volterHealthBar.style.width = `${percent}%`;

    renderLifeMatrix(state.volterLives, prevLives);

    // Update status badge
    if (state.volterLives <= 0) {
      el.volterStatusBadge.textContent = 'DESTROYED';
      el.volterStatusBadge.className = 'badge-status destroyed';
    } else if (state.volterLives <= 8) {
      el.volterStatusBadge.textContent = 'CRITICAL FAILURE';
      el.volterStatusBadge.className = 'badge-status critical';
    } else if (state.volterLives <= 18) {
      el.volterStatusBadge.textContent = 'ARMOR BREACHED';
      el.volterStatusBadge.className = 'badge-status';
      el.volterStatusBadge.style.color = '#fbbf24';
      el.volterStatusBadge.style.borderColor = 'rgba(251, 191, 36, 0.4)';
    } else {
      el.volterStatusBadge.textContent = 'OPERATIONAL';
      el.volterStatusBadge.className = 'badge-status';
      el.volterStatusBadge.style.color = '#34d399';
      el.volterStatusBadge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    }

    // Impact reaction
    if (damageDealt > 0) {
      triggerImpactEffects(damageDealt, hitType, rawVal);
    }

    // Defeat
    if (state.volterLives <= 0 && !state.isGameOver) {
      triggerGameOver();
    }
  }

  function triggerImpactEffects(damage, hitType, rawVal) {
    state.totalHits += 1;
    el.totalSmashCount.textContent = state.totalHits;

    if (hitType === 'CRITICAL' || damage >= 3) {
      state.criticalHits += 1;
      el.critSmashCount.textContent = state.criticalHits;
      playSound('hammer-critical');
    } else {
      state.smallHits += 1;
      el.smallSmashCount.textContent = state.smallHits;
      playSound('hammer-small');
    }

    if (rawVal > state.peakAdc) {
      state.peakAdc = rawVal;
      el.highestImpactDisplay.textContent = rawVal;
    }

    // Screen Shake
    const isCrit = hitType === 'CRITICAL' || damage >= 3;
    const shakeClass = isCrit ? 'impact-shake-heavy' : 'impact-shake-normal';
    el.impactWrapper.classList.remove('impact-shake-normal', 'impact-shake-heavy');
    void el.impactWrapper.offsetWidth;
    el.impactWrapper.classList.add(shakeClass);
    setTimeout(() => el.impactWrapper.classList.remove(shakeClass), 380);

    // Canvas flash
    el.impactFlashOverlay.style.background = isCrit ? 'rgba(192, 132, 252, 0.45)' : 'rgba(255, 56, 92, 0.35)';
    el.impactFlashOverlay.style.opacity = '1';
    setTimeout(() => { el.impactFlashOverlay.style.opacity = '0'; }, 160);

    // Volter damage flash
    el.volterCard.classList.remove('volter-damaged');
    void el.volterCard.offsetWidth;
    el.volterCard.classList.add('volter-damaged');

    // Turbo hammer swing
    el.turboCard.classList.remove('turbo-hammer-swing');
    void el.turboCard.offsetWidth;
    el.turboCard.classList.add('turbo-hammer-swing');

    // Damage indicator pill
    el.damageReductionPill.textContent = isCrit ? `-3 CRITICAL!` : `-1 SMALL`;
    el.damageReductionPill.style.background = isCrit ? '#a855f7' : '#ff385c';
    el.damageReductionPill.classList.add('show');
    setTimeout(() => el.damageReductionPill.classList.remove('show'), 800);

    // Status callout
    if (isCrit) {
      el.impactStatusText.textContent = `💥 CRITICAL SMASH! ADC: ${rawVal} (-3 HP DEVASTATION)`;
      el.impactIcon.textContent = '💥';
      el.impactIcon.style.color = '#c084fc';
      addLogEntry('crit', `💥 [CRITICAL HIT] ADC: ${rawVal} | Volter: -3 HP (Remaining: ${state.volterLives}/30)`);
    } else {
      el.impactStatusText.textContent = `🔨 SMALL HIT! ADC: ${rawVal} (-1 HP)`;
      el.impactIcon.textContent = '🔨';
      el.impactIcon.style.color = '#ff385c';
      addLogEntry('hit', `🔨 [SMALL HIT] ADC: ${rawVal} | Volter: -1 HP (Remaining: ${state.volterLives}/30)`);
    }

    setTimeout(() => {
      if (!state.isGameOver) {
        el.impactStatusText.textContent = 'SAMPLING SENSOR AT 20,000+ READS/SEC...';
        el.impactIcon.textContent = '⚡';
        el.impactIcon.style.color = '#00f0ff';
      }
    }, 2000);
  }

  function triggerGameOver() {
    state.isGameOver = true;
    playSound('gameover');

    el.modalStrikes.textContent = state.totalHits;
    el.modalTime.textContent = el.matchTimer.textContent;

    let fav = 'TIED';
    if (state.votes.volter > state.votes.turbo) fav = 'VOLTER PRIME';
    else if (state.votes.turbo > state.votes.volter) fav = 'TURBO OD';
    el.modalFav.textContent = fav;

    el.gameOverModal.classList.add('active');
    addLogEntry('crit', `☠️ MATCH FINISHED: Turbo OD wins! Recorded to Match History.`);
  }

  function restartMatch() {
    el.gameOverModal.classList.remove('active');
    state.isGameOver = false;
    state.startTime = Date.now();
    state.totalHits = 0;
    state.smallHits = 0;
    state.criticalHits = 0;
    el.totalSmashCount.textContent = '0';
    el.smallSmashCount.textContent = '0';
    el.critSmashCount.textContent = '0';
    updateHealthDisplay(MAX_LIVES);
    playSound('restart');
    addLogEntry('system', `🔄 Match restarted! Ready for next round.`);
    sendWs({ action: 'RESET_MATCH', payload: { resetVotes: false } });
  }

  // ============================================================================
  // VOTING SYSTEM (WITH VOTER NAMES)
  // ============================================================================
  function updateVoteDisplay(volterVotes, turboVotes, remaining) {
    state.votes.volter = volterVotes;
    state.votes.turbo = turboVotes;
    state.votes.remaining = remaining;

    el.volterVoteCount.textContent = state.votes.volter;
    el.turboVoteCount.textContent = state.votes.turbo;
    el.votesRemainingText.textContent = state.votes.remaining;

    renderVotePips(state.votes.remaining);

    const totalCast = state.votes.volter + state.votes.turbo;
    let vPercent = 50;
    let tPercent = 50;
    if (totalCast > 0) {
      vPercent = Math.round((state.votes.volter / totalCast) * 100);
      tPercent = 100 - vPercent;
    }

    el.volterHypeBar.style.width = `${vPercent}%`;
    el.turboHypeBar.style.width = `${tPercent}%`;
    el.volterHypePercent.textContent = `${vPercent}%`;
    el.turboHypePercent.textContent = `${tPercent}%`;

    const noVotesLeft = state.votes.remaining <= 0;
    el.voteVolterBtn.disabled = noVotesLeft;
    el.voteTurboBtn.disabled = noVotesLeft;

    if (noVotesLeft) {
      el.voteVolterBtn.innerHTML = '<span>⚡</span> NO VOTES LEFT';
      el.voteTurboBtn.innerHTML = '<span>🔨</span> NO VOTES LEFT';
    } else {
      el.voteVolterBtn.innerHTML = '<span>⚡</span> VOTE VOLTER PRIME';
      el.voteTurboBtn.innerHTML = '<span>🔨</span> VOTE TURBO OD';
    }
  }

  function castVote(target) {
    if (state.votes.remaining <= 0) return;

    let voterName = el.voterNameInput.value.trim();
    if (!voterName) {
      el.voterNameInput.focus();
      el.voterNameInput.placeholder = '⚠️ Please enter your name first!';
      setTimeout(() => { el.voterNameInput.placeholder = 'Enter your name to cast vote...'; }, 2000);
      return;
    }

    playSound('vote');
    sendWs({ action: 'VOTE', payload: { target, voterName } });
    el.voterNameInput.value = ''; // clear for next voter
  }

  function resetVotes() {
    sendWs({ action: 'RESET_VOTES' });
    playSound('vote');
  }

  // ============================================================================
  // MATCH HISTORY SYSTEM
  // ============================================================================
  function renderMatchHistory(historyList = []) {
    state.matchHistory = historyList;
    el.historyNavCount.textContent = historyList.length;

    if (!historyList || historyList.length === 0) {
      el.historyListContainer.innerHTML = '<div class="empty-history-msg">No past matches recorded yet. Fight to create history!</div>';
      return;
    }

    el.historyListContainer.innerHTML = historyList.map(m => {
      const isTurbo = m.winner === 'TURBO OD';
      const winnerColor = isTurbo ? 'var(--turbo-cyan)' : 'var(--volter-red)';
      
      const volterVoterChips = (m.votes && m.votes.volterVoters && m.votes.volterVoters.length) 
        ? m.votes.volterVoters.map(v => `<span class="voter-chip-pill volter-voter-chip">⚡ ${v.name || v}</span>`).join('') 
        : '<span class="no-voters-msg">None</span>';
        
      const turboVoterChips = (m.votes && m.votes.turboVoters && m.votes.turboVoters.length) 
        ? m.votes.turboVoters.map(v => `<span class="voter-chip-pill turbo-voter-chip">🔨 ${v.name || v}</span>`).join('') 
        : '<span class="no-voters-msg">None</span>';

      return `
        <div class="history-match-card">
          <div class="match-card-top">
            <span class="match-number-tag">MATCH #${m.matchNumber || m.id}</span>
            <span class="match-date-tag">${m.date || ''} • ${m.time || ''}</span>
          </div>

          <div class="match-winner-row" style="color: ${winnerColor}">
            <span>🏆 WINNER: <strong>${m.winner}</strong></span>
          </div>

          <div class="match-stats-pills">
            <span class="mini-stat-pill">⏱ Duration: ${m.duration}</span>
            <span class="mini-stat-pill">🔨 Small Hits: ${m.smallHits || 0}</span>
            <span class="mini-stat-pill">💥 Critical Crushes: ${m.criticalHits || 0}</span>
            <span class="mini-stat-pill">⚡ Peak ADC: ${m.peakAdc || 0}</span>
          </div>

          <div class="match-voters-summary">
            <div><strong>Volter Voters (${m.votes ? m.votes.volterCount : 0}):</strong> ${volterVoterChips}</div>
            <div style="margin-top: 3px;"><strong>Turbo Voters (${m.votes ? m.votes.turboCount : 0}):</strong> ${turboVoterChips}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ============================================================================
  // ULTRA-SMOOTH OSCILLOSCOPE (DUAL THRESHOLD LINES & FREQUENCY METER)
  // ============================================================================
  const ctx = el.scopeCanvas.getContext('2d');
  let clientPacketCount = 0;
  let lastFreqCalcTime = Date.now();

  function updateScopeData(newVal, incomingHz = null) {
    state.currentAdc = newVal;
    el.liveAdcText.textContent = newVal;
    if (newVal > state.peakAdc) {
      state.peakAdc = newVal;
      el.highestImpactDisplay.textContent = newVal;
    }
    state.scopeData.push(newVal);
    state.scopeData.shift();

    // High-resolution readings per second (Hz) display
    clientPacketCount++;
    const now = Date.now();
    if (incomingHz !== null && incomingHz !== undefined && incomingHz > 0) {
      if (el.liveFrequency) el.liveFrequency.textContent = incomingHz;
    } else if (now - lastFreqCalcTime >= 1000) {
      if (el.liveFrequency) el.liveFrequency.textContent = clientPacketCount;
      clientPacketCount = 0;
      lastFreqCalcTime = now;
    }
  }

  function drawOscilloscope() {
    const width = el.scopeCanvas.width;
    const height = el.scopeCanvas.height;

    ctx.clearRect(0, 0, width, height);

    // Subtle grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < width; x += 40) {
      ctx.moveTo(x, 0); ctx.lineTo(x, height);
    }
    for (let y = 0; y < height; y += 26) {
      ctx.moveTo(0, y); ctx.lineTo(width, y);
    }
    ctx.stroke();

    // 1. Dotted Red Small Hit Threshold Line
    const threshY = height - (state.threshold / 4095) * (height - 20) - 10;
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, threshY);
    ctx.lineTo(width, threshY);
    ctx.stroke();

    // 2. Dotted Purple Critical Hit Threshold Line
    const critY = height - (state.critThreshold / 4095) * (height - 20) - 10;
    ctx.strokeStyle = 'rgba(192, 132, 252, 0.8)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, critY);
    ctx.lineTo(width, critY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Update tags
    el.thresholdMarkerTag.style.top = `${Math.max(4, Math.min(height - 20, threshY - 9))}px`;
    el.thresholdMarkerTag.textContent = `TH: ${state.threshold}`;

    el.critMarkerTag.style.top = `${Math.max(4, Math.min(height - 20, critY - 9))}px`;
    el.critMarkerTag.textContent = `CRIT: ${state.critThreshold}`;

    // Waveform Area Gradient Fill
    const sliceWidth = width / (state.scopeData.length - 1);
    const areaGrad = ctx.createLinearGradient(0, 0, 0, height);
    areaGrad.addColorStop(0, 'rgba(0, 240, 255, 0.22)');
    areaGrad.addColorStop(1, 'rgba(0, 240, 255, 0.0)');

    ctx.fillStyle = areaGrad;
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let i = 0; i < state.scopeData.length; i++) {
      const v = state.scopeData[i];
      const y = height - (v / 4095) * (height - 18) - 6;
      const x = i * sliceWidth;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();

    // Glowing Waveform Stroke
    ctx.strokeStyle = '#00f0ff';
    ctx.shadowColor = '#00f0ff';
    ctx.shadowBlur = 8;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (let i = 0; i < state.scopeData.length; i++) {
      const v = state.scopeData[i];
      const y = height - (v / 4095) * (height - 18) - 6;
      const x = i * sliceWidth;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    requestAnimationFrame(drawOscilloscope);
  }

  // ============================================================================
  // COMBAT LOG
  // ============================================================================
  function addLogEntry(type, text) {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}-entry`;
    const timeStr = new Date().toLocaleTimeString();
    entry.innerHTML = `<span class="log-time">[${timeStr}]</span> <span class="log-msg">${text}</span>`;
    el.combatLogList.prepend(entry);

    while (el.combatLogList.children.length > 50) {
      el.combatLogList.removeChild(el.combatLogList.lastChild);
    }
  }

  // ============================================================================
  // WEBSOCKET TELEMETRY
  // ============================================================================
  let socket = null;
  function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      el.statusDot.classList.remove('offline');
      el.portStatusText.textContent = 'COM10 ONLINE';
      addLogEntry('system', 'High-speed WebSocket uplink active.');
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch (e) {}
    };

    socket.onclose = () => {
      el.statusDot.classList.add('offline');
      el.portStatusText.textContent = 'RECONNECTING...';
      setTimeout(initWebSocket, 2000);
    };

    socket.onerror = (err) => console.warn('WS error', err);
  }

  function sendWs(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  function handleServerMessage(msg) {
    const { type, data } = msg;

    if (type === 'STATE_UPDATE') {
      if (data.volter) updateHealthDisplay(data.volter.lives);
      if (data.votes) {
        updateVoteDisplay(data.votes.volterPrime, data.votes.turboOD, data.votes.remainingVotes);
        renderVotersList(data.votes.volterVoters, data.votes.turboVoters);
      }
      if (data.match) {
        state.smallHits = data.match.smallHits || 0;
        state.criticalHits = data.match.criticalHits || 0;
        state.totalHits = data.match.totalHits || 0;
        el.smallSmashCount.textContent = state.smallHits;
        el.critSmashCount.textContent = state.criticalHits;
        el.totalSmashCount.textContent = state.totalHits;

        state.isGameOver = data.match.isGameOver;
        if (state.isGameOver) el.gameOverModal.classList.add('active');
        else el.gameOverModal.classList.remove('active');
      }
      if (data.matchHistory) {
        renderMatchHistory(data.matchHistory);
      }
      if (data.telemetry) {
        state.threshold = data.telemetry.hitThreshold || 850;
        state.critThreshold = data.telemetry.critThreshold || 1600;
        el.threshSlider.value = state.threshold;
        el.threshValueLabel.textContent = state.threshold;
        el.critSlider.value = state.critThreshold;
        el.critValueLabel.textContent = state.critThreshold;

        if (data.telemetry.baudRate) {
          document.querySelectorAll('.baud-btn').forEach(b => {
            if (parseInt(b.dataset.baud, 10) === data.telemetry.baudRate) {
              b.classList.add('active');
            } else {
              b.classList.remove('active');
            }
          });
        }

        if (data.telemetry.isConnected) {
          el.statusDot.classList.remove('offline');
          el.portStatusText.textContent = `${data.telemetry.port} ONLINE (${data.telemetry.baudRate || 115200})`;
        } else {
          el.statusDot.classList.add('offline');
          el.portStatusText.textContent = `${data.telemetry.port} OFFLINE`;
        }

        // Wireless Wi-Fi Link Indicator
        if (el.wifiStatusDot && el.wifiStatusText) {
          if (data.telemetry.isWirelessConnected) {
            el.wifiStatusDot.classList.remove('offline');
            el.wifiStatusDot.classList.add('pulse');
            el.wifiStatusText.textContent = data.telemetry.wirelessMode || 'WI-FI ONLINE';
          } else {
            el.wifiStatusDot.classList.add('offline');
            el.wifiStatusDot.classList.remove('pulse');
            el.wifiStatusText.textContent = 'WI-FI STANDBY';
          }
        }
      }
    }
    else if (type === 'HIT_EVENT') {
      if (data.smallHits !== undefined) el.smallSmashCount.textContent = data.smallHits;
      if (data.criticalHits !== undefined) el.critSmashCount.textContent = data.criticalHits;
      if (data.totalHits !== undefined) el.totalSmashCount.textContent = data.totalHits;
      updateHealthDisplay(data.livesRemaining, data.damage, data.hitType, data.rawVal);
    }
    else if (type === 'TELEMETRY_DATA') {
      updateScopeData(data.val, data.hz);
    }
    else if (type === 'FREQUENCY_UPDATE') {
      if (el.liveFrequency && data && data.hz !== undefined) {
        el.liveFrequency.textContent = data.hz;
      }
    }
    else if (type === 'MATCH_HISTORY_UPDATE') {
      renderMatchHistory(data);
    }
  }

  // ============================================================================
  // DIRECT BROWSER WEB SERIAL LINK
  // ============================================================================
  let webSerialPort = null;
  async function connectWebSerial() {
    if (!('serial' in navigator)) {
      alert('Web Serial API is not supported in this browser. Please use Chrome or Edge.');
      return;
    }

    try {
      webSerialPort = await navigator.serial.requestPort();
      await webSerialPort.open({ baudRate: 9600 });
      el.statusDot.classList.remove('offline');
      el.portStatusText.textContent = 'WEB SERIAL LINKED';
      addLogEntry('system', 'Web Serial connected directly from browser!');
      el.configModal.classList.remove('active');

      const textDecoder = new TextDecoderStream();
      webSerialPort.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable.getReader();

      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          buffer += value;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop();
          for (const line of lines) {
            parseDirectSerialLine(line.trim());
          }
        }
      }
    } catch (err) {
      alert('Web Serial error: ' + err.message);
    }
  }

  function parseDirectSerialLine(line) {
    if (!line) return;
    sendWs({ action: 'WEB_SERIAL_DATA', payload: { line } });

    // C:<val>
    const cMatch = line.match(/^C:(\d+)/i);
    if (cMatch) {
      const val = parseInt(cMatch[1], 10);
      updateScopeData(val);
      updateHealthDisplay(Math.max(0, state.volterLives - 3), 3, 'CRITICAL', val);
      return;
    }

    // S:<val>
    const sMatch = line.match(/^S:(\d+)/i);
    if (sMatch) {
      const val = parseInt(sMatch[1], 10);
      updateScopeData(val);
      updateHealthDisplay(Math.max(0, state.volterLives - 1), 1, 'SMALL', val);
      return;
    }

    // Analog: <val>
    const analogMatch = line.match(/^Analog:\s*(\d+)/i);
    if (analogMatch) {
      const val = parseInt(analogMatch[1], 10);
      updateScopeData(val);
      if (val >= state.critThreshold) {
        updateHealthDisplay(Math.max(0, state.volterLives - 3), 3, 'CRITICAL', val);
      } else if (val >= state.threshold) {
        updateHealthDisplay(Math.max(0, state.volterLives - 1), 1, 'SMALL', val);
      }
    }
  }

  // ============================================================================
  // MATCH TIMER
  // ============================================================================
  function updateTimer() {
    if (state.isGameOver) return;
    const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    el.matchTimer.textContent = `${mins}:${secs}`;
  }
  setInterval(updateTimer, 1000);

  // ============================================================================
  // EVENT LISTENERS & UI BINDINGS
  // ============================================================================
  function setupEventListeners() {
    // Voting with Name
    el.voteVolterBtn.addEventListener('click', () => castVote('volter'));
    el.voteTurboBtn.addEventListener('click', () => castVote('turbo'));
    el.resetVotesBtn.addEventListener('click', resetVotes);

    el.voterNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        castVote('volter');
      }
    });

    // Simulation Tools: Small (-1) and Critical (-3)
    el.testStrikeBtn.addEventListener('click', () => {
      sendWs({ action: 'SIMULATE_HIT', payload: { damage: 1, val: 120, type: 'SMALL' } });
    });
    el.testCritBtn.addEventListener('click', () => {
      sendWs({ action: 'SIMULATE_HIT', payload: { damage: 3, val: 380, type: 'CRITICAL' } });
    });
    el.resetMatchBtn.addEventListener('click', restartMatch);
    el.rematchBtn.addEventListener('click', restartMatch);

    // Quick Sensitivity Presets Strip
    document.querySelectorAll('.sens-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sens-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const newSmall = parseInt(btn.dataset.sens, 10);
        const newCrit = parseInt(btn.dataset.crit, 10);
        state.threshold = newSmall;
        state.critThreshold = newCrit;
        el.threshSlider.value = newSmall;
        el.threshValueLabel.textContent = newSmall;
        el.critSlider.value = newCrit;
        el.critValueLabel.textContent = newCrit;
        sendWs({ action: 'SET_THRESHOLD', payload: { threshold: newSmall, critThreshold: newCrit } });
        addLogEntry('system', `Thresholds updated: Small: ${newSmall} ADC | Crit: ${newCrit} ADC`);
      });
    });

    // Audio SFX toggle
    el.soundToggleBtn.addEventListener('click', () => {
      state.soundEnabled = !state.soundEnabled;
      el.soundIcon.textContent = state.soundEnabled ? '🔊' : '🔇';
    });

    // Fullscreen toggle
    el.fullscreenBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    // Match History Dialog
    el.historyToggleBtn.addEventListener('click', () => el.historyModal.classList.add('active'));
    el.closeHistoryBtn.addEventListener('click', () => el.historyModal.classList.remove('active'));
    el.historyModal.addEventListener('click', (e) => {
      if (e.target === el.historyModal) el.historyModal.classList.remove('active');
    });

    el.clearHistoryBtn.addEventListener('click', () => {
      if (confirm('Clear all recorded match history?')) {
        sendWs({ action: 'CLEAR_HISTORY' });
      }
    });

    // Clear combat log
    el.clearLogBtn.addEventListener('click', () => {
      el.combatLogList.innerHTML = '';
      addLogEntry('system', 'Combat log cleared.');
    });

    // Config Dialog
    el.configToggleBtn.addEventListener('click', () => el.configModal.classList.add('active'));
    el.closeConfigBtn.addEventListener('click', () => el.configModal.classList.remove('active'));
    el.configModal.addEventListener('click', (e) => {
      if (e.target === el.configModal) el.configModal.classList.remove('active');
    });

    // Port connect button
    el.applyPortBtn.addEventListener('click', () => {
      const port = el.portInput.value.trim();
      if (port) {
        sendWs({ action: 'CONNECT_PORT', payload: { port, baud: 9600 } });
        el.configModal.classList.remove('active');
      }
    });

    // Web Serial connect
    el.webSerialConnectBtn.addEventListener('click', connectWebSerial);

    // Baud Rate Switchers
    document.querySelectorAll('.baud-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.baud-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const baud = parseInt(btn.dataset.baud, 10);
        sendWs({ action: 'SET_BAUD', payload: { baud } });
        addLogEntry('system', `Hardware baud rate switched to ${baud} BAUD`);
      });
    });

    // Threshold Sliders
    el.threshSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      state.threshold = val;
      el.threshValueLabel.textContent = val;
      sendWs({ action: 'SET_THRESHOLD', payload: { threshold: val, critThreshold: state.critThreshold } });
    });

    el.critSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      state.critThreshold = val;
      el.critValueLabel.textContent = val;
      sendWs({ action: 'SET_THRESHOLD', payload: { threshold: state.threshold, critThreshold: val } });
    });
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================
  function init() {
    init30LifeNodes();
    initVotePips();
    updateHealthDisplay(MAX_LIVES);
    updateVoteDisplay(0, 0, MAX_VOTES);
    setupEventListeners();
    initWebSocket();
    requestAnimationFrame(drawOscilloscope);
  }

  window.addEventListener('DOMContentLoaded', init);

})();
