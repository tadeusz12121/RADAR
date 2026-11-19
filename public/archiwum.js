import * as L from 'leaflet';

const dateSelect = document.querySelector('#archive-date');
const loadButton = document.querySelector('#load-archive');
const searchInput = document.querySelector('#archive-search');
const aircraftList = document.querySelector('#archive-aircraft-list');
const archiveStatus = document.querySelector('#archive-status');
const trackSelect = document.querySelector('#track-aircraft');
const trackMessage = document.querySelector('#track-message');
const numberFormat = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 });
const timeFormat = new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
});
let archivePlanes = [];
let trackLayer = L.featureGroup();

const archiveMap = L.map('archive-map', { zoomControl: false }).setView([50.28778, 21.43167], 10);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19
}).addTo(archiveMap);
L.control.zoom({ position: 'bottomright' }).addTo(archiveMap);

function showStatus(message, isError = false) {
    archiveStatus.textContent = message;
    archiveStatus.classList.toggle('is-error', isError);
    archiveStatus.classList.add('is-visible');
}

function hideStatus() {
    archiveStatus.classList.remove('is-visible', 'is-error');
}

function formatValue(value, unit) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    const formatted = numberFormat.format(value);
    return unit ? `${formatted} ${unit}` : formatted;
}

function displayDate(date) {
    const parsed = new Date(`${date}T12:00:00+01:00`);
    return new Intl.DateTimeFormat('pl-PL', {
        timeZone: 'Europe/Warsaw',
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    }).format(parsed);
}

function setSummary(planes) {
    const altitudes = planes.map(plane => plane.maxAltitude)
        .filter(value => Number.isFinite(value) && value > 0);
    const speeds = planes.map(plane => plane.maxSpeed)
        .filter(value => Number.isFinite(value) && value > 0);
    const pointCount = planes.reduce((total, plane) =>
        total + (Array.isArray(plane.trackPoints) ? plane.trackPoints.length : 0), 0);

    document.querySelector('#archive-count').textContent = numberFormat.format(planes.length);
    document.querySelector('#archive-max-altitude').textContent =
        altitudes.length ? formatValue(Math.max(...altitudes), 'ft') : '—';
    document.querySelector('#archive-max-speed').textContent =
        speeds.length ? formatValue(Math.max(...speeds), 'kt') : '—';
    document.querySelector('#archive-track-count').textContent = numberFormat.format(pointCount);
}

function createDetail(label, value) {
    const detail = document.createElement('div');
    detail.className = 'archive-detail';
    const name = document.createElement('span');
    name.textContent = label;
    const content = document.createElement('strong');
    content.textContent = value || '—';
    detail.append(name, content);
    return detail;
}

function createRawDetails(plane) {
    const details = document.createElement('details');
    details.className = 'archive-raw';
    const summary = document.createElement('summary');
    summary.textContent = `Pełny zapis danych (${plane.trackPoints?.length ?? 0} próbek pozycji)`;
    const pre = document.createElement('pre');
    let loaded = false;
    details.addEventListener('toggle', () => {
        if (details.open && !loaded) {
            pre.textContent = JSON.stringify({
                aircraft: plane.latestData ?? null,
                trackPoints: plane.trackPoints ?? []
            }, null, 2);
            loaded = true;
        }
    });
    details.append(summary, pre);
    return details;
}

function createAircraftCard(plane) {
    const card = document.createElement('article');
    card.className = 'archive-card';

    const header = document.createElement('div');
    header.className = 'archive-card-summary';
    const title = document.createElement('div');
    title.className = 'archive-card-title';
    const heading = document.createElement('strong');
    heading.textContent = plane.callsign || plane.registration || 'Samolot bez callsign';
    const subheading = document.createElement('small');
    subheading.textContent = [
        plane.hex?.toUpperCase() ?? '—',
        plane.registration ?? 'brak rejestracji',
        plane.aircraftType ?? 'typ nieznany'
    ].join(' · ');
    title.append(heading, subheading);

    const meta = document.createElement('div');
    meta.className = 'archive-card-meta';
    for (const [label, value] of [
        ['WYSOKOŚĆ MAKS.', formatValue(plane.maxAltitude, 'ft')],
        ['PRĘDKOŚĆ MAKS.', formatValue(plane.maxSpeed, 'kt')]
    ]) {
        const item = document.createElement('span');
        item.textContent = label;
        const strong = document.createElement('strong');
        strong.textContent = value;
        item.append(strong);
        meta.append(item);
    }

    const routeButton = document.createElement('button');
    routeButton.className = 'archive-route-button';
    routeButton.type = 'button';
    routeButton.textContent = 'Pokaż trasę';
    routeButton.disabled = !Array.isArray(plane.trackPoints) || plane.trackPoints.length < 2;
    routeButton.addEventListener('click', () => showTrack(plane));
    header.append(title, meta, routeButton);

    const details = document.createElement('details');
    details.className = 'archive-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Szczegóły samolotu';
    const grid = document.createElement('div');
    grid.className = 'archive-details-grid';
    grid.append(
        createDetail('Rejestracja', plane.registration),
        createDetail('Typ statku powietrznego', plane.aircraftType),
        createDetail('Kategoria ADS-B', plane.category),
        createDetail('Kod transpondera', plane.squawk),
        createDetail('Sytuacja awaryjna', plane.emergency),
        createDetail('Pierwsze wykrycie', plane.firstSeen ? timeFormat.format(new Date(plane.firstSeen)) : null),
        createDetail('Ostatnie wykrycie', plane.lastSeen ? timeFormat.format(new Date(plane.lastSeen)) : null),
        createDetail('Ostatnia wysokość', formatValue(plane.lastAltitude, 'ft')),
        createDetail('Ostatnia prędkość', formatValue(plane.lastSpeed, 'kt')),
        createDetail('Ostatnia pozycja', Number.isFinite(plane.lastLatitude) && Number.isFinite(plane.lastLongitude)
            ? `${plane.lastLatitude.toFixed(5)}, ${plane.lastLongitude.toFixed(5)}`
            : '—'),
        createDetail('Odebrane wiadomości', formatValue(plane.messages, '')),
        createDetail('Próbki trasy', numberFormat.format(plane.trackPoints?.length ?? 0))
    );
    details.append(summary, grid, createRawDetails(plane));
    card.append(header, details);
    return card;
}

function renderAircraftList() {
    const query = searchInput.value.trim().toLowerCase();
    const filtered = archivePlanes.filter(plane =>
        [plane.callsign, plane.hex, plane.registration, plane.aircraftType]
            .some(value => String(value ?? '').toLowerCase().includes(query))
    );
    document.querySelector('#filtered-count').textContent = `(${filtered.length})`;
    aircraftList.replaceChildren();

    if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'archive-empty';
        empty.textContent = archivePlanes.length
            ? 'Brak samolotów pasujących do wyszukiwania.'
            : 'W tym dniu nie ma jeszcze zarchiwizowanych samolotów.';
        aircraftList.append(empty);
        return;
    }

    for (const plane of filtered) {
        aircraftList.append(createAircraftCard(plane));
    }
}

function showTrack(plane) {
    const points = (plane.trackPoints ?? []).filter(point =>
        Number.isFinite(point.lat) && Number.isFinite(point.lon)
    );
    if (points.length < 2) {
        trackMessage.textContent = 'Za mało zapisanych pozycji, aby narysować trasę.';
        trackMessage.hidden = false;
        return;
    }

    trackLayer.remove();
    trackLayer = L.featureGroup();
    const path = L.polyline(points.map(point => [point.lat, point.lon]), {
        color: '#58e0c2',
        weight: 4,
        opacity: 0.88,
        lineCap: 'round',
        lineJoin: 'round'
    }).addTo(trackLayer);

    const start = points[0];
    const end = points.at(-1);
    L.circleMarker([start.lat, start.lon], {
        radius: 5,
        color: '#ffffff',
        weight: 2,
        fillColor: '#58e0c2',
        fillOpacity: 1
    }).bindTooltip('Początek zapisu').addTo(trackLayer);
    L.circleMarker([end.lat, end.lon], {
        radius: 5,
        color: '#ffffff',
        weight: 2,
        fillColor: '#f0b765',
        fillOpacity: 1
    }).bindTooltip('Koniec zapisu').addTo(trackLayer);

    trackLayer.addTo(archiveMap);
    archiveMap.fitBounds(path.getBounds(), { padding: [35, 35], maxZoom: 12 });
    trackMessage.textContent = `${plane.callsign || plane.hex.toUpperCase()} · ${points.length} próbek trasy`;
    trackMessage.hidden = false;
    trackSelect.value = plane.hex;
}

function renderTrackOptions(planes) {
    trackSelect.replaceChildren();
    const trackPlanes = planes.filter(plane =>
        Array.isArray(plane.trackPoints) && plane.trackPoints.length >= 2
    );
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = trackPlanes.length
        ? 'Wybierz samolot…'
        : 'Brak zapisanych tras dla tego dnia';
    trackSelect.append(placeholder);
    trackSelect.disabled = !trackPlanes.length;

    for (const plane of trackPlanes) {
        const option = document.createElement('option');
        option.value = plane.hex;
        option.textContent = `${plane.callsign || 'Bez callsign'} · ${plane.hex.toUpperCase()}`;
        trackSelect.append(option);
    }
}

async function loadArchive() {
    const date = dateSelect.value;
    if (!date) {
        showStatus('Wybierz dzień archiwum.', true);
        return;
    }

    loadButton.disabled = true;
    showStatus('Pobieranie szczegółowego archiwum…');
    try {
        const response = await fetch(`/api/archive/${encodeURIComponent(date)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Serwer zwrócił status ${response.status}`);
        const archive = await response.json();
        if (!Array.isArray(archive.planes)) throw new Error('Nieprawidłowy format archiwum');

        archivePlanes = archive.planes;
        setSummary(archivePlanes);
        renderAircraftList();
        renderTrackOptions(archivePlanes);
        trackLayer.remove();
        trackMessage.textContent = archivePlanes.some(plane => plane.trackPoints?.length)
            ? 'Wybierz samolot z listy, aby narysować trasę.'
            : 'Brak zapisanych śladów dla tego dnia. Nowe pozycje będą archiwizowane po wdrożeniu tej wersji.';
        trackMessage.hidden = false;
        hideStatus();
        if (!archivePlanes.length) {
            showStatus('Brak rekordów z tego dnia. Archiwum gromadzi dane od czasu uruchomienia zbierania.');
        }
        document.querySelector('.archive-hero h1').innerHTML =
            `Archiwum <span>lotów.</span>`;
        document.querySelector('.archive-date-control small').textContent =
            `Wybrany dzień: ${displayDate(date)} · Europe/Warsaw`;
        setTimeout(() => archiveMap.invalidateSize(), 50);
    } catch (error) {
        console.error('Nie udało się pobrać archiwum:', error);
        showStatus('Nie udało się pobrać archiwum. Sprawdź połączenie z serwerem i bazą danych.', true);
    } finally {
        loadButton.disabled = false;
    }
}

async function loadAvailableDays() {
    try {
        const response = await fetch('/api/archive/days', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Serwer zwrócił status ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data.days)) throw new Error('Nieprawidłowy format listy archiwum');

        dateSelect.replaceChildren();
        if (!data.days.length) {
            const option = document.createElement('option');
            option.value = data.today;
            option.textContent = `${data.today} — bieżący dzień, jeszcze bez rekordów`;
            dateSelect.append(option);
            dateSelect.value = data.today;
            await loadArchive();
            return;
        }

        for (const day of data.days) {
            const option = document.createElement('option');
            option.value = day;
            option.textContent = displayDate(day);
            dateSelect.append(option);
        }

        const requestedDate = new URLSearchParams(location.search).get('date');
        if (requestedDate && data.days.includes(requestedDate)) {
            dateSelect.value = requestedDate;
        } else {
            dateSelect.value = data.days.includes(data.today) ? data.today : data.days[0];
        }
        await loadArchive();
    } catch (error) {
        console.error('Nie udało się pobrać dostępnych dni:', error);
        showStatus('Nie udało się pobrać listy archiwum. Sprawdź, czy serwer i baza danych są uruchomione.', true);
    }
}

loadButton.addEventListener('click', loadArchive);
searchInput.addEventListener('input', renderAircraftList);
trackSelect.addEventListener('change', () => {
    const plane = archivePlanes.find(item => item.hex === trackSelect.value);
    if (plane) showTrack(plane);
});
dateSelect.addEventListener('change', () => {
    if (dateSelect.value) loadArchive();
});

loadAvailableDays();
