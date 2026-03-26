/**
 * Taxicab PTT — Serveur WebSocket v2
 * Variables d'environnement :
 *   PTT_CODE  → code d'accès requis (vide = pas de code)
 */

const WebSocket = require('ws');

const PORT        = process.env.PORT || 3000;
const ACCESS_CODE = process.env.PTT_CODE || '';

const wss      = new WebSocket.Server({ port: PORT });
const channels = new Map(); // Map<channelId, Map<ws, {userId, status}>>

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

/* ── Connexion ───────────────────────────────────────────── */
wss.on('connection', (ws) => {
  ws.channelId  = null;
  ws.userId     = null;
  ws.status     = 'disponible';
  ws.isTalking  = false;
  ws.authorized = false;
  ws.isAlive    = true;
  ws.on('pong', () => { ws.isAlive = true; }); // réponse au heartbeat serveur

  ws.on('message', (data, isBinary) => {

    /* Audio binaire → relayer si autorisé et en train de parler */
    if (isBinary) {
      if (ws.authorized && ws.channelId && ws.isTalking)
        broadcast(ws.channelId, data, ws);
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch (e) { return; }

    /* Rejoindre un canal */
    if (msg.type === 'join') {
      if (ACCESS_CODE && msg.password !== ACCESS_CODE) {
        ws.send(JSON.stringify({ type: 'error', message: 'Code d\'accès incorrect' }));
        ws.close(); return;
      }

      const targetChannel = msg.channel || 'main';
      const targetUserId  = (msg.userId || 'Chauffeur').substring(0, 30);

      /* Vérifier si le userId est déjà pris dans ce canal (autre connexion) */
      const existing = channels.get(targetChannel);
      if (existing) {
        for (const [client, info] of existing.entries()) {
          if (client !== ws && info && info.userId === targetUserId) {
            ws.send(JSON.stringify({ type: 'error', code: 'VEHICLE_TAKEN', message: 'Véhicule déjà connecté' }));
            ws.close(); return;
          }
        }
      }

      ws.authorized = true;

      if (ws.channelId) {
        const old = channels.get(ws.channelId);
        if (old) old.delete(ws);
        broadcast(ws.channelId, JSON.stringify({
          type: 'user_left', userId: ws.userId, members: getMembers(ws.channelId)
        }));
      }

      ws.channelId = targetChannel;
      ws.userId    = targetUserId;
      ws.status    = msg.status || 'disponible';

      if (!channels.has(ws.channelId)) channels.set(ws.channelId, new Map());
      channels.get(ws.channelId).set(ws, { userId: ws.userId, status: ws.status });

      ws.send(JSON.stringify({
        type: 'joined', channel: ws.channelId, members: getMembers(ws.channelId)
      }));
      broadcast(ws.channelId, JSON.stringify({
        type: 'user_joined', userId: ws.userId, status: ws.status, members: getMembers(ws.channelId)
      }), ws);

      console.log(`[JOIN] ${ws.userId} → "${ws.channelId}" (${getMembers(ws.channelId).length} connectés)`);
    }

    else if (!ws.authorized) return;

    /* Début parole */
    else if (msg.type === 'start_talk') {
      ws.isTalking = true;
      broadcast(ws.channelId, JSON.stringify({ type: 'talking', userId: ws.userId, talking: true }), ws);
    }

    /* Fin parole */
    else if (msg.type === 'end_talk') {
      ws.isTalking = false;
      broadcast(ws.channelId, JSON.stringify({ type: 'talking', userId: ws.userId, talking: false }), ws);
    }

    /* Changement de statut */
    else if (msg.type === 'status') {
      const validStatus = ['disponible', 'en_course', 'occupe', 'pause'];
      ws.status = validStatus.includes(msg.status) ? msg.status : 'disponible';
      const ch = channels.get(ws.channelId);
      if (ch) ch.set(ws, { userId: ws.userId, status: ws.status });
      broadcast(ws.channelId, JSON.stringify({
        type: 'status_update', userId: ws.userId, status: ws.status
      }));
    }

    /* Message texte rapide */
    else if (msg.type === 'text_msg') {
      const text = (msg.text || '').substring(0, 120);
      if (text) broadcast(ws.channelId, JSON.stringify({
        type: 'text_msg', userId: ws.userId, text, ts: Date.now()
      }));
    }

    /* Ping keepalive */
    else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
    }
  });

  ws.on('close', () => {
    if (ws.channelId) {
      const ch = channels.get(ws.channelId);
      if (ch) ch.delete(ws);
      broadcast(ws.channelId, JSON.stringify({
        type: 'user_left', userId: ws.userId, members: getMembers(ws.channelId)
      }));
      console.log(`[QUIT] ${ws.userId} a quitté "${ws.channelId}"`);
    }
  });

  ws.on('error', err => console.error('WS erreur:', err.message));
});

/* Nettoyage canaux vides */
setInterval(() => {
  channels.forEach((ch, id) => { if (ch.size === 0) channels.delete(id); });
}, 60_000);

/* Heartbeat — détecte et ferme les connexions zombies (client disparu sans close) */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);


console.log(`✅ Taxicab PTT v2 — port ${PORT}${ACCESS_CODE ? ' (code requis)' : ''}`);
