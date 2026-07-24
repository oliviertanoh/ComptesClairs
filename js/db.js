// db.js — couche IndexedDB.
//
// Pourquoi IndexedDB et pas localStorage : localStorage est synchrone,
// limité à ~5 Mo et ne stocke que des chaînes. IndexedDB gère des objets
// structurés et des index. On masque ici sa verbosité derrière une petite
// API à base de promesses — sans bibliothèque tierce.
//
// Un store par entité (voir §4 du spec).

const DB_NAME = 'comptes-clairs';
const DB_VERSION = 1;

export const STORES = {
  categories: 'categories',
  expenses: 'expenses',
  merchants: 'merchants',
  monthlyBudgets: 'monthlyBudgets',
  settings: 'settings',
};

let _dbPromise = null;

/** Ouvre (et migre au besoin) la base. Idempotent. */
export function openDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
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
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return _dbPromise;
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
  return value;
}

async function del(store, key) {
  const db = await openDB();
  return asPromise(tx(db, store, 'readwrite').delete(key));
}

/** Insère un lot dans une seule transaction (utilisé par le seed / l'import). */
async function bulkPut(store, values) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    for (const v of values) os.put(v);
    t.oncomplete = () => resolve(values.length);
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

// --- Réinitialisation d'un mois --------------------------------------------

/** Supprime toutes les dépenses d'un mois donné (avec confirmation côté vue). */
export async function resetMonth(year, month) {
  const list = await expenses.forMonth(year, month);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORES.expenses, 'readwrite');
    const os = t.objectStore(STORES.expenses);
    for (const e of list) os.delete(e.id);
    t.oncomplete = () => resolve(list.length);
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
  const [cats, exps, merch, budgets, cfg] = await Promise.all([
    getAll(STORES.categories),
    getAll(STORES.expenses),
    getAll(STORES.merchants),
    getAll(STORES.monthlyBudgets),
    settings.get(),
  ]);
  return {
    categories: cats,
    expenses: exps,
    merchants: merch,
    monthlyBudgets: budgets,
    settings: cfg,
  };
}

/**
 * Restaure une sauvegarde complète : REMPLACE tout le contenu de la base.
 * Destructif — la confirmation est gérée par la vue.
 * @param {object} data structure renvoyée par exportAll()
 */
export async function importAll(data) {
  await Promise.all([
    clearStore(STORES.categories),
    clearStore(STORES.expenses),
    clearStore(STORES.merchants),
    clearStore(STORES.monthlyBudgets),
    clearStore(STORES.settings),
  ]);
  if (data.categories?.length) await bulkPut(STORES.categories, data.categories);
  if (data.expenses?.length) await bulkPut(STORES.expenses, data.expenses);
  if (data.merchants?.length) await bulkPut(STORES.merchants, data.merchants);
  if (data.monthlyBudgets?.length) await bulkPut(STORES.monthlyBudgets, data.monthlyBudgets);
  if (data.settings) await settings.put(data.settings);
}

/** UUID sans dépendance (dispo dans Safari iOS 17). */
export function uuid() {
  return crypto.randomUUID();
}
