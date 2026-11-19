
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

app.get('/api/today', async (req, res) => {
    try {
        const today = getToday();

        const planes = await DailyAircraft.find({
            date: today
        }).sort({
            firstSeen: 1
        });

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
            cached.photo ?? { error: 'Nie znaleziono zdjęcia samolotu' }
        );
    }

    try {
        const response = await fetch(
            `https://api.planespotters.net/pub/photos/hex/${hex}`,
            { signal: AbortSignal.timeout(8000) }
        );

        if (!response.ok) {
            throw new Error(`PlaneSpotters zwrócił status ${response.status}`);
        }

        const data = await response.json();
        const photo = data.photos?.[0];
        const result = photo
            ? {
                url: photo.thumbnail_large?.src ?? photo.thumbnail?.src,
                link: photo.link
            }
            : null;

        if (result?.url) {
            aircraftPhotoCache.set(hex, {
                photo: result,
                expiresAt: Date.now() + 6 * 60 * 60 * 1000
            });
            return res.json(result);
        }

        aircraftPhotoCache.set(hex, {
            photo: null,
            expiresAt: Date.now() + 60 * 60 * 1000
        });
        return res.status(404).json({
            error: 'Nie znaleziono zdjęcia samolotu'
        });
    } catch (err) {
        console.error(`Błąd pobierania zdjęcia samolotu ${hex}:`, err);
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
            const update = {
                $set: {
                    lastSeen: new Date()
                },

                $setOnInsert: {
                    firstSeen: new Date()
                }
            };

            // Callsign
            if (plane.flight?.trim()) {
                update.$set.callsign = plane.flight.trim();
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
