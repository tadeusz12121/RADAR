const aircraftGrid = document.querySelector('#aircraft-grid');
const statusMessage = document.querySelector('#status-message');
const refreshButton = document.querySelector('#refresh-button');
const searchInput = document.querySelector('#search-input');
let planes = [];
let photoObserver;

const numberFormat = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 });
const timeFormat = new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw',
    hour: '2-digit',
    minute: '2-digit'
});
const dateFormat = new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
});

function showStatus(message, isError = false) {
    statusMessage.textContent = message;
    statusMessage.classList.toggle('is-error', isError);
    statusMessage.classList.add('is-visible');
}

function hideStatus() {
    statusMessage.classList.remove('is-visible', 'is-error');
}

function formatValue(value, unit) {
    return typeof value === 'number' && Number.isFinite(value)
        ? `${numberFormat.format(value)} ${unit}`
        : '—';
}

function getHour(date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Warsaw',
        hour: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);
    return Number(parts.find(part => part.type === 'hour')?.value ?? 0);
}

function renderChart(items) {
    const chart = document.querySelector('#hour-chart');
    const counts = Array(24).fill(0);

    for (const plane of items) {
        if (plane.firstSeen) {
            const date = new Date(plane.firstSeen);
            if (!Number.isNaN(date.getTime())) counts[getHour(date)] += 1;
        }
    }

    const peak = Math.max(...counts, 0);
    const currentHour = getHour(new Date());
    const busiest = peak > 0 ? counts.indexOf(peak) : -1;
    chart.replaceChildren();

    counts.forEach((count, hour) => {
        const column = document.createElement('div');
        column.className = `bar-column${hour === busiest ? ' is-busiest' : ''}`;
        column.title = `${String(hour).padStart(2, '0')}:00 — ${count} ${count === 1 ? 'samolot' : 'samolotów'}`;
        const bar = document.createElement('span');
        bar.className = 'bar';
        bar.style.height = `${peak ? Math.max((count / peak) * 100, 2) : 2}%`;
        const label = document.createElement('span');
        label.className = 'bar-label';
        if (hour % 3 === 0 || hour === currentHour) label.textContent = String(hour).padStart(2, '0');
        column.append(bar, label);
        chart.append(column);
    });

    document.querySelector('#busiest-hour').textContent =
        busiest < 0 ? 'Brak danych' : `${String(busiest).padStart(2, '0')}:00`;
    document.querySelector('#busiest-caption').textContent =
        peak ? `${numberFormat.format(peak)} ${peak === 1 ? 'samolot' : 'samolotów'} zarejestrowanych w tej godzinie` : 'brak wykrytych samolotów';
}

function renderSummary(items) {
    const altitudes = items.map(plane => plane.maxAltitude)
        .filter(value => Number.isFinite(value) && value > 0);
    const speeds = items.map(plane => plane.maxSpeed)
        .filter(value => Number.isFinite(value) && value > 0);
    const averageAltitude = altitudes.length
        ? altitudes.reduce((sum, altitude) => sum + altitude, 0) / altitudes.length
        : null;
    const earliest = items.reduce((best, plane) =>
        plane.firstSeen && (!best || new Date(plane.firstSeen) < new Date(best))
            ? plane.firstSeen
            : best, null);
    const latest = items.reduce((best, plane) =>
        plane.firstSeen && (!best || new Date(plane.firstSeen) > new Date(best))
            ? plane.firstSeen
            : best, null);
    const topCallsign = items.find(plane => plane.callsign)?.callsign;
    const today = new Date();

    document.querySelector('#report-date').textContent = dateFormat.format(today);
    document.querySelector('#last-updated').textContent = timeFormat.format(today);
    document.querySelector('#plane-count').textContent = numberFormat.format(items.length);
    document.querySelector('#max-altitude').textContent =
        altitudes.length ? formatValue(Math.max(...altitudes), 'ft') : '—';
    document.querySelector('#max-speed').textContent =
        speeds.length ? formatValue(Math.max(...speeds), 'kt') : '—';
    document.querySelector('#first-seen').textContent = earliest ? timeFormat.format(new Date(earliest)) : '—';
    document.querySelector('#last-seen').textContent = latest ? timeFormat.format(new Date(latest)) : '—';
    document.querySelector('#top-callsign').textContent = topCallsign ?? 'Brak danych';
    document.querySelector('#average-altitude').textContent =
        averageAltitude === null ? '—' : formatValue(averageAltitude, 'ft');

    renderChart(items);
}

function createPlaceholder() {
    const placeholder = document.createElement('div');
    placeholder.className = 'photo-placeholder';
    placeholder.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 16v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3h2v3h14v-3zM12 2l6 8h-4v5h-4v-5H6z"/></svg><span>Brak zdjęcia w bazie</span>';
    return placeholder;
}

function loadPhoto(card) {
    const hex = card.dataset.hex;
    const photoArea = card.querySelector('.aircraft-photo');
    fetch(`/api/aircraft-photo/${encodeURIComponent(hex)}`)
        .then(async response => {
            if (response.status === 404) return null;
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        })
        .then(photo => {
            photoArea.replaceChildren();
            if (!photo?.url) {
                photoArea.append(createPlaceholder());
                return;
            }

            const image = document.createElement('img');
            image.src = photo.url;
            image.alt = `Zdjęcie samolotu ${card.dataset.callsign || hex}`;
            image.loading = 'lazy';
            image.referrerPolicy = 'no-referrer';
            image.addEventListener('error', () => {
                photoArea.replaceChildren(createPlaceholder());
            }, { once: true });
            photoArea.append(image);

            if (photo.link) {
                const credit = document.createElement('a');
                credit.className = 'photo-credit';
                credit.href = photo.link;
                credit.target = '_blank';
                credit.rel = 'noopener noreferrer';
                credit.textContent = 'PlaneSpotters';
                photoArea.append(credit);
            }
        })
        .catch(() => {
            photoArea.replaceChildren(createPlaceholder());
        });
}

function createAircraftCard(plane) {
    const card = document.createElement('article');
    const callsign = plane.callsign?.trim() || 'Nieznany callsign';
    card.className = 'aircraft-card';
    card.dataset.hex = plane.hex ?? '';
    card.dataset.callsign = callsign;

    const photo = document.createElement('div');
    photo.className = 'aircraft-photo';
    photo.setAttribute('aria-label', `Zdjęcie samolotu ${callsign}`);
    const placeholder = document.createElement('div');
    placeholder.className = 'photo-placeholder';
    placeholder.textContent = 'Ładowanie zdjęcia…';
    photo.append(placeholder);

    const info = document.createElement('div');
    info.className = 'aircraft-info';
    const title = document.createElement('div');
    title.className = 'aircraft-title';
    const heading = document.createElement('h3');
    heading.textContent = callsign;
    const hex = document.createElement('span');
    hex.className = 'hex-code';
    hex.textContent = plane.hex?.toUpperCase() ?? '—';
    title.append(heading, hex);

    const seen = document.createElement('div');
    seen.className = 'aircraft-time';
    seen.textContent = plane.firstSeen ? `Pierwsze wykrycie: ${timeFormat.format(new Date(plane.firstSeen))}` : 'Godzina wykrycia: —';

    const metrics = document.createElement('div');
    metrics.className = 'aircraft-metrics';
    for (const [label, value] of [
        ['Maks. wysokość', formatValue(plane.maxAltitude, 'ft')],
        ['Maks. prędkość', formatValue(plane.maxSpeed, 'kt')]
    ]) {
        const metric = document.createElement('div');
        const metricLabel = document.createElement('span');
        metricLabel.textContent = label;
        const metricValue = document.createElement('strong');
        metricValue.textContent = value;
        metric.append(metricLabel, metricValue);
        metrics.append(metric);
    }

    info.append(title, seen, metrics);
    card.append(photo, info);
    return card;
}

function renderGallery() {
    const query = searchInput.value.trim().toLowerCase();
    const filtered = planes.filter(plane =>
        `${plane.callsign ?? ''} ${plane.hex ?? ''}`.toLowerCase().includes(query)
    );
    document.querySelector('#gallery-count').textContent = `(${filtered.length})`;
    aircraftGrid.replaceChildren();

    if (!filtered.length) {
        const empty = document.createElement('p');
        empty.className = 'no-results';
        empty.textContent = planes.length ? 'Nie znaleziono samolotów pasujących do wyszukiwania.' : 'Brak zarejestrowanych samolotów dzisiaj.';
        aircraftGrid.append(empty);
        return;
    }

    photoObserver?.disconnect();
    photoObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                loadPhoto(entry.target);
                photoObserver.unobserve(entry.target);
            }
        }
    }, { rootMargin: '250px' });

    for (const plane of filtered) {
        const card = createAircraftCard(plane);
        aircraftGrid.append(card);
        if (/^[a-f0-9]{6}$/i.test(plane.hex ?? '')) photoObserver.observe(card);
        else card.querySelector('.aircraft-photo').replaceChildren(createPlaceholder());
    }
}

async function loadToday() {
    refreshButton.disabled = true;
    refreshButton.querySelector('span').textContent = '…';
    showStatus('Pobieranie dzisiejszych danych…');

    try {
        const response = await fetch('/api/today', { cache: 'no-store' });
        if (!response.ok) throw new Error(`Serwer zwrócił status ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error('Nieprawidłowy format danych z serwera');

        planes = data.sort((a, b) => new Date(a.firstSeen) - new Date(b.firstSeen));
        renderSummary(planes);
        renderGallery();
        hideStatus();
        if (!planes.length) {
            showStatus('Jeszcze nie zarejestrowano dziś samolotów. Dane pojawią się po wykryciu pierwszej maszyny przez radar.');
        }
    } catch (error) {
        console.error('Nie udało się pobrać statystyk:', error);
        showStatus('Nie udało się pobrać danych. Sprawdź, czy serwer i baza danych są uruchomione, a następnie spróbuj ponownie.', true);
    } finally {
        refreshButton.disabled = false;
        refreshButton.querySelector('span').textContent = '↻';
    }
}

refreshButton.addEventListener('click', loadToday);
searchInput.addEventListener('input', renderGallery);
loadToday();
setInterval(loadToday, 60_000);
