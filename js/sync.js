// sync.js — sauvegarde automatique dans un dépôt GitHub PRIVÉ.
//
// Pourquoi : télécharger un fichier JSON à la main tous les 30 jours, ça ne
// tient pas sur un usage quotidien. Ici l'app pousse toute seule après chaque
// modification et récupère au lancement. Le fichier écrit a EXACTEMENT le même
// format que la sauvegarde manuelle (backup.js) : il reste restaurable à la
// main si la sync casse un jour.
//
// ── Le dépôt doit être PRIVÉ ────────────────────────────────────────────────
// Le fichier contient le revenu, l'objectif d'épargne, et chaque dépense avec
// sa date, son montant et le nom du commerçant. C'est un profil financier
// complet. Sur un dépôt public il serait lisible par n'importe qui, indexable,
// et présent DÉFINITIVEMENT dans l'historique git même après suppression.
// D'où un dépôt séparé du dépôt public de l'app (qui, lui, sert les Pages).
//
// ── Le jeton ───────────────────────────────────────────────────────────────
// Un fine-grained PAT limité à CE SEUL dépôt, permission « Contents:
// Read and write », et rien d'autre. Il est stocké dans IndexedDB sur
// l'appareil (store `sync`), jamais dans le code, jamais dans une sauvegarde.
// Portée minimale : si le téléphone est compromis, le jeton ne donne accès
// qu'à ce dépôt de données.
//
// ── Conflits ───────────────────────────────────────────────────────────────
// L'API Contents de GitHub exige le `sha` du fichier qu'on remplace. On garde
// donc le dernier `sha` connu. S'il ne correspond plus, c'est qu'un autre
// appareil a écrit entre-temps : on ne décide pas à la place de l'utilisateur,
// on remonte un conflit et c'est lui qui tranche.

import { exportAll, importAll, syncConfig, onDbChange, STORES } from './db.js';
import { buildBackup, parseBackup } from './backup.js';

const API = 'https://api.github.com';
const DEFAULT_PATH = 'comptes-clairs.json';
const DEFAULT_BRANCH = 'main';
const DEBOUNCE_MS = 3000;

// --- État observable --------------------------------------------------------

/** @type {{state:string, message:string, lastSyncAt:number|null, pending:boolean}} */
let status = { state: 'disabled', message: '', lastSyncAt: null, pending: false };
const listeners = new Set();

/** S'abonne aux changements d'état de la sync. Renvoie le désabonnement. */
export function onSyncStatus(handler) {
  listeners.add(handler);
  handler(status);
  return () => listeners.delete(handler);
}

function setStatus(patch) {
  status = { ...status, ...patch };
  for (const l of listeners) l(status);
}

export function getStatus() {
  return status;
}

// --- Base64 compatible UTF-8 ------------------------------------------------
// btoa() lève sur tout caractère hors Latin-1. Or les noms de commerçants et
// de catégories contiennent des accents et des emoji. On passe donc par les
// octets UTF-8, par tranches pour ne pas exploser la pile sur un gros export.

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// --- Configuration ----------------------------------------------------------

/**
 * Configuration courante, avec ses valeurs par défaut.
 * @returns {Promise<{owner:string, repo:string, branch:string, path:string,
 *   token:string, enabled:boolean, sha:string|null, lastSyncAt:number|null,
 *   deviceName:string}>}
 */
export async function getConfig() {
  const cfg = (await syncConfig.get()) || {};
  return {
    owner: cfg.owner || '',
    repo: cfg.repo || '',
    branch: cfg.branch || DEFAULT_BRANCH,
    path: cfg.path || DEFAULT_PATH,
    token: cfg.token || '',
    enabled: cfg.enabled ?? false,
    sha: cfg.sha ?? null,
    lastSyncAt: cfg.lastSyncAt ?? null,
    // Marque d'écriture locale non encore envoyée (survit à un redémarrage).
    dirtySince: cfg.dirtySince ?? null,
    deviceName: cfg.deviceName || defaultDeviceName(),
  };
}

export async function saveConfig(patch) {
  await syncConfig.patch(patch);
  return getConfig();
}

export async function disconnect() {
  teardown?.();
  teardown = null;
  clearTimeout(timer);
  dirty = false;
  await syncConfig.clear();
  setStatus({ state: 'disabled', message: '', lastSyncAt: null, pending: false });
}

/** Configuration exploitable ? (sert à décider d'activer la sync du tout) */
export function isConfigured(cfg) {
  return Boolean(cfg.owner && cfg.repo && cfg.token);
}

function defaultDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'PC';
  return 'appareil';
}

// --- Client HTTP GitHub -----------------------------------------------------

class SyncError extends Error {
  constructor(message, { kind = 'error', status: httpStatus = 0 } = {}) {
    super(message);
    this.kind = kind; // 'auth' | 'notfound' | 'conflict' | 'offline' | 'error'
    this.status = httpStatus;
  }
}

async function ghFetch(cfg, path, options = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      // Le service worker ne doit jamais servir une réponse d'API en cache.
      cache: 'no-store',
    });
  } catch {
    throw new SyncError('Pas de connexion.', { kind: 'offline' });
  }

  if (res.status === 401) {
    throw new SyncError('Jeton refusé — il a peut-être expiré.', { kind: 'auth', status: 401 });
  }
  if (res.status === 403) {
    throw new SyncError(
      "Accès refusé — vérifie que le jeton a la permission « Contents: Read and write » sur ce dépôt.",
      { kind: 'auth', status: 403 },
    );
  }
  if (res.status === 404) {
    throw new SyncError('Introuvable.', { kind: 'notfound', status: 404 });
  }
  if (res.status === 409 || res.status === 422) {
    throw new SyncError('Le fichier a changé sur GitHub depuis la dernière synchro.', {
      kind: 'conflict',
      status: res.status,
    });
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.message || '';
    } catch { /* réponse non JSON : on garde le code */ }
    throw new SyncError(`GitHub a répondu ${res.status}${detail ? ` — ${detail}` : ''}.`, {
      status: res.status,
    });
  }
  return res.status === 204 ? null : res.json();
}

function contentsPath(cfg) {
  const encoded = cfg.path.split('/').map(encodeURIComponent).join('/');
  return `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${encoded}`;
}

// --- Opérations de haut niveau ---------------------------------------------

/**
 * Vérifie l'accès au dépôt et renvoie de quoi rassurer l'utilisateur.
 * @returns {Promise<{private:boolean, fullName:string, hasFile:boolean,
 *   exportedAt:number|null, device:string|null}>}
 */
export async function testConnection(cfg) {
  let repo;
  try {
    repo = await ghFetch(
      cfg,
      `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`,
    );
  } catch (e) {
    // Un 404 nu n'aide personne : sur un dépôt privé, « inexistant » et
    // « invisible pour ce jeton » se ressemblent, et c'est le second cas
    // qu'on rencontre en pratique.
    if (e.kind === 'notfound') {
      throw new SyncError(
        `Dépôt ${cfg.owner}/${cfg.repo} introuvable — soit le nom est faux, soit `
        + "le jeton n'a pas accès à ce dépôt (vérifie qu'il est bien listé dans "
        + '« Repository access »).',
        { kind: 'notfound', status: 404 },
      );
    }
    throw e;
  }
  let remote = null;
  try {
    remote = await fetchRemote(cfg);
  } catch (e) {
    if (e.kind !== 'notfound') throw e; // pas encore de fichier : normal
  }
  return {
    private: Boolean(repo.private),
    fullName: repo.full_name,
    hasFile: remote !== null,
    exportedAt: remote?.exportedAt ?? null,
    device: remote?.device ?? null,
    counts: remote?.counts ?? null,
  };
}

/**
 * Lit le fichier distant. Renvoie null si le dépôt n'en contient pas encore.
 * @returns {Promise<{data:object, counts:object, exportedAt:number|null,
 *   device:string|null, sha:string}|null>}
 */
async function fetchRemote(cfg) {
  const file = await ghFetch(cfg, `${contentsPath(cfg)}?ref=${encodeURIComponent(cfg.branch)}`);
  if (!file) return null;

  // Au-delà de 1 Mo, l'API Contents renvoie le descripteur du fichier mais un
  // contenu VIDE. Le confondre avec « pas encore de sauvegarde » ferait
  // écraser la vraie sauvegarde au premier envoi : on refuse bruyamment.
  if (!file.content) {
    if (file.size > 0) {
      throw new SyncError(
        `La sauvegarde distante fait ${Math.round(file.size / 1024)} ko et dépasse la `
        + "limite de lecture de l'API GitHub. Récupère-la à la main depuis le dépôt.",
      );
    }
    return null;
  }

  // parseBackup valide l'entête : un fichier étranger ne sera jamais restauré.
  return { ...parseBackup(fromBase64(file.content)), sha: file.sha };
}

/** Idem, mais renvoie null au lieu de lever sur fichier absent. */
export async function peekRemote(cfg) {
  try {
    return await fetchRemote(cfg);
  } catch (e) {
    if (e.kind === 'notfound') return null;
    throw e;
  }
}

/**
 * Envoie l'état local vers GitHub.
 * @param {object} cfg
 * @param {{force?:boolean, reason?:string}} opts force ignore le conflit de sha
 * @returns {Promise<{sha:string, at:number}>}
 */
export async function push(cfg, { force = false, reason = 'maj' } = {}) {
  const backup = { ...(await buildBackup()), device: cfg.deviceName };
  const content = toBase64(JSON.stringify(backup, null, 2));

  // Sans sha connu, GitHub refuse d'écraser un fichier existant (422). On va
  // donc le chercher — sauf en création, où il n'y en a pas.
  let sha = cfg.sha;
  if (!sha || force) {
    const remote = await peekRemote(cfg);
    sha = remote?.sha ?? null;
  }

  const body = {
    message: `Comptes Clairs — ${reason} (${cfg.deviceName})`,
    content,
    branch: cfg.branch,
    ...(sha ? { sha } : {}),
  };

  let res;
  try {
    res = await ghFetch(cfg, contentsPath(cfg), {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e.kind === 'notfound') {
      throw new SyncError(
        `Écriture impossible : dépôt ${cfg.owner}/${cfg.repo} ou branche `
        + `« ${cfg.branch} » introuvable.`,
        { kind: 'notfound', status: 404 },
      );
    }
    throw e;
  }

  const at = Date.now();
  // `dirtySince` levée ici, et seulement ici : tant que l'envoi n'a pas
  // abouti, le prochain démarrage doit savoir qu'il reste quelque chose.
  await saveConfig({ sha: res.content.sha, lastSyncAt: at, dirtySince: null });
  setStatus({ state: 'ok', message: 'Sauvegardé sur GitHub', lastSyncAt: at, pending: false });
  return { sha: res.content.sha, at };
}

/**
 * Récupère GitHub et REMPLACE les données locales. Destructif : la
 * confirmation est du ressort de l'appelant.
 * @returns {Promise<{counts:object, exportedAt:number|null}>}
 */
export async function pull(cfg) {
  const remote = await fetchRemote(cfg);
  if (!remote) throw new SyncError('Aucune sauvegarde sur GitHub.', { kind: 'notfound' });

  applyingRemote = true;
  try {
    await importAll(remote.data);
  } finally {
    applyingRemote = false;
  }
  const at = Date.now();
  dirty = false;
  clearTimeout(timer);
  await saveConfig({ sha: remote.sha, lastSyncAt: at, dirtySince: null });
  setStatus({ state: 'ok', message: 'Récupéré depuis GitHub.', lastSyncAt: at, pending: false });
  return { counts: remote.counts, exportedAt: remote.exportedAt };
}

// --- Moteur automatique -----------------------------------------------------

let applyingRemote = false; // une restauration ne doit pas déclencher un envoi
let timer = null;
let pushing = false;
let dirty = false;
let appRef = null;
let teardown = null; // désarme les écouteurs du dernier initSync

/**
 * Démarre (ou redémarre) la sync automatique : envoi différé après chaque
 * écriture, envoi à la fermeture de l'app, reprise au retour du réseau.
 *
 * Idempotent : appelé au démarrage PUIS à chaque bascule de l'interrupteur
 * dans les réglages. Sans le désarmement ci-dessous, chaque appel empilerait
 * un jeu d'écouteurs de plus — donc autant d'envois redondants par écriture.
 *
 * @param {object} app helpers de main.js (toast, confirm, refresh)
 */
export async function initSync(app) {
  appRef = app;
  teardown?.();
  teardown = null;

  const cfg = await getConfig();

  if (!isConfigured(cfg) || !cfg.enabled) {
    clearTimeout(timer);
    setStatus({ state: 'disabled', message: '', lastSyncAt: cfg.lastSyncAt, pending: false });
    return;
  }
  setStatus({
    state: dirty ? 'pending' : 'idle',
    message: '',
    lastSyncAt: cfg.lastSyncAt,
    pending: dirty,
  });

  const offDb = onDbChange((store) => {
    // Écrire la config de sync ne doit pas provoquer un envoi (boucle).
    if (store === STORES.sync) return;
    if (applyingRemote) return;
    schedulePush();
  });

  // Quitter l'app / verrouiller l'écran : on ne compte pas sur le timer.
  const onHide = () => {
    if (document.visibilityState === 'hidden' && dirty) flushPush('fermeture');
  };
  const onPageHide = () => { if (dirty) flushPush('fermeture'); };
  const onOnline = () => { if (dirty) flushPush('reprise réseau'); };

  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('online', onOnline);

  teardown = () => {
    offDb();
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('online', onOnline);
  };
}

function schedulePush() {
  // `dirty` ne vit qu'en mémoire : si iOS tue l'app avant l'envoi, il
  // disparaît et la modification ne partirait JAMAIS (au redémarrage, le sha
  // distant correspond toujours au nôtre, donc rien ne semble à faire).
  // On pose donc aussi une marque persistante, relue par syncOnBoot.
  if (!dirty) syncConfig.patch({ dirtySince: Date.now() });
  dirty = true;
  setStatus({ state: 'pending', message: 'Modifications non envoyées', pending: true });
  clearTimeout(timer);
  timer = setTimeout(() => flushPush('maj'), DEBOUNCE_MS);
}

/** Envoi immédiat de ce qui est en attente. Ne lève jamais. */
export async function flushPush(reason = 'maj') {
  clearTimeout(timer);
  // Un envoi est déjà en vol : on ne le double pas, mais on reprogramme —
  // sinon la modification arrivée entre-temps attendrait la prochaine
  // écriture pour partir.
  if (pushing) { schedulePush(); return; }

  const cfg = await getConfig();
  if (!isConfigured(cfg) || !cfg.enabled) return;

  pushing = true;
  dirty = false;
  setStatus({ state: 'syncing', message: 'Envoi…', pending: true });

  try {
    const { at } = await push(cfg, { reason });
    setStatus({ state: 'ok', message: 'Sauvegardé sur GitHub', lastSyncAt: at, pending: false });
  } catch (e) {
    dirty = true; // on retentera : à la prochaine écriture, au retour du réseau
    if (e.kind === 'offline') {
      setStatus({ state: 'offline', message: 'Hors ligne — envoi en attente', pending: true });
    } else if (e.kind === 'conflict') {
      setStatus({ state: 'conflict', message: 'Conflit avec GitHub', pending: true });
      appRef?.toast('Conflit de synchro — ouvre les réglages.', { duration: 5000 });
    } else {
      setStatus({ state: 'error', message: e.message, pending: true });
    }
  } finally {
    pushing = false;
  }
}

/**
 * Au démarrage : décide quoi faire de l'état distant.
 *   - base locale vide  -> on récupère (c'est le cas « nouveau téléphone »)
 *   - sha distant différent du dernier connu -> un autre appareil a écrit,
 *     on demande à l'utilisateur plutôt que d'écraser quoi que ce soit.
 * @param {object} app
 * @param {{localEmpty:boolean}} opts
 * @returns {Promise<'restored'|'none'>}
 */
export async function syncOnBoot(app, { localEmpty }) {
  const cfg = await getConfig();
  if (!isConfigured(cfg) || !cfg.enabled) return 'none';

  let remote;
  try {
    setStatus({ state: 'syncing', message: 'Vérification…' });
    remote = await peekRemote(cfg);
  } catch (e) {
    setStatus({
      state: e.kind === 'offline' ? 'offline' : 'error',
      message: e.kind === 'offline' ? 'Hors ligne' : e.message,
    });
    return 'none';
  }

  if (!remote) {
    // Dépôt configuré mais vide : on y dépose l'état local.
    setStatus({ state: 'idle', message: '' });
    if (!localEmpty) flushPush('première sauvegarde');
    return 'none';
  }

  if (localEmpty) {
    applyingRemote = true;
    try {
      await importAll(remote.data);
    } finally {
      applyingRemote = false;
    }
    const at = Date.now();
    // Local == distant : plus rien en attente d'envoi.
    dirty = false;
    await saveConfig({ sha: remote.sha, lastSyncAt: at, dirtySince: null });
    setStatus({ state: 'ok', message: 'Récupéré depuis GitHub', lastSyncAt: at });
    return 'restored';
  }

  // Données des deux côtés. Si le sha n'a pas bougé, le distant vient de nous.
  if (remote.sha === cfg.sha) {
    // …sauf si une écriture locale n'a jamais pu partir (app fermée hors
    // ligne). Le sha correspond, mais le distant est en retard sur nous.
    if (cfg.dirtySince) {
      dirty = true;
      flushPush('envoi différé');
      return 'none';
    }
    setStatus({ state: 'ok', message: 'À jour', lastSyncAt: cfg.lastSyncAt });
    return 'none';
  }

  // Un autre appareil a écrit. Écraser d'un côté ou de l'autre perd des
  // données : on laisse trancher, avec les chiffres sous les yeux.
  const local = await exportAll();
  const when = remote.exportedAt
    ? new Date(remote.exportedAt).toLocaleString('fr-FR')
    : 'date inconnue';
  const device = remote.device ? ` depuis ${remote.device}` : '';

  const take = await app.confirm({
    title: 'Version plus récente sur GitHub',
    message:
      `GitHub : ${remote.counts.expenses} dépense(s), sauvegardé le ${when}${device}.\n`
      + `Cet appareil : ${local.expenses.length} dépense(s).\n\n`
      + 'Récupérer la version GitHub remplacera les données de cet appareil.',
    confirmLabel: 'Récupérer GitHub',
    danger: true,
  });

  if (take) {
    applyingRemote = true;
    try {
      await importAll(remote.data);
    } finally {
      applyingRemote = false;
    }
    const at = Date.now();
    // Local == distant : plus rien en attente d'envoi.
    dirty = false;
    await saveConfig({ sha: remote.sha, lastSyncAt: at, dirtySince: null });
    setStatus({ state: 'ok', message: 'Récupéré depuis GitHub', lastSyncAt: at });
    return 'restored';
  }

  // L'utilisateur garde le local : on adopte le sha distant pour pouvoir
  // l'écraser au prochain envoi, sans repasser par un conflit.
  await saveConfig({ sha: remote.sha });
  setStatus({ state: 'pending', message: 'Local conservé — sera envoyé', pending: true });
  flushPush('remplacement depuis ' + cfg.deviceName);
  return 'none';
}

/** Libellé court pour l'UI. */
export function statusLabel(s) {
  switch (s.state) {
    case 'disabled': return 'Non configurée';
    case 'syncing': return 'Synchronisation…';
    case 'pending': return s.message || 'En attente';
    case 'offline': return 'Hors ligne — en attente';
    case 'conflict': return 'Conflit à résoudre';
    case 'error': return s.message || 'Erreur';
    case 'ok':
    case 'idle':
    default:
      return s.lastSyncAt
        ? `Sauvegardé ${relativeTime(s.lastSyncAt)}`
        : 'Prête';
  }
}

function relativeTime(ts) {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return "à l'instant";
  if (sec < 3600) return `il y a ${Math.round(sec / 60)} min`;
  if (sec < 86400) return `il y a ${Math.round(sec / 3600)} h`;
  return `le ${new Date(ts).toLocaleDateString('fr-FR')}`;
}
