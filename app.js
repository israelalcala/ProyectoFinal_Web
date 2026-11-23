/* ==========================================================================
   PLATAFORMA WEB DE BIENES RAÍCES - INMOBAJA (UABC FIAD)
   Backend simulado en JavaScript con validaciones de entrada, prevención de
   doble envío, persistencia en localStorage, borradores ante recarga, manejo
   de fallos de red/imágenes externas, mapa Leaflet y moderación.
========================================================================== */

(function () {
  'use strict';

  const STORAGE_KEYS = {
    USERS: 'inmobaja_users_v1',
    PROPERTIES: 'inmobaja_properties_v1',
    MESSAGES: 'inmobaja_messages_v1',
    REPORTS: 'inmobaja_reports_v1',
    SESSION: 'inmobaja_session_v1',
    DRAFTS: 'inmobaja_drafts_v1'
  };

  // Límites máximos de longitud (evita textos de 200+ letras desbordando UI/datos)
  const LIMITS = {
    NAME_MAX: 80,
    EMAIL_MAX: 120,
    PHONE_MAX: 25,
    PASSWORD_MIN: 6,
    PASSWORD_MAX: 100,
    PROP_TITLE_MAX: 100,
    PROP_ADDRESS_MAX: 140,
    PROP_DESC_MAX: 1000,
    REPORT_DETAILS_MAX: 600,
    CHAT_MSG_MAX: 600,
    MAX_PRICE: 500000000,
    MAX_SIZE: 1000000,
    MAX_ROOMS: 100
  };

  // Imagen de respaldo local (SVG Data URI) si falla la red o la URL externa
  const FALLBACK_IMAGE =
    'data:image/svg+xml;charset=UTF-8,' +
    encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">
        <rect width="800" height="500" fill="#e2e8f0"/>
        <path d="M400 135L230 275v125h115v-85h110v85h115V275L400 135z" fill="#0f4c81"/>
        <text x="400" y="445" font-family="sans-serif" font-size="22" font-weight="bold" fill="#334155" text-anchor="middle">
          Imagen no disponible sin conexión
        </text>
      </svg>
    `);

  const NEARBY_SERVICES = [
    { name: 'UABC Campus Ensenada (FIAD)', category: 'school', lat: 31.8656, lng: -116.6669 },
    { name: 'CICESE Ensenada', category: 'school', lat: 31.8685, lng: -116.6631 },
    { name: 'CETYS Universidad Campus Ensenada', category: 'school', lat: 31.8254, lng: -116.6012 },
    { name: 'Hospital General de Ensenada', category: 'hospital', lat: 31.8592, lng: -116.6058 },
    { name: 'Hospital Velmar', category: 'hospital', lat: 31.8634, lng: -116.6215 },
    { name: 'Costco Wholesale Ensenada', category: 'market', lat: 31.8428, lng: -116.6079 },
    { name: 'Calimax Zona Centro', category: 'market', lat: 31.8661, lng: -116.6238 },
    { name: 'Soriana Híper Reforma', category: 'market', lat: 31.8389, lng: -116.6025 }
  ];

  let currentUser = null;
  let activeChatThreadId = null;
  let mapInstance = null;
  let propertyMarkersLayer = null;
  let poiMarkersLayer = null;
  let hasUnsavedFormWork = false;
  const busyLocks = new Set();

  /* ========================================================================
     1. UTILIDADES DE SEGURIDAD, FORMATO Y VALIDACIÓN
  ======================================================================== */
  async function hashPassword(plainText) {
    if (window.crypto && window.crypto.subtle) {
      const encoder = new TextEncoder();
      const data = encoder.encode(plainText);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return btoa(unescape(encodeURIComponent(plainText)));
  }

  function formatCurrency(amount) {
    const safeNum = Number.isFinite(Number(amount)) ? Number(amount) : 0;
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN',
      maximumFractionDigits: 0
    }).format(safeNum);
  }

  function sanitize(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }

  function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.classList.add('hidden');
    }, 3400);
  }

  // Valida números estrictamente (rechaza texto, NaN, Infinity, vacíos o fuera de rango)
  function parseStrictNumber(rawValue, { min = 0, max = Infinity, allowZero = true, label = 'campo numérico' } = {}) {
    const str = String(rawValue ?? '').trim();
    if (str === '') {
      return { ok: false, error: `El campo "${label}" es obligatorio y debe ser un número.` };
    }
    // Evita que "123abc" pase con parseFloat
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(str)) {
      return { ok: false, error: `"${label}" solo acepta valores numéricos válidos (no texto).` };
    }
    const num = Number(str);
    if (!Number.isFinite(num)) {
      return { ok: false, error: `"${label}" no es un número válido.` };
    }
    if (allowZero ? num < min : num <= min) {
      return {
        ok: false,
        error: allowZero
          ? `"${label}" no puede ser menor que ${min}.`
          : `"${label}" debe ser mayor que ${min}.`
      };
    }
    if (num > max) {
      return { ok: false, error: `"${label}" no puede exceder ${max.toLocaleString('es-MX')}.` };
    }
    return { ok: true, value: num };
  }

  function validateTextField(rawValue, { label, minLen = 1, maxLen, required = true }) {
    const clean = String(rawValue ?? '').trim();
    if (required && clean.length === 0) {
      return { ok: false, error: `El campo "${label}" no puede estar vacío.` };
    }
    if (clean.length > 0 && clean.length < minLen) {
      return { ok: false, error: `"${label}" debe tener al menos ${minLen} caracteres.` };
    }
    if (typeof maxLen === 'number' && clean.length > maxLen) {
      return {
        ok: false,
        error: `"${label}" supera el máximo permitido de ${maxLen} caracteres (actual: ${clean.length}).`
      };
    }
    return { ok: true, value: clean };
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
  }

  function isSafeHttpUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  }

  // Bloquea doble clic / envíos simultáneos en cualquier acción asíncrona o de formulario
  async function runWithSubmitLock(lockKey, submitBtn, taskFn) {
    if (busyLocks.has(lockKey)) {
      return;
    }
    busyLocks.add(lockKey);
    const prevText = submitBtn ? submitBtn.textContent : '';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Procesando...';
    }
    try {
      await taskFn();
    } finally {
      busyLocks.delete(lockKey);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = prevText;
      }
    }
  }

  /* ========================================================================
     2. CAPA DE DATOS (SEED INICIAL + CRUD EN LOCALSTORAGE)
  ======================================================================== */
  function readStore(key, fallback = []) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      showToast('No se pudo guardar en almacenamiento local (espacio lleno o bloqueado).');
      return false;
    }
  }

  async function seedDatabaseIfEmpty() {
    if (readStore(STORAGE_KEYS.USERS, []).length === 0) {
      const defaultPass = await hashPassword('123456');
      const users = [
        {
          id: 'usr_comprador',
          name: 'Ana Sofía Martínez',
          email: 'comprador@inmobaja.mx',
          phone: '646 110 2233',
          role: 'comprador',
          passwordHash: defaultPass,
          favorites: ['prop_1', 'prop_3'],
          active: true
        },
        {
          id: 'usr_vendedor',
          name: 'Israel Ledesma Alcalá',
          email: 'vendedor@inmobaja.mx',
          phone: '646 373 8440',
          role: 'vendedor',
          passwordHash: defaultPass,
          favorites: [],
          active: true
        },
        {
          id: 'usr_admin',
          name: 'Administrador FIAD',
          email: 'admin@inmobaja.mx',
          phone: '646 175 0744',
          role: 'admin',
          passwordHash: defaultPass,
          favorites: [],
          active: true
        }
      ];
      writeStore(STORAGE_KEYS.USERS, users);
    }

    if (readStore(STORAGE_KEYS.PROPERTIES, []).length === 0) {
      const properties = [
        {
          id: 'prop_1',
          sellerId: 'usr_vendedor',
          sellerName: 'Israel Ledesma Alcalá',
          title: 'Residencia Vista al Mar en El Sauzal',
          type: 'Casa',
          zone: 'El Sauzal',
          price: 4850000,
          size: 260,
          beds: 3,
          baths: 3,
          address: 'Carretera Tijuana-Ensenada Km 103, El Sauzal',
          lat: 31.8895,
          lng: -116.6921,
          image: 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=900&q=80',
          description: 'Casa contemporánea de dos niveles con terraza panorámica al océano Pacífico, cochera para 2 autos y a 5 minutos de UABC Campus Sauzal.',
          views: 142,
          status: 'activa'
        },
        {
          id: 'prop_2',
          sellerId: 'usr_vendedor',
          sellerName: 'Israel Ledesma Alcalá',
          title: 'Terreno Residencial cerca de UABC Playitas',
          type: 'Terreno',
          zone: 'Playitas',
          price: 1650000,
          size: 320,
          beds: 0,
          baths: 0,
          address: 'Calle Segunda y Coral, Playitas, Ensenada',
          lat: 31.8632,
          lng: -116.6625,
          image: 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?auto=format&fit=crop&w=900&q=80',
          description: 'Terreno plano listo para escriturar con servicios de agua, luz y drenaje a pie de calle. Excelente ubicación universitaria y residencial.',
          views: 98,
          status: 'activa'
        },
        {
          id: 'prop_3',
          sellerId: 'usr_vendedor',
          sellerName: 'Israel Ledesma Alcalá',
          title: 'Casa Familiar en Fraccionamiento Chapultepec',
          type: 'Casa',
          zone: 'Chapultepec',
          price: 3950000,
          size: 215,
          beds: 4,
          baths: 2,
          address: 'Av. Esmeralda #312, Chapultepec, Ensenada',
          lat: 31.8498,
          lng: -116.6122,
          image: 'https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=900&q=80',
          description: 'Amplia residencia en zona tranquila, patio trasero con asador, cocina integral de madera y cercanía inmediata a hospitales y centros comerciales.',
          views: 210,
          status: 'activa'
        },
        {
          id: 'prop_4',
          sellerId: 'usr_vendedor',
          sellerName: 'Israel Ledesma Alcalá',
          title: 'Terreno Campestre para Viñedo en Valle de Guadalupe',
          type: 'Terreno',
          zone: 'Valle de Guadalupe',
          price: 2900000,
          size: 1500,
          beds: 0,
          baths: 0,
          address: 'Ruta del Vino Km 74, San Antonio de las Minas',
          lat: 31.9765,
          lng: -116.6315,
          image: 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=900&q=80',
          description: 'Predio campestre ideal para cabañas boutique o proyecto vitivinícola con vistas a las montañas del Valle de Guadalupe.',
          views: 175,
          status: 'activa'
        },
        {
          id: 'prop_5',
          sellerId: 'usr_vendedor',
          sellerName: 'Israel Ledesma Alcalá',
          title: 'Departamento Ejecutivo en Zona Centro',
          type: 'Departamento',
          zone: 'Zona Centro',
          price: 2350000,
          size: 110,
          beds: 2,
          baths: 2,
          address: 'Calle Ruiz y Séptima #714, Zona Centro',
          lat: 31.8678,
          lng: -116.6254,
          image: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=900&q=80',
          description: 'Departamento moderno con acceso controlado, balcón, cuarto de lavado y ubicación caminable a supermercados, bancos y malecón.',
          views: 84,
          status: 'activa'
        }
      ];
      writeStore(STORAGE_KEYS.PROPERTIES, properties);
    }

    if (readStore(STORAGE_KEYS.MESSAGES, []).length === 0) {
      const threads = [
        {
          id: 'chat_prop_1_usr_comprador',
          propertyId: 'prop_1',
          propertyTitle: 'Residencia Vista al Mar en El Sauzal',
          buyerId: 'usr_comprador',
          buyerName: 'Ana Sofía Martínez',
          sellerId: 'usr_vendedor',
          sellerName: 'Israel Ledesma Alcalá',
          messages: [
            {
              senderId: 'usr_comprador',
              senderName: 'Ana Sofía Martínez',
              text: 'Hola, me interesa mucho la casa en El Sauzal. ¿Podríamos agendar una visita este sábado?',
              timestamp: '10:30 AM'
            },
            {
              senderId: 'usr_vendedor',
              senderName: 'Israel Ledesma Alcalá',
              text: '¡Hola Ana Sofía! Claro que sí, tengo disponibilidad el sábado a las 11:00 AM para mostrarte la propiedad.',
              timestamp: '10:42 AM'
            }
          ]
        }
      ];
      writeStore(STORAGE_KEYS.MESSAGES, threads);
    }

    if (readStore(STORAGE_KEYS.REPORTS, []).length === 0) {
      const reports = [
        {
          id: 'rep_1',
          propertyId: 'prop_5',
          propertyTitle: 'Departamento Ejecutivo en Zona Centro',
          reason: 'Información o precio falso',
          details: 'El usuario solicita verificar si incluye cajón de estacionamiento escriturado.',
          reportedBy: 'Ana Sofía Martínez',
          status: 'pendiente'
        }
      ];
      writeStore(STORAGE_KEYS.REPORTS, reports);
    }
  }

  /* ========================================================================
     3. BORRADORES ANTE RECARGA DE PÁGINA Y AVISO DE CAMBIOS SIN GUARDAR
  ======================================================================== */
  function saveDraft(draftKey, data) {
    const drafts = readStore(STORAGE_KEYS.DRAFTS, {});
    drafts[draftKey] = { data, updatedAt: Date.now() };
    writeStore(STORAGE_KEYS.DRAFTS, drafts);
  }

  function loadDraft(draftKey) {
    const drafts = readStore(STORAGE_KEYS.DRAFTS, {});
    return drafts[draftKey] ? drafts[draftKey].data : null;
  }

  function clearDraft(draftKey) {
    const drafts = readStore(STORAGE_KEYS.DRAFTS, {});
    delete drafts[draftKey];
    writeStore(STORAGE_KEYS.DRAFTS, drafts);
  }

  function setupDraftAndReloadProtection() {
    // Restaurar borrador de propiedad si hubo recarga a mitad de publicación
    const propDraft = loadDraft('propertyForm');
    if (propDraft) {
      if (propDraft.title) document.getElementById('propTitle').value = propDraft.title;
      if (propDraft.type) document.getElementById('propType').value = propDraft.type;
      if (propDraft.zone) document.getElementById('propZone').value = propDraft.zone;
      if (propDraft.price) document.getElementById('propPrice').value = propDraft.price;
      if (propDraft.size) document.getElementById('propSize').value = propDraft.size;
      if (propDraft.beds !== undefined) document.getElementById('propBeds').value = propDraft.beds;
      if (propDraft.baths !== undefined) document.getElementById('propBaths').value = propDraft.baths;
      if (propDraft.address) document.getElementById('propAddress').value = propDraft.address;
      if (propDraft.description) document.getElementById('propDesc').value = propDraft.description;
    }

    document.getElementById('propertyForm').addEventListener('input', () => {
      hasUnsavedFormWork = true;
      saveDraft('propertyForm', {
        title: document.getElementById('propTitle').value,
        type: document.getElementById('propType').value,
        zone: document.getElementById('propZone').value,
        price: document.getElementById('propPrice').value,
        size: document.getElementById('propSize').value,
        beds: document.getElementById('propBeds').value,
        baths: document.getElementById('propBaths').value,
        address: document.getElementById('propAddress').value,
        description: document.getElementById('propDesc').value
      });
    });

    // Restaurar borrador de reporte
    const reportDraft = loadDraft('reportForm');
    if (reportDraft) {
      if (reportDraft.reason) document.getElementById('reportReason').value = reportDraft.reason;
      if (reportDraft.details) document.getElementById('reportDetails').value = reportDraft.details;
    }

    document.getElementById('reportForm').addEventListener('input', () => {
      hasUnsavedFormWork = true;
      saveDraft('reportForm', {
        reason: document.getElementById('reportReason').value,
        details: document.getElementById('reportDetails').value
      });
    });

    // Avisar al usuario si intenta recargar/cerrar con cambios sin guardar
    window.addEventListener('beforeunload', (e) => {
      if (hasUnsavedFormWork) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // Detectar cambios de conexión a internet para mapa/imágenes externas
    window.addEventListener('offline', () => {
      showToast('Sin conexión a internet: el mapa o fotos externas pueden tardar o no cargar.');
    });
    window.addEventListener('online', () => {
      showToast('Conexión a internet restablecida.');
      if (mapInstance) mapInstance.invalidateSize();
      renderCatalogAndMap();
    });
  }

  /* ========================================================================
     4. AUTENTICACIÓN Y GESTIÓN DE SESIÓN
  ======================================================================== */
  function setupAuthEvents() {
    const tabLogin = document.getElementById('tabLogin');
    const tabRegister = document.getElementById('tabRegister');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');

    tabLogin.addEventListener('click', () => {
      tabLogin.classList.add('active');
      tabRegister.classList.remove('active');
      loginForm.classList.add('active');
      registerForm.classList.remove('active');
    });

    tabRegister.addEventListener('click', () => {
      tabRegister.classList.add('active');
      tabLogin.classList.remove('active');
      registerForm.classList.add('active');
      loginForm.classList.remove('active');
    });

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = loginForm.querySelector('button[type="submit"]');
      await runWithSubmitLock('loginSubmit', submitBtn, async () => {
        const errorEl = document.getElementById('loginError');
        errorEl.textContent = '';

        const emailCheck = validateTextField(document.getElementById('loginEmail').value, {
          label: 'Correo electrónico',
          maxLen: LIMITS.EMAIL_MAX
        });
        if (!emailCheck.ok) {
          errorEl.textContent = emailCheck.error;
          return;
        }
        const email = emailCheck.value.toLowerCase();
        if (!isValidEmail(email)) {
          errorEl.textContent = 'Ingresa un correo electrónico con formato válido.';
          return;
        }

        const passCheck = validateTextField(document.getElementById('loginPassword').value, {
          label: 'Contraseña',
          maxLen: LIMITS.PASSWORD_MAX
        });
        if (!passCheck.ok) {
          errorEl.textContent = passCheck.error;
          return;
        }

        const users = readStore(STORAGE_KEYS.USERS, []);
        const passwordHash = await hashPassword(passCheck.value);
        const user = users.find((u) => u.email === email && u.passwordHash === passwordHash);

        if (!user) {
          errorEl.textContent = 'Credenciales incorrectas. Verifica tu correo o contraseña.';
          return;
        }

        if (!user.active) {
          errorEl.textContent = 'Esta cuenta fue suspendida por un administrador.';
          return;
        }

        startUserSession(user);
      });
    });

    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = registerForm.querySelector('button[type="submit"]');
      await runWithSubmitLock('registerSubmit', submitBtn, async () => {
        const errorEl = document.getElementById('registerError');
        errorEl.textContent = '';

        const roleInput = document.querySelector('input[name="registerRole"]:checked');
        const role = roleInput && ['comprador', 'vendedor'].includes(roleInput.value) ? roleInput.value : 'comprador';

        const nameCheck = validateTextField(document.getElementById('regName').value, {
          label: 'Nombre completo',
          minLen: 2,
          maxLen: LIMITS.NAME_MAX
        });
        if (!nameCheck.ok) {
          errorEl.textContent = nameCheck.error;
          return;
        }

        const emailCheck = validateTextField(document.getElementById('regEmail').value, {
          label: 'Correo electrónico',
          maxLen: LIMITS.EMAIL_MAX
        });
        if (!emailCheck.ok || !isValidEmail(emailCheck.value.toLowerCase())) {
          errorEl.textContent = emailCheck.ok ? 'Ingresa un correo electrónico válido.' : emailCheck.error;
          return;
        }
        const email = emailCheck.value.toLowerCase();

        const phoneCheck = validateTextField(document.getElementById('regPhone').value, {
          label: 'Teléfono',
          minLen: 7,
          maxLen: LIMITS.PHONE_MAX
        });
        if (!phoneCheck.ok || !/^[0-9+\-\s()]{7,}$/.test(phoneCheck.value)) {
          errorEl.textContent = phoneCheck.ok ? 'Ingresa un teléfono válido (solo dígitos y símbolos).' : phoneCheck.error;
          return;
        }

        const passRaw = document.getElementById('regPassword').value;
        if (!passRaw || passRaw.trim().length < LIMITS.PASSWORD_MIN) {
          errorEl.textContent = `La contraseña debe tener al menos ${LIMITS.PASSWORD_MIN} caracteres sin espacios vacíos.`;
          return;
        }
        if (passRaw.length > LIMITS.PASSWORD_MAX) {
          errorEl.textContent = `La contraseña no puede superar ${LIMITS.PASSWORD_MAX} caracteres.`;
          return;
        }

        const users = readStore(STORAGE_KEYS.USERS, []);
        if (users.some((u) => u.email === email)) {
          errorEl.textContent = 'Este correo ya está registrado.';
          return;
        }

        const newUser = {
          id: 'usr_' + Date.now(),
          name: nameCheck.value,
          email,
          phone: phoneCheck.value,
          role,
          passwordHash: await hashPassword(passRaw),
          favorites: [],
          active: true
        };

        users.push(newUser);
        writeStore(STORAGE_KEYS.USERS, users);
        showToast(`¡Bienvenido ${newUser.name}! Cuenta creada como ${role}.`);
        startUserSession(newUser);
      });
    });

    document.querySelectorAll('[data-demo-role]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetRole = btn.getAttribute('data-demo-role');
        const users = readStore(STORAGE_KEYS.USERS, []);
        const demoUser = users.find((u) => u.role === targetRole);
        if (demoUser) {
          startUserSession(demoUser);
        }
      });
    });

    document.getElementById('logoutBtn').addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEYS.SESSION);
      currentUser = null;
      hasUnsavedFormWork = false;
      document.getElementById('appView').classList.add('hidden');
      document.getElementById('authView').classList.remove('hidden');
      showToast('Sesión cerrada correctamente.');
    });
  }

  function startUserSession(user) {
    currentUser = user;
    localStorage.setItem(STORAGE_KEYS.SESSION, user.id);

    document.getElementById('authView').classList.add('hidden');
    document.getElementById('appView').classList.remove('hidden');

    document.getElementById('userNameDisplay').textContent = user.name;
    document.getElementById('userRoleBadge').textContent = user.role;
    document.getElementById('userAvatar').textContent = user.name.charAt(0).toUpperCase();

    const navSellerBtn = document.getElementById('navSellerBtn');
    const navAdminBtn = document.getElementById('navAdminBtn');

    navSellerBtn.classList.toggle('hidden', user.role !== 'vendedor' && user.role !== 'admin');
    navAdminBtn.classList.toggle('hidden', user.role !== 'admin');

    switchSection('exploreSection');
    initMapIfNeeded();
    refreshAllUI();
  }

  /* ========================================================================
     5. NAVEGACIÓN ENTRE SECCIONES Y VISTAS
  ======================================================================== */
  function setupNavigationEvents() {
    document.querySelectorAll('.nav-btn[data-section]').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchSection(btn.getAttribute('data-section'));
      });
    });

    const layout = document.getElementById('exploreLayout');
    const catalogCol = document.getElementById('catalogColumn');
    const mapCol = document.getElementById('mapColumn');

    document.getElementById('viewSplitBtn').addEventListener('click', (e) => {
      setActiveToggle(e.target);
      layout.className = 'explore-layout';
      catalogCol.classList.remove('hidden');
      mapCol.classList.remove('hidden');
      setTimeout(() => mapInstance && mapInstance.invalidateSize(), 150);
    });

    document.getElementById('viewGridBtn').addEventListener('click', (e) => {
      setActiveToggle(e.target);
      layout.className = 'explore-layout only-grid';
      catalogCol.classList.remove('hidden');
      mapCol.classList.add('hidden');
    });

    document.getElementById('viewMapBtn').addEventListener('click', (e) => {
      setActiveToggle(e.target);
      layout.className = 'explore-layout only-map';
      catalogCol.classList.add('hidden');
      mapCol.classList.remove('hidden');
      setTimeout(() => mapInstance && mapInstance.invalidateSize(), 150);
    });

    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const modalId = btn.getAttribute('data-close-modal');
        document.getElementById(modalId).classList.add('hidden');
      });
    });
  }

  function setActiveToggle(activeBtn) {
    document.querySelectorAll('.toggle-btn').forEach((b) => b.classList.remove('active'));
    activeBtn.classList.add('active');
  }

  function switchSection(sectionId) {
    document.querySelectorAll('.content-section').forEach((sec) => sec.classList.remove('active'));
    document.getElementById(sectionId).classList.add('active');

    document.querySelectorAll('.nav-btn[data-section]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-section') === sectionId);
    });

    if (sectionId === 'exploreSection' && mapInstance) {
      setTimeout(() => mapInstance.invalidateSize(), 150);
    }
  }

  /* ========================================================================
     6. FILTROS, CATÁLOGO Y FAVORITOS (COMPRADOR)
  ======================================================================== */
  function getFilteredProperties() {
    const allProps = readStore(STORAGE_KEYS.PROPERTIES, []).filter((p) => p.status === 'activa');
    const zone = document.getElementById('filterZone').value;
    const type = document.getElementById('filterType').value;

    const rawMaxPrice = document.getElementById('filterMaxPrice').value.trim();
    const rawMinSize = document.getElementById('filterMinSize').value.trim();

    const maxPriceNum = rawMaxPrice !== '' && Number(rawMaxPrice) > 0 ? Number(rawMaxPrice) : null;
    const minSizeNum = rawMinSize !== '' && Number(rawMinSize) > 0 ? Number(rawMinSize) : null;

    return allProps.filter((prop) => {
      if (zone !== 'todas' && prop.zone !== zone) return false;
      if (type !== 'todos' && prop.type !== type) return false;
      if (maxPriceNum !== null && prop.price > maxPriceNum) return false;
      if (minSizeNum !== null && prop.size < minSizeNum) return false;
      return true;
    });
  }

  function setupFilterEvents() {
    ['filterZone', 'filterType', 'filterMaxPrice', 'filterMinSize'].forEach((id) => {
      document.getElementById(id).addEventListener('input', (e) => {
        // Evita números negativos en filtros
        if ((id === 'filterMaxPrice' || id === 'filterMinSize') && Number(e.target.value) < 0) {
          e.target.value = '';
        }
        renderCatalogAndMap();
      });
    });

    document.getElementById('resetFiltersBtn').addEventListener('click', () => {
      document.getElementById('filterZone').value = 'todas';
      document.getElementById('filterType').value = 'todos';
      document.getElementById('filterMaxPrice').value = '';
      document.getElementById('filterMinSize').value = '';
      renderCatalogAndMap();
    });

    ['toggleSchools', 'toggleHospitals', 'toggleMarkets'].forEach((id) => {
      document.getElementById(id).addEventListener('change', renderNearbyServicesOnMap);
    });
  }

  function buildPropertyCardHTML(prop) {
    const isFav = currentUser && Array.isArray(currentUser.favorites) && currentUser.favorites.includes(prop.id);
    const specsText =
      prop.type === 'Terreno'
        ? `📐 ${prop.size} m² • Zona ${sanitize(prop.zone)}`
        : `📐 ${prop.size} m² • 🛏️ ${prop.beds} rec. • 🚿 ${prop.baths} baños`;

    return `
      <article class="property-card">
        <div class="property-img-wrap">
          <img src="${sanitize(prop.image || FALLBACK_IMAGE)}" alt="${sanitize(prop.title)}" loading="lazy" onerror="window.__handleImgError(this)" />
          <span class="prop-type-badge">${sanitize(prop.type)}</span>
          <button type="button" class="fav-btn ${isFav ? 'active' : ''}" data-fav-id="${prop.id}" title="Guardar en favoritos">
            ${isFav ? '♥' : '♡'}
          </button>
        </div>
        <div class="property-body">
          <div class="property-price">${formatCurrency(prop.price)}</div>
          <h3 class="property-title">${sanitize(prop.title)}</h3>
          <p class="property-loc">📍 ${sanitize(prop.address)}</p>
          <div class="property-specs">${specsText}</div>
          <div class="property-footer">
            <button type="button" class="btn btn-primary btn-sm" style="flex:1;" data-detail-id="${prop.id}">Ver detalles</button>
            <button type="button" class="btn btn-outline btn-sm" data-focus-map-id="${prop.id}" title="Ubicar en el mapa">🗺️</button>
          </div>
        </div>
      </article>
    `;
  }

  window.__handleImgError = function (imgEl) {
    if (imgEl && !imgEl.dataset.fallbackApplied) {
      imgEl.dataset.fallbackApplied = '1';
      imgEl.src = FALLBACK_IMAGE;
    }
  };

  function renderCatalogAndMap() {
    const filtered = getFilteredProperties();
    const grid = document.getElementById('propertiesGrid');
    document.getElementById('resultsCounter').textContent = `Mostrando ${filtered.length} propiedad(es) disponible(s)`;

    if (filtered.length === 0) {
      grid.innerHTML = `<p>No se encontraron propiedades que coincidan con tu búsqueda o filtros.</p>`;
    } else {
      grid.innerHTML = filtered.map(buildPropertyCardHTML).join('');
    }

    renderPropertiesOnMap(filtered);
    renderFavoritesSection();
  }

  function renderFavoritesSection() {
    if (!currentUser) return;
    const allProps = readStore(STORAGE_KEYS.PROPERTIES, []);
    const favList = Array.isArray(currentUser.favorites) ? currentUser.favorites : [];
    const favProps = allProps.filter((p) => favList.includes(p.id));
    document.getElementById('favCountBadge').textContent = favProps.length;

    const favGrid = document.getElementById('favoritesGrid');
    if (favProps.length === 0) {
      favGrid.innerHTML = `<p>Aún no tienes propiedades favoritas. Haz clic en el corazón (♡) de cualquier anuncio.</p>`;
    } else {
      favGrid.innerHTML = favProps.map(buildPropertyCardHTML).join('');
    }
  }

  function toggleFavorite(propertyId) {
    const users = readStore(STORAGE_KEYS.USERS, []);
    const idx = users.findIndex((u) => u.id === currentUser.id);
    if (idx === -1) return;

    const favs = Array.isArray(users[idx].favorites) ? users[idx].favorites : [];
    if (favs.includes(propertyId)) {
      users[idx].favorites = favs.filter((id) => id !== propertyId);
      showToast('Eliminada de favoritos.');
    } else {
      users[idx].favorites.push(propertyId);
      showToast('Guardada en favoritos ♥');
    }

    currentUser = users[idx];
    writeStore(STORAGE_KEYS.USERS, users);
    refreshAllUI();
  }

  /* ========================================================================
     7. MAPA INTERACTIVO (LEAFLET.JS) Y CERCANÍA A SERVICIOS
  ======================================================================== */
  function initMapIfNeeded() {
    if (mapInstance) return;
    if (typeof L === 'undefined') {
      const mapEl = document.getElementById('propertyMap');
      if (mapEl) {
        mapEl.innerHTML =
          '<div style="padding:20px;color:#475569;">El servicio de mapas no está disponible en este momento (verifica tu conexión o bloqueadores).</div>';
      }
      return;
    }

    try {
      mapInstance = L.map('propertyMap').setView([31.8667, -116.645], 12);
      const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
      });
      tileLayer.on('tileerror', () => {
        if (!navigator.onLine) {
          showToast('Sin conexión para cargar mosaicos del mapa.');
        }
      });
      tileLayer.addTo(mapInstance);

      propertyMarkersLayer = L.layerGroup().addTo(mapInstance);
      poiMarkersLayer = L.layerGroup().addTo(mapInstance);

      renderNearbyServicesOnMap();
    } catch {
      showToast('No fue posible inicializar el mapa interactivo.');
    }
  }

  function renderPropertiesOnMap(properties) {
    if (!mapInstance || !propertyMarkersLayer) return;
    propertyMarkersLayer.clearLayers();

    properties.forEach((prop) => {
      if (!Number.isFinite(prop.lat) || !Number.isFinite(prop.lng)) return;
      const marker = L.marker([prop.lat, prop.lng]);
      marker.bindPopup(`
        <div style="min-width:190px;">
          <strong>${sanitize(prop.title)}</strong><br/>
          <span style="color:#0f4c81;font-weight:700;">${formatCurrency(prop.price)}</span><br/>
          <small>${sanitize(prop.type)} • ${prop.size} m²</small><br/>
          <button type="button" onclick="window.__openPropertyDetail('${prop.id}')"
            style="margin-top:6px;padding:4px 8px;background:#0f4c81;color:#fff;border:none;border-radius:4px;cursor:pointer;">
            Ver publicación
          </button>
        </div>
      `);
      marker.addTo(propertyMarkersLayer);
    });
  }

  function renderNearbyServicesOnMap() {
    if (!mapInstance || !poiMarkersLayer) return;
    poiMarkersLayer.clearLayers();

    const showSchools = document.getElementById('toggleSchools').checked;
    const showHospitals = document.getElementById('toggleHospitals').checked;
    const showMarkets = document.getElementById('toggleMarkets').checked;

    const categoryMeta = {
      school: { enabled: showSchools, emoji: '🎓', label: 'Escuela / Universidad', color: '#2563eb' },
      hospital: { enabled: showHospitals, emoji: '🏥', label: 'Hospital / Clínica', color: '#dc2626' },
      market: { enabled: showMarkets, emoji: '🛒', label: 'Supermercado', color: '#16a34a' }
    };

    NEARBY_SERVICES.forEach((srv) => {
      const meta = categoryMeta[srv.category];
      if (!meta || !meta.enabled) return;

      const icon = L.divIcon({
        className: 'custom-poi-pin',
        html: `<div style="background:${meta.color};color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3);">${meta.emoji}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });

      L.marker([srv.lat, srv.lng], { icon })
        .bindPopup(`<strong>${meta.emoji} ${sanitize(srv.name)}</strong><br/><small>${meta.label}</small>`)
        .addTo(poiMarkersLayer);
    });
  }

  function calculateNearestServices(lat, lng) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    return NEARBY_SERVICES.map((srv) => {
      const R = 6371;
      const dLat = toRad(srv.lat - lat);
      const dLng = toRad(srv.lng - lng);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat)) * Math.cos(toRad(srv.lat)) * Math.sin(dLng / 2) ** 2;
      const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return { ...srv, distanceKm: dist.toFixed(1) };
    })
      .sort((a, b) => parseFloat(a.distanceKm) - parseFloat(b.distanceKm))
      .slice(0, 3);
  }

  /* ========================================================================
     8. DETALLE DE PROPIEDAD, CONTACTO DIRECTO Y REPORTES
  ======================================================================== */
  window.__openPropertyDetail = function (propertyId) {
    const properties = readStore(STORAGE_KEYS.PROPERTIES, []);
    const prop = properties.find((p) => p.id === propertyId);
    if (!prop) return;

    prop.views = (prop.views || 0) + 1;
    writeStore(STORAGE_KEYS.PROPERTIES, properties);
    renderSellerDashboard();

    const nearest = calculateNearestServices(prop.lat, prop.lng);
    const nearestHTML = nearest
      .map((s) => `<li><strong>${sanitize(s.name)}</strong> — a ${s.distanceKm} km</li>`)
      .join('');

    const favList = Array.isArray(currentUser?.favorites) ? currentUser.favorites : [];

    const detailContainer = document.getElementById('propertyDetailContent');
    detailContainer.innerHTML = `
      <img src="${sanitize(prop.image || FALLBACK_IMAGE)}" alt="${sanitize(prop.title)}" class="detail-hero" onerror="window.__handleImgError(this)" />
      <div class="detail-header">
        <div>
          <span class="status-pill status-active">${sanitize(prop.type)} • ${sanitize(prop.zone)}</span>
          <h2 style="margin-top:6px;">${sanitize(prop.title)}</h2>
          <p style="color:var(--text-muted);">📍 ${sanitize(prop.address)}</p>
        </div>
        <div style="text-align:right;">
          <div class="property-price" style="font-size:1.45rem;">${formatCurrency(prop.price)}</div>
          <small style="color:var(--text-muted);">👁️ ${prop.views} visitas</small>
        </div>
      </div>

      <div class="property-specs">
        <span>📐 Superficie: <strong>${prop.size} m²</strong></span>
        ${prop.type !== 'Terreno' ? `<span>🛏️ Recámaras: <strong>${prop.beds}</strong></span><span>🚿 Baños: <strong>${prop.baths}</strong></span>` : ''}
        <span>👤 Vendedor: <strong>${sanitize(prop.sellerName)}</strong></span>
      </div>

      <p style="margin:12px 0;">${sanitize(prop.description)}</p>

      <div class="detail-nearby">
        <strong>Servicios importantes cercanos:</strong>
        <ul style="margin-left:18px;margin-top:6px;">${nearestHTML}</ul>
      </div>

      <div class="modal-actions" style="justify-content:space-between;flex-wrap:wrap;">
        <button type="button" class="btn btn-ghost btn-sm" id="btnOpenReportModal">🚩 Denunciar anuncio</button>
        <div style="display:flex;gap:10px;">
          <button type="button" class="btn btn-secondary" id="btnDetailFav">
            ${favList.includes(prop.id) ? '♥ En Favoritos' : '♡ Guardar Favorito'}
          </button>
          <button type="button" class="btn btn-primary" id="btnContactSeller">💬 Contactar al Vendedor</button>
        </div>
      </div>
    `;

    document.getElementById('btnDetailFav').addEventListener('click', () => {
      toggleFavorite(prop.id);
      window.__openPropertyDetail(prop.id);
    });

    document.getElementById('btnContactSeller').addEventListener('click', () => {
      document.getElementById('propertyDetailModal').classList.add('hidden');
      startOrOpenChat(prop);
    });

    document.getElementById('btnOpenReportModal').addEventListener('click', () => {
      document.getElementById('propertyDetailModal').classList.add('hidden');
      document.getElementById('reportPropId').value = prop.id;
      document.getElementById('reportModal').classList.remove('hidden');
    });

    document.getElementById('propertyDetailModal').classList.remove('hidden');
  };

  function setupReportForm() {
    const reportForm = document.getElementById('reportForm');
    reportForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = reportForm.querySelector('button[type="submit"]');
      await runWithSubmitLock('reportSubmit', submitBtn, async () => {
        const propertyId = document.getElementById('reportPropId').value;
        const reasonCheck = validateTextField(document.getElementById('reportReason').value, {
          label: 'Motivo del reporte',
          maxLen: 100
        });
        const detailsCheck = validateTextField(document.getElementById('reportDetails').value, {
          label: 'Detalles adicionales',
          minLen: 5,
          maxLen: LIMITS.REPORT_DETAILS_MAX
        });

        if (!reasonCheck.ok) {
          showToast(reasonCheck.error);
          return;
        }
        if (!detailsCheck.ok) {
          showToast(detailsCheck.error);
          return;
        }

        const prop = readStore(STORAGE_KEYS.PROPERTIES, []).find((p) => p.id === propertyId);
        if (!prop) {
          showToast('La propiedad reportada ya no existe.');
          return;
        }

        const reports = readStore(STORAGE_KEYS.REPORTS, []);
        reports.unshift({
          id: 'rep_' + Date.now(),
          propertyId: prop.id,
          propertyTitle: prop.title,
          reason: reasonCheck.value,
          details: detailsCheck.value,
          reportedBy: currentUser.name,
          status: 'pendiente'
        });

        writeStore(STORAGE_KEYS.REPORTS, reports);
        clearDraft('reportForm');
        hasUnsavedFormWork = false;
        reportForm.reset();
        document.getElementById('reportModal').classList.add('hidden');
        showToast('Reporte enviado al panel de administración.');
        renderAdminPanel();
      });
    });
  }

  /* ========================================================================
     9. PANEL DEL VENDEDOR (CREAR, EDITAR, PAUSAR, ELIMINAR Y ESTADÍSTICAS)
  ======================================================================== */
  function setupSellerEvents() {
    const propForm = document.getElementById('propertyForm');

    document.getElementById('openNewPropertyModalBtn').addEventListener('click', () => {
      document.getElementById('propertyFormTitle').textContent = 'Publicar Nueva Propiedad';
      propForm.reset();
      document.getElementById('propId').value = '';
      document.getElementById('propFormError').textContent = '';
      clearDraft('propertyForm');
      hasUnsavedFormWork = false;
      document.getElementById('propertyFormModal').classList.remove('hidden');
    });

    propForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = propForm.querySelector('button[type="submit"]');
      await runWithSubmitLock('propertySubmit', submitBtn, async () => {
        const errorEl = document.getElementById('propFormError');
        errorEl.textContent = '';

        const id = document.getElementById('propId').value.trim();
        const titleCheck = validateTextField(document.getElementById('propTitle').value, {
          label: 'Título del anuncio',
          minLen: 3,
          maxLen: LIMITS.PROP_TITLE_MAX
        });
        if (!titleCheck.ok) {
          errorEl.textContent = titleCheck.error;
          return;
        }

        const type = document.getElementById('propType').value;
        const zone = document.getElementById('propZone').value;

        const priceCheck = parseStrictNumber(document.getElementById('propPrice').value, {
          min: 0,
          max: LIMITS.MAX_PRICE,
          allowZero: false,
          label: 'Precio (MXN)'
        });
        if (!priceCheck.ok) {
          errorEl.textContent = priceCheck.error;
          return;
        }

        const sizeCheck = parseStrictNumber(document.getElementById('propSize').value, {
          min: 0,
          max: LIMITS.MAX_SIZE,
          allowZero: false,
          label: 'Superficie (m²)'
        });
        if (!sizeCheck.ok) {
          errorEl.textContent = sizeCheck.error;
          return;
        }

        const bedsCheck = parseStrictNumber(document.getElementById('propBeds').value, {
          min: 0,
          max: LIMITS.MAX_ROOMS,
          allowZero: true,
          label: 'Recámaras'
        });
        if (!bedsCheck.ok) {
          errorEl.textContent = bedsCheck.error;
          return;
        }

        const bathsCheck = parseStrictNumber(document.getElementById('propBaths').value, {
          min: 0,
          max: LIMITS.MAX_ROOMS,
          allowZero: true,
          label: 'Baños'
        });
        if (!bathsCheck.ok) {
          errorEl.textContent = bathsCheck.error;
          return;
        }

        const addressCheck = validateTextField(document.getElementById('propAddress').value, {
          label: 'Dirección o referencia',
          minLen: 4,
          maxLen: LIMITS.PROP_ADDRESS_MAX
        });
        if (!addressCheck.ok) {
          errorEl.textContent = addressCheck.error;
          return;
        }

        const latCheck = parseStrictNumber(document.getElementById('propLat').value, {
          min: -90,
          max: 90,
          allowZero: true,
          label: 'Latitud'
        });
        if (!latCheck.ok) {
          errorEl.textContent = latCheck.error;
          return;
        }

        const lngCheck = parseStrictNumber(document.getElementById('propLng').value, {
          min: -180,
          max: 180,
          allowZero: true,
          label: 'Longitud'
        });
        if (!lngCheck.ok) {
          errorEl.textContent = lngCheck.error;
          return;
        }

        const descCheck = validateTextField(document.getElementById('propDesc').value, {
          label: 'Descripción detallada',
          minLen: 10,
          maxLen: LIMITS.PROP_DESC_MAX
        });
        if (!descCheck.ok) {
          errorEl.textContent = descCheck.error;
          return;
        }

        const imageUrlInput = document.getElementById('propImageUrl').value.trim();
        const fileInput = document.getElementById('propImageFile');

        if (imageUrlInput && !isSafeHttpUrl(imageUrlInput)) {
          errorEl.textContent = 'La URL de la imagen debe comenzar con http:// o https://.';
          return;
        }

        if (fileInput.files && fileInput.files[0]) {
          const file = fileInput.files[0];
          if (!file.type.startsWith('image/')) {
            errorEl.textContent = 'El archivo seleccionado debe ser una imagen válida.';
            return;
          }
          if (file.size > 3 * 1024 * 1024) {
            errorEl.textContent = 'La imagen no debe superar 3 MB.';
            return;
          }
        }

        let finalImage = imageUrlInput || FALLBACK_IMAGE;
        if (fileInput.files && fileInput.files[0]) {
          finalImage = await fileToDataURL(fileInput.files[0]);
        }

        const properties = readStore(STORAGE_KEYS.PROPERTIES, []);

        if (id) {
          const index = properties.findIndex((p) => p.id === id);
          if (index !== -1) {
            properties[index] = {
              ...properties[index],
              title: titleCheck.value,
              type,
              zone,
              price: priceCheck.value,
              size: sizeCheck.value,
              beds: Math.trunc(bedsCheck.value),
              baths: Math.trunc(bathsCheck.value),
              address: addressCheck.value,
              lat: latCheck.value,
              lng: lngCheck.value,
              image: fileInput.files[0] || imageUrlInput ? finalImage : properties[index].image,
              description: descCheck.value
            };
            showToast('Publicación actualizada correctamente.');
          }
        } else {
          properties.unshift({
            id: 'prop_' + Date.now(),
            sellerId: currentUser.id,
            sellerName: currentUser.name,
            title: titleCheck.value,
            type,
            zone,
            price: priceCheck.value,
            size: sizeCheck.value,
            beds: Math.trunc(bedsCheck.value),
            baths: Math.trunc(bathsCheck.value),
            address: addressCheck.value,
            lat: latCheck.value,
            lng: lngCheck.value,
            image: finalImage,
            description: descCheck.value,
            views: 1,
            status: 'activa'
          });
          showToast('¡Propiedad publicada con éxito!');
        }

        writeStore(STORAGE_KEYS.PROPERTIES, properties);
        clearDraft('propertyForm');
        hasUnsavedFormWork = false;
        document.getElementById('propertyFormModal').classList.add('hidden');
        refreshAllUI();
      });
    });
  }

  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Error al leer la imagen'));
      reader.readAsDataURL(file);
    });
  }

  function renderSellerDashboard() {
    if (!currentUser) return;
    const allProps = readStore(STORAGE_KEYS.PROPERTIES, []);
    const myProps =
      currentUser.role === 'admin'
        ? allProps
        : allProps.filter((p) => p.sellerId === currentUser.id);

    const allUsers = readStore(STORAGE_KEYS.USERS, []);
    const myPropIds = myProps.map((p) => p.id);
    const totalFavs = allUsers.reduce((acc, u) => {
      const favs = Array.isArray(u.favorites) ? u.favorites : [];
      return acc + favs.filter((fid) => myPropIds.includes(fid)).length;
    }, 0);

    const myChats = readStore(STORAGE_KEYS.MESSAGES, []).filter((c) => myPropIds.includes(c.propertyId));

    document.getElementById('statTotalProps').textContent = myProps.length;
    document.getElementById('statTotalViews').textContent = myProps.reduce((sum, p) => sum + (p.views || 0), 0);
    document.getElementById('statTotalFavs').textContent = totalFavs;
    document.getElementById('statTotalChats').textContent = myChats.length;

    const tbody = document.getElementById('sellerPropertiesTable');
    if (myProps.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6">Aún no tienes propiedades publicadas. Haz clic en "+ Publicar Propiedad".</td></tr>`;
      return;
    }

    tbody.innerHTML = myProps
      .map(
        (prop) => `
      <tr>
        <td><strong>${sanitize(prop.title)}</strong></td>
        <td>${sanitize(prop.zone)} • ${sanitize(prop.type)}</td>
        <td>${formatCurrency(prop.price)}</td>
        <td>${prop.views || 0}</td>
        <td>
          <span class="status-pill ${prop.status === 'activa' ? 'status-active' : 'status-paused'}">
            ${prop.status === 'activa' ? 'Activa' : 'Pausada'}
          </span>
        </td>
        <td>
          <button type="button" class="btn btn-secondary btn-sm" data-edit-prop="${prop.id}">Editar</button>
          <button type="button" class="btn btn-outline btn-sm" data-toggle-prop="${prop.id}">
            ${prop.status === 'activa' ? 'Pausar' : 'Activar'}
          </button>
          <button type="button" class="btn btn-danger btn-sm" data-delete-prop="${prop.id}">Eliminar</button>
        </td>
      </tr>
    `
      )
      .join('');
  }

  /* ========================================================================
     10. CHAT INTERNO COMPRADOR - VENDEDOR
  ======================================================================== */
  function setupChatEvents() {
    const drawer = document.getElementById('chatDrawer');
    document.getElementById('openMessagesBtn').addEventListener('click', () => {
      drawer.classList.remove('hidden');
      renderChatThreads();
    });

    document.getElementById('closeChatDrawerBtn').addEventListener('click', () => {
      drawer.classList.add('hidden');
    });

    const chatForm = document.getElementById('chatSendForm');
    chatForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!activeChatThreadId) return;
      const submitBtn = chatForm.querySelector('button[type="submit"]');
      await runWithSubmitLock('chatSend', submitBtn, async () => {
        const input = document.getElementById('chatMessageInput');
        const msgCheck = validateTextField(input.value, {
          label: 'Mensaje',
          minLen: 1,
          maxLen: LIMITS.CHAT_MSG_MAX
        });
        if (!msgCheck.ok) {
          showToast(msgCheck.error);
          return;
        }

        const threads = readStore(STORAGE_KEYS.MESSAGES, []);
        const thread = threads.find((t) => t.id === activeChatThreadId);
        if (!thread) return;

        const now = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
        thread.messages.push({
          senderId: currentUser.id,
          senderName: currentUser.name,
          text: msgCheck.value,
          timestamp: now
        });

        writeStore(STORAGE_KEYS.MESSAGES, threads);
        input.value = '';
        renderChatThreads();
        renderActiveChatMessages();
      });
    });
  }

  function startOrOpenChat(property) {
    const threads = readStore(STORAGE_KEYS.MESSAGES, []);
    const threadId = `chat_${property.id}_${currentUser.id}`;
    let thread = threads.find((t) => t.id === threadId);

    if (!thread) {
      thread = {
        id: threadId,
        propertyId: property.id,
        propertyTitle: property.title,
        buyerId: currentUser.id,
        buyerName: currentUser.name,
        sellerId: property.sellerId,
        sellerName: property.sellerName,
        messages: [
          {
            senderId: currentUser.id,
            senderName: currentUser.name,
            text: `Hola ${property.sellerName}, me interesa la propiedad "${property.title}". ¿Podríamos coordinar una cita para visitarla?`,
            timestamp: new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
          }
        ]
      };
      threads.unshift(thread);
      writeStore(STORAGE_KEYS.MESSAGES, threads);
    }

    activeChatThreadId = thread.id;
    document.getElementById('chatDrawer').classList.remove('hidden');
    renderChatThreads();
    renderActiveChatMessages();
  }

  function getUserThreads() {
    if (!currentUser) return [];
    const threads = readStore(STORAGE_KEYS.MESSAGES, []);
    if (currentUser.role === 'admin') return threads;
    return threads.filter((t) => t.buyerId === currentUser.id || t.sellerId === currentUser.id);
  }

  function renderChatThreads() {
    const threads = getUserThreads();
    document.getElementById('msgCountBadge').textContent = threads.length;
    const listEl = document.getElementById('chatThreadsList');

    if (threads.length === 0) {
      listEl.innerHTML = `<p style="padding:14px;font-size:0.84rem;color:var(--text-muted);">No tienes conversaciones aún.</p>`;
      return;
    }

    if (!activeChatThreadId || !threads.some((t) => t.id === activeChatThreadId)) {
      activeChatThreadId = threads[0].id;
    }

    listEl.innerHTML = threads
      .map((t) => {
        const counterpart = t.buyerId === currentUser.id ? t.sellerName : t.buyerName;
        return `
          <div class="thread-item ${t.id === activeChatThreadId ? 'active' : ''}" data-thread-id="${t.id}">
            <strong>${sanitize(counterpart)}</strong>
            <span>${sanitize(t.propertyTitle)}</span>
          </div>
        `;
      })
      .join('');

    renderActiveChatMessages();
  }

  function renderActiveChatMessages() {
    const threads = getUserThreads();
    const thread = threads.find((t) => t.id === activeChatThreadId);
    const headerEl = document.getElementById('activeChatHeader');
    const containerEl = document.getElementById('chatMessagesContainer');
    const formEl = document.getElementById('chatSendForm');

    if (!thread) {
      headerEl.textContent = 'Selecciona una conversación';
      containerEl.innerHTML = `<p class="empty-hint">Selecciona un chat o inicia uno desde el detalle de una propiedad.</p>`;
      formEl.classList.add('hidden');
      return;
    }

    headerEl.textContent = `${thread.propertyTitle} (${thread.buyerName} ↔ ${thread.sellerName})`;
    formEl.classList.remove('hidden');

    containerEl.innerHTML = thread.messages
      .map((m) => {
        const isMine = m.senderId === currentUser.id;
        return `
          <div class="msg-bubble ${isMine ? 'msg-mine' : 'msg-theirs'}">
            ${sanitize(m.text)}
            <span class="msg-meta">${sanitize(m.senderName)} • ${sanitize(m.timestamp)}</span>
          </div>
        `;
      })
      .join('');

    containerEl.scrollTop = containerEl.scrollHeight;
  }

  /* ========================================================================
     11. PANEL DE ADMINISTRACIÓN (REPORTES Y USUARIOS)
  ======================================================================== */
  function renderAdminPanel() {
    const reports = readStore(STORAGE_KEYS.REPORTS, []);
    const pendingCount = reports.filter((r) => r.status === 'pendiente').length;
    document.getElementById('reportCountBadge').textContent = pendingCount;

    const reportsTbody = document.getElementById('adminReportsTable');
    if (reports.length === 0) {
      reportsTbody.innerHTML = `<tr><td colspan="5">No hay reportes registrados.</td></tr>`;
    } else {
      reportsTbody.innerHTML = reports
        .map(
          (rep) => `
        <tr>
          <td><strong>${sanitize(rep.propertyTitle)}</strong></td>
          <td>${sanitize(rep.reason)}<br/><small style="color:var(--text-muted);">${sanitize(rep.details)}</small></td>
          <td>${sanitize(rep.reportedBy)}</td>
          <td>
            <span class="status-pill ${rep.status === 'pendiente' ? 'status-pending' : 'status-active'}">
              ${rep.status === 'pendiente' ? 'Pendiente' : 'Resuelto'}
            </span>
          </td>
          <td>
            ${
              rep.status === 'pendiente'
                ? `<button type="button" class="btn btn-secondary btn-sm" data-resolve-report="${rep.id}">Descartar</button>
                   <button type="button" class="btn btn-danger btn-sm" data-remove-reported-prop="${rep.id}">Eliminar Anuncio</button>`
                : '—'
            }
          </td>
        </tr>
      `
        )
        .join('');
    }

    const users = readStore(STORAGE_KEYS.USERS, []);
    const usersTbody = document.getElementById('adminUsersTable');
    if (users.length === 0) {
      usersTbody.innerHTML = `<tr><td colspan="5">No hay usuarios registrados.</td></tr>`;
      return;
    }

    usersTbody.innerHTML = users
      .map(
        (u) => `
      <tr>
        <td><strong>${sanitize(u.name)}</strong></td>
        <td>${sanitize(u.email)}</td>
        <td style="text-transform:capitalize;">${sanitize(u.role)}</td>
        <td>
          <span class="status-pill ${u.active ? 'status-active' : 'status-pending'}">
            ${u.active ? 'Activo' : 'Suspendido'}
          </span>
        </td>
        <td>
          ${
            u.role !== 'admin'
              ? `<button type="button" class="btn btn-outline btn-sm" data-toggle-user="${u.id}">
                  ${u.active ? 'Suspender' : 'Reactivar'}
                </button>`
              : 'Protegido'
          }
        </td>
      </tr>
    `
      )
      .join('');
  }

  /* ========================================================================
     12. DELEGACIÓN GLOBAL DE EVENTOS DINÁMICOS
  ======================================================================== */
  function setupDelegatedActions() {
    document.body.addEventListener('click', (e) => {
      const favBtn = e.target.closest('[data-fav-id]');
      if (favBtn) {
        toggleFavorite(favBtn.getAttribute('data-fav-id'));
        return;
      }

      const detailBtn = e.target.closest('[data-detail-id]');
      if (detailBtn) {
        window.__openPropertyDetail(detailBtn.getAttribute('data-detail-id'));
        return;
      }

      const mapBtn = e.target.closest('[data-focus-map-id]');
      if (mapBtn && mapInstance) {
        const prop = readStore(STORAGE_KEYS.PROPERTIES, []).find(
          (p) => p.id === mapBtn.getAttribute('data-focus-map-id')
        );
        if (prop) {
          mapInstance.setView([prop.lat, prop.lng], 15);
          showToast(`Ubicando "${prop.title}" en el mapa.`);
        }
        return;
      }

      const editBtn = e.target.closest('[data-edit-prop]');
      if (editBtn) {
        const prop = readStore(STORAGE_KEYS.PROPERTIES, []).find(
          (p) => p.id === editBtn.getAttribute('data-edit-prop')
        );
        if (prop) {
          document.getElementById('propertyFormTitle').textContent = 'Editar Publicación';
          document.getElementById('propId').value = prop.id;
          document.getElementById('propTitle').value = prop.title;
          document.getElementById('propType').value = prop.type;
          document.getElementById('propZone').value = prop.zone;
          document.getElementById('propPrice').value = prop.price;
          document.getElementById('propSize').value = prop.size;
          document.getElementById('propBeds').value = prop.beds;
          document.getElementById('propBaths').value = prop.baths;
          document.getElementById('propAddress').value = prop.address;
          document.getElementById('propLat').value = prop.lat;
          document.getElementById('propLng').value = prop.lng;
          document.getElementById('propImageUrl').value = prop.image && prop.image.startsWith('http') ? prop.image : '';
          document.getElementById('propDesc').value = prop.description;
          document.getElementById('propertyFormModal').classList.remove('hidden');
        }
        return;
      }

      const togglePropBtn = e.target.closest('[data-toggle-prop]');
      if (togglePropBtn) {
        const props = readStore(STORAGE_KEYS.PROPERTIES, []);
        const prop = props.find((p) => p.id === togglePropBtn.getAttribute('data-toggle-prop'));
        if (prop) {
          prop.status = prop.status === 'activa' ? 'pausada' : 'activa';
          writeStore(STORAGE_KEYS.PROPERTIES, props);
          showToast(`Publicación marcada como ${prop.status}.`);
          refreshAllUI();
        }
        return;
      }

      const deletePropBtn = e.target.closest('[data-delete-prop]');
      if (deletePropBtn) {
        const targetId = deletePropBtn.getAttribute('data-delete-prop');
        const props = readStore(STORAGE_KEYS.PROPERTIES, []).filter((p) => p.id !== targetId);
        writeStore(STORAGE_KEYS.PROPERTIES, props);
        showToast('Publicación eliminada.');
        refreshAllUI();
        return;
      }

      const threadItem = e.target.closest('[data-thread-id]');
      if (threadItem) {
        activeChatThreadId = threadItem.getAttribute('data-thread-id');
        renderChatThreads();
        return;
      }

      const resolveRepBtn = e.target.closest('[data-resolve-report]');
      if (resolveRepBtn) {
        const reports = readStore(STORAGE_KEYS.REPORTS, []);
        const rep = reports.find((r) => r.id === resolveRepBtn.getAttribute('data-resolve-report'));
        if (rep) {
          rep.status = 'resuelto';
          writeStore(STORAGE_KEYS.REPORTS, reports);
          showToast('Reporte marcado como resuelto.');
          renderAdminPanel();
        }
        return;
      }

      const removeReportedBtn = e.target.closest('[data-remove-reported-prop]');
      if (removeReportedBtn) {
        const reports = readStore(STORAGE_KEYS.REPORTS, []);
        const rep = reports.find((r) => r.id === removeReportedBtn.getAttribute('data-remove-reported-prop'));
        if (rep) {
          rep.status = 'resuelto';
          writeStore(STORAGE_KEYS.REPORTS, reports);
          const props = readStore(STORAGE_KEYS.PROPERTIES, []).filter((p) => p.id !== rep.propertyId);
          writeStore(STORAGE_KEYS.PROPERTIES, props);
          showToast('Anuncio eliminado y reporte resuelto.');
          refreshAllUI();
        }
        return;
      }

      const toggleUserBtn = e.target.closest('[data-toggle-user]');
      if (toggleUserBtn) {
        const users = readStore(STORAGE_KEYS.USERS, []);
        const user = users.find((u) => u.id === toggleUserBtn.getAttribute('data-toggle-user'));
        if (user) {
          user.active = !user.active;
          writeStore(STORAGE_KEYS.USERS, users);
          showToast(`Estado de usuario actualizado (${user.active ? 'Activo' : 'Suspendido'}).`);
          renderAdminPanel();
        }
      }
    });
  }

  function refreshAllUI() {
    renderCatalogAndMap();
    renderSellerDashboard();
    renderChatThreads();
    renderAdminPanel();
  }

  /* ========================================================================
     13. INICIALIZACIÓN DE LA APLICACIÓN
  ======================================================================== */
  document.addEventListener('DOMContentLoaded', async () => {
    await seedDatabaseIfEmpty();

    setupAuthEvents();
    setupNavigationEvents();
    setupFilterEvents();
    setupSellerEvents();
    setupChatEvents();
    setupReportForm();
    setupDraftAndReloadProtection();
    setupDelegatedActions();

    const savedSessionId = localStorage.getItem(STORAGE_KEYS.SESSION);
    if (savedSessionId) {
      const user = readStore(STORAGE_KEYS.USERS, []).find((u) => u.id === savedSessionId && u.active);
      if (user) {
        startUserSession(user);
      }
    }
  });
})();