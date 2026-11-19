
import express from 'express';
import mongoose from 'mongoose';
import { readFile } from 'node:fs/promises';
import DailyAircraft from './daily.js';

const url = "mongodb://127.0.0.1:27017/radar";

const app = express();
app.use(express.static('public'));

let i = 0;
let aircrafts = [];
let isReading = false;
let lastSuccessfulReadAt = null;
const lastTrackSampleAt = new Map();
const aircraftPhotoCache = new Map();

// Łączenie z MongoDB
mongoose.connect(url)
    .then(() => console.log('Połączono z MongoDB'))
    .catch(err => console.error('Błąd MongoDB:', err));


// Sprawdzanie odległości od Mielca
function isNearMielec(lat, lon) {
    const mielecLat = 50.2878;
    const mielecLon = 21.4239;

    const distance = Math.sqrt(
        Math.pow(lat - mielecLat, 2) +
        Math.pow(
            (lon - mielecLon) *
            Math.cos(mielecLat * Math.PI / 180),
            2
        )
    ) * 111;

    return distance <= 20;
}


// Aktualna data w polskiej strefie czasowej
function getToday() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Warsaw',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

function isValidArchiveDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parsed = new Date(`${date}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === date;
}

app.get('/api/health', (req, res) => {
    const currentPlanes = aircrafts.aircraft ?? [];
    const receiverOnline = lastSuccessfulReadAt !== null &&
        Date.now() - lastSuccessfulReadAt.getTime() < 10_000;

    res.json({
        receiverOnline,
        databaseOnline: mongoose.connection.readyState === 1,
        lastReadAt: lastSuccessfulReadAt,
        activeAircraft: currentPlanes.filter(plane =>
            typeof plane.lat === 'number' &&
            typeof plane.lon === 'number' &&
            !(typeof plane.seen_pos === 'number' && plane.seen_pos > 60)
        ).length
    });
});

app.get('/api/archive/days', async (req, res) => {
    try {
        const dates = await DailyAircraft.distinct('date');
        res.json({
            today: getToday(),
            days: dates.filter(isValidArchiveDate).sort().reverse()
        });
    } catch (err) {
        console.error('Błąd pobierania dni archiwum:', err);
        res.status(500).json({
            error: 'Nie udało się pobrać dni archiwum'
        });
    }
});

app.get('/api/archive/:date', async (req, res) => {
    const { date } = req.params;
    if (!isValidArchiveDate(date)) {
        return res.status(400).json({
            error: 'Nieprawidłowa data archiwum'
        });
    }

    try {
        const planes = await DailyAircraft.find({ date })
            .sort({ firstSeen: 1 })
            .lean();
        res.json({ date, count: planes.length, planes });
    } catch (err) {
        console.error(`Błąd pobierania archiwum za ${date}:`, err);
        res.status(500).json({
            error: 'Nie udało się pobrać archiwum'
        });
    }
});

app.get('/api/today/tracks', async (req, res) => {
    try {
        const planes = await DailyAircraft.find({ date: getToday() })
            .select({
                hex: 1,
                callsign: 1,
                'trackPoints.at': 1,
                'trackPoints.lat': 1,
                'trackPoints.lon': 1
            })
            .lean();
        res.json({ planes });
    } catch (err) {
        console.error('Błąd pobierania śladów samolotów:', err);
        res.status(500).json({
            error: 'Nie udało się pobrać śladów samolotów'
        });
    }
});

app.get('/api/today', async (req, res) => {
    try {
        const today = getToday();

        const planes = await DailyAircraft.find({
            date: today
        })
            .select('date hex callsign registration aircraftType category squawk emergency firstSeen lastSeen maxAltitude maxSpeed messages lastLatitude lastLongitude lastAltitude lastSpeed lastHeading verticalRate')
            .sort({ firstSeen: 1 });

        res.json(planes);

    } catch (err) {
        console.error('Błąd pobierania dzisiejszych samolotów:', err);

        res.status(500).json({
            error: 'Nie udało się pobrać samolotów'
        });
    }
});

app.get('/api/aircraft-photo/:hex', async (req, res) => {
    const hex = req.params.hex.toLowerCase();

    if (!/^[a-f0-9]{6}$/.test(hex)) {
        return res.status(400).json({
            error: 'Nieprawidłowy identyfikator samolotu'
        });
    }

    const cached = aircraftPhotoCache.get(hex);
    if (cached && cached.expiresAt > Date.now()) {
        return res.status(cached.photo ? 200 : 404).json(
            cached.photo ?? { error: 'Nie znaleziono danych samolotu' }
        );
    }

    try {
        const aircraftResponse = await fetch(
            `https://hexdb.io/api/v2/aircraft/${hex}`,
            {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(8000)
            }
        );

        if (aircraftResponse.status === 404) {
            aircraftPhotoCache.set(hex, {
                photo: null,
                expiresAt: Date.now() + 60 * 60 * 1000
            });
            return res.status(404).json({
                error: 'Nie znaleziono rejestracji samolotu'
            });
        }
        if (!aircraftResponse.ok) {
            throw new Error(`HexDB zwrócił status ${aircraftResponse.status}`);
        }

        const aircraft = await aircraftResponse.json();
        const registration = aircraft.registration?.trim();
        if (!registration || !/^[a-z0-9-]{2,10}$/i.test(registration)) {
            aircraftPhotoCache.set(hex, {
                photo: null,
                expiresAt: Date.now() + 60 * 60 * 1000
            });
            return res.status(404).json({
                error: 'Nie znaleziono rejestracji samolotu'
            });
        }

        const jetPhotosUrl = new URL(
            `/registration/${encodeURIComponent(registration)}`,
            'https://www.jetphotos.com'
        );
        const imageUrl = aircraft.images?.thumbnail ?? aircraft.images?.full;
        let photo = null;
        if (imageUrl) {
            const parsedImageUrl = new URL(imageUrl);
            if (
                parsedImageUrl.protocol !== 'https:' ||
                parsedImageUrl.hostname !== 'hexdb.io'
            ) {
                throw new Error('HexDB zwrócił nieprawidłowy adres zdjęcia');
            }
            photo = {
                url: parsedImageUrl.toString(),
                link: `https://hexdb.io/api/v2/aircraft/${hex}`,
                source: 'HexDB',
                registration
            };
        } else {
            photo = {
                url: null,
                link: jetPhotosUrl.toString(),
                source: 'JetPhotos',
                registration
            };
        }

        aircraftPhotoCache.set(hex, {
            photo,
            expiresAt: Date.now() + (photo.url ? 6 : 1) * 60 * 60 * 1000
        });
        return res.json(photo);
    } catch (err) {
        console.error(`Błąd pobierania zdjęcia dla ${hex}:`, err);
        return res.status(502).json({
            error: 'Nie udało się pobrać zdjęcia samolotu'
        });
    }
});
// Odczytywanie samolotów
async function readplanes() {

    if (isReading) return;

    isReading = true;

    try {

        const data = await readFile(
            '/run/dump1090/aircraft.json',
            'utf8'
        );

        aircrafts = JSON.parse(data);
        lastSuccessfulReadAt = new Date();

        i++;

        const today = getToday();

        for (const plane of aircrafts.aircraft ?? []) {

            // Pomijamy samoloty bez identyfikatora
            if (!plane.hex) continue;

            // Pomijamy samoloty bez pozycji
            if (
                typeof plane.lat !== 'number' ||
                typeof plane.lon !== 'number'
            ) continue;

            // Pomijamy stare pozycje
            if (
                typeof plane.seen_pos === 'number' &&
                plane.seen_pos > 60
            ) continue;

            // Sprawdzamy, czy samolot jest w promieniu 20 km
            if (!isNearMielec(plane.lat, plane.lon)) continue;


            console.log(
                plane.hex,
                plane.flight,
                plane.lat,
                plane.lon
            );


            // Dane do zapisania
            const now = new Date();
            const update = {
                $set: {
                    lastSeen: now,
                    lastLatitude: plane.lat,
                    lastLongitude: plane.lon,
                    latestData: plane
                },

                $setOnInsert: {
                    firstSeen: now
                }
            };

            // Callsign
            if (plane.flight?.trim()) {
                update.$set.callsign = plane.flight.trim();
            }
            if (typeof plane.r === 'string') {
                update.$set.registration = plane.r.trim();
            }
            if (typeof plane.t === 'string') {
                update.$set.aircraftType = plane.t.trim();
            }
            if (typeof plane.category === 'string') {
                update.$set.category = plane.category;
            }
            if (typeof plane.squawk === 'string') {
                update.$set.squawk = plane.squawk;
            }
            if (typeof plane.emergency === 'string') {
                update.$set.emergency = plane.emergency;
            }
            if (typeof plane.alt_baro === 'number') {
                update.$set.lastAltitude = plane.alt_baro;
            }
            if (typeof plane.gs === 'number') {
                update.$set.lastSpeed = plane.gs;
            }
            if (typeof plane.track === 'number') {
                update.$set.lastHeading = plane.track;
            }
            if (typeof plane.baro_rate === 'number') {
                update.$set.verticalRate = plane.baro_rate;
            }

            // Największa wysokość
            if (typeof plane.alt_baro === 'number') {
                update.$max = {
                    ...update.$max,
                    maxAltitude: plane.alt_baro
                };
            }

            // Największa prędkość
            if (typeof plane.gs === 'number') {
                update.$max = {
                    ...update.$max,
                    maxSpeed: plane.gs
                };
            }

            // Licznik odebranych wiadomości (maksymalna zaobserwowana wartość)
            if (typeof plane.messages === 'number') {
                update.$max = {
                    ...update.$max,
                    messages: plane.messages
                };
            }

            const lastSample = lastTrackSampleAt.get(plane.hex) ?? 0;
            if (now.getTime() - lastSample >= 15_000) {
                const point = {
                    at: now,
                    lat: plane.lat,
                    lon: plane.lon,
                    data: plane
                };
                if (typeof plane.alt_baro === 'number') {
                    point.altitude = plane.alt_baro;
                }
                if (typeof plane.gs === 'number') {
                    point.speed = plane.gs;
                }
                if (typeof plane.track === 'number') {
                    point.heading = plane.track;
                }
                if (typeof plane.baro_rate === 'number') {
                    point.verticalRate = plane.baro_rate;
                }
                update.$push = {
                    trackPoints: {
                        $each: [point],
                        $slice: -5000
                    }
                };
                lastTrackSampleAt.set(plane.hex, now.getTime());
            }


            // Zapis do MongoDB
            await DailyAircraft.findOneAndUpdate(
                {
                    date: today,
                    hex: plane.hex
                },
                update,
                {
                    upsert: true,
                    new: true
                }
            );

        }

        console.log('Odczyt nr:', i);

    } catch (err) {

        console.error('Błąd odczytu samolotów:', err);

    } finally {

        isReading = false;

    }
}


// Odczyt co 1,5 sekundy
setInterval(readplanes, 1500);

readplanes();


// API
app.get('/', (req, res) => {
    res.json(aircrafts);
});

app.get('/api/planes', (req, res) => {
    res.json(aircrafts);
});


// Serwer
app.listen(8080, () => {
    console.log('RADAR działa na porcie 8080');
});
