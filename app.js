/* ==========================================================================
   PLATAFORMA WEB DE BIENES RAÍCES - INMOBAJA (UABC FIAD)
   Backend simulado en JavaScript (Persistencia localStorage, Auth con Hash SHA-256,
   CRUD de Propiedades, Favoritos, Mapa Leaflet con POIs, Chat Interno y Moderación)
========================================================================== */

(function () {
  'use strict';

  // Claves de almacenamiento local
  const STORAGE_KEYS = {
    USERS: 'inmobaja_users_v1',
    PROPERTIES: 'inmobaja_properties_v1',
    MESSAGES: 'inmobaja_messages_v1',
    REPORTS: 'inmobaja_reports_v1',
    SESSION: 'inmobaja_session_v1'
  };

  // Servicios importantes en Ensenada (Escuelas, Hospitales, Supermercados)
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

  // Estado en memoria
  let currentUser = null;
  let activeChatThreadId = null;
  let mapInstance = null;
  let propertyMarkersLayer = null;
  let poiMarkersLayer = null;

  /* ========================================================================
     1. UTILIDADES DE SEGURIDAD (CIFRADO SHA-256) Y FORMATEO
  ======================================================================== */
  async function hashPassword(plainText) {
    if (window.crypto && window.crypto.subtle) {
      const encoder = new TextEncoder();
      const data = encoder.encode(plainText);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    // Respaldo simple en entornos sin contexto seguro
    return btoa(unescape(encodeURIComponent(plainText)));
  }

  function formatCurrency(amount) {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN',
      maximumFractionDigits: 0
    }).format(amount);
  }

  function sanitize(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.classList.add('hidden');
    }, 3200);
  }

  /* ========================================================================
     2. CAPA DE DATOS (SEED INICIAL + CRUD EN LOCALSTORAGE)
  ======================================================================== */
  function readStore(key) {
    try {
      return JSON.parse(localStorage.getItem(key)) || [];
    } catch {
      return [];
    }
  }

  function writeStore(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  async function seedDatabaseIfEmpty() {
    if (readStore(STORAGE_KEYS.USERS).length === 0) {
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

    if (readStore(STORAGE_KEYS.PROPERTIES).length === 0) {
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

    if (readStore(STORAGE_KEYS.MESSAGES).length === 0) {
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

    if (readStore(STORAGE_KEYS.REPORTS).length === 0) {
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
     3. AUTENTICACIÓN Y GESTIÓN DE SESIÓN
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

    // Inicio de sesión
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('loginEmail').value.trim().toLowerCase();
      const password = document.getElementById('loginPassword').value;
      const errorEl = document.getElementById('loginError');
      errorEl.textContent = '';

      if (!email || !password) {
        errorEl.textContent = 'Completa tu correo y contraseña.';
        return;
      }

      const users = readStore(STORAGE_KEYS.USERS);
      const passwordHash = await hashPassword(password);
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

    // Registro de usuario (Comprador o Vendedor)
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const role = document.querySelector('input[name="registerRole"]:checked').value;
      const name = document.getElementById('regName').value.trim();
      const email = document.getElementById('regEmail').value.trim().toLowerCase();
      const phone = document.getElementById('regPhone').value.trim();
      const password = document.getElementById('regPassword').value;
      const errorEl = document.getElementById('registerError');
      errorEl.textContent = '';

      if (!name || !email || !phone || password.length < 6) {
        errorEl.textContent = 'Completa todos los campos (contraseña mínima de 6 caracteres).';
        return;
      }

      const users = readStore(STORAGE_KEYS.USERS);
      if (users.some((u) => u.email === email)) {
        errorEl.textContent = 'Este correo ya está registrado.';
        return;
      }

      const newUser = {
        id: 'usr_' + Date.now(),
        name,
        email,
        phone,
        role,
        passwordHash: await hashPassword(password),
        favorites: [],
        active: true
      };

      users.push(newUser);
      writeStore(STORAGE_KEYS.USERS, users);
      showToast(`¡Bienvenido ${name}! Cuenta creada como ${role}.`);
      startUserSession(newUser);
    });

    // Accesos rápidos de demostración
    document.querySelectorAll('[data-demo-role]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetRole = btn.getAttribute('data-demo-role');
        const users = readStore(STORAGE_KEYS.USERS);
        const demoUser = users.find((u) => u.role === targetRole);
        if (demoUser) {
          startUserSession(demoUser);
        }
      });
    });

    // Cerrar sesión
    document.getElementById('logoutBtn').addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEYS.SESSION);
      currentUser = null;
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

    // Actualizar datos del usuario en navbar
    document.getElementById('userNameDisplay').textContent = user.name;
    document.getElementById('userRoleBadge').textContent = user.role;
    document.getElementById('userAvatar').textContent = user.name.charAt(0).toUpperCase();

    // Mostrar pestañas según el rol
    const navSellerBtn = document.getElementById('navSellerBtn');
    const navAdminBtn = document.getElementById('navAdminBtn');

    navSellerBtn.classList.toggle('hidden', user.role !== 'vendedor' && user.role !== 'admin');
    navAdminBtn.classList.toggle('hidden', user.role !== 'admin');

    switchSection('exploreSection');
    initMapIfNeeded();
    refreshAllUI();
  }

  /* ========================================================================
     4. NAVEGACIÓN ENTRE SECCIONES Y VISTAS
  ======================================================================== */
  function setupNavigationEvents() {
    document.querySelectorAll('.nav-btn[data-section]').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchSection(btn.getAttribute('data-section'));
      });
    });

    // Botones de vista dividida / catálogo / mapa
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

    // Cierre de modales
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
     5. FILTROS, CATÁLOGO Y FAVORITOS (COMPRADOR)
  ======================================================================== */
  function getFilteredProperties() {
    const allProps = readStore(STORAGE_KEYS.PROPERTIES).filter((p) => p.status === 'activa');
    const zone = document.getElementById('filterZone').value;
    const type = document.getElementById('filterType').value;
    const maxPrice = parseFloat(document.getElementById('filterMaxPrice').value);
    const minSize = parseFloat(document.getElementById('filterMinSize').value);

    return allProps.filter((prop) => {
      if (zone !== 'todas' && prop.zone !== zone) return false;
      if (type !== 'todos' && prop.type !== type) return false;
      if (!isNaN(maxPrice) && maxPrice > 0 && prop.price > maxPrice) return false;
      if (!isNaN(minSize) && minSize > 0 && prop.size < minSize) return false;
      return true;
    });
  }

  function setupFilterEvents() {
    ['filterZone', 'filterType', 'filterMaxPrice', 'filterMinSize'].forEach((id) => {
      document.getElementById(id).addEventListener('input', () => {
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

    // Toggles de servicios cercanos en el mapa
    ['toggleSchools', 'toggleHospitals', 'toggleMarkets'].forEach((id) => {
      document.getElementById(id).addEventListener('change', renderNearbyServicesOnMap);
    });
  }

  function buildPropertyCardHTML(prop) {
    const isFav = currentUser && currentUser.favorites && currentUser.favorites.includes(prop.id);
    const specsText =
      prop.type === 'Terreno'
        ? `📐 ${prop.size} m² • Zona ${sanitize(prop.zone)}`
        : `📐 ${prop.size} m² • 🛏️ ${prop.beds} rec. • 🚿 ${prop.baths} baños`;

    return `
      <article class="property-card">
        <div class="property-img-wrap">
          <img src="${sanitize(prop.image)}" alt="${sanitize(prop.title)}" loading="lazy" />
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

  function renderCatalogAndMap() {
    const filtered = getFilteredProperties();
    const grid = document.getElementById('propertiesGrid');
    document.getElementById('resultsCounter').textContent = `Mostrando ${filtered.length} propiedad(es) disponible(s)`;

    if (filtered.length === 0) {
      grid.innerHTML = `<p>No se encontraron propiedades con los filtros seleccionados.</p>`;
    } else {
      grid.innerHTML = filtered.map(buildPropertyCardHTML).join('');
    }

    renderPropertiesOnMap(filtered);
    renderFavoritesSection();
  }

  function renderFavoritesSection() {
    if (!currentUser) return;
    const allProps = readStore(STORAGE_KEYS.PROPERTIES);
    const favProps = allProps.filter((p) => currentUser.favorites.includes(p.id));
    document.getElementById('favCountBadge').textContent = favProps.length;

    const favGrid = document.getElementById('favoritesGrid');
    if (favProps.length === 0) {
      favGrid.innerHTML = `<p>Aún no has marcado propiedades como favoritas. Haz clic en el corazón (♡) de cualquier anuncio.</p>`;
    } else {
      favGrid.innerHTML = favProps.map(buildPropertyCardHTML).join('');
    }
  }

  function toggleFavorite(propertyId) {
    const users = readStore(STORAGE_KEYS.USERS);
    const idx = users.findIndex((u) => u.id === currentUser.id);
    if (idx === -1) return;

    const favs = users[idx].favorites || [];
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
     6. MAPA INTERACTIVO (LEAFLET.JS) Y CERCANÍA A SERVICIOS
  ======================================================================== */
  function initMapIfNeeded() {
    if (mapInstance || typeof L === 'undefined') return;

    mapInstance = L.map('propertyMap').setView([31.8667, -116.645], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(mapInstance);

    propertyMarkersLayer = L.layerGroup().addTo(mapInstance);
    poiMarkersLayer = L.layerGroup().addTo(mapInstance);

    renderNearbyServicesOnMap();
  }

  function renderPropertiesOnMap(properties) {
    if (!mapInstance || !propertyMarkersLayer) return;
    propertyMarkersLayer.clearLayers();

    properties.forEach((prop) => {
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
    // Distancia aproximada en km (Fórmula Haversine)
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
     7. DETALLE DE PROPIEDAD, CONTACTO DIRECTO Y REPORTES
  ======================================================================== */
  window.__openPropertyDetail = function (propertyId) {
    const properties = readStore(STORAGE_KEYS.PROPERTIES);
    const prop = properties.find((p) => p.id === propertyId);
    if (!prop) return;

    // Incrementar contador de visitas
    prop.views = (prop.views || 0) + 1;
    writeStore(STORAGE_KEYS.PROPERTIES, properties);
    renderSellerDashboard();

    const nearest = calculateNearestServices(prop.lat, prop.lng);
    const nearestHTML = nearest
      .map((s) => `<li><strong>${sanitize(s.name)}</strong> — a ${s.distanceKm} km</li>`)
      .join('');

    const detailContainer = document.getElementById('propertyDetailContent');
    detailContainer.innerHTML = `
      <img src="${sanitize(prop.image)}" alt="${sanitize(prop.title)}" class="detail-hero" />
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
            ${currentUser.favorites.includes(prop.id) ? '♥ En Favoritos' : '♡ Guardar Favorito'}
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
    document.getElementById('reportForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const propertyId = document.getElementById('reportPropId').value;
      const reason = document.getElementById('reportReason').value;
      const details = document.getElementById('reportDetails').value.trim();

      const prop = readStore(STORAGE_KEYS.PROPERTIES).find((p) => p.id === propertyId);
      if (!prop) return;

      const reports = readStore(STORAGE_KEYS.REPORTS);
      reports.unshift({
        id: 'rep_' + Date.now(),
        propertyId: prop.id,
        propertyTitle: prop.title,
        reason,
        details,
        reportedBy: currentUser.name,
        status: 'pendiente'
      });

      writeStore(STORAGE_KEYS.REPORTS, reports);
      document.getElementById('reportForm').reset();
      document.getElementById('reportModal').classList.add('hidden');
      showToast('Reporte enviado al panel de administración.');
      renderAdminPanel();
    });
  }

  /* ========================================================================
     8. PANEL DEL VENDEDOR (CREAR, EDITAR, PAUSAR, ELIMINAR Y ESTADÍSTICAS)
  ======================================================================== */
  function setupSellerEvents() {
    document.getElementById('openNewPropertyModalBtn').addEventListener('click', () => {
      document.getElementById('propertyFormTitle').textContent = 'Publicar Nueva Propiedad';
      document.getElementById('propertyForm').reset();
      document.getElementById('propId').value = '';
      document.getElementById('propFormError').textContent = '';
      document.getElementById('propertyFormModal').classList.remove('hidden');
    });

    document.getElementById('propertyForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById('propFormError');
      errorEl.textContent = '';

      const id = document.getElementById('propId').value;
      const title = document.getElementById('propTitle').value.trim();
      const type = document.getElementById('propType').value;
      const zone = document.getElementById('propZone').value;
      const price = parseFloat(document.getElementById('propPrice').value);
      const size = parseFloat(document.getElementById('propSize').value);
      const beds = parseInt(document.getElementById('propBeds').value, 10) || 0;
      const baths = parseInt(document.getElementById('propBaths').value, 10) || 0;
      const address = document.getElementById('propAddress').value.trim();
      const lat = parseFloat(document.getElementById('propLat').value);
      const lng = parseFloat(document.getElementById('propLng').value);
      const description = document.getElementById('propDesc').value.trim();
      const imageUrlInput = document.getElementById('propImageUrl').value.trim();
      const fileInput = document.getElementById('propImageFile');

      if (!title || !address || !description || isNaN(price) || isNaN(size) || isNaN(lat) || isNaN(lng)) {
        errorEl.textContent = 'Por favor completa todos los campos obligatorios correctamente.';
        return;
      }

      // Leer archivo local como Base64 si el vendedor subió fotografía
      let finalImage =
        imageUrlInput ||
        'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?auto=format&fit=crop&w=900&q=80';

      if (fileInput.files && fileInput.files[0]) {
        finalImage = await fileToDataURL(fileInput.files[0]);
      }

      const properties = readStore(STORAGE_KEYS.PROPERTIES);

      if (id) {
        const index = properties.findIndex((p) => p.id === id);
        if (index !== -1) {
          properties[index] = {
            ...properties[index],
            title,
            type,
            zone,
            price,
            size,
            beds,
            baths,
            address,
            lat,
            lng,
            image: fileInput.files[0] || imageUrlInput ? finalImage : properties[index].image,
            description
          };
          showToast('Publicación actualizada correctamente.');
        }
      } else {
        properties.unshift({
          id: 'prop_' + Date.now(),
          sellerId: currentUser.id,
          sellerName: currentUser.name,
          title,
          type,
          zone,
          price,
          size,
          beds,
          baths,
          address,
          lat,
          lng,
          image: finalImage,
          description,
          views: 1,
          status: 'activa'
        });
        showToast('¡Propiedad publicada con éxito!');
      }

      writeStore(STORAGE_KEYS.PROPERTIES, properties);
      document.getElementById('propertyFormModal').classList.add('hidden');
      refreshAllUI();
    });
  }

  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function renderSellerDashboard() {
    if (!currentUser) return;
    const allProps = readStore(STORAGE_KEYS.PROPERTIES);
    const myProps =
      currentUser.role === 'admin'
        ? allProps
        : allProps.filter((p) => p.sellerId === currentUser.id);

    const allUsers = readStore(STORAGE_KEYS.USERS);
    const myPropIds = myProps.map((p) => p.id);
    const totalFavs = allUsers.reduce((acc, u) => {
      const count = (u.favorites || []).filter((fid) => myPropIds.includes(fid)).length;
      return acc + count;
    }, 0);

    const myChats = readStore(STORAGE_KEYS.MESSAGES).filter((c) => myPropIds.includes(c.propertyId));

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
     9. CHAT INTERNO COMPRADOR - VENDEDOR
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

    document.getElementById('chatSendForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!activeChatThreadId) return;
      const input = document.getElementById('chatMessageInput');
      const text = input.value.trim();
      if (!text) return;

      const threads = readStore(STORAGE_KEYS.MESSAGES);
      const thread = threads.find((t) => t.id === activeChatThreadId);
      if (!thread) return;

      const now = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
      thread.messages.push({
        senderId: currentUser.id,
        senderName: currentUser.name,
        text,
        timestamp: now
      });

      writeStore(STORAGE_KEYS.MESSAGES, threads);
      input.value = '';
      renderChatThreads();
      renderActiveChatMessages();
    });
  }

  function startOrOpenChat(property) {
    const threads = readStore(STORAGE_KEYS.MESSAGES);
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
    const threads = readStore(STORAGE_KEYS.MESSAGES);
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

    if (!activeChatThreadId) {
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
     10. PANEL DE ADMINISTRACIÓN (REPORTES Y USUARIOS)
  ======================================================================== */
  function renderAdminPanel() {
    const reports = readStore(STORAGE_KEYS.REPORTS);
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

    const users = readStore(STORAGE_KEYS.USERS);
    const usersTbody = document.getElementById('adminUsersTable');
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
     11. DELEGACIÓN GLOBAL DE EVENTOS DINÁMICOS
  ======================================================================== */
  function setupDelegatedActions() {
    document.body.addEventListener('click', (e) => {
      // Favoritos
      const favBtn = e.target.closest('[data-fav-id]');
      if (favBtn) {
        toggleFavorite(favBtn.getAttribute('data-fav-id'));
        return;
      }

      // Detalle de propiedad
      const detailBtn = e.target.closest('[data-detail-id]');
      if (detailBtn) {
        window.__openPropertyDetail(detailBtn.getAttribute('data-detail-id'));
        return;
      }

      // Centrar propiedad en el mapa
      const mapBtn = e.target.closest('[data-focus-map-id]');
      if (mapBtn && mapInstance) {
        const prop = readStore(STORAGE_KEYS.PROPERTIES).find(
          (p) => p.id === mapBtn.getAttribute('data-focus-map-id')
        );
        if (prop) {
          mapInstance.setView([prop.lat, prop.lng], 15);
          showToast(`Ubicando "${prop.title}" en el mapa.`);
        }
        return;
      }

      // Vendedor: Editar propiedad
      const editBtn = e.target.closest('[data-edit-prop]');
      if (editBtn) {
        const prop = readStore(STORAGE_KEYS.PROPERTIES).find(
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
          document.getElementById('propImageUrl').value = prop.image.startsWith('http') ? prop.image : '';
          document.getElementById('propDesc').value = prop.description;
          document.getElementById('propertyFormModal').classList.remove('hidden');
        }
        return;
      }

      // Vendedor: Pausar / Activar propiedad
      const togglePropBtn = e.target.closest('[data-toggle-prop]');
      if (togglePropBtn) {
        const props = readStore(STORAGE_KEYS.PROPERTIES);
        const prop = props.find((p) => p.id === togglePropBtn.getAttribute('data-toggle-prop'));
        if (prop) {
          prop.status = prop.status === 'activa' ? 'pausada' : 'activa';
          writeStore(STORAGE_KEYS.PROPERTIES, props);
          showToast(`Publicación marcada como ${prop.status}.`);
          refreshAllUI();
        }
        return;
      }

      // Vendedor: Eliminar propiedad
      const deletePropBtn = e.target.closest('[data-delete-prop]');
      if (deletePropBtn) {
        const targetId = deletePropBtn.getAttribute('data-delete-prop');
        const props = readStore(STORAGE_KEYS.PROPERTIES).filter((p) => p.id !== targetId);
        writeStore(STORAGE_KEYS.PROPERTIES, props);
        showToast('Publicación eliminada.');
        refreshAllUI();
        return;
      }

      // Chat: Seleccionar hilo
      const threadItem = e.target.closest('[data-thread-id]');
      if (threadItem) {
        activeChatThreadId = threadItem.getAttribute('data-thread-id');
        renderChatThreads();
        return;
      }

      // Admin: Descartar reporte
      const resolveRepBtn = e.target.closest('[data-resolve-report]');
      if (resolveRepBtn) {
        const reports = readStore(STORAGE_KEYS.REPORTS);
        const rep = reports.find((r) => r.id === resolveRepBtn.getAttribute('data-resolve-report'));
        if (rep) {
          rep.status = 'resuelto';
          writeStore(STORAGE_KEYS.REPORTS, reports);
          showToast('Reporte marcado como resuelto.');
          renderAdminPanel();
        }
        return;
      }

      // Admin: Eliminar anuncio reportado
      const removeReportedBtn = e.target.closest('[data-remove-reported-prop]');
      if (removeReportedBtn) {
        const reports = readStore(STORAGE_KEYS.REPORTS);
        const rep = reports.find((r) => r.id === removeReportedBtn.getAttribute('data-remove-reported-prop'));
        if (rep) {
          rep.status = 'resuelto';
          writeStore(STORAGE_KEYS.REPORTS, reports);
          const props = readStore(STORAGE_KEYS.PROPERTIES).filter((p) => p.id !== rep.propertyId);
          writeStore(STORAGE_KEYS.PROPERTIES, props);
          showToast('Anuncio eliminado y reporte resuelto.');
          refreshAllUI();
        }
        return;
      }

      // Admin: Suspender / Reactivar usuario
      const toggleUserBtn = e.target.closest('[data-toggle-user]');
      if (toggleUserBtn) {
        const users = readStore(STORAGE_KEYS.USERS);
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
     12. INICIALIZACIÓN DE LA APLICACIÓN
  ======================================================================== */
  document.addEventListener('DOMContentLoaded', async () => {
    await seedDatabaseIfEmpty();

    setupAuthEvents();
    setupNavigationEvents();
    setupFilterEvents();
    setupSellerEvents();
    setupChatEvents();
    setupReportForm();
    setupDelegatedActions();

    // Restaurar sesión activa si existe
    const savedSessionId = localStorage.getItem(STORAGE_KEYS.SESSION);
    if (savedSessionId) {
      const user = readStore(STORAGE_KEYS.USERS).find((u) => u.id === savedSessionId && u.active);
      if (user) {
        startUserSession(user);
      }
    }
  });
})();