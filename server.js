/**
 * Taxicab PTT — Serveur WebSocket
 * Déployer sur Railway.app (gratuit)
 *
 * Variable d'environnement :
 *   PTT_CODE  → code d'accès requis pour rejoindre (laisser vide = pas de code)
 */

const WebSocket = require('ws');

const PORT        = process.env.PORT        || 3000;
const ACCESS_CODE = process.env.PTT_CODE    || '';

const wss = new WebSocket.Server({ port: PORT });

// channels : Map<channelId, Map<WebSocket, userId>>
const channels = new Map();

function getUsers(channelId) {
  const ch = channels.get(channelId);
  if (!ch) return [];
  return Array.from(ch.values()).filter(Boolean);
}

function broadcast(channelId, data, exclude = null) {
  const ch = channels.get(channelId);
  if (!ch) return;
  ch.forEach((userId, client) => {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

wss.on('connection', (ws) => {
  ws.channelId   = null;
  ws.userId      = null;
  ws.isTalking   = false;
  ws.authorized  = false;

  ws.on('message', (data, isBinary) => {

    // ── Audio binaire → relayer uniquement si autorisé ──────────────
    if (isBinary) {
      if (ws.authorized && ws.channelId && ws.isTalking) {
        broadcast(ws.channelId, data, ws);
      }
      return;
    }

    // ── Message JSON → contrôle ─────────────────────────────────────
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch (e) { return; }

    // Rejoindre un canal
    if (msg.type === 'join') {

      // Vérification du code d'accès
      if (ACCESS_CODE && msg.password !== ACCESS_CODE) {
        ws.send(JSON.stringify({ type: 'error', message: 'Code d\'accès incorrect' }));
        ws.close();
        return;
      }

      ws.authorized = true;

      // Quitter l'ancien canal si besoin
      if (ws.channelId) {
        const old = channels.get(ws.channelId);
        if (old) old.delete(ws);
        broadcast(ws.channelId, JSON.stringify({
          type: 'user_left',
          userId: ws.userId,
          users: getUsers(ws.channelId)
        }));
      }

      ws.channelId = msg.channel || 'main';
      ws.userId    = (msg.userId || 'Chauffeur').substring(0, 30); // max 30 chars

      if (!channels.has(ws.channelId)) channels.set(ws.channelId, new Map());
      channels.get(ws.channelId).set(ws, ws.userId);

      ws.send(JSON.stringify({
        type:    'joined',
        channel: ws.channelId,
        users:   getUsers(ws.channelId)
      }));

      broadcast(ws.channelId, JSON.stringify({
        type:   'user_joined',
        userId: ws.userId,
        users:  getUsers(ws.channelId)
      }), ws);

      console.log(`[JOIN] ${ws.userId} → canal "${ws.channelId}" (${getUsers(ws.channelId).length} connectés)`);
    }

    // Début de prise de parole
    else if (msg.type === 'start_talk' && ws.authorized) {
      ws.isTalking = true;
      broadcast(ws.channelId, JSON.stringify({
        type: 'talking', userId: ws.userId, talking: true
      }), ws);
    }

    // Fin de prise de parole
    else if (msg.type === 'end_talk' && ws.authorized) {
      ws.isTalking = false;
      broadcast(ws.channelId, JSON.stringify({
        type: 'talking', userId: ws.userId, talking: false
      }), ws);
    }

    // Ping keepalive (client → serveur)
    else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    if (ws.channelId) {
      const ch = channels.get(ws.channelId);
      if (ch) ch.delete(ws);
      broadcast(ws.channelId, JSON.stringify({
        type:   'user_left',
        userId: ws.userId,
        users:  getUsers(ws.channelId)
      }));
      console.log(`[QUIT] ${ws.userId} a quitté "${ws.channelId}"`);
    }
  });

  ws.on('error', (err) => {
    console.error('WS erreur:', err.message);
  });
});

// Nettoyage périodique des canaux vides
setInterval(() => {
  channels.forEach((ch, id) => {
    if (ch.size === 0) channels.delete(id);
  });
}, 60_000);

console.log(`✅ Taxicab PTT Server démarré — port ${PORT}${ACCESS_CODE ? ' (code requis)' : ' (sans code)'}`);
