import * as L from 'leaflet';

const MIELEC = [50.28778, 21.43167];
const markers = new Map();
const planeList = document.querySelector('#plane-list');
const aircraftCount = document.querySelector('#aircraft-count');
const connectionIndicator = document.querySelector('#connection-indicator');
const connectionLabel = document.querySelector('#connection-label');
const lastUpdate = document.querySelector('#last-update');
const flightPanel = document.querySelector('#flight-panel');
const panelToggle = document.querySelector('#panel-toggle');
let listSignature = null;

const map = L.map('map', {
    zoomControl: false,
    attributionControl: true
}).setView(MIELEC, 12);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19
}).addTo(map);

L.circle(MIELEC, {
    radius: 20_000,
    color: '#58e0c2',
    weight: 1,
    opacity: 0.62,
    dashArray: '5 7',
    fillColor: '#58e0c2',
    fillOpacity: 0.025,
    interactive: false
}).addTo(map);

L.circleMarker(MIELEC, {
    radius: 4,
    color: '#dffff8',
    weight: 2,
    fillColor: '#58e0c2',
    fillOpacity: 1
}).addTo(map);

const timeFormatter = new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
});
const numberFormatter = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 });

function createPlaneIcon(track) {
    const heading = Number.isFinite(Number(track))
        ? ((Number(track) % 360) + 360) % 360
        : 0;

    return L.divIcon({
        className: 'plane-div-icon',
        html: `<svg class="plane-marker" viewBox="0 0 24 24" style="transform:rotate(${heading}deg)" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle class="plane-marker-glow" cx="12" cy="12" r="10"></circle><path d="M12 1 13.2 9 21 14v2l-7.8-2.5L13 21l2 2v1l-3-1.5L9 24v-1l2-2-.2-7.5L3 16v-2l7.8-5z"/></svg>`,
        iconSize: [36, 36],
        iconAnchor: [18, 18]
    });
}

function formatMetric(value, unit) {
    return typeof value === 'number' && Number.isFinite(value)
        ? `${numberFormatter.format(value)} ${unit}`
        : '—';
}

function createPopup(plane) {
    const content = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'popup-title';
    title.textContent = plane.flight?.trim() || 'Nieznany callsign';

    const details = document.createElement('div');
    details.className = 'popup-detail';
    details.textContent = [
        `HEX ${plane.hex.toUpperCase()}`,
        `Wysokość ${formatMetric(plane.alt_baro, 'ft')}`,
        `Prędkość ${formatMetric(plane.gs, 'kt')}`
    ].join(' · ');

    content.append(title, details);
    return content;
}

function setConnection(online) {
    connectionIndicator.classList.toggle('is-online', online);
    connectionIndicator.classList.toggle('is-offline', !online);
    connectionLabel.textContent = online ? 'SERWER RADARU ONLINE' : 'SERWER RADARU NIEDOSTĘPNY';
}

function renderPlaneList(planes) {
    const signature = planes.map(plane =>
        [plane.hex, plane.flight, plane.alt_baro, plane.gs].join(':')
    ).join('|');

    aircraftCount.textContent = String(planes.length);
    if (signature === listSignature) return;
    listSignature = signature;
    planeList.replaceChildren();

    if (!planes.length) {
        const empty = document.createElement('div');
        empty.className = 'list-placeholder';
        empty.textContent = 'Brak aktywnych samolotów z aktualną pozycją. Gdy odbiornik wykryje nowy ślad, pojawi się tutaj.';
        planeList.append(empty);
        return;
    }

    const ordered = [...planes].sort((a, b) =>
        (a.seen_pos ?? 0) - (b.seen_pos ?? 0)
    );

    for (const plane of ordered) {
        const button = document.createElement('button');
        button.className = 'plane-row';
        button.type = 'button';
        button.setAttribute('aria-label', `Pokaż samolot ${plane.flight?.trim() || plane.hex}`);

        const icon = document.createElement('span');
        icon.className = 'row-plane-icon';
        icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 1 1.2 8L21 14v2l-7.8-2.5L13 21l2 2v1l-3-1.5L9 24v-1l2-2-.2-7.5L3 16v-2l7.8-5z"/></svg>';

        const copy = document.createElement('span');
        copy.className = 'row-copy';
        const callsign = document.createElement('span');
        callsign.className = 'row-callsign';
        callsign.textContent = plane.flight?.trim() || 'Nieznany callsign';
        const hex = document.createElement('span');
        hex.className = 'row-hex';
        hex.textContent = plane.hex.toUpperCase();
        copy.append(callsign, hex);

        const altitude = document.createElement('span');
        altitude.className = 'row-altitude';
        altitude.textContent = formatMetric(plane.alt_baro, 'ft');
        button.append(icon, copy, altitude);
        button.addEventListener('click', () => {
            const marker = markers.get(plane.hex);
            if (marker) {
                map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 12), { duration: 0.65 });
                marker.openPopup();
                if (window.matchMedia('(max-width: 700px)').matches) closePanel();
            }
        });
        planeList.append(button);
    }
}

function openPanel() {
    flightPanel.classList.add('is-open');
    panelToggle.setAttribute('aria-expanded', 'true');
}

function closePanel() {
    flightPanel.classList.remove('is-open');
    panelToggle.setAttribute('aria-expanded', 'false');
}

async function getPlanes() {
    try {
        const response = await fetch('/api/planes', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Serwer zwrócił status ${response.status}`);

        const data = await response.json();
        const aircraft = Array.isArray(data) ? data : data.aircraft;
        if (!Array.isArray(aircraft)) {
            throw new Error('Nieprawidłowy format danych odbiornika');
        }

        const activePlanes = new Map();

        for (const plane of aircraft) {
            if (
                typeof plane.hex !== 'string' ||
                typeof plane.lat !== 'number' ||
                !Number.isFinite(plane.lat) ||
                typeof plane.lon !== 'number' ||
                !Number.isFinite(plane.lon)
            ) continue;

            if (typeof plane.seen_pos === 'number' && plane.seen_pos > 60) continue;

            activePlanes.set(plane.hex, plane);
            const position = [plane.lat, plane.lon];

            if (markers.has(plane.hex)) {
                const marker = markers.get(plane.hex);
                marker.setLatLng(position);
                marker.setIcon(createPlaneIcon(plane.track));
                marker.setPopupContent(createPopup(plane));
            } else {
                const marker = L.marker(position, {
                    icon: createPlaneIcon(plane.track),
                    keyboard: true
                }).addTo(map);
                marker.bindPopup(createPopup(plane));
                markers.set(plane.hex, marker);
            }
        }

        for (const [hex, marker] of markers) {
            if (!activePlanes.has(hex)) {
                map.removeLayer(marker);
                markers.delete(hex);
            }
        }

        renderPlaneList([...activePlanes.values()]);
        lastUpdate.textContent = timeFormatter.format(new Date());
        setConnection(true);
    } catch (error) {
        console.error('Błąd pobierania samolotów:', error);
        setConnection(false);
    }
}

function togglePanel() {
    if (flightPanel.classList.contains('is-open')) closePanel();
    else openPanel();
}

document.querySelector('#center-button').addEventListener('click', () => {
    map.flyTo(MIELEC, 12, { duration: 0.8 });
});
panelToggle.addEventListener('click', togglePanel);
document.querySelector('#panel-close').addEventListener('click', closePanel);

getPlanes();
setInterval(getPlanes, 1500);
