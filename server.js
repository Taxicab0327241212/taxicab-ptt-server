/**
 * Taxicab PTT — Serveur WebSocket v4
 * Variables d'environnement :
 *   PTT_CODE      → code d'accès requis (vide = pas de code)
 *   TAXICAB_URL   → URL de base Infomaniak (défaut: https://taxicab.ch)
 */

const WebSocket = require('ws');

const PORT        = process.env.PORT || 3000;
const ACCESS_CODE = process.env.PTT_CODE || '';
const API_BASE    = (process.env.TAXICAB_URL || 'https://taxicab.ch').replace(/\/$/, '');

/* ── Helpers API Infomaniak ───────────────────────────────── */
function apiPost(path, body) {
  if (!ACCESS_CODE) return;
  fetch(API_BASE + path, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ptt_code: ACCESS_CODE, ...body })
  }).catch(() => {}); // silencieux — ne jamais bloquer le WS
}

const wss      = new WebSocket.Server({ port: PORT });
const channels = new Map(); // Map<channelId, Map<ws, {userId, status, listenOnly}>>

/* ── Message cache (hors-ligne) ──────────────────────────── */
// msgCache[channelId] = [{msgId, userId, ts, buffer}]
const msgCache  = new Map();
const MSG_MAX   = 3;           // max 3 messages par canal
const MSG_TTL   = 3 * 60_000; // 3 minutes

/* ── Compteurs globaux ────────────────────────────────────── */
let globalMsgId = 0; // compteur incrémental de msgId

/* ── File d'attente PTT ───────────────────────────────────── */
// speakQ[channelId] = [ws, ...]
const speakQ = new Map();

/* ── Haut-parleur actif par canal ────────────────────────── */
// channelSpeaker[channelId] = ws | null
const channelSpeaker = new Map();

/* ── Accusés de réception ─────────────────────────────────── */
// ackCounts[msgId] = count
const ackCounts = new Map();

/* ── Helpers ─────────────────────────────────────────────── */
function getMembers(channelId) {
  const ch = channels.get(channelId);
  if (!ch) return [];
  return Array.from(ch.values()).filter(Boolean);
}

function broadcast(channelId, data, exclude = null) {
  const ch = channels.get(channelId);
  if (!ch) return;
  ch.forEach((info, client) => {
    if (client !== exclude && client.readyState === WebSocket.OPEN)
      client.send(data);
  });
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
}

function getQ(channelId) {
  if (!speakQ.has(channelId)) speakQ.set(channelId, []);
  return speakQ.get(channelId);
}

function getCache(channelId) {
  if (!msgCache.has(channelId)) msgCache.set(channelId, []);
  return msgCache.get(channelId);
}

function pruneCache(channelId) {
  const cache = getCache(channelId);
  const now   = Date.now();
  // Supprimer les messages trop anciens
  while (cache.length > 0 && now - cache[0].ts > MSG_TTL) cache.shift();
  // Garder max MSG_MAX messages
  while (cache.length > MSG_MAX) cache.shift();
}

/* ── Connexion ───────────────────────────────────────────── */
wss.on('connection', (ws) => {
  ws.channelId  = null;
  ws.userId     = null;
  ws.status     = 'disponible';
  ws.isTalking  = false;
  ws.authorized = false;
  ws.isAlive    = true;
  ws.listenOnly = false;
  ws.talkBuf    = []; // accumulation des chunks audio pour le cache
  ws.currentMsgId = null; // msgId de la transmission en cours

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {

    /* Audio binaire → relayer si autorisé et en train de parler */
    if (isBinary) {
      if (ws.authorized && ws.channelId && ws.isTalking && !ws.listenOnly) {
        broadcast(ws.channelId, data, ws);
        ws.talkBuf.push(Buffer.from(data)); // accumulation pour le cache
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch (e) { return; }

    /* Rejoindre un canal */
    if (msg.type === 'join') {
      if (ACCESS_CODE && msg.password !== ACCESS_CODE) {
        send(ws, JSON.stringify({ type: 'error', message: 'Code d\'accès incorrect' }));
        ws.close(); return;
      }

      const targetChannel = msg.channel || 'main';
      const targetUserId  = (msg.userId || 'Chauffeur').substring(0, 30);

      /* Vérifier si le userId est déjà pris dans ce canal (autre connexion) */
      const existing = channels.get(targetChannel);
      if (existing) {
        for (const [client, info] of existing.entries()) {
          if (client !== ws && info && info.userId === targetUserId) {
            send(ws, JSON.stringify({ type: 'error', code: 'VEHICLE_TAKEN', message: 'Véhicule déjà connecté' }));
            ws.close(); return;
          }
        }
      }

      ws.authorized = true;
      ws.listenOnly = !!msg.listenOnly;

      if (ws.channelId) {
        const old = channels.get(ws.channelId);
        if (old) old.delete(ws);
        broadcast(ws.channelId, JSON.stringify({
          type: 'user_left', userId: ws.userId, members: getMembers(ws.channelId)
        }));
        // Retirer de la file d'attente de l'ancien canal
        const oldQ = getQ(ws.channelId);
        const qi = oldQ.indexOf(ws);
        if (qi !== -1) oldQ.splice(qi, 1);
      }

      ws.channelId = targetChannel;
      ws.userId    = targetUserId;
      ws.status    = msg.status || 'disponible';

      if (!channels.has(ws.channelId)) channels.set(ws.channelId, new Map());
      channels.get(ws.channelId).set(ws, { userId: ws.userId, status: ws.status, listenOnly: ws.listenOnly });

      send(ws, JSON.stringify({
        type: 'joined', channel: ws.channelId, members: getMembers(ws.channelId)
      }));
      broadcast(ws.channelId, JSON.stringify({
        type: 'user_joined', userId: ws.userId, status: ws.status,
        listenOnly: ws.listenOnly, members: getMembers(ws.channelId)
      }), ws);

      /* Envoyer les messages cachés (hors-ligne) */
      pruneCache(ws.channelId);
      const cache = getCache(ws.channelId);
      if (cache.length > 0) {
        send(ws, JSON.stringify({ type: 'cached_count', count: cache.length }));
        for (const entry of cache) {
          send(ws, JSON.stringify({
            type: 'cached_audio', msgId: entry.msgId, userId: entry.userId, ts: entry.ts
          }));
          // Envoyer les données binaires
          send(ws, entry.buffer);
        }
      }

      console.log(`[JOIN] ${ws.userId}${ws.listenOnly?' [écoute]':''} → "${ws.channelId}" (${getMembers(ws.channelId).length} connectés)`);
    }

    else if (!ws.authorized) return;

    /* Début parole */
    else if (msg.type === 'start_talk') {
      // Refuser si listenOnly
      if (ws.listenOnly) {
        send(ws, JSON.stringify({ type: 'error', message: 'Mode écoute seule actif' }));
        return;
      }

      const speaker = channelSpeaker.get(ws.channelId);

      // Canal occupé
      if (speaker && speaker !== ws && speaker.readyState === WebSocket.OPEN) {
        if (msg.emergency) {
          // Mode urgence : interrompre le speaker actuel
          send(speaker, JSON.stringify({ type: 'interrupted', reason: 'emergency' }));
          broadcast(ws.channelId, JSON.stringify({
            type: 'talking', userId: speaker.userId, talking: false
          }), speaker);
          // Sauvegarder le buffer du speaker interrompu si assez long
          if (speaker.talkBuf && speaker.talkBuf.length > 0) {
            _saveMsgToCache(ws.channelId, speaker);
          }
          speaker.isTalking = false;
          speaker.talkBuf = [];
          speaker.currentMsgId = null;
          channelSpeaker.set(ws.channelId, null);
          // Continuer : accorder la parole à l'émetteur urgence
        } else {
          // File d'attente
          const q = getQ(ws.channelId);
          if (!q.includes(ws)) q.push(ws);
          const pos = q.indexOf(ws) + 1;
          send(ws, JSON.stringify({ type: 'queued', position: pos }));
          return;
        }
      }

      // Accorder la parole
      globalMsgId++;
      ws.isTalking = true;
      ws.talkBuf   = [];
      ws.currentMsgId = globalMsgId;
      channelSpeaker.set(ws.channelId, ws);
      broadcast(ws.channelId, JSON.stringify({
        type: 'talking', userId: ws.userId, talking: true, msgId: globalMsgId
      }), ws);
    }

    /* Fin parole */
    else if (msg.type === 'end_talk') {
      ws.isTalking = false;

      // Sauvegarder en cache
      if (ws.talkBuf && ws.talkBuf.length > 0) {
        _saveMsgToCache(ws.channelId, ws);
      }
      ws.talkBuf = [];

      // Historique + push
      const audioMsgId = ws.currentMsgId;
      apiPost('/api/ptt_log.php',  { channel: ws.channelId, user_id: ws.userId, type: 'audio', msg_id: audioMsgId });
      apiPost('/api/ptt_push.php', { channel: ws.channelId, sender_id: ws.userId, type: 'audio' });

      ws.currentMsgId = null;

      if (channelSpeaker.get(ws.channelId) === ws) {
        channelSpeaker.set(ws.channelId, null);
      }

      broadcast(ws.channelId, JSON.stringify({
        type: 'talking', userId: ws.userId, talking: false
      }), ws);

      // Notifier le premier en file d'attente
      const q = getQ(ws.channelId);
      if (q.length > 0) {
        const next = q.shift();
        if (next && next.readyState === WebSocket.OPEN) {
          send(next, JSON.stringify({ type: 'your_turn' }));
        }
        // Renuméroter les suivants
        q.forEach((w, i) => {
          if (w.readyState === WebSocket.OPEN)
            send(w, JSON.stringify({ type: 'queued', position: i + 1 }));
        });
      }
    }

    /* Accusé de réception */
    else if (msg.type === 'ack') {
      const mid = msg.msgId;
      if (!mid) return;
      const count = (ackCounts.get(mid) || 0) + 1;
      ackCounts.set(mid, count);
      broadcast(ws.channelId, JSON.stringify({ type: 'ack_update', msgId: mid, count }));
    }

    /* Message privé */
    else if (msg.type === 'private_text') {
      const targetId = msg.targetId;
      const text     = (msg.text || '').substring(0, 120);
      if (!targetId || !text) return;
      const ch = channels.get(ws.channelId);
      if (!ch) return;
      // Trouver le client cible
      let sent = false;
      ch.forEach((info, client) => {
        if (info && info.userId === targetId && client.readyState === WebSocket.OPEN) {
          send(client, JSON.stringify({
            type: 'private_text', fromId: ws.userId, text, ts: Date.now()
          }));
          sent = true;
        }
      });
      if (sent) {
        send(ws, JSON.stringify({
          type: 'private_text_sent', to: targetId, text, ts: Date.now()
        }));
      } else {
        send(ws, JSON.stringify({ type: 'error', message: 'Destinataire introuvable' }));
      }
    }

    /* Changement de statut */
    else if (msg.type === 'status') {
      const validStatus = ['disponible', 'en_course', 'occupe', 'pause'];
      ws.status = validStatus.includes(msg.status) ? msg.status : 'disponible';
      const ch = channels.get(ws.channelId);
      if (ch) ch.set(ws, { userId: ws.userId, status: ws.status, listenOnly: ws.listenOnly });
      broadcast(ws.channelId, JSON.stringify({
        type: 'status_update', userId: ws.userId, status: ws.status
      }));
    }

    /* Message texte rapide */
    else if (msg.type === 'text_msg') {
      const text = (msg.text || '').substring(0, 120);
      if (text) {
        broadcast(ws.channelId, JSON.stringify({
          type: 'text_msg', userId: ws.userId, text, ts: Date.now()
        }), ws); // exclure l'émetteur — il gère son propre historique localement
        // Historique + push
        apiPost('/api/ptt_log.php',  { channel: ws.channelId, user_id: ws.userId, type: 'text', text });
        apiPost('/api/ptt_push.php', { channel: ws.channelId, sender_id: ws.userId, type: 'text', text });
      }
    }

    /* Ping keepalive */
    else if (msg.type === 'ping') {
      send(ws, JSON.stringify({ type: 'pong', ts: msg.ts }));
    }
  });

  ws.on('close', () => {
    if (ws.channelId) {
      const ch = channels.get(ws.channelId);
      if (ch) ch.delete(ws);

      // Libérer le canal si ce client parlait
      if (channelSpeaker.get(ws.channelId) === ws) {
        channelSpeaker.set(ws.channelId, null);
        broadcast(ws.channelId, JSON.stringify({
          type: 'talking', userId: ws.userId, talking: false
        }));
        // Notifier le suivant en file
        const q = getQ(ws.channelId);
        if (q.length > 0) {
          const next = q.shift();
          if (next && next.readyState === WebSocket.OPEN)
            send(next, JSON.stringify({ type: 'your_turn' }));
          q.forEach((w, i) => {
            if (w.readyState === WebSocket.OPEN)
              send(w, JSON.stringify({ type: 'queued', position: i + 1 }));
          });
        }
      }

      // Retirer de la file d'attente
      const q = getQ(ws.channelId);
      const qi = q.indexOf(ws);
      if (qi !== -1) {
        q.splice(qi, 1);
        q.forEach((w, i) => {
          if (w.readyState === WebSocket.OPEN)
            send(w, JSON.stringify({ type: 'queued', position: i + 1 }));
        });
      }

      broadcast(ws.channelId, JSON.stringify({
        type: 'user_left', userId: ws.userId, members: getMembers(ws.channelId)
      }));
      console.log(`[QUIT] ${ws.userId} a quitté "${ws.channelId}"`);
    }
  });

  ws.on('error', err => console.error('WS erreur:', err.message));
});

/* ── Helper : sauvegarder un message dans le cache ─────────── */
function _saveMsgToCache(channelId, ws) {
  const combined = Buffer.concat(ws.talkBuf);
  const cache    = getCache(channelId);
  pruneCache(channelId);
  cache.push({
    msgId:  ws.currentMsgId || ++globalMsgId,
    userId: ws.userId,
    ts:     Date.now(),
    buffer: combined
  });
  // Garder max MSG_MAX
  while (cache.length > MSG_MAX) cache.shift();
}

/* Nettoyage canaux vides */
setInterval(() => {
  channels.forEach((ch, id) => { if (ch.size === 0) channels.delete(id); });
  // Nettoyer les caches périmés
  msgCache.forEach((cache, id) => { pruneCache(id); if (!cache.length) msgCache.delete(id); });
}, 60_000);

/* Heartbeat — détecte et ferme les connexions zombies (client disparu sans close) */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);


console.log(`✅ Taxicab PTT v3 — port ${PORT}${ACCESS_CODE ? ' (code requis)' : ''}`);
