
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
let databaseReady = false;
let lastSuccessfulReadAt = null;
const lastTrackSampleAt = new Map();
const aircraftPhotoCache = new Map();

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

async function migrateLegacyMielecRecords() {
    let lastId = null;
    let migratedCount = 0;

    while (true) {
        const filter = { nearMielec: { $exists: false } };
        if (lastId) filter._id = { $gt: lastId };
        const planes = await DailyAircraft.find(filter)
            .select('_id firstSeen lastSeen maxAltitude maxSpeed messages lastLatitude lastLongitude lastAltitude lastSpeed lastHeading verticalRate')
            .sort({ _id: 1 })
            .limit(500)
            .lean();
        if (!planes.length) break;

        const operations = planes.map(plane => {
            const localFields = { nearMielec: true };
            for (const [source, target] of [
                ['firstSeen', 'firstSeenMielec'],
                ['lastSeen', 'lastSeenMielec'],
                ['maxAltitude', 'maxAltitudeMielec'],
                ['maxSpeed', 'maxSpeedMielec'],
                ['messages', 'messagesMielec'],
                ['lastLatitude', 'lastLatitudeMielec'],
                ['lastLongitude', 'lastLongitudeMielec'],
                ['lastAltitude', 'lastAltitudeMielec'],
                ['lastSpeed', 'lastSpeedMielec'],
                ['lastHeading', 'lastHeadingMielec'],
                ['verticalRate', 'verticalRateMielec']
            ]) {
                if (plane[source] !== undefined) localFields[target] = plane[source];
            }

            return {
                updateOne: {
                    filter: { _id: plane._id, nearMielec: { $exists: false } },
                    update: { $set: localFields }
                }
            };
        });

        const result = await DailyAircraft.bulkWrite(operations, { ordered: false });
        migratedCount += result.modifiedCount;
        lastId = planes.at(-1)._id;
    }

    if (migratedCount) {
        console.log(`Zaktualizowano starsze wpisy Mielca: ${migratedCount}`);
    }
}

// Łączenie z MongoDB i zachowanie dotychczasowych statystyk Mielca.
mongoose.connect(url)
    .then(async () => {
        await migrateLegacyMielecRecords();
        databaseReady = true;
        console.log('Połączono z MongoDB');
    })
    .catch(err => console.error('Błąd przygotowania MongoDB:', err));

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
                registration: 1,
                maxAltitude: 1,
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
            date: today,
            $or: [
                { nearMielec: true },
                { nearMielec: { $exists: false } }
            ]
        })
            .select('date hex callsign registration aircraftType category squawk emergency firstSeen firstSeenMielec lastSeen lastSeenMielec maxAltitude maxAltitudeMielec maxSpeed maxSpeedMielec messages messagesMielec lastLatitude lastLatitudeMielec lastLongitude lastLongitudeMielec lastAltitude lastAltitudeMielec lastSpeed lastSpeedMielec lastHeading lastHeadingMielec verticalRate verticalRateMielec')
            .sort({ firstSeenMielec: 1, firstSeen: 1 })
            .lean();

        res.json(planes.map(plane => ({
            ...plane,
            firstSeen: plane.firstSeenMielec ?? plane.firstSeen,
            lastSeen: plane.lastSeenMielec ?? plane.lastSeen,
            maxAltitude: plane.maxAltitudeMielec ?? plane.maxAltitude,
            maxSpeed: plane.maxSpeedMielec ?? plane.maxSpeed,
            messages: plane.messagesMielec ?? plane.messages,
            lastLatitude: plane.lastLatitudeMielec ?? plane.lastLatitude,
            lastLongitude: plane.lastLongitudeMielec ?? plane.lastLongitude,
            lastAltitude: plane.lastAltitudeMielec ?? plane.lastAltitude,
            lastSpeed: plane.lastSpeedMielec ?? plane.lastSpeed,
            lastHeading: plane.lastHeadingMielec ?? plane.lastHeading,
            verticalRate: plane.verticalRateMielec ?? plane.verticalRate
        })));

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
        const manufacturer = typeof aircraft.manufacturer === 'string'
            ? aircraft.manufacturer.trim()
            : '';
        const modelName = typeof aircraft.type === 'string'
            ? aircraft.type.trim()
            : '';
        const aircraftType = modelName
            ? manufacturer && !modelName.toLowerCase().includes(manufacturer.toLowerCase())
                ? `${manufacturer} ${modelName}`
                : modelName
            : typeof aircraft.icao_type_code === 'string'
                ? aircraft.icao_type_code.trim()
                : null;
        const registration = aircraft.registration?.trim();
        if (!registration || !/^[a-z0-9-]{2,10}$/i.test(registration)) {
            if (aircraftType) {
                const metadata = {
                    url: null,
                    link: null,
                    source: 'HexDB',
                    registration: null,
                    aircraftType
                };
                aircraftPhotoCache.set(hex, {
                    photo: metadata,
                    expiresAt: Date.now() + 60 * 60 * 1000
                });
                return res.json(metadata);
            }
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
                registration,
                aircraftType
            };
        } else {
            photo = {
                url: null,
                link: jetPhotosUrl.toString(),
                source: 'JetPhotos',
                registration,
                aircraftType
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

    if (!databaseReady || isReading) return;

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
        const updates = [];
        const sampleCutoff = Date.now() - 60_000;
        for (const [hex, sampledAt] of lastTrackSampleAt) {
            if (sampledAt < sampleCutoff) lastTrackSampleAt.delete(hex);
        }

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

            const nearMielec = isNearMielec(plane.lat, plane.lon);
            const altitude = typeof plane.alt_baro === 'number'
                ? plane.alt_baro
                : typeof plane.alt_geom === 'number'
                    ? plane.alt_geom
                    : undefined;

            if (nearMielec) {
                console.log(
                    plane.hex,
                    plane.flight,
                    plane.lat,
                    plane.lon
                );
            }


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
            if (nearMielec) {
                update.$set.nearMielec = true;
                update.$min = { firstSeenMielec: now };
                update.$max = { lastSeenMielec: now };
                update.$set.lastLatitudeMielec = plane.lat;
                update.$set.lastLongitudeMielec = plane.lon;
            } else {
                update.$setOnInsert.nearMielec = false;
            }

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
            if (altitude !== undefined) {
                update.$set.lastAltitude = altitude;
                if (nearMielec) update.$set.lastAltitudeMielec = altitude;
            }
            if (typeof plane.gs === 'number') {
                update.$set.lastSpeed = plane.gs;
                if (nearMielec) update.$set.lastSpeedMielec = plane.gs;
            }
            if (typeof plane.track === 'number') {
                update.$set.lastHeading = plane.track;
                if (nearMielec) update.$set.lastHeadingMielec = plane.track;
            }
            if (typeof plane.baro_rate === 'number') {
                update.$set.verticalRate = plane.baro_rate;
                if (nearMielec) update.$set.verticalRateMielec = plane.baro_rate;
            }

            // Największa wysokość
            if (altitude !== undefined) {
                update.$max = {
                    ...update.$max,
                    maxAltitude: altitude
                };
                if (nearMielec) {
                    update.$max.maxAltitudeMielec = altitude;
                }
            }

            // Największa prędkość
            if (typeof plane.gs === 'number') {
                update.$max = {
                    ...update.$max,
                    maxSpeed: plane.gs
                };
                if (nearMielec) {
                    update.$max.maxSpeedMielec = plane.gs;
                }
            }

            // Licznik odebranych wiadomości (maksymalna zaobserwowana wartość)
            if (typeof plane.messages === 'number') {
                update.$max = {
                    ...update.$max,
                    messages: plane.messages
                };
                if (nearMielec) {
                    update.$max.messagesMielec = plane.messages;
                }
            }

            const lastSample = lastTrackSampleAt.get(plane.hex) ?? 0;
            if (now.getTime() - lastSample >= 15_000) {
                const point = {
                    at: now,
                    lat: plane.lat,
                    lon: plane.lon,
                    data: plane
                };
                if (altitude !== undefined) {
                    point.altitude = altitude;
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


            updates.push({
                updateOne: {
                    filter: {
                        date: today,
                        hex: plane.hex
                    },
                    update,
                    upsert: true
                }
            });
        }

        if (updates.length) {
            await DailyAircraft.bulkWrite(updates, { ordered: false });
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
