'use strict';

(function () {
  const config = window.ESTUDO_MULTIPLAYER_CONFIG || {};
  const roles = ['Macrófago', 'Neutrófilo', 'Lin. B'];
  let client = null;
  let channel = null;
  let roomCode = '';
  let playerId = '';
  let hostId = '';
  let localSlot = -1;
  let connected = false;
  let host = false;
  let handlers = {};
  let slots = new Map();
  let remoteInputs = new Map();
  let lastInputAt = 0;

  function notify(name, value) {
    try {
      if (typeof handlers[name] === 'function') handlers[name](value);
    } catch (error) {
      console.error(`Falha no callback multiplayer (${name}):`, error);
    }
  }

  function getRoomMembers() {
    if (!channel) return [];
    return Object.values(channel.presenceState()).flat()
      .filter(member => member && typeof member.playerId === 'string');
  }

  function broadcast(event, payload) {
    if (!channel || !connected) return Promise.resolve(false);
    return channel.send({ type: 'broadcast', event, payload })
      .then(result => result === 'ok')
      .catch(error => {
        console.error(`Falha ao enviar mensagem multiplayer (${event}):`, error);
        return false;
      });
  }

  function refreshPresence() {
    const members = getRoomMembers();
    const hostMember = members.find(member => member.isHost);
    if (!hostMember) {
      if (!host) notify('status', { state: 'host-left', roomCode });
      notify('roster', { count: 1, members: [] });
      return;
    }
    hostId = hostMember.playerId;

    const ordered = members
      .filter(member => member.playerId === hostId || !member.isHost)
      .sort((left, right) => {
        if (left.playerId === hostId) return -1;
        if (right.playerId === hostId) return 1;
        return String(left.joinedAt).localeCompare(String(right.joinedAt))
          || left.playerId.localeCompare(right.playerId);
      });
    slots = new Map(ordered.slice(0, 3).map((member, index) => [member.playerId, index]));
    localSlot = slots.has(playerId) ? slots.get(playerId) : -1;
    remoteInputs.forEach((_, id) => {
      if (!slots.has(id)) remoteInputs.delete(id);
    });

    const roster = ordered.slice(0, 3).map((member, index) => ({
      playerId: member.playerId,
      slot: index,
      name: roles[index],
      isHost: member.playerId === hostId
    }));
    notify('roster', { count: roster.length, members: roster });

    if (host) {
      roster.slice(1).forEach(member => {
        broadcast('assignment', { playerId: member.playerId, hostId, slot: member.slot });
      });
    } else if (localSlot < 0) {
      notify('status', { state: 'full', roomCode });
    } else if (hostId && slots.has(hostId)) {
      notify('status', { state: 'connected', roomCode, slot: localSlot });
      if (connected) broadcast('join-request', { playerId });
    }
  }

  async function loadClient() {
    if (client) return client;
    const url = typeof config.supabaseUrl === 'string' ? config.supabaseUrl.trim() : '';
    const key = typeof config.supabasePublishableKey === 'string' ? config.supabasePublishableKey.trim() : '';
    if (!url || !key) {
      throw new Error('Configure o endereço e a chave publishable do Supabase em multiplayer-config.js.');
    }
    if (!/^https:\/\/[^/]+/i.test(url)) {
      throw new Error('O endereço do Supabase deve começar com https://.');
    }
    notify('status', { state: 'loading-sdk' });
    const module = await import('https://esm.sh/@supabase/supabase-js@2');
    client = module.createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    return client;
  }

  async function connect(code, asHost) {
    if (connected) await leave();
    roomCode = code.toUpperCase();
    host = asHost;
    playerId = crypto.randomUUID();
    hostId = asHost ? playerId : '';
    localSlot = asHost ? 0 : -1;
    slots = new Map();
    remoteInputs = new Map();
    notify('status', { state: 'connecting', roomCode });
    const supabase = await loadClient();
    channel = supabase.channel(`estudo-biomedico-${roomCode}`, {
      config: { broadcast: { self: false }, presence: { key: playerId }, private: false }
    });
    channel
      .on('presence', { event: 'sync' }, refreshPresence)
      .on('broadcast', { event: 'assignment' }, ({ payload }) => {
        if (!payload || payload.playerId !== playerId || payload.hostId !== hostId) return;
        if (!Number.isInteger(payload.slot) || payload.slot < 1 || payload.slot > 2) {
          localSlot = -1;
          notify('status', { state: 'full', roomCode });
          return;
        }
        localSlot = payload.slot;
        notify('status', { state: 'connected', roomCode, slot: localSlot });
      })
      .on('broadcast', { event: 'join-request' }, ({ payload }) => {
        if (!host || !payload || typeof payload.playerId !== 'string' || !slots.has(payload.playerId)) return;
        const slot = slots.get(payload.playerId);
        if (slot > 0) broadcast('assignment', { playerId: payload.playerId, hostId, slot });
      })
      .on('broadcast', { event: 'input' }, ({ payload }) => {
        if (!host || !payload || !slots.has(payload.playerId) || slots.get(payload.playerId) < 1) return;
        if (!Number.isFinite(payload.x) || !Number.isFinite(payload.y)) return;
        remoteInputs.set(payload.playerId, {
          slot: slots.get(payload.playerId),
          x: Math.max(-1, Math.min(1, payload.x)),
          y: Math.max(-1, Math.min(1, payload.y)),
          receivedAt: Date.now()
        });
      })
      .on('broadcast', { event: 'command' }, ({ payload }) => {
        if (!host || !payload || !slots.has(payload.playerId) || slots.get(payload.playerId) < 1) return;
        notify('command', { playerId: payload.playerId, slot: slots.get(payload.playerId), command: payload.command });
      })
      .on('broadcast', { event: 'snapshot' }, ({ payload }) => {
        if (host || !payload || payload.hostId !== hostId || !payload.snapshot) return;
        notify('snapshot', payload.snapshot);
      });

    await new Promise((resolve, reject) => {
      let settled = false;
      channel.subscribe(async status => {
        if (status === 'SUBSCRIBED' && !settled) {
          try {
            await channel.track({
              playerId,
              isHost: host,
              joinedAt: new Date().toISOString()
            });
            connected = true;
            settled = true;
            refreshPresence();
            if (host) notify('status', { state: 'connected', roomCode, slot: 0 });
            else if (!hostId) notify('status', { state: 'waiting', roomCode });
            resolve();
          } catch (error) {
            settled = true;
            reject(error);
          }
        } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status) && !settled) {
          settled = true;
          reject(new Error(`A conexão em tempo real falhou (${status}).`));
        }
      });
    });
  }

  function makeRoomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const random = new Uint8Array(6);
    crypto.getRandomValues(random);
    return Array.from(random, value => alphabet[value % alphabet.length]).join('');
  }

  async function createRoom() {
    await connect(makeRoomCode(), true);
    return roomCode;
  }

  async function joinRoom(code) {
    const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z0-9]{6}$/.test(normalized)) {
      throw new Error('Digite um código de sala com seis letras ou números.');
    }
    await connect(normalized, false);
    return roomCode;
  }

  async function leave() {
    const previousChannel = channel;
    connected = false;
    channel = null;
    roomCode = '';
    hostId = '';
    playerId = '';
    localSlot = -1;
    host = false;
    slots = new Map();
    remoteInputs = new Map();
    if (previousChannel && client) {
      try {
        await previousChannel.untrack();
      } catch (error) {
        console.error('Falha ao liberar a presença na sala online:', error);
      }
      try {
        await client.removeChannel(previousChannel);
      } catch (error) {
        console.error('Falha ao fechar o canal da sala online:', error);
      }
    }
    notify('status', { state: 'offline' });
    notify('roster', { count: 1, members: [] });
  }

  window.onlinePlay = {
    setHandlers(value) { handlers = value || {}; },
    isConnected() { return connected; },
    isHost() { return connected && host; },
    getRoomCode() { return roomCode; },
    getLocalSlot() { return localSlot; },
    createRoom,
    joinRoom,
    leave,
    sendCommand(command) {
      if (!connected || host || localSlot < 1) return false;
      return broadcast('command', { playerId, command });
    },
    sendInput(x, y) {
      if (!connected || host || localSlot < 1) return false;
      const now = performance.now();
      if (now - lastInputAt < 80) return true;
      lastInputAt = now;
      return broadcast('input', { playerId, x, y });
    },
    sendSnapshot(snapshot) {
      if (!connected || !host) return false;
      const serialized = JSON.stringify(snapshot);
      if (serialized.length > 180000) {
        notify('status', { state: 'error', message: 'A partida excedeu o limite de dados para sincronização.' });
        return false;
      }
      return broadcast('snapshot', { hostId, snapshot });
    },
    getRemoteInputs() {
      const cutoff = Date.now() - 500;
      return Array.from(remoteInputs.values()).filter(input => input.receivedAt >= cutoff);
    },
    getSlotForPlayer(id) { return slots.has(id) ? slots.get(id) : -1; }
  };
})();
