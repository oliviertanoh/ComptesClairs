// db.js — couche IndexedDB.
//
// Pourquoi IndexedDB et pas localStorage : localStorage est synchrone,
// limité à ~5 Mo et ne stocke que des chaînes. IndexedDB gère des objets
// structurés et des index. On masque ici sa verbosité derrière une petite
// API à base de promesses — sans bibliothèque tierce.
//
// Un store par entité (voir §4 du spec).

const DB_NAME = 'comptes-clairs';
const DB_VERSION = 3;

export const STORES = {
  categories: 'categories',
  expenses: 'expenses',
  merchants: 'merchants',
  monthlyBudgets: 'monthlyBudgets',
  settings: 'settings',
  // v2 : configuration de synchronisation (dépôt, jeton). Volontairement
  // HORS des stores exportés — un jeton GitHub ne doit jamais se retrouver
  // dans un fichier de sauvegarde, encore moins poussé sur le dépôt.
  sync: 'sync',
  // v3 : charges fixes récurrentes (loyer, abonnements) et instantané du
  // plan de chaque mois (revenu + objectif d'épargne d'alors).
  recurring: 'recurring',
  monthlyPlan: 'monthlyPlan',
};

let _dbPromise = null;

// --- Notification des écritures ---------------------------------------------
// La synchronisation a besoin de savoir « quelque chose a changé » sans que
// chaque vue ait à l'appeler. On émet donc ici, au seul endroit qui écrit.

const changes = new EventTarget();

/**
 * S'abonne aux écritures en base.
 * @param {(store:string)=>void} handler
 * @returns {()=>void} désabonnement
 */
export function onDbChange(handler) {
  const wrapped = (e) => handler(e.detail.store);
  changes.addEventListener('change', wrapped);
  return () => changes.removeEventListener('change', wrapped);
}

function emitChange(store) {
  changes.dispatchEvent(new CustomEvent('change', { detail: { store } }));
}

/** Ouvre (et migre au besoin) la base. Idempotent. */
export function openDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORES.categories)) {
        db.createObjectStore(STORES.categories, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(STORES.expenses)) {
        const s = db.createObjectStore(STORES.expenses, { keyPath: 'id' });
        s.createIndex('date', 'date', { unique: false });
        s.createIndex('categoryId', 'categoryId', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.merchants)) {
        db.createObjectStore(STORES.merchants, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(STORES.monthlyBudgets)) {
        const s = db.createObjectStore(STORES.monthlyBudgets, { keyPath: 'id' });
        s.createIndex('yearMonth', ['year', 'month'], { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(STORES.sync)) {
        db.createObjectStore(STORES.sync, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(STORES.recurring)) {
        db.createObjectStore(STORES.recurring, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(STORES.monthlyPlan)) {
        db.createObjectStore(STORES.monthlyPlan, { keyPath: 'id' });
      }
    };

    // Une migration échouée doit rejeter, pas laisser la promesse en l'air :
    // sans ça l'app reste sur « Chargement… » indéfiniment.
    req.onupgradeneeded = withUpgradeGuard(req, req.onupgradeneeded, reject);

    // BLOQUÉ : un autre onglet (ou la PWA) tient encore la version
    // précédente. Le navigateur n'émet alors NI onsuccess NI onerror — la
    // promesse ne se règle jamais. C'est le cas qui figeait le démarrage.
    req.onblocked = () => {
      reject(new Error(
        'Base de données verrouillée par un autre onglet. Ferme les autres '
        + 'onglets (et l\'app installée) de Comptes Clairs, puis recharge.',
      ));
    };

    req.onsuccess = () => {
      const db = req.result;
      // Symétrique : quand un AUTRE onglet voudra migrer, on libère la base
      // au lieu de le bloquer à son tour.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });

  // Une ouverture ratée ne doit pas être mise en cache : sans ça, toutes les
  // tentatives suivantes rejetteraient avec la même vieille erreur, même
  // après avoir fermé l'onglet fautif.
  _dbPromise = _dbPromise.catch((err) => {
    _dbPromise = null;
    throw err;
  });

  return _dbPromise;
}

/**
 * Enveloppe le gestionnaire de migration pour transformer une exception en
 * rejet de la promesse. Une erreur levée dans `onupgradeneeded` avorte la
 * transaction de version sans déclencher `onerror` de façon fiable.
 */
function withUpgradeGuard(req, handler, reject) {
  return (event) => {
    try {
      handler.call(req, event);
    } catch (err) {
      reject(new Error(`Migration de la base impossible : ${err.message}`));
      try { req.transaction?.abort(); } catch { /* déjà avortée */ }
    }
  };
}

// --- primitives bas niveau --------------------------------------------------

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function asPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAll(store) {
  const db = await openDB();
  return asPromise(tx(db, store, 'readonly').getAll());
}

async function get(store, key) {
  const db = await openDB();
  return asPromise(tx(db, store, 'readonly').get(key));
}

async function put(store, value) {
  const db = await openDB();
  const os = tx(db, store, 'readwrite');
  await asPromise(os.put(value));
  emitChange(store);
  return value;
}

async function del(store, key) {
  const db = await openDB();
  const result = await asPromise(tx(db, store, 'readwrite').delete(key));
  emitChange(store);
  return result;
}

/** Insère un lot dans une seule transaction (utilisé par le seed / l'import). */
async function bulkPut(store, values) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    for (const v of values) os.put(v);
    t.oncomplete = () => { emitChange(store); resolve(values.length); };
    t.onerror = () => reject(t.error);
  });
}

// --- Catégories -------------------------------------------------------------

export const categories = {
  all: () => getAll(STORES.categories),
  async active() {
    const all = await getAll(STORES.categories);
    return all
      .filter((c) => !c.archived)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  },
  get: (id) => get(STORES.categories, id),
  put: (category) => put(STORES.categories, category),
  bulkPut: (list) => bulkPut(STORES.categories, list),
};

// --- Dépenses ---------------------------------------------------------------

export const expenses = {
  all: () => getAll(STORES.expenses),
  get: (id) => get(STORES.expenses, id),
  put: (expense) => put(STORES.expenses, expense),
  delete: (id) => del(STORES.expenses, id),
  bulkPut: (list) => bulkPut(STORES.expenses, list),

  /**
   * Dépenses d'un mois donné, via l'index `date` (bornes ISO).
   * @param {number} year
   * @param {number} month 1-12
   */
  async forMonth(year, month) {
    const db = await openDB();
    const mm = String(month).padStart(2, '0');
    const lo = `${year}-${mm}-01`;
    const hi = `${year}-${mm}-31`;
    const range = IDBKeyRange.bound(lo, hi);
    const index = tx(db, STORES.expenses, 'readonly').index('date');
    return asPromise(index.getAll(range));
  },
};

// --- Commerçants (bibliothèque de libellés) ---------------------------------

export const merchants = {
  async all() {
    const list = await getAll(STORES.merchants);
    return list.sort((a, b) => b.useCount - a.useCount);
  },
  get: (id) => get(STORES.merchants, id),
  put: (merchant) => put(STORES.merchants, merchant),
  delete: (id) => del(STORES.merchants, id),
  bulkPut: (list) => bulkPut(STORES.merchants, list),

  /** Incrémente le compteur d'usage et l'horodatage. */
  async touch(id) {
    const m = await get(STORES.merchants, id);
    if (!m) return null;
    m.useCount = (m.useCount || 0) + 1;
    m.lastUsedAt = Date.now();
    return put(STORES.merchants, m);
  },
};

// --- Budgets mensuels -------------------------------------------------------

export const monthlyBudgets = {
  all: () => getAll(STORES.monthlyBudgets),
  put: (budget) => put(STORES.monthlyBudgets, budget),
  bulkPut: (list) => bulkPut(STORES.monthlyBudgets, list),

  async forMonth(year, month) {
    const db = await openDB();
    const index = tx(db, STORES.monthlyBudgets, 'readonly').index('yearMonth');
    return asPromise(index.getAll(IDBKeyRange.only([year, month])));
  },

  /**
   * Garantit qu'un mois possède ses budgets. S'il n'en a pas, on recopie
   * ceux du mois précédent ; à défaut, les budgets « de référence » des
   * catégories. Renvoie la liste des budgets du mois.
   */
  async ensure(year, month) {
    const existing = await this.forMonth(year, month);
    if (existing.length > 0) return existing;

    // Mois précédent
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prev = await this.forMonth(prevYear, prevMonth);
    const cats = await categories.all();

    const prevByCat = new Map(prev.map((b) => [b.categoryId, b.amount]));

    const created = cats.map((c) => ({
      id: `${year}-${String(month).padStart(2, '0')}_${c.id}`,
      year,
      month,
      categoryId: c.id,
      amount: prevByCat.has(c.id) ? prevByCat.get(c.id) : c.monthlyBudget,
    }));

    await this.bulkPut(created);
    return created;
  },
};

// --- Charges fixes récurrentes ----------------------------------------------
//
// Une règle décrit une charge qui retombe chaque mois (loyer, abonnement).
// `materialized` liste les mois où la dépense a déjà été créée : c'est ce qui
// rend la génération idempotente ET permet de supprimer une occurrence sans
// la voir réapparaître au prochain affichage du mois.
//
// { id, label, amount, categoryId, dayOfMonth, active,
//   startMonth:'YYYY-MM', endMonth:'YYYY-MM'|null, materialized:['YYYY-MM'] }

export const recurring = {
  async all() {
    const list = await getAll(STORES.recurring);
    return list.sort((a, b) => (a.dayOfMonth - b.dayOfMonth) || a.label.localeCompare(b.label));
  },
  get: (id) => get(STORES.recurring, id),
  put: (rule) => put(STORES.recurring, rule),
  delete: (id) => del(STORES.recurring, id),
  bulkPut: (list) => bulkPut(STORES.recurring, list),
};

// --- Plan mensuel (revenu + objectif du mois) -------------------------------
//
// Le revenu ne vit plus seulement dans `settings` : on en fige un instantané
// par mois. Sans ça, l'écran Bilan recalculerait l'épargne de mars avec le
// salaire d'aujourd'hui — un historique faux est pire que pas d'historique.

export const monthlyPlan = {
  all: () => getAll(STORES.monthlyPlan),
  put: (plan) => put(STORES.monthlyPlan, plan),
  bulkPut: (list) => bulkPut(STORES.monthlyPlan, list),

  /**
   * Instantané d'un mois. Créé à la volée depuis les réglages pour le mois
   * courant et les suivants.
   *
   * Pour un mois PASSÉ sans instantané, on renvoie un objet à zéro SANS
   * l'enregistrer : y estampiller le revenu d'aujourd'hui inventerait un
   * historique. On ne sait pas ce qui est rentré en mars — l'écran Bilan
   * masque donc ce mois, et l'utilisateur peut le renseigner explicitement
   * depuis les réglages (ce qui, lui, écrit vraiment).
   */
  async ensure(year, month) {
    const id = monthKey(year, month);
    const existing = await get(STORES.monthlyPlan, id);
    if (existing) return existing;

    const now = new Date();
    const isPast = id < monthKey(now.getFullYear(), now.getMonth() + 1);

    const cfg = (await settings.get()) || {};
    const draft = {
      id,
      year,
      month,
      income: isPast ? 0 : (cfg.monthlyIncome ?? 0),
      savingsTarget: isPast ? 0 : (cfg.savingsTarget ?? 0),
    };
    if (isPast) return draft;

    await put(STORES.monthlyPlan, draft);
    return draft;
  },
};

/** Clé de mois normalisée « YYYY-MM ». */
export function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

// --- Réglages (singleton) ---------------------------------------------------

const SETTINGS_ID = 'singleton';

export const settings = {
  async get() {
    return (await get(STORES.settings, SETTINGS_ID)) || null;
  },
  put(value) {
    return put(STORES.settings, { ...value, id: SETTINGS_ID });
  },
  async patch(partial) {
    const current = (await this.get()) || { id: SETTINGS_ID };
    return this.put({ ...current, ...partial });
  },
};

// --- Config de synchronisation (singleton, JAMAIS exportée) -----------------
//
// Vit dans son propre store pour une raison précise : `exportAll()` ne le lit
// pas, donc le jeton GitHub ne peut pas se retrouver dans une sauvegarde —
// ni dans le fichier JSON, ni dans le fichier poussé sur le dépôt.
// `importAll()` ne le vide pas non plus : restaurer une sauvegarde ne
// déconnecte pas l'appareil.

const SYNC_ID = 'github';

export const syncConfig = {
  async get() {
    return (await get(STORES.sync, SYNC_ID)) || null;
  },
  async patch(partial) {
    const current = (await this.get()) || { id: SYNC_ID };
    return put(STORES.sync, { ...current, ...partial, id: SYNC_ID });
  },
  clear: () => del(STORES.sync, SYNC_ID),
};

// --- Réinitialisation d'un mois --------------------------------------------

/** Supprime toutes les dépenses d'un mois donné (avec confirmation côté vue). */
export async function resetMonth(year, month) {
  const list = await expenses.forMonth(year, month);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORES.expenses, 'readwrite');
    const os = t.objectStore(STORES.expenses);
    for (const e of list) os.delete(e.id);
    t.oncomplete = () => { emitChange(STORES.expenses); resolve(list.length); };
    t.onerror = () => reject(t.error);
  });
}

/** Vide entièrement un store. */
async function clearStore(store) {
  const db = await openDB();
  return asPromise(tx(db, store, 'readwrite').clear());
}

/**
 * Exporte l'intégralité de la base (tous les stores) — sauvegarde complète.
 * @returns {Promise<{categories:array, expenses:array, merchants:array,
 *   monthlyBudgets:array, settings:object|null}>}
 */
export async function exportAll() {
  const [cats, exps, merch, budgets, rules, plans, cfg] = await Promise.all([
    getAll(STORES.categories),
    getAll(STORES.expenses),
    getAll(STORES.merchants),
    getAll(STORES.monthlyBudgets),
    getAll(STORES.recurring),
    getAll(STORES.monthlyPlan),
    settings.get(),
  ]);
  return {
    categories: cats,
    expenses: exps,
    merchants: merch,
    monthlyBudgets: budgets,
    recurring: rules,
    monthlyPlan: plans,
    settings: cfg,
  };
}

/**
 * Restaure une sauvegarde complète : REMPLACE tout le contenu de la base.
 * Destructif — la confirmation est gérée par la vue.
 * @param {object} data structure renvoyée par exportAll()
 */
export async function importAll(data) {
  // STORES.sync est délibérément absent : restaurer une sauvegarde ne doit
  // pas déconnecter l'appareil de son dépôt (le jeton n'est de toute façon
  // jamais dans le fichier).
  await Promise.all([
    clearStore(STORES.categories),
    clearStore(STORES.expenses),
    clearStore(STORES.merchants),
    clearStore(STORES.monthlyBudgets),
    clearStore(STORES.recurring),
    clearStore(STORES.monthlyPlan),
    clearStore(STORES.settings),
  ]);
  if (data.categories?.length) await bulkPut(STORES.categories, data.categories);
  if (data.expenses?.length) await bulkPut(STORES.expenses, data.expenses);
  if (data.merchants?.length) await bulkPut(STORES.merchants, data.merchants);
  if (data.monthlyBudgets?.length) await bulkPut(STORES.monthlyBudgets, data.monthlyBudgets);
  if (data.recurring?.length) await bulkPut(STORES.recurring, data.recurring);
  if (data.monthlyPlan?.length) await bulkPut(STORES.monthlyPlan, data.monthlyPlan);
  if (data.settings) await settings.put(data.settings);
}

/** UUID sans dépendance (dispo dans Safari iOS 17). */
export function uuid() {
  return crypto.randomUUID();
}
