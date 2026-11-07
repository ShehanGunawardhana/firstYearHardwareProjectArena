const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const { WebSocketServer, WebSocket } = require('ws');
let SerialPortPackage = null;
try {
  SerialPortPackage = require('serialport');
} catch (e) {
  console.warn('[SERIAL] serialport module not available, running in virtual mode.');
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const UDP_PORT = parseInt(process.env.UDP_PORT || '41234', 10);
let TARGET_COM_PORT = process.env.SERIAL_PORT || 'COM10';
let BAUD_RATE = parseInt(process.env.BAUD_RATE || '115200', 10);
const HISTORY_FILE = path.join(__dirname, 'match_history.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load persisted match history
let matchHistory = [];
try {
  if (fs.existsSync(HISTORY_FILE)) {
    matchHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (!Array.isArray(matchHistory)) matchHistory = [];
  }
} catch (err) {
  console.warn('[HISTORY] Could not load match history file:', err.message);
  matchHistory = [];
}

function saveMatchHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(matchHistory, null, 2), 'utf8');
  } catch (err) {
    console.error('[HISTORY] Error saving history:', err.message);
  }
}

// ==========================================
// GAME & BATTLE ARENA STATE
// ==========================================
const MAX_LIVES = 30;
const MAX_VOTES = 10;

let battleState = {
  volter: {
    name: 'VOLTER PRIME',
    weapon: 'HYDRAULIC FLIPPER',
    color: '#ff385c',
    lives: MAX_LIVES,
    maxLives: MAX_LIVES,
    status: 'OPERATIONAL'
  },
  turbo: {
    name: 'TURBO OD',
    weapon: 'KINETIC HAMMER',
    color: '#00f0ff',
    status: 'ACTIVE'
  },
  votes: {
    volterPrime: 0,
    turboOD: 0,
    remainingVotes: MAX_VOTES,
    totalPool: MAX_VOTES,
    volterVoters: [], // Array of { name, time }
    turboVoters: []   // Array of { name, time }
  },
  telemetry: {
    lastAnalog: 0,
    peakAnalog: 0,
    hitThreshold: 850,   // Small Damage trigger (calibrated for real-world ESP32 noise floor ~440 ADC)
    critThreshold: 1600, // Critical Damage trigger (heavy kinetic hammer smash)
    cooldownMs: 250,     // 250ms refractory debounce to prevent rapid multi-hits from single strikes
    port: TARGET_COM_PORT,
    baudRate: BAUD_RATE,
    isConnected: false,
    statusMsg: 'Connecting to ' + TARGET_COM_PORT + '...',
    isWirelessConnected: false,
    wirelessMode: 'STANDBY',
    wirelessClientIp: null,
    lastWirelessTime: 0,
    udpPort: UDP_PORT
  },
  match: {
    matchNumber: matchHistory.length + 1,
    isGameOver: false,
    winner: null,
    totalHits: 0,
    smallHits: 0,
    criticalHits: 0,
    startTime: Date.now()
  },
  events: []
};

function addEvent(type, text, details = {}) {
  const event = {
    id: Date.now() + Math.random().toString(36).substring(2, 6),
    time: new Date().toLocaleTimeString(),
    type,
    text,
    details
  };
  battleState.events.unshift(event);
  if (battleState.events.length > 50) battleState.events.pop();
  return event;
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function broadcastFullState() {
  broadcast('STATE_UPDATE', {
    ...battleState,
    matchHistory
  });
}

// ==========================================
// DUAL DAMAGE IMPACT SYSTEM (SMALL & CRITICAL)
// ==========================================
let lastHitTimestamp = 0;

function registerHit(rawVal, forcedDamage = null, forcedType = null) {
  const now = Date.now();
  // Strictly enforce cooldown debounce on ALL hits to stop rapid health drain!
  if (now - lastHitTimestamp < battleState.telemetry.cooldownMs) {
    return; // Refractory debounce
  }
  lastHitTimestamp = now;

  let damage = forcedDamage;
  let hitType = forcedType;

  if (!damage) {
    if (rawVal >= battleState.telemetry.critThreshold) {
      damage = 3;
      hitType = 'CRITICAL';
    } else {
      damage = 1;
      hitType = 'SMALL';
    }
  }

  if (battleState.match.isGameOver) return;

  battleState.volter.lives = Math.max(0, battleState.volter.lives - damage);
  battleState.match.totalHits += 1;

  if (hitType === 'CRITICAL' || damage >= 3) {
    battleState.match.criticalHits += 1;
    addEvent('CRITICAL', `💥 CRITICAL HAMMER CRUSH! ADC: ${rawVal} | -${damage} HP | Volter Lives: ${battleState.volter.lives}/${MAX_LIVES}`, { rawVal, damage });
  } else {
    battleState.match.smallHits += 1;
    addEvent('HIT', `🔨 Small Damage Hit! ADC: ${rawVal} | -${damage} HP | Volter Lives: ${battleState.volter.lives}/${MAX_LIVES}`, { rawVal, damage });
  }

  // Update Volter status badge
  if (battleState.volter.lives <= 0) {
    battleState.volter.lives = 0;
    battleState.volter.status = 'DESTROYED';
    battleState.match.isGameOver = true;
    battleState.match.winner = 'TURBO OD';
    addEvent('CRITICAL', `☠️ VOLTER PRIME DESTROYED! TURBO OD EMERGES VICTORIOUS!`);

    // Record into match history
    recordMatchOutcome('TURBO OD');
  } else if (battleState.volter.lives <= 8) {
    battleState.volter.status = 'CRITICAL INTEGRITY';
  } else if (battleState.volter.lives <= 18) {
    battleState.volter.status = 'ARMOR BREACHED';
  }

  broadcast('HIT_EVENT', {
    rawVal,
    damage,
    hitType: hitType || (damage >= 3 ? 'CRITICAL' : 'SMALL'),
    livesRemaining: battleState.volter.lives,
    maxLives: MAX_LIVES,
    isGameOver: battleState.match.isGameOver,
    winner: battleState.match.winner,
    status: battleState.volter.status,
    smallHits: battleState.match.smallHits,
    criticalHits: battleState.match.criticalHits,
    totalHits: battleState.match.totalHits
  });
}

function recordMatchOutcome(winner) {
  const elapsedSec = Math.floor((Date.now() - battleState.match.startTime) / 1000);
  const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
  const secs = String(elapsedSec % 60).padStart(2, '0');

  const historyEntry = {
    id: matchHistory.length + 1,
    matchNumber: battleState.match.matchNumber,
    date: new Date().toLocaleDateString(),
    time: new Date().toLocaleTimeString(),
    duration: `${mins}:${secs}`,
    winner: winner,
    loser: winner === 'TURBO OD' ? 'VOLTER PRIME' : 'TURBO OD',
    finalVolterLives: battleState.volter.lives,
    totalHits: battleState.match.totalHits,
    smallHits: battleState.match.smallHits,
    criticalHits: battleState.match.criticalHits,
    peakAdc: battleState.telemetry.peakAnalog,
    votes: {
      volterCount: battleState.votes.volterPrime,
      turboCount: battleState.votes.turboOD,
      volterVoters: [...battleState.votes.volterVoters],
      turboVoters: [...battleState.votes.turboVoters]
    }
  };

  matchHistory.unshift(historyEntry);
  if (matchHistory.length > 30) matchHistory.pop();
  saveMatchHistory();
  broadcast('MATCH_HISTORY_UPDATE', matchHistory);
}

// ==========================================
// SERIAL PORT CONNECTION MANAGER
// ==========================================
let serialPortInstance = null;
let serialLineBuffer = '';

function connectSerialPort(portName, baud = BAUD_RATE) {
  if (!SerialPortPackage) {
    battleState.telemetry.statusMsg = 'Running in Virtual / Web Serial mode.';
    battleState.telemetry.isConnected = false;
    broadcastFullState();
    return;
  }

  if (serialPortInstance && serialPortInstance.isOpen) {
    try { serialPortInstance.close(); } catch (e) {}
  }

  TARGET_COM_PORT = portName;
  BAUD_RATE = baud;
  battleState.telemetry.port = portName;
  battleState.telemetry.baudRate = baud;
  battleState.telemetry.statusMsg = `Connecting to ${portName}...`;
  battleState.telemetry.isConnected = false;
  broadcastFullState();

  try {
    serialPortInstance = new SerialPortPackage.SerialPort({
      path: portName,
      baudRate: baud,
      autoOpen: false
    });

    serialPortInstance.open((err) => {
      if (err) {
        console.warn(`[SERIAL] Failed to open ${portName}:`, err.message);
        battleState.telemetry.isConnected = false;
        battleState.telemetry.statusMsg = `Port ${portName} unavailable: ${err.message}`;
        broadcastFullState();
        return;
      }

      console.log(`[SERIAL] Connected to ${portName} at ${baud} baud!`);
      battleState.telemetry.isConnected = true;
      battleState.telemetry.statusMsg = `Connected to ${portName} @ ${baud} BAUD`;
      addEvent('SYSTEM', `Serial link established on ${portName} [High-Speed Telemetry Active]`);
      broadcastFullState();
    });

    serialPortInstance.on('data', (chunk) => {
      serialLineBuffer += chunk.toString('utf8');
      const lines = serialLineBuffer.split(/\r?\n/);
      serialLineBuffer = lines.pop();

      for (const line of lines) {
        handleSerialLine(line.trim());
      }
    });

    serialPortInstance.on('error', (err) => {
      battleState.telemetry.isConnected = false;
      battleState.telemetry.statusMsg = `Serial Error: ${err.message}`;
      broadcastFullState();
    });

    serialPortInstance.on('close', () => {
      battleState.telemetry.isConnected = false;
      battleState.telemetry.statusMsg = `Disconnected from ${portName}`;
      broadcastFullState();
    });

  } catch (err) {
    battleState.telemetry.isConnected = false;
    battleState.telemetry.statusMsg = `Exception: ${err.message}`;
    broadcastFullState();
  }
}

// ==========================================
// WIRELESS WI-FI UDP RECEIVER MANAGER
// ==========================================
let udpServer = null;

try {
  udpServer = dgram.createSocket('udp4');

  udpServer.on('error', (err) => {
    console.warn('[UDP] Error:', err.message);
  });

  udpServer.on('message', (msg, rinfo) => {
    const text = msg.toString('utf8');
    const lines = text.split(/\r?\n/);

    const now = Date.now();
    if (!battleState.telemetry.isWirelessConnected) {
      battleState.telemetry.isWirelessConnected = true;
      battleState.telemetry.wirelessMode = `Wi-Fi (${rinfo.address})`;
      battleState.telemetry.wirelessClientIp = rinfo.address;
      addEvent('SYSTEM', `📡 Robot Wi-Fi Link Established with ${rinfo.address}!`);
      broadcastFullState();
    }
    battleState.telemetry.lastWirelessTime = now;
    battleState.telemetry.wirelessClientIp = rinfo.address;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        handleSerialLine(trimmed);
      }
    }
  });

  udpServer.bind(UDP_PORT, '0.0.0.0', () => {
    console.log(`[WIRELESS] 📡 UDP Receiver listening on 0.0.0.0:${UDP_PORT} (Wi-Fi Ready)`);
  });
} catch (err) {
  console.warn('[WIRELESS] Could not initialize UDP socket:', err.message);
}

// Wireless heartbeat watchdog (marks standby if no wireless packet in 4 seconds)
setInterval(() => {
  if (battleState.telemetry.isWirelessConnected && Date.now() - battleState.telemetry.lastWirelessTime > 4000) {
    battleState.telemetry.isWirelessConnected = false;
    battleState.telemetry.wirelessMode = 'STANDBY';
    addEvent('SYSTEM', '📡 Wireless link standby (no UDP packets).');
    broadcastFullState();
  }
}, 2000);

// Parse high-speed lines from ESP32
function handleSerialLine(line) {
  if (!line) return;

  // 1. High-speed compact packets: "C:<val>" (Critical) or "S:<val>" (Small)
  const critMatch = line.match(/^C:(\d+)/i);
  if (critMatch) {
    const val = parseInt(critMatch[1], 10);
    processRawReading(val, false);
    registerHit(val, 3, 'CRITICAL');
    return;
  }

  const smallMatch = line.match(/^S:(\d+)/i);
  if (smallMatch) {
    const val = parseInt(smallMatch[1], 10);
    processRawReading(val, false);
    registerHit(val, 1, 'SMALL');
    return;
  }

  // 2. High-speed analog waveform packet: "A:<val>"
  const aMatch = line.match(/^A:(\d+)/i);
  if (aMatch) {
    const val = parseInt(aMatch[1], 10);
    processRawReading(val, true);
    return;
  }

  // 3. JSON format
  if (line.startsWith('{') && line.endsWith('}')) {
    try {
      const data = JSON.parse(line);
      if (data.event === 'HIT') {
        const val = data.val || 100;
        const dmg = data.type === 'CRITICAL' || data.damage >= 3 ? 3 : 1;
        const type = dmg === 3 ? 'CRITICAL' : 'SMALL';
        processRawReading(val, false);
        registerHit(val, dmg, type);
        return;
      }
      if (data.val !== undefined || data.raw !== undefined) {
        processRawReading(data.val || data.raw, true);
        return;
      }
    } catch (e) {}
  }

  // 4. Backward-compatible text: "CRITICAL_HIT: <val>" or "SMALL_HIT: <val>"
  const critTextMatch = line.match(/^(?:CRITICAL_HIT|CRIT):\s*(\d+)/i);
  if (critTextMatch) {
    const val = parseInt(critTextMatch[1], 10);
    processRawReading(val, false);
    registerHit(val, 3, 'CRITICAL');
    return;
  }

  const smallTextMatch = line.match(/^(?:SMALL_HIT|HIT):\s*(\d+)/i);
  if (smallTextMatch) {
    const val = parseInt(smallTextMatch[1], 10);
    processRawReading(val, false);
    registerHit(val, 1, 'SMALL');
    return;
  }

  // 5. "Analog: <val>"
  const analogMatch = line.match(/^Analog:\s*(\d+)/i);
  if (analogMatch) {
    const val = parseInt(analogMatch[1], 10);
    processRawReading(val, true);
    return;
  }

  // 6. Raw integer
  if (/^\d+$/.test(line)) {
    const val = parseInt(line, 10);
    processRawReading(val, true);
  }
}

let serverBaseline = 440.0;
let readingCountThisSecond = 0;
let currentReadsPerSec = 0;

// High-speed frequency calculation (updates Hz every second)
setInterval(() => {
  currentReadsPerSec = readingCountThisSecond;
  readingCountThisSecond = 0;
  broadcast('FREQUENCY_UPDATE', { hz: currentReadsPerSec });
}, 1000);

function processRawReading(val, checkThresholds = true) {
  readingCountThisSecond++;
  battleState.telemetry.lastAnalog = val;
  if (val > battleState.telemetry.peakAnalog) {
    battleState.telemetry.peakAnalog = val;
  }

  // Rolling baseline tracking during quiet states
  if (val < battleState.telemetry.hitThreshold - 100) {
    serverBaseline = (serverBaseline * 127.0 + val) / 128.0;
  }

  // Check thresholds with dynamic dual-layer verification (absolute & net spike)
  if (checkThresholds) {
    const netDelta = val - Math.round(serverBaseline);
    const smallDelta = Math.max(350, battleState.telemetry.hitThreshold - Math.round(serverBaseline));
    const critDelta = Math.max(1000, battleState.telemetry.critThreshold - Math.round(serverBaseline));

    if (val >= battleState.telemetry.critThreshold || netDelta >= critDelta) {
      registerHit(val, 3, 'CRITICAL');
    } else if (val >= battleState.telemetry.hitThreshold || netDelta >= smallDelta) {
      registerHit(val, 1, 'SMALL');
    }
  }

  // Broadcast waveform point for smooth oscilloscope with real-time Hz
  broadcast('TELEMETRY_DATA', {
    val,
    peak: battleState.telemetry.peakAnalog,
    baseline: Math.round(serverBaseline),
    smallThreshold: battleState.telemetry.hitThreshold,
    critThreshold: battleState.telemetry.critThreshold,
    hz: currentReadsPerSec,
    time: Date.now()
  });
}

// ==========================================
// REST API ROUTES
// ==========================================
app.get('/api/state', (req, res) => {
  res.json({ ...battleState, matchHistory });
});

app.get('/api/history', (req, res) => {
  res.json(matchHistory);
});

app.post('/api/history/clear', (req, res) => {
  matchHistory = [];
  saveMatchHistory();
  broadcast('MATCH_HISTORY_UPDATE', matchHistory);
  res.json({ success: true, message: 'Match history cleared' });
});

app.post('/api/vote', (req, res) => {
  const { target, voterName } = req.body;
  if (battleState.votes.remainingVotes <= 0) {
    return res.status(400).json({ error: 'No votes remaining! (10/10 cast)' });
  }

  const name = voterName ? String(voterName).trim().substring(0, 25) : 'Anonymous';

  if (target === 'volter') {
    battleState.votes.volterPrime += 1;
    battleState.votes.remainingVotes -= 1;
    battleState.votes.volterVoters.push({ name, time: new Date().toLocaleTimeString() });
    addEvent('VOTE', `⚡ ${name} cast a fan vote for VOLTER PRIME! [${battleState.votes.remainingVotes} left]`);
  } else if (target === 'turbo') {
    battleState.votes.turboOD += 1;
    battleState.votes.remainingVotes -= 1;
    battleState.votes.turboVoters.push({ name, time: new Date().toLocaleTimeString() });
    addEvent('VOTE', `🔨 ${name} cast a fan vote for TURBO OD! [${battleState.votes.remainingVotes} left]`);
  } else {
    return res.status(400).json({ error: 'Invalid target' });
  }

  broadcastFullState();
  res.json({ success: true, votes: battleState.votes });
});

app.post('/api/reset-match', (req, res) => {
  const { resetVotes } = req.body || {};
  battleState.volter.lives = MAX_LIVES;
  battleState.volter.status = 'OPERATIONAL';
  battleState.match.isGameOver = false;
  battleState.match.winner = null;
  battleState.match.totalHits = 0;
  battleState.match.smallHits = 0;
  battleState.match.criticalHits = 0;
  battleState.match.startTime = Date.now();
  battleState.match.matchNumber = matchHistory.length + 1;
  battleState.telemetry.peakAnalog = 0;

  if (resetVotes) {
    battleState.votes.volterPrime = 0;
    battleState.votes.turboOD = 0;
    battleState.votes.remainingVotes = MAX_VOTES;
    battleState.votes.volterVoters = [];
    battleState.votes.turboVoters = [];
  }

  addEvent('SYSTEM', `🔄 MATCH RESTARTED! Volter Prime full health restored (30/30 HP)!`);
  broadcastFullState();
  res.json({ success: true, battleState });
});

// ==========================================
// WEBSOCKET HANDLERS
// ==========================================
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'STATE_UPDATE', data: { ...battleState, matchHistory } }));

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message);
      const { action, payload } = parsed;

      switch (action) {
        case 'VOTE': {
          if (battleState.votes.remainingVotes > 0) {
            const name = payload.voterName ? String(payload.voterName).trim().substring(0, 25) : 'Anonymous';
            if (payload.target === 'volter') {
              battleState.votes.volterPrime += 1;
              battleState.votes.remainingVotes -= 1;
              battleState.votes.volterVoters.push({ name, time: new Date().toLocaleTimeString() });
              addEvent('VOTE', `⚡ ${name} voted for VOLTER PRIME! [Remaining: ${battleState.votes.remainingVotes}]`);
            } else if (payload.target === 'turbo') {
              battleState.votes.turboOD += 1;
              battleState.votes.remainingVotes -= 1;
              battleState.votes.turboVoters.push({ name, time: new Date().toLocaleTimeString() });
              addEvent('VOTE', `🔨 ${name} voted for TURBO OD! [Remaining: ${battleState.votes.remainingVotes}]`);
            }
            broadcastFullState();
          }
          break;
        }

        case 'RESET_VOTES': {
          battleState.votes.volterPrime = 0;
          battleState.votes.turboOD = 0;
          battleState.votes.remainingVotes = MAX_VOTES;
          battleState.votes.volterVoters = [];
          battleState.votes.turboVoters = [];
          addEvent('SYSTEM', `🗳️ Voting pool & voter list reset (10 votes available).`);
          broadcastFullState();
          break;
        }

        case 'RESET_MATCH': {
          battleState.volter.lives = MAX_LIVES;
          battleState.volter.status = 'OPERATIONAL';
          battleState.match.isGameOver = false;
          battleState.match.winner = null;
          battleState.match.totalHits = 0;
          battleState.match.smallHits = 0;
          battleState.match.criticalHits = 0;
          battleState.match.startTime = Date.now();
          battleState.match.matchNumber = matchHistory.length + 1;
          if (payload && payload.resetVotes) {
            battleState.votes.volterPrime = 0;
            battleState.votes.turboOD = 0;
            battleState.votes.remainingVotes = MAX_VOTES;
            battleState.votes.volterVoters = [];
            battleState.votes.turboVoters = [];
          }
          addEvent('SYSTEM', `⚔️ ARENA READY: Match #${battleState.match.matchNumber} started.`);
          broadcastFullState();
          break;
        }

        case 'SIMULATE_HIT': {
          const dmg = payload.damage || 1;
          const val = payload.val || 120;
          const type = payload.type || (dmg >= 3 ? 'CRITICAL' : 'SMALL');
          processRawReading(val, false);
          registerHit(val, dmg, type);
          break;
        }

        case 'WEB_SERIAL_DATA': {
          if (payload && payload.line) {
            handleSerialLine(payload.line);
          } else if (payload && payload.val !== undefined) {
            processRawReading(payload.val, true);
          }
          break;
        }

        case 'SET_THRESHOLD': {
          if (payload && payload.threshold) {
            battleState.telemetry.hitThreshold = parseInt(payload.threshold, 10);
            if (payload.critThreshold) {
              battleState.telemetry.critThreshold = parseInt(payload.critThreshold, 10);
            }
            addEvent('CONFIG', `Small hit threshold: ${battleState.telemetry.hitThreshold} ADC | Critical threshold: ${battleState.telemetry.critThreshold} ADC`);
            broadcastFullState();
          }
          break;
        }

        case 'CONNECT_PORT': {
          if (payload && payload.port) {
            connectSerialPort(payload.port, payload.baud || BAUD_RATE);
          }
          break;
        }

        case 'SET_BAUD': {
          if (payload && payload.baud) {
            connectSerialPort(TARGET_COM_PORT, parseInt(payload.baud, 10));
          }
          break;
        }

        case 'CLEAR_HISTORY': {
          matchHistory = [];
          saveMatchHistory();
          broadcast('MATCH_HISTORY_UPDATE', matchHistory);
          break;
        }
      }
    } catch (err) {
      console.error('[WS ERROR]', err);
    }
  });
});

connectSerialPort(TARGET_COM_PORT, BAUD_RATE);

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`⚔️  STEEL CLASH ARENA SERVER LIVE ON PORT ${PORT}  ⚔️`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`🔌 Target Serial Port: ${TARGET_COM_PORT} @ ${BAUD_RATE} baud`);
  console.log(`📊 Loaded ${matchHistory.length} match records from history`);
  console.log(`=======================================================`);
});
